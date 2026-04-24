import { decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements, SettleResponse } from "@x402/core/types";
import { getAddress } from "viem";
import type { ClientEvmSigner } from "../../signer";
import { batchSettlementABI } from "../abi";
import { BATCH_SETTLEMENT_ADDRESS, MIN_WITHDRAW_DELAY } from "../constants";
import type { BatchSettlementPaymentRequirementsExtra, ChannelConfig } from "../types";
import { computeChannelId } from "../utils";
import type { BatchSettlementClientContext, ClientSessionStorage } from "./storage";

/**
 * Runtime dependency bag shared by every storage-bound client helper (session,
 * recovery, refund) and the {@link BatchSettlementEvmScheme} class. Carries the
 * live signer + storage plus the channel-id inputs (`salt`, `payerAuthorizer`,
 * optional separate `voucherSigner`).
 */
export interface BatchSettlementClientDeps {
  signer: ClientEvmSigner;
  storage: ClientSessionStorage;
  salt: `0x${string}`;
  payerAuthorizer?: `0x${string}`;
  voucherSigner?: ClientEvmSigner;
}

/**
 * Constructs the immutable {@link ChannelConfig} from payment requirements and
 * a client deps bag (signer, salt, optional payerAuthorizer / voucherSigner).
 *
 * @param deps - Client identity inputs.
 * @param paymentRequirements - Server payment requirements providing receiver, asset, and extra fields.
 * @returns The ChannelConfig that uniquely identifies this payment channel.
 */
export function buildChannelConfig(
  deps: BatchSettlementClientDeps,
  paymentRequirements: PaymentRequirements,
): ChannelConfig {
  const extra = paymentRequirements.extra as
    | Partial<BatchSettlementPaymentRequirementsExtra>
    | undefined;
  return {
    payer: deps.signer.address,
    payerAuthorizer: getAddress(
      deps.payerAuthorizer ?? deps.voucherSigner?.address ?? deps.signer.address,
    ),
    receiver: paymentRequirements.payTo as `0x${string}`,
    receiverAuthorizer:
      extra?.receiverAuthorizer ?? ("0x0000000000000000000000000000000000000000" as `0x${string}`),
    token: paymentRequirements.asset as `0x${string}`,
    withdrawDelay:
      typeof extra?.withdrawDelay === "number" ? extra.withdrawDelay : MIN_WITHDRAW_DELAY,
    salt: deps.salt,
  };
}

/**
 * Updates local session state from a parsed `SettleResponse`.
 *
 * @param storage - Client session storage.
 * @param settle - The parsed settle response.
 */
export async function processSettleResponse(
  storage: ClientSessionStorage,
  settle: SettleResponse,
): Promise<void> {
  const extra = settle.extra ?? {};
  const channelId =
    typeof extra.channelId === "string" && extra.channelId ? extra.channelId : undefined;
  if (!channelId) return;

  const key = channelId.toLowerCase();

  if (extra.refund === true) {
    await updateSessionAfterRefund(storage, key, extra);
    return;
  }

  const prev = await storage.get(key);
  const next: BatchSettlementClientContext = { ...(prev ?? {}) };

  if (extra.chargedCumulativeAmount !== undefined) {
    next.chargedCumulativeAmount = String(extra.chargedCumulativeAmount);
  }
  if (extra.balance !== undefined) {
    next.balance = String(extra.balance);
  }
  if (extra.totalClaimed !== undefined) {
    next.totalClaimed = String(extra.totalClaimed);
  }

  await storage.set(key, next);
}

/**
 * Reconciles local session state with the outcome of a cooperative refund.
 *
 * Deletes the session when the post-refund balance is zero (full refund),
 * otherwise updates `balance`, `chargedCumulativeAmount`, and `totalClaimed`
 * from the server snapshot (partial refund — channel stays open).
 *
 * @param storage - Client session storage.
 * @param channelKey - Lowercased channel id used as the storage key.
 * @param settleExtra - The `extra` block from the refund settle response.
 */
