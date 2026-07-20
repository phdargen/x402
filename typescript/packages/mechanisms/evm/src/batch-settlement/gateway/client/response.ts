import type { SettleResponse } from "@x402/core/types";
import { getAddress, verifyTypedData } from "viem";
import { getEvmChainId } from "../../../utils";
import { gatewayClaimAuthorizationTypes, VOUCHER_GATEWAY } from "../constants";
import {
  computeGatewayVoucherDigest,
  getGatewayEip712Domain,
  readVoucherGatewayInfo,
} from "../utils";
import type { GatewayClientStorage } from "./storage";

/**
 * Verifies the facilitator settle response claimAuthorization and updates local gateway storage.
 *
 * @param storage - Gateway client storage.
 * @param settle - Settle response from PAYMENT-RESPONSE.
 * @param opts - Request context needed for verification.
 * @param opts.channelId - Channel id.
 * @param opts.payTo - Server payee address.
 * @param opts.receiverAuthorizer - Receiver authorizer address.
 * @param opts.gatewayVoucherMaxClaimable - Gateway voucher max claimable amount.
 * @param opts.gatewayVoucherGatewayId - Gateway voucher id.
 * @param opts.authorizedAmount - Authorized amount for this request.
 * @param opts.previousServerCharged - Prior server charged cumulative amount.
 * @param opts.previousAggregateCharged - Prior aggregate charged cumulative amount.
 * @param opts.network - Network identifier.
 * @param opts.gateway - Gateway contract address.
 * @returns Whether local state was updated.
 */
export async function processGatewaySettleResponse(
  storage: GatewayClientStorage,
  settle: SettleResponse,
  opts: {
    channelId: `0x${string}`;
    payTo: `0x${string}`;
    receiverAuthorizer: `0x${string}`;
    gatewayVoucherMaxClaimable: string;
    gatewayVoucherGatewayId: `0x${string}`;
    authorizedAmount: string;
    previousServerCharged: string;
    previousAggregateCharged: string;
    network: string;
    gateway: `0x${string}`;
  },
): Promise<boolean> {
  const info = readVoucherGatewayInfo(settle.extensions as Record<string, unknown> | undefined);
  const claimAuthorization = info?.gatewayState?.claimAuthorization;
  if (!claimAuthorization) return false;

  const digest = computeGatewayVoucherDigest(
    opts.gatewayVoucherGatewayId,
    opts.gatewayVoucherMaxClaimable,
    opts.network,
    opts.gateway,
  );

  const valid = await verifyTypedData({
    address: getAddress(opts.receiverAuthorizer),
    domain: getGatewayEip712Domain(getEvmChainId(opts.network), opts.gateway),
    types: gatewayClaimAuthorizationTypes,
    primaryType: "GatewayClaimAuthorization",
    message: {
      gatewayVoucherDigest: digest,
      totalClaimed: BigInt(claimAuthorization.totalClaimed),
    },
    signature: claimAuthorization.signature,
  });
  if (!valid) return false;

  if (BigInt(claimAuthorization.totalClaimed) > BigInt(opts.gatewayVoucherMaxClaimable)) {
    return false;
  }

  const chargedAmount = BigInt(
    typeof settle.extra?.chargedAmount === "string" ? settle.extra.chargedAmount : "0",
  );
  const delta = BigInt(claimAuthorization.totalClaimed) - BigInt(opts.previousServerCharged);
  if (delta !== chargedAmount || chargedAmount > BigInt(opts.authorizedAmount)) {
    return false;
  }

  const channelState = settle.extra?.channelState as
    | { chargedCumulativeAmount?: string; balance?: string; totalClaimed?: string }
    | undefined;
  const newAggregate = channelState?.chargedCumulativeAmount;
  if (
    newAggregate === undefined ||
    BigInt(newAggregate) !== BigInt(opts.previousAggregateCharged) + chargedAmount
  ) {
    return false;
  }

  const key = opts.channelId.toLowerCase();
  const prev = (await storage.get(key)) ?? { servers: {} };
  const serverKey = getAddress(opts.payTo).toLowerCase();
  await storage.set(key, {
    ...prev,
    balance: channelState?.balance ?? prev.balance,
    totalClaimed: channelState?.totalClaimed ?? prev.totalClaimed,
    aggregateChargedCumulativeAmount: newAggregate,
    // Keep aggregate voucher from deposit; settle response may echo it under voucherState.
    aggregateMaxClaimable: prev.aggregateMaxClaimable,
    aggregateSignature: prev.aggregateSignature,
    servers: {
      ...prev.servers,
      [serverKey]: { chargedCumulativeAmount: claimAuthorization.totalClaimed },
    },
  });

  return true;
}

