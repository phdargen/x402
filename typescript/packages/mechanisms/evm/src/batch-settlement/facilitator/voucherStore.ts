import type {
  FacilitatorContext,
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { getAddress, isAddressEqual, recoverTypedDataAddress } from "viem";
import type { PendingSettlementStore } from "@x402/core/facilitator";
import type { FacilitatorEvmSigner } from "../../signer";
import type { AuthorizerSigner } from "../types";
import {
  isBatchSettlementDepositPayload,
  isBatchSettlementPayload,
  isBatchSettlementRefundPayload,
  isBatchSettlementVoucherPayload,
} from "../types";
import type {
  BatchSettlementDepositPayload,
  BatchSettlementEnrichedDepositPayload,
  BatchSettlementEnrichedRefundPayload,
  BatchSettlementEnrichedVoucherPayload,
  BatchSettlementPayload,
  BatchSettlementRefundPayload,
  BatchSettlementVoucherClaim,
  BatchSettlementVoucherPayload,
} from "../types";
import { refundTypes } from "../constants";
import * as Errors from "../errors";
import {
  evaluateVoucherAgainstCachedState,
  getBatchSettlementEip712Domain,
  unpackRefundAuthorizer,
  validateChannelConfig,
  verifyEoaVoucherSignature,
} from "../utils";
import { createNonce, getEvmChainId } from "../../utils";
import {
  admissionOwner,
  channelStateExtra,
  commitVoucherCharge,
  defaultOnchainStateTtlMs,
  paymentResponseExtra,
  pendingTtlMs,
} from "../voucherStore";
import {
  rethrowLockImplementationError,
  type ChannelLockStorage,
  type ChannelStorage,
} from "../storage/channel";
import type { DelegatedAuthStore } from "../storage/delegatedAuth";
import { verifyDeposit, settleDeposit } from "./deposit";
import { readChannelState } from "./utils";
import { verifyVoucher } from "./voucher";
import { encodeChargeCountsSuffix } from "../chargeCounts";
import { submitRefund } from "./refund";
import type { DelegatedSettleContext, FacilitatorChannel } from "./types";
import type { SubmitMode } from "./submit";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type ResolveCallerIdentity = (
  ctx: DelegatedSettleContext,
) => Promise<string | undefined> | string | undefined;

export type VoucherStoreDeps = {
  signer: FacilitatorEvmSigner;
  authorizerSigner: AuthorizerSigner;
  authorizerSubmitter?: FacilitatorEvmSigner;
  submitMode?: SubmitMode;
  storage: ChannelStorage<FacilitatorChannel>;
  lockStorage: ChannelLockStorage;
  withdrawDelay: number;
  /** Cached onchain accept window. `0` disables the cache. Omit to derive from `withdrawDelay`. */
  onchainStateTtlMs?: number;
  resolveCallerIdentity?: ResolveCallerIdentity;
  delegatedAuthStore?: DelegatedAuthStore;
  eip6492AllowedFactories: string[];
  pendingStore: PendingSettlementStore;
};

/**
 * True when `/settle` carries a server-authored cancel flag.
 *
 * @param raw - Client payload that may include settle enrichment fields.
 * @returns True when `cancel` is exactly `true`.
 */
function isCancelSettlePayload(
  raw: BatchSettlementPayload,
): raw is BatchSettlementPayload & { pendingId?: string; cancel: true } {
  return "cancel" in raw && raw.cancel === true;
}

/**
 * Lock-store owner for a settle that echoed `pendingId`.
 *
 * @param pendingId - Server-minted nonce from `/verify`, if the server attached one.
 * @param voucher - Voucher presented on this `/settle`.
 * @returns Bound owner, or undefined when `/settle` omitted `pendingId`.
 */
function boundAdmissionOwner(
  pendingId: string | undefined,
  voucher: BatchSettlementVoucherPayload["voucher"],
): string | undefined {
  return pendingId ? admissionOwner(pendingId, voucher) : undefined;
}

/**
 * Whether this settle still holds the verify admission lock for this voucher.
 *
 * Lock-store I/O failures degrade to not-held (optimistic). Implementation
 * errors fail closed and propagate.
 *
 * @param deps - Store dependencies.
 * @param channelId - Channel id.
 * @param owner - Voucher-bound lock owner, if the server attached a `pendingId`.
 * @returns True only when `owner` is present and still holds.
 */
async function admissionHeld(
  deps: VoucherStoreDeps,
  channelId: string,
  owner: string | undefined,
): Promise<boolean> {
  if (owner === undefined) {
    return false;
  }
  try {
    return await deps.lockStorage.isHeld(channelId, owner);
  } catch (err) {
    rethrowLockImplementationError(err);
    return false;
  }
}

/**
 * Whether any live admission lock exists on this channel.
 *
 * Lock-store I/O failures degrade to not-held (optimistic). Implementation
 * errors fail closed and propagate.
 *
 * @param deps - Store dependencies.
 * @param channelId - Channel id.
 * @returns True when a live lock is present.
 */
async function anyAdmissionHeld(deps: VoucherStoreDeps, channelId: string): Promise<boolean> {
  try {
    return await deps.lockStorage.isHeld(channelId);
  } catch (err) {
    rethrowLockImplementationError(err);
    return false;
  }
}

/**
 * Releases the voucher-bound verify owner. No-op when `/settle` omitted
 * `pendingId` (lock-lost path: TTL may already have dropped the hold).
 *
 * @param deps - Store dependencies.
 * @param channelId - Channel id.
 * @param owner - Voucher-bound lock owner, if any.
 */
async function releaseAdmission(
  deps: VoucherStoreDeps,
  channelId: string,
  owner: string | undefined,
): Promise<void> {
  if (owner) {
    await releaseLock(deps, channelId, owner);
  }
}

/**
 * Facilitator-managed `/verify`.
 *
 * @param deps - Store, lock, and signer dependencies.
 * @param payload - Payment envelope.
 * @param requirements - Payment requirements (must have `voucherStore: true`).
 * @param context - Optional facilitator extension context.
 * @returns Verify response with watermark extras.
 */
export async function verifyManaged(
  deps: VoucherStoreDeps,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  context?: FacilitatorContext,
): Promise<VerifyResponse> {
  const raw = payload.payload;
  if (!isBatchSettlementPayload(raw)) {
    return { isValid: false, invalidReason: Errors.ErrInvalidPayloadType };
  }

  if ("cancel" in raw && raw.cancel !== undefined) {
    return {
      isValid: false,
      invalidReason: Errors.ErrUnexpectedCancel,
      payer: raw.channelConfig.payer,
    };
  }

  const managedErr = managedRequirementError(deps, raw.channelConfig.salt, requirements);
  if (managedErr) {
    return { isValid: false, invalidReason: managedErr, payer: raw.channelConfig.payer };
  }

  if (isBatchSettlementVoucherPayload(raw) && raw.channelConfig.payerAuthorizer !== ZERO_ADDRESS) {
    const signatureOk = await verifyEoaVoucherSignature(raw, requirements.network);
    if (!signatureOk) {
      return {
        isValid: false,
        invalidReason: Errors.ErrInvalidVoucherSignature,
        payer: raw.channelConfig.payer,
      };
    }
  }

  const channelId = raw.voucher.channelId;
  const pendingId = createNonce();
  const owner = admissionOwner(pendingId, raw.voucher);
  let reserved = false;
  try {
    if (
      !(await deps.lockStorage.acquire(
        channelId,
        owner,
        pendingTtlMs(requirements.maxTimeoutSeconds),
      ))
    ) {
      return {
        isValid: false,
        invalidReason: Errors.ErrChannelBusy,
        payer: raw.channelConfig.payer,
      };
    }
    reserved = true;

    const stored = await deps.storage.get(channelId);
    const verified = isBatchSettlementDepositPayload(raw)
      ? await verifyDeposit(
          deps.signer,
          payload,
          raw,
          requirements,
          context,
          deps.eip6492AllowedFactories,
        )
      : isBatchSettlementVoucherPayload(raw)
        ? (evaluateVoucherAgainstCachedState(
            raw,
            requirements,
            stored,
            Date.now(),
            deps.onchainStateTtlMs ?? defaultOnchainStateTtlMs(deps.withdrawDelay),
          ) ?? (await verifyVoucher(deps.signer, raw, requirements, raw.channelConfig)))
        : await verifyVoucher(deps.signer, raw, requirements, raw.channelConfig);

    if (!verified.isValid) {
      await releaseLock(deps, channelId, owner);
      return verified;
    }
    const onchainClaimed = readExtraTotalClaimed(verified.extra);
    const charged = stored?.chargedCumulativeAmount ?? onchainClaimed;
    const isRefund = isBatchSettlementRefundPayload(raw);
    const expected = isRefund ? BigInt(charged) : BigInt(charged) + BigInt(requirements.amount);

    if (BigInt(raw.voucher.maxClaimableAmount) !== expected) {
      await releaseLock(deps, channelId, owner);
      return {
        isValid: false,
        invalidReason: Errors.ErrCumulativeAmountMismatch,
        payer: raw.channelConfig.payer,
        extra: {
          channelState: mismatchChannelState(channelId, verified.extra, stored, charged),
          voucherState: stored
            ? {
                signedMaxClaimable: stored.signedMaxClaimable,
                signature: stored.signature as `0x${string}`,
              }
            : {},
        },
      };
    }

    return {
      ...verified,
      extra: {
        ...verified.extra,
        chargedCumulativeAmount: charged,
        pendingId,
      },
    };
  } catch (err) {
    rethrowLockImplementationError(err);
    if (reserved) {
      await releaseLock(deps, channelId, owner);
    }
    return {
      isValid: false,
      invalidReason: Errors.ErrRpcReadFailed,
      payer: raw.channelConfig.payer,
    };
  }
}

/**
 * Facilitator-managed `/settle`.
 *
 * @param deps - Store, lock, and signer dependencies.
 * @param payload - Payment envelope.
 * @param requirements - Payment requirements.
 * @param context - Optional facilitator extension context.
 * @param dataSuffix - Optional calldata suffix.
 * @returns Settle response with charge extras.
 */
export async function settleManaged(
  deps: VoucherStoreDeps,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  context?: FacilitatorContext,
  dataSuffix?: `0x${string}`,
): Promise<SettleResponse> {
  const raw = payload.payload;
  if (isBatchSettlementPayload(raw) && isCancelSettlePayload(raw)) {
    return settleManagedCancel(deps, raw, requirements);
  }
  if (isBatchSettlementVoucherPayload(raw)) {
    return settleManagedVoucher(deps, raw, requirements);
  }
  if (isBatchSettlementDepositPayload(raw)) {
    return settleManagedDeposit(deps, payload, raw, requirements, context, dataSuffix);
  }
  if (isBatchSettlementRefundPayload(raw)) {
    return settleManagedRefund(deps, payload, raw, requirements, context, dataSuffix);
  }
  return {
    success: false,
    errorReason: Errors.ErrInvalidPayloadType,
    transaction: "",
    network: requirements.network,
  };
}

/**
 * Drops the admission lock without charging, depositing, or refunding.
 *
 * @param deps - Store dependencies.
 * @param raw - Original payload plus server-authored `cancel` / `pendingId`.
 * @param requirements - Payment requirements.
 * @returns Offchain success with an empty transaction.
 */
async function settleManagedCancel(
  deps: VoucherStoreDeps,
  raw: BatchSettlementPayload & { pendingId?: string; cancel?: boolean },
  requirements: PaymentRequirements,
): Promise<SettleResponse> {
  const channelId = raw.voucher.channelId;
  const owner = boundAdmissionOwner(raw.pendingId, raw.voucher);
  await releaseAdmission(deps, channelId, owner);
  return {
    success: true,
    transaction: "",
    network: requirements.network,
    payer: raw.channelConfig.payer.toLowerCase() as `0x${string}`,
    amount: "",
  };
}

/**
 * Commits an offchain voucher charge.
 *
 * The stored row is the charge base, passed as the CAS callback's `current`
 * rather than as a snapshot, so a settle never claims onchain freshness it did
 * not read. Only the missing-row retry carries a snapshot, and that one comes
 * from {@link provisionalFromOnchain}, which does read onchain.
 *
 * @param deps - Store dependencies.
 * @param raw - Voucher payload.
 * @param requirements - Payment requirements.
 * @returns Offchain settle response.
 */
async function settleManagedVoucher(
  deps: VoucherStoreDeps,
  raw: BatchSettlementEnrichedVoucherPayload,
  requirements: PaymentRequirements,
): Promise<SettleResponse> {
  const channelId = raw.voucher.channelId;
  const owner = boundAdmissionOwner(raw.pendingId, raw.voucher);
  try {
    const held = await admissionHeld(deps, channelId, owner);
    if (held) {
      const configErr = validateChannelConfig(
        raw.channelConfig,
        raw.voucher.channelId,
        requirements,
      );
      if (configErr) {
        return failSettle(requirements, configErr);
      }
    } else if (raw.pendingId && (await anyAdmissionHeld(deps, channelId))) {
      return failSettle(requirements, Errors.ErrPendingIdMismatch);
    } else {
      const verified = await verifyVoucher(deps.signer, raw, requirements, raw.channelConfig);
      if (!verified.isValid) {
        return failSettle(
          requirements,
          verified.invalidReason ?? Errors.ErrInvalidVoucherSignature,
        );
      }
    }

    const increment = BigInt(requirements.amount);
    const signedCap = BigInt(raw.voucher.maxClaimableAmount);
    const map =
      increment === 0n
        ? undefined
        : (channel: FacilitatorChannel) => incrementChargeCount(channel, requirements.network);
    let outcome = await commitVoucherCharge(deps.storage, channelId, {
      increment,
      signedCap,
      voucher: raw.voucher,
      map,
    });

    if (outcome.status === "missing") {
      outcome = await commitVoucherCharge(deps.storage, channelId, {
        increment,
        signedCap,
        voucher: raw.voucher,
        snapshot: await provisionalFromOnchain(deps, raw, requirements),
        map,
      });
    }

    if (outcome.status === "missing") {
      return failSettle(requirements, Errors.ErrMissingChannel);
    }
    if (outcome.status === "cap_exceeded") {
      return failSettle(requirements, Errors.ErrChargeExceedsSignedCumulative);
    }
    if (outcome.status !== "committed") {
      return failSettle(requirements, Errors.ErrChannelBusy);
    }

    return {
      success: true,
      transaction: "",
      network: requirements.network,
      payer: raw.channelConfig.payer.toLowerCase() as `0x${string}`,
      amount: "",
      extra: paymentResponseExtra({
        channelState: channelStateExtra(outcome.current, outcome.current.chargedCumulativeAmount),
        chargedAmount: requirements.amount,
        chargeCount: outcome.current.chargeCount,
      }),
    };
  } finally {
    await releaseAdmission(deps, channelId, owner);
  }
}

/**
 * Settles a deposit onchain, then persists the voucher and watermark.
 *
 * @param deps - Store dependencies.
 * @param payment - Payment envelope.
 * @param raw - Deposit payload.
 * @param requirements - Payment requirements.
 * @param context - Facilitator extension context.
 * @param dataSuffix - Optional calldata suffix.
 * @returns Deposit settle response with charge extras.
 */
async function settleManagedDeposit(
  deps: VoucherStoreDeps,
  payment: PaymentPayload,
  raw: BatchSettlementEnrichedDepositPayload,
  requirements: PaymentRequirements,
  context: FacilitatorContext | undefined,
  dataSuffix: `0x${string}` | undefined,
): Promise<SettleResponse> {
  const channelId = raw.voucher.channelId;
  const owner = boundAdmissionOwner(raw.pendingId, raw.voucher);
  try {
    const settled = await settleDeposit(
      deps.signer,
      payment,
      raw,
      requirements,
      context,
      dataSuffix,
      deps.eip6492AllowedFactories,
      deps.pendingStore,
    );
    if (!settled.success) {
      return settled;
    }

    let identity: string | undefined;
    try {
      identity = await resolveIdentity(deps, {
        step: "deposit",
        channelId,
        network: requirements.network,
        payer: raw.channelConfig.payer,
        amount: raw.deposit.amount,
        payload: payment,
        requirements,
        facilitatorContext: context,
      });
    } catch (err) {
      console.warn(
        "batch-settlement: resolveCallerIdentity failed after deposit settle; continuing without identity",
        err,
      );
    }

    const stored = await deps.storage.get(channelId);
    const snapshot = depositChargeSnapshot(raw, requirements, settled.extra, stored);
    const outcome = await commitVoucherCharge(deps.storage, channelId, {
      increment: BigInt(requirements.amount),
      signedCap: BigInt(raw.voucher.maxClaimableAmount),
      voucher: raw.voucher,
      snapshot,
      map: channel => ({
        ...incrementChargeCount(channel, requirements.network),
        callerIdentity: channel.callerIdentity ?? identity,
      }),
    });

    if (outcome.status !== "committed") {
      return {
        ...settled,
        extra: {
          ...settled.extra,
          ...(outcome.status === "cap_exceeded" ? {} : { chargeCount: stored?.chargeCount ?? 0 }),
        },
      };
    }

    return {
      ...settled,
      extra: paymentResponseExtra({
        channelState: {
          ...(typeof settled.extra?.channelState === "object" ? settled.extra.channelState : {}),
          ...channelStateExtra(outcome.current, outcome.current.chargedCumulativeAmount),
        },
        chargedAmount: requirements.amount,
        chargeCount: outcome.current.chargeCount,
      }),
    };
  } finally {
    await releaseAdmission(deps, channelId, owner);
  }
}

/**
 * Settles a managed cooperative refund after consent and watermark checks.
 *
 * @param deps - Store dependencies.
 * @param payment - Payment envelope.
 * @param raw - Refund payload (possibly enriched).
 * @param requirements - Payment requirements.
 * @param context - Facilitator extension context.
 * @param dataSuffix - Optional calldata suffix.
 * @returns Refund settle response.
 */
async function settleManagedRefund(
  deps: VoucherStoreDeps,
  payment: PaymentPayload,
  raw: BatchSettlementRefundPayload & { pendingId?: string; cancel?: boolean },
  requirements: PaymentRequirements,
  context: FacilitatorContext | undefined,
  dataSuffix: `0x${string}` | undefined,
): Promise<SettleResponse> {
  const channelId = raw.voucher.channelId;
  const owner = boundAdmissionOwner(raw.pendingId, raw.voucher);
  try {
    const amountError = refundAmountError(raw);
    if (amountError) {
      return failSettle(requirements, amountError);
    }
    const stored = await deps.storage.get(channelId);
    const consentErr = await checkRefundConsent(deps, payment, raw, requirements, context, stored);
    if (consentErr) {
      return failSettle(requirements, consentErr);
    }

    if (
      !stored ||
      BigInt(raw.voucher.maxClaimableAmount) !== BigInt(stored.chargedCumulativeAmount)
    ) {
      return failSettle(requirements, Errors.ErrCumulativeAmountMismatch);
    }

    const claims = rebuildClaims(stored);
    const attested = claims.length > 0 ? stored.chargeCount : 0;
    const amount = resolveRefundAmount(raw, stored);
    const nonce = String(stored.refundNonce ?? 0);
    const enriched: BatchSettlementEnrichedRefundPayload = {
      ...raw,
      amount,
      refundNonce: nonce,
      claims,
    };
    delete (enriched as { refundAuthorizerSignature?: `0x${string}` }).refundAuthorizerSignature;
    delete (enriched as { claimAuthorizerSignature?: `0x${string}` }).claimAuthorizerSignature;

    const settled = await submitRefund(
      {
        network: requirements.network,
        payload: enriched,
        dataSuffix,
        ...(claims.length > 0 ? { claimDataSuffix: encodeChargeCountsSuffix([attested]) } : {}),
      },
      {
        submitMode: deps.submitMode,
        signer: deps.signer,
        authorizerSigner: deps.authorizerSigner,
        authorizerSubmitter: deps.authorizerSubmitter,
      },
    );
    if (!settled.success) {
      return settled;
    }

    const extraState = settled.extra as { channelState?: Record<string, unknown> } | undefined;
    const balance = String(extraState?.channelState?.balance ?? stored.balance);
    const totalClaimed = String(extraState?.channelState?.totalClaimed ?? stored.totalClaimed);

    const updated = await deps.storage.updateChannel(channelId, current => {
      if (!current) {
        return current;
      }
      const chargeCount = Math.max(0, current.chargeCount - attested);
      const next = {
        ...current,
        balance,
        totalClaimed,
        chargeCount,
        withdrawRequestedAt: Number(extraState?.channelState?.withdrawRequestedAt ?? 0),
        refundNonce: Number(extraState?.channelState?.refundNonce ?? current.refundNonce + 1),
        lastRequestTimestamp: Date.now(),
      };
      const closed = BigInt(balance) <= BigInt(totalClaimed) && chargeCount === 0;
      return closed ? undefined : next;
    });

    return {
      ...settled,
      extra: paymentResponseExtra({
        channelState: {
          ...(typeof extraState?.channelState === "object" ? extraState.channelState : {}),
          chargedCumulativeAmount: stored.chargedCumulativeAmount,
        },
        chargeCount: updated.channel?.chargeCount ?? 0,
      }),
    };
  } finally {
    await releaseAdmission(deps, channelId, owner);
  }
}

/**
 * Validates managed-only requirement fields.
 *
 * @param deps - Store dependencies.
 * @param salt - Channel salt.
 * @param requirements - Payment requirements.
 * @returns Error code, or undefined when valid.
 */
function managedRequirementError(
  deps: VoucherStoreDeps,
  salt: `0x${string}`,
  requirements: PaymentRequirements,
): string | undefined {
  const extra = requirements.extra ?? {};
  const advertised = extra.receiverAuthorizer;
  if (
    typeof advertised !== "string" ||
    !isAddressEqual(getAddress(advertised), getAddress(deps.authorizerSigner.address))
  ) {
    return Errors.ErrReceiverAuthorizerMismatch;
  }
  if (Number(extra.withdrawDelay) !== deps.withdrawDelay) {
    return Errors.ErrWithdrawDelayMismatch;
  }
  const refundAuthorizer = extra.refundAuthorizer;
  if (typeof refundAuthorizer === "string") {
    try {
      if (!isAddressEqual(unpackRefundAuthorizer(salt), getAddress(refundAuthorizer))) {
        return Errors.ErrRefundAuthorizerMismatch;
      }
    } catch {
      return Errors.ErrRefundAuthorizerMismatch;
    }
  }
  return undefined;
}

/**
 * Checks managed refund consent (signature path and/or caller identity).
 *
 * @param deps - Store dependencies.
 * @param payment - Payment envelope.
 * @param raw - Refund payload.
 * @param requirements - Payment requirements.
 * @param context - Facilitator extension context.
 * @param stored - Channel row the caller already read, if any.
 * @returns Error code, or undefined when consent is valid.
 */
async function checkRefundConsent(
  deps: VoucherStoreDeps,
  payment: PaymentPayload,
  raw: BatchSettlementRefundPayload,
  requirements: PaymentRequirements,
  context: FacilitatorContext | undefined,
  stored: FacilitatorChannel | undefined,
): Promise<string | undefined> {
  const amountError = refundAmountError(raw);
  if (amountError) {
    return amountError;
  }
  const extra = requirements.extra ?? {};
  const refundAuthorizer = extra.refundAuthorizer;
  if (typeof refundAuthorizer === "string") {
    try {
      if (
        !isAddressEqual(
          unpackRefundAuthorizer(raw.channelConfig.salt),
          getAddress(refundAuthorizer),
        )
      ) {
        return Errors.ErrRefundAuthorizerMismatch;
      }
    } catch {
      return Errors.ErrRefundAuthorizerMismatch;
    }
    const signature = (raw as BatchSettlementEnrichedRefundPayload).refundAuthorizerSignature;
    if (!signature) {
      return Errors.ErrRefundAuthorizerSignature;
    }
    const amount = resolveRefundAmount(raw, stored);
    const nonce = String(stored?.refundNonce ?? 0);
    try {
      const recovered = await recoverTypedDataAddress({
        domain: getBatchSettlementEip712Domain(getEvmChainId(requirements.network)),
        types: refundTypes,
        primaryType: "Refund",
        message: {
          channelId: raw.voucher.channelId,
          nonce: BigInt(nonce),
          amount: BigInt(amount),
        },
        signature,
      });
      if (!isAddressEqual(recovered, getAddress(refundAuthorizer))) {
        return Errors.ErrRefundAuthorizerSignature;
      }
    } catch {
      return Errors.ErrRefundAuthorizerSignature;
    }
    return undefined;
  }

  if (!deps.resolveCallerIdentity) {
    return Errors.ErrRefundAuthorizerSignature;
  }

  let identity: string | undefined;
  try {
    identity = await resolveIdentity(deps, {
      step: "refund",
      channelId: raw.voucher.channelId,
      network: requirements.network,
      payer: raw.channelConfig.payer,
      payload: payment,
      requirements,
      facilitatorContext: context,
    });
  } catch {
    return Errors.ErrRefundAuthorizerSignature;
  }
  if (!identity) {
    return Errors.ErrRefundAuthorizerSignature;
  }

  const bound = stored?.callerIdentity;
  let storeIdentity: string | undefined;
  try {
    storeIdentity = (
      await deps.delegatedAuthStore?.get(raw.voucher.channelId, requirements.network)
    )?.callerIdentity;
  } catch {
    return Errors.ErrRefundAuthorizerSignature;
  }

  const expected = bound ?? storeIdentity;
  if (!expected || expected !== identity) {
    return Errors.ErrRefundAuthorizerSignature;
  }
  return undefined;
}

/**
 * Resolves caller identity when the hook is configured.
 *
 * @param deps - Store dependencies.
 * @param ctx - Settle identity context.
 * @returns Identity string, or undefined.
 */
async function resolveIdentity(
  deps: VoucherStoreDeps,
  ctx: DelegatedSettleContext,
): Promise<string | undefined> {
  if (!deps.resolveCallerIdentity) {
    return undefined;
  }
  return deps.resolveCallerIdentity(ctx);
}

/**
 * Releases an admission lock, ignoring store errors.
 *
 * @param deps - Store dependencies.
 * @param channelId - Channel id.
 * @param owner - Lock owner.
 */
async function releaseLock(
  deps: VoucherStoreDeps,
  channelId: string,
  owner: string,
): Promise<void> {
  try {
    await deps.lockStorage.release(channelId, owner);
  } catch (err) {
    rethrowLockImplementationError(err);
  }
}

/**
 * Increments `chargeCount` and stamps `network` on a committed record.
 * Callers skip this map when `increment` is `0n`.
 *
 * @param channel - Record after the charge CAS fields are applied.
 * @param network - CAIP-2 network.
 * @returns Updated facilitator channel.
 */
function incrementChargeCount(channel: FacilitatorChannel, network: Network): FacilitatorChannel {
  return {
    ...channel,
    network,
    chargeCount: (channel.chargeCount ?? 0) + 1,
  };
}

/**
 * Builds the deposit charge CAS base the same way self-managed `afterSettle` does.
 *
 * Onchain fields come from {@link settleDeposit}'s confirm snapshot: polled
 * post-tx RPC when the top-up is visible, otherwise optimistic
 * `pre-deposit + deposit.amount` (and the matching pre-deposit `totalClaimed`).
 * Missing confirm fields fall back to the stored row so a failed read does not
 * zero the channel. Offchain charged is the stored watermark, or that same
 * confirm `totalClaimed` when the store has no row. The request charge is
 * applied separately by {@link commitVoucherCharge}.
 *
 * @param raw - Deposit payload.
 * @param requirements - Payment requirements.
 * @param extra - `settleDeposit` response extra.
 * @param stored - Existing store row, if any.
 * @returns Snapshot used as the CAS base.
 */
function depositChargeSnapshot(
  raw: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
  extra: Record<string, unknown> | undefined,
  stored: FacilitatorChannel | undefined,
): FacilitatorChannel {
  const confirmed = readDepositConfirmState(extra);
  return {
    channelId: raw.voucher.channelId,
    channelConfig: stored?.channelConfig ?? raw.channelConfig,
    chargedCumulativeAmount: stored?.chargedCumulativeAmount ?? confirmed.totalClaimed ?? "0",
    signedMaxClaimable: raw.voucher.maxClaimableAmount,
    signature: raw.voucher.signature,
    balance: confirmed.balance ?? stored?.balance ?? "0",
    totalClaimed: confirmed.totalClaimed ?? stored?.totalClaimed ?? "0",
    withdrawRequestedAt: confirmed.withdrawRequestedAt ?? stored?.withdrawRequestedAt ?? 0,
    refundNonce: confirmed.refundNonce ?? stored?.refundNonce ?? 0,
    lastRequestTimestamp: stored?.lastRequestTimestamp ?? Date.now(),
    network: stored?.network ?? requirements.network,
    chargeCount: stored?.chargeCount ?? 0,
    callerIdentity: stored?.callerIdentity,
  };
}

/**
 * Reads onchain fields from `settleDeposit`'s confirm extra.
 *
 * Accepts nested `channelState` (settle) or a flat extra (verify-shaped).
 * Omits a field when it is absent or not a non-negative integer so callers
 * can fall back to the stored row.
 *
 * @param extra - Settle response extra.
 * @returns Present confirm fields only.
 */
function readDepositConfirmState(extra: Record<string, unknown> | undefined): {
  balance?: string;
  totalClaimed?: string;
  withdrawRequestedAt?: number;
  refundNonce?: number;
} {
  const state =
    extra && typeof extra.channelState === "object" && extra.channelState !== null
      ? (extra.channelState as Record<string, unknown>)
      : (extra ?? {});
  return {
    balance: optionalUintString(state.balance),
    totalClaimed: optionalUintString(state.totalClaimed),
    withdrawRequestedAt: optionalUintNumber(state.withdrawRequestedAt),
    refundNonce: optionalUintNumber(state.refundNonce),
  };
}

/**
 * Parses a non-negative integer extra field to a decimal string.
 *
 * @param value - Extra field value.
 * @returns Decimal string, or undefined when missing/invalid.
 */
function optionalUintString(value: unknown): string | undefined {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return String(value);
  return undefined;
}

/**
 * Parses a non-negative integer extra field to a number.
 *
 * @param value - Extra field value.
 * @returns Number, or undefined when missing/invalid.
 */
function optionalUintNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/**
 * Builds a snapshot from onchain state when the store has no row.
 *
 * @param deps - Store dependencies.
 * @param raw - Voucher payload.
 * @param requirements - Payment requirements.
 * @returns Provisional facilitator channel.
 */
async function provisionalFromOnchain(
  deps: VoucherStoreDeps,
  raw: BatchSettlementVoucherPayload,
  requirements: PaymentRequirements,
): Promise<FacilitatorChannel> {
  const state = await readChannelState(deps.signer, raw.voucher.channelId);
  return {
    channelId: raw.voucher.channelId,
    channelConfig: raw.channelConfig,
    chargedCumulativeAmount: state.totalClaimed.toString(),
    signedMaxClaimable: raw.voucher.maxClaimableAmount,
    signature: raw.voucher.signature,
    balance: state.balance.toString(),
    totalClaimed: state.totalClaimed.toString(),
    withdrawRequestedAt: state.withdrawRequestedAt,
    refundNonce: Number(state.refundNonce),
    lastRequestTimestamp: Date.now(),
    network: requirements.network,
    chargeCount: 0,
  };
}

/**
 * Rebuilds the refund claim list from the stored voucher.
 *
 * @param stored - Authoritative channel record.
 * @returns Claim entries, or empty when nothing is unclaimed.
 */
function rebuildClaims(stored: FacilitatorChannel): BatchSettlementVoucherClaim[] {
  if (BigInt(stored.chargedCumulativeAmount) <= BigInt(stored.totalClaimed)) {
    return [];
  }
  return [
    {
      voucher: {
        channel: stored.channelConfig,
        maxClaimableAmount: stored.signedMaxClaimable,
      },
      signature: stored.signature as `0x${string}`,
      totalClaimed: stored.chargedCumulativeAmount,
    },
  ];
}

/**
 * Returns `invalid_batch_settlement_evm_refund_amount_invalid` when an explicit
 * refund `amount` is present but not a positive integer. Omitted `amount`
 * (full refund) is valid and resolves to the remainder downstream.
 *
 * @param raw - Refund payload that may carry an explicit amount.
 * @param raw.amount - Explicit refund amount as a decimal string, when set.
 * @returns Error code, or undefined when the amount is omitted or valid.
 */
function refundAmountError(raw: { amount?: unknown }): string | undefined {
  if (raw.amount === undefined) {
    return undefined;
  }
  if (typeof raw.amount !== "string" || !/^\d+$/.test(raw.amount)) {
    return Errors.ErrRefundAmountInvalid;
  }
  try {
    if (BigInt(raw.amount) <= 0n) {
      return Errors.ErrRefundAmountInvalid;
    }
  } catch {
    return Errors.ErrRefundAmountInvalid;
  }
  return undefined;
}

/**
 * Resolves the refund amount from the payload or the remaining unclaimed escrow.
 * Callers must run {@link refundAmountError} first; this assumes an omitted or
 * positive-integer amount.
 *
 * @param raw - Refund payload.
 * @param stored - Stored channel, if any.
 * @returns Decimal amount string.
 */
function resolveRefundAmount(
  raw: BatchSettlementRefundPayload,
  stored: FacilitatorChannel | undefined,
): string {
  if (raw.amount !== undefined && /^\d+$/.test(raw.amount)) {
    return raw.amount;
  }
  if (!stored) {
    return "0";
  }
  const remainder = BigInt(stored.balance) - BigInt(stored.chargedCumulativeAmount);
  return remainder > 0n ? remainder.toString() : "0";
}

/**
 * Reads onchain `totalClaimed` from a verify extra blob.
 *
 * @param extra - Verify response extra.
 * @returns Decimal string.
 */
function readExtraTotalClaimed(extra: Record<string, unknown> | undefined): string {
  const value = extra?.totalClaimed;
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return String(value);
  return "0";
}

/**
 * Builds a corrective channel snapshot for a watermark mismatch.
 *
 * @param channelId - Channel id.
 * @param extra - Verify extra (onchain fields).
 * @param stored - Stored record, if any.
 * @param charged - Current watermark.
 * @returns Corrective channelState object.
 */
function mismatchChannelState(
  channelId: string,
  extra: Record<string, unknown> | undefined,
  stored: FacilitatorChannel | undefined,
  charged: string,
) {
  return channelStateExtra(
    {
      channelId,
      balance: stored?.balance ?? String(extra?.balance ?? "0"),
      totalClaimed: stored?.totalClaimed ?? String(extra?.totalClaimed ?? "0"),
      withdrawRequestedAt: stored?.withdrawRequestedAt ?? Number(extra?.withdrawRequestedAt ?? 0),
      refundNonce: stored?.refundNonce ?? Number(extra?.refundNonce ?? 0),
    },
    charged,
  );
}

/**
 * Builds a failed settle response.
 *
 * @param requirements - Payment requirements.
 * @param errorReason - Error code.
 * @returns Failed settle response.
 */
function failSettle(requirements: PaymentRequirements, errorReason: string): SettleResponse {
  return {
    success: false,
    errorReason,
    transaction: "",
    network: requirements.network,
  };
}