export async function updateSessionAfterRefund(
  storage: ClientSessionStorage,
  channelKey: string,
  settleExtra: Record<string, unknown>,
): Promise<void> {
  const balanceAfter =
    settleExtra.balance !== undefined ? BigInt(String(settleExtra.balance)) : undefined;

  if (balanceAfter === undefined || balanceAfter <= 0n) {
    await storage.delete(channelKey);
    return;
  }

  const prev = await storage.get(channelKey);
  const next: BatchSettlementClientContext = { ...(prev ?? {}) };
  next.balance = balanceAfter.toString();
  if (settleExtra.chargedCumulativeAmount !== undefined) {
    next.chargedCumulativeAmount = String(settleExtra.chargedCumulativeAmount);
  }
  if (settleExtra.totalClaimed !== undefined) {
    next.totalClaimed = String(settleExtra.totalClaimed);
  }
  await storage.set(channelKey, next);
}

/**
 * Processes the `PAYMENT-RESPONSE` header after a successful request.
 *
 * Decodes the header into a `SettleResponse` and delegates to
 * {@link processSettleResponse}.
 *
 * @param storage - Client session storage.
 * @param getHeader - Function to retrieve a response header by name.
 */
export async function processPaymentResponse(
  storage: ClientSessionStorage,
  getHeader: (name: string) => string | null | undefined,
): Promise<void> {
  const raw = getHeader("PAYMENT-RESPONSE");
  if (!raw) return;

  const settle = decodePaymentResponseHeader(raw);
  await processSettleResponse(storage, settle);
}

/**
 * Recovers a channel session from on-chain state (useful after a cold start or
 * session loss).
 *
 * @param deps - Signer + storage + identity inputs.
 * @param paymentRequirements - Server payment requirements used to derive the ChannelConfig.
 * @returns The recovered client context.
 */
export async function recoverSession(
  deps: BatchSettlementClientDeps,
  paymentRequirements: PaymentRequirements,
): Promise<BatchSettlementClientContext> {
  if (!deps.signer.readContract) {
    throw new Error("recoverSession requires ClientEvmSigner.readContract");
  }

  const config = buildChannelConfig(deps, paymentRequirements);
  const channelId = computeChannelId(config);

  const [chBalance, chTotalClaimed] = await readChannelBalanceAndTotalClaimed(
    deps.signer,
    channelId,
  );

  const ctx: BatchSettlementClientContext = {
    chargedCumulativeAmount: chTotalClaimed.toString(),
    balance: chBalance.toString(),
    totalClaimed: chTotalClaimed.toString(),
  };

  await deps.storage.set(channelId.toLowerCase(), ctx);
  return ctx;
}

/**
 * Reads `channels(channelId)` returning `[balance, totalClaimed]`.
 *
 * @param signer - Signer providing `readContract`.
 * @param channelId - The `bytes32` channel id to query.
 * @returns Tuple of `[balance, totalClaimed]` as bigints.
 */
export async function readChannelBalanceAndTotalClaimed(
  signer: ClientEvmSigner,
  channelId: `0x${string}`,
): Promise<[bigint, bigint]> {
  if (!signer.readContract) {
    throw new Error("readChannelBalanceAndTotalClaimed requires ClientEvmSigner.readContract");
  }
  return (await signer.readContract({
    address: BATCH_SETTLEMENT_ADDRESS,
    abi: batchSettlementABI,
    functionName: "channels",
    args: [channelId],
  })) as [bigint, bigint];
}

/**
 * Returns whether a local session exists for the given channel.
 *
 * @param storage - Client session storage.
 * @param channelId - The channel identifier to check.
 * @returns `true` when a session is stored for the channel.
 */
export async function hasSession(
  storage: ClientSessionStorage,
  channelId: string,
): Promise<boolean> {
  const session = await storage.get(channelId.toLowerCase());
  return session !== undefined;
}

/**
 * Returns the local session context for a channel, if present.
 *
 * @param storage - Client session storage.
 * @param channelId - The channel identifier.
 * @returns Stored context or `undefined`.
 */
export async function getSession(
  storage: ClientSessionStorage,
  channelId: string,
): Promise<BatchSettlementClientContext | undefined> {
  return storage.get(channelId.toLowerCase());
}