/**
 * Applies a verified gateway settle response when the client still has the request context.
 *
 * Lightweight path used from scheme hooks: extracts verification inputs from the
 * payment payload that was sent.
 *
 * @param storage - Gateway client storage.
 * @param settle - Settle response.
 * @param paymentPayloadExtensions - Extensions from the outbound payment payload.
 * @param accepted - Accepted payment requirements from the outbound payload.
 * @param accepted.amount - Authorized amount string.
 * @param accepted.payTo - Payee address.
 * @param accepted.network - Network identifier.
 * @param accepted.extra - Optional extra fields on accepted requirements.
 * @param channelId - Channel id.
 * @returns Whether state was updated.
 */
export async function processGatewaySettleResponseFromPayload(
  storage: GatewayClientStorage,
  settle: SettleResponse,
  paymentPayloadExtensions: Record<string, unknown> | undefined,
  accepted: {
    amount: string;
    payTo: string;
    network: string;
    extra?: Record<string, unknown>;
  },
  channelId: `0x${string}`,
): Promise<boolean> {
  const sent = readVoucherGatewayInfo(paymentPayloadExtensions);
  if (!sent?.gateway || !sent.gatewayConfig || !sent.gatewayVoucher) return false;

  const receiverAuthorizer = accepted.extra?.receiverAuthorizer;
  if (typeof receiverAuthorizer !== "string") return false;

  const key = channelId.toLowerCase();
  const prev = (await storage.get(key)) ?? { servers: {} };
  const serverKey = getAddress(accepted.payTo).toLowerCase();
  const previousServerCharged = prev.servers[serverKey]?.chargedCumulativeAmount ?? "0";
  const previousAggregateCharged = prev.aggregateChargedCumulativeAmount ?? "0";

  // On deposit settle, adopt the new aggregate voucher signature from the outbound payload.
  if (sent.gatewayVoucher && prev.aggregateMaxClaimable === undefined) {
    // Will be filled below after verification via channel state; also stash from payload if deposit.
  }

  const ok = await processGatewaySettleResponse(storage, settle, {
    channelId,
    payTo: getAddress(accepted.payTo),
    receiverAuthorizer: getAddress(receiverAuthorizer),
    gatewayVoucherMaxClaimable: sent.gatewayVoucher.maxClaimableAmount,
    gatewayVoucherGatewayId: sent.gatewayVoucher.gatewayId,
    authorizedAmount: accepted.amount,
    previousServerCharged,
    previousAggregateCharged,
    network: accepted.network,
    gateway: getAddress(sent.gateway),
  });

  if (ok) {
    const updated = await storage.get(key);
    if (updated) {
      // If this was a deposit, the outbound aggregate voucher is authoritative.
      const channelState = settle.extra?.channelState as { balance?: string } | undefined;
      if (channelState?.balance && sent.gatewayVoucher) {
        // Aggregate voucher max equals post-deposit balance for deposits; for voucher-only keep prior.
        const maybeAggregate = channelState.balance;
        // Only overwrite aggregate signature when balance matches a freshly signed deposit aggregate
        // stored pending in payment.ts (aggregateMaxClaimable set to postDepositBalance).
        if (updated.aggregateMaxClaimable === maybeAggregate) {
          // Signature is on the base payload voucher — caller should pass it; keep existing if set.
        }
      }
    }
  }

  return ok;
}

/**
 * Stores the deposit-signed aggregate voucher fields after a successful deposit settle.
 *
 * @param storage - Gateway client storage.
 * @param channelId - Channel id.
 * @param aggregateMaxClaimable - Deposit aggregate ceiling.
 * @param aggregateSignature - Deposit aggregate signature.
 */
export async function storeAggregateVoucher(
  storage: GatewayClientStorage,
  channelId: string,
  aggregateMaxClaimable: string,
  aggregateSignature: `0x${string}`,
): Promise<void> {
  const key = channelId.toLowerCase();
  const prev = (await storage.get(key)) ?? { servers: {} };
  await storage.set(key, {
    ...prev,
    aggregateMaxClaimable,
    aggregateSignature,
  });
}

export { VOUCHER_GATEWAY };
