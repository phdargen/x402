import type { FacilitatorContext, PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { getAddress, isAddressEqual, recoverTypedDataAddress } from "viem";
import { refundTypes } from "../constants";
import * as Errors from "../errors";
import type { DelegatedAuthStore } from "../storage/delegatedAuth";
import type { BatchSettlementEnrichedRefundPayload, BatchSettlementRefundPayload } from "../types";
import { getBatchSettlementEip712Domain, unpackRefundAuthorizer } from "../utils";
import { getEvmChainId } from "../../utils";
import type { ResolveCallerIdentity } from "./types";

/** Dependencies for {@link checkDelegatedRefundConsent}. */
export type RefundConsentDeps = {
  resolveCallerIdentity?: ResolveCallerIdentity;
  delegatedAuthStore?: DelegatedAuthStore;
};

/**
 * Drops client-supplied authorizer signatures so the facilitator signs the onchain `Refund` and
 * `ClaimBatch` digests itself. Call only after consent has been established, otherwise
 * `refundWithSignature` would be submitted with a signature the contract rejects.
 *
 * @param payload - Enriched refund payload.
 * @returns A copy without `refundAuthorizerSignature` / `claimAuthorizerSignature`.
 */
export function stripAuthorizerSignatures(
  payload: BatchSettlementEnrichedRefundPayload,
): BatchSettlementEnrichedRefundPayload {
  const {
    refundAuthorizerSignature: _refundAuthorizerSignature,
    claimAuthorizerSignature: _claimAuthorizerSignature,
    ...rest
  } = payload;
  void _refundAuthorizerSignature;
  void _claimAuthorizerSignature;
  return rest;
}

/**
 * Checks the server's consent to a facilitator-managed cooperative refund (always the case in facilitator-managed mode).
 *
 * Consent is selected by the 402's `extra.refundAuthorizer`:
 * - Absent: the server relies on the facilitator's `delegatedRefund`. The `/settle` caller must
 *   resolve to the identity bound to the channel at deposit. No signature is expected.
 * - Present: let R be the refund authorizer unpacked from `channelConfig.salt`. R must equal
 *   `extra.refundAuthorizer` (`ErrRefundAuthorizerMismatch`), and `refundAuthorizerSignature` must
 *   recover to R over the EIP-712 `Refund` digest.
 *
 * @param deps - Caller-identity wiring.
 * @param payment - Payment envelope.
 * @param raw - Refund payload (possibly carrying `refundAuthorizerSignature`).
 * @param refund - Refund amount and onchain nonce the digest is signed over.
 * @param refund.amount - Refund amount in atomic units.
 * @param refund.nonce - Onchain refund nonce.
 * @param requirements - Payment requirements.
 * @param context - Facilitator extension context.
 * @returns Error code, or undefined when consent is valid.
 */
export async function checkDelegatedRefundConsent(
  deps: RefundConsentDeps,
  payment: PaymentPayload,
  raw: BatchSettlementRefundPayload & { refundAuthorizerSignature?: `0x${string}` },
  refund: { amount: string; nonce: string },
  requirements: PaymentRequirements,
  context: FacilitatorContext | undefined,
): Promise<string | undefined> {
  const advertised = requirements.extra?.refundAuthorizer;
  if (typeof advertised !== "string" || advertised === "") {
    return checkCallerIdentity(deps, payment, raw, refund.amount, requirements, context);
  }

  let channelRefundAuthorizer: `0x${string}`;
  try {
    channelRefundAuthorizer = unpackRefundAuthorizer(raw.channelConfig.salt);
    if (!isAddressEqual(channelRefundAuthorizer, getAddress(advertised))) {
      return Errors.ErrRefundAuthorizerMismatch;
    }
  } catch {
    return Errors.ErrRefundAuthorizerMismatch;
  }

  return checkRefundSignature(raw, refund, channelRefundAuthorizer, requirements);
}

/**
 * Requires `refundAuthorizerSignature` to recover to the channel's refund authorizer.
 *
 * @param raw - Refund payload.
 * @param refund - Refund amount and onchain nonce.
 * @param refund.amount - Refund amount in atomic units.
 * @param refund.nonce - Onchain refund nonce.
 * @param refundAuthorizer - Address unpacked from the channel salt.
 * @param requirements - Payment requirements (network for the EIP-712 domain).
 * @returns Error code, or undefined when the signature is valid.
 */
async function checkRefundSignature(
  raw: BatchSettlementRefundPayload & { refundAuthorizerSignature?: `0x${string}` },
  refund: { amount: string; nonce: string },
  refundAuthorizer: `0x${string}`,
  requirements: PaymentRequirements,
): Promise<string | undefined> {
  const signature = raw.refundAuthorizerSignature;
  if (!signature) {
    return Errors.ErrRefundAuthorizerSignature;
  }
  try {
    const recovered = await recoverTypedDataAddress({
      domain: getBatchSettlementEip712Domain(getEvmChainId(requirements.network)),
      types: refundTypes,
      primaryType: "Refund",
      message: {
        channelId: raw.voucher.channelId,
        nonce: BigInt(refund.nonce),
        amount: BigInt(refund.amount),
      },
      signature,
    });
    if (!isAddressEqual(recovered, refundAuthorizer)) {
      return Errors.ErrRefundAuthorizerSignature;
    }
  } catch {
    return Errors.ErrRefundAuthorizerSignature;
  }
  return undefined;
}

/**
 * Requires the `/settle` caller to resolve to the identity bound to the channel at deposit.
 * Missing hooks, bindings, store errors and identity mismatches all fail closed.
 *
 * @param deps - Caller-identity wiring.
 * @param payment - Payment envelope.
 * @param raw - Refund payload.
 * @param amount - Refund amount in atomic units.
 * @param requirements - Payment requirements.
 * @param context - Facilitator extension context.
 * @returns Error code, or undefined when the caller is the channel's bound caller.
 */
async function checkCallerIdentity(
  deps: RefundConsentDeps,
  payment: PaymentPayload,
  raw: BatchSettlementRefundPayload,
  amount: string,
  requirements: PaymentRequirements,
  context: FacilitatorContext | undefined,
): Promise<string | undefined> {
  if (!deps.resolveCallerIdentity || !deps.delegatedAuthStore) {
    return Errors.ErrRefundAuthorizerSignature;
  }

  let identity: string | undefined;
  try {
    identity = await deps.resolveCallerIdentity({
      abortSignal: undefined,
      step: "refund",
      channelId: raw.voucher.channelId,
      network: requirements.network,
      payer: raw.channelConfig.payer,
      amount,
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

  let boundIdentity: string | undefined;
  try {
    boundIdentity = (await deps.delegatedAuthStore.get(raw.voucher.channelId, requirements.network))
      ?.callerIdentity;
  } catch {
    return Errors.ErrRefundAuthorizerSignature;
  }
  if (!boundIdentity || boundIdentity !== identity) {
    return Errors.ErrRefundAuthorizerSignature;
  }
  return undefined;
}
