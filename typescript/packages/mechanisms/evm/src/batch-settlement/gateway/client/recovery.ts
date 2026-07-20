import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { getAddress, recoverTypedDataAddress, verifyTypedData } from "viem";
import { getEvmChainId } from "../../../utils";
import { BATCH_SETTLEMENT_SCHEME, voucherTypes } from "../../constants";
import { readChannelBalanceAndTotalClaimed } from "../../client/channel";
import { computeChannelId, getBatchSettlementEip712Domain } from "../../utils";
import { batchSettlementGatewayABI } from "../abi";
import { gatewayClaimAuthorizationTypes } from "../constants";
import * as GwErrors from "../errors";
import type { GatewayClaimAuthorization, GatewayStateInfo } from "../types";
import {
  computeGatewayVoucherDigest,
  getGatewayEip712Domain,
  readVoucherGatewayInfo,
} from "../utils";
import { buildGatewayChannelConfig, type GatewayClientPaymentDeps } from "./deps";
import type { GatewayClientChannelContext, GatewayClientStorage } from "./storage";

/**
 * Handles a corrective 402 when the client's per-server cumulative is out of sync.
 *
 * Mirrors base {@link processCorrectivePaymentRequired}: gate on gateway corrective
 * error codes, prefer signed proofs from the 402, otherwise baseline from onchain
 * `distributedCumulative` / channel state.
 *
 * @param deps - Gateway client deps (signer + gateway storage).
 * @param paymentRequired - The decoded 402 response body.
 * @returns `true` if local state was resynced and the request can be retried.
 */
export async function processGatewayCorrectivePaymentRequired(
  deps: GatewayClientPaymentDeps,
  paymentRequired: PaymentRequired,
): Promise<boolean> {
  if (
    paymentRequired.error !== GwErrors.ErrCumulativeMismatch &&
    paymentRequired.error !== GwErrors.ErrReceiverCumulativeBelowDistributed
  ) {
    return false;
  }

  const accept = paymentRequired.accepts.find(a => a.scheme === BATCH_SETTLEMENT_SCHEME);
  if (!accept) {
    return false;
  }

  const info = readVoucherGatewayInfo(
    paymentRequired.extensions as Record<string, unknown> | undefined,
  );
  if (!info?.gateway) {
    return false;
  }

  const channelState = accept.extra?.channelState as
    | {
        channelId?: string;
        balance?: string;
        totalClaimed?: string;
        chargedCumulativeAmount?: string;
      }
    | undefined;
  const voucherState = accept.extra?.voucherState as
    | { signedMaxClaimable?: string; signature?: `0x${string}` }
    | undefined;
  const gatewayState = info.gatewayState;

  const hasSigProofs =
    (voucherState?.signedMaxClaimable !== undefined && voucherState.signature !== undefined) ||
    gatewayState?.claimAuthorization !== undefined;

  if (!hasSigProofs) {
    return recoverGatewayFromOnChainState(deps, accept, info.gateway, gatewayState);
  }

  return recoverGatewayFromSignature(
    deps,
    accept,
    info.gateway,
    channelState,
    voucherState,
    gatewayState,
  );
}

/**
 * Recovers gateway client state from a corrective 402 that includes signed proofs.
 *
 * @param deps - Gateway client deps.
 * @param accept - Matching payment requirements.
 * @param gateway - Gateway contract address.
 * @param channelState - Optional channel snapshot from accepts[].extra.
 * @param voucherState - Optional deposit-signed aggregate voucher proof.
 * @param gatewayState - Optional per-server gateway state from the extension.
 * @returns Whether local state was updated.
 */
async function recoverGatewayFromSignature(
  deps: GatewayClientPaymentDeps,
  accept: PaymentRequirements,
  gateway: `0x${string}`,
  channelState:
    | {
        channelId?: string;
        balance?: string;
        totalClaimed?: string;
        chargedCumulativeAmount?: string;
      }
    | undefined,
  voucherState: { signedMaxClaimable?: string; signature?: `0x${string}` } | undefined,
  gatewayState: GatewayStateInfo | undefined,
): Promise<boolean> {
  const config = buildGatewayChannelConfig(deps, accept, getAddress(gateway));
  const channelId = (channelState?.channelId ??
    computeChannelId(config, accept.network)) as `0x${string}`;

  if (voucherState?.signedMaxClaimable !== undefined && voucherState.signature !== undefined) {
    const signed = BigInt(voucherState.signedMaxClaimable);
    const chainId = getEvmChainId(accept.network);
    const recovered = await recoverTypedDataAddress({
      domain: getBatchSettlementEip712Domain(chainId),
      types: voucherTypes,
      primaryType: "Voucher",
      message: {
        channelId,
        maxClaimableAmount: signed,
      },
      signature: voucherState.signature,
    });
    const expectedSigner = getAddress(
      deps.payerAuthorizer ?? deps.voucherSigner?.address ?? deps.signer.address,
    );
    if (recovered.toLowerCase() !== expectedSigner.toLowerCase()) {
      return false;
    }
  }

  const claimAuthorization = gatewayState?.claimAuthorization;
  const perServerVoucher = gatewayState?.voucherState;
  let verifiedClaim: GatewayClaimAuthorization | undefined;
  if (claimAuthorization && perServerVoucher && gatewayState) {
    const receiverAuthorizer = accept.extra?.receiverAuthorizer;
    if (typeof receiverAuthorizer !== "string") {
      return false;
    }
    const digest = computeGatewayVoucherDigest(
      gatewayState.gatewayId,
      perServerVoucher.maxClaimableAmount,
      accept.network,
      getAddress(gateway),
    );
    const claimOk = await verifyTypedData({
      address: getAddress(receiverAuthorizer),
      domain: getGatewayEip712Domain(getEvmChainId(accept.network), getAddress(gateway)),
      types: gatewayClaimAuthorizationTypes,
      primaryType: "GatewayClaimAuthorization",
      message: {
        gatewayVoucherDigest: digest,
        totalClaimed: BigInt(claimAuthorization.totalClaimed),
      },
      signature: claimAuthorization.signature,
    });
    if (!claimOk) {
      return false;
    }
    if (BigInt(claimAuthorization.totalClaimed) > BigInt(perServerVoucher.maxClaimableAmount)) {
      return false;
    }
    verifiedClaim = claimAuthorization;
  }

  if (deps.signer.readContract) {
    const distributed = await readDistributedCumulative(
      deps,
      getAddress(gateway),
      channelId,
      getAddress(accept.payTo),
    );
    const chargedBaseline = verifiedClaim ? BigInt(verifiedClaim.totalClaimed) : distributed;
    if (chargedBaseline < distributed) {
      return false;
    }
  }

  return writeGatewayRecoveryState(deps.gatewayStorage, {
    channelId,
    accept,
    channelState,
    voucherState,
    claimAuthorization: verifiedClaim,
    gatewayState,
    deps,
    gateway: getAddress(gateway),
  });
}

/**
 * Recovers gateway client state from onchain baselines when proofs are absent.
 *
 * @param deps - Gateway client deps.
 * @param accept - Matching payment requirements.
 * @param gateway - Gateway contract address.
 * @param gatewayState - Optional gateway state (may still carry distributedCumulative).
 * @returns Whether local state was updated.
 */
async function recoverGatewayFromOnChainState(
  deps: GatewayClientPaymentDeps,
  accept: PaymentRequirements,
  gateway: `0x${string}`,
  gatewayState: GatewayStateInfo | undefined,
): Promise<boolean> {
  if (!deps.signer.readContract) {
    return false;
  }

  const config = buildGatewayChannelConfig(deps, accept, getAddress(gateway));
  const channelId = computeChannelId(config, accept.network);

  const [chBalance, chTotalClaimed] = await readChannelBalanceAndTotalClaimed(
    deps.signer,
    channelId,
  );
  const distributed = await readDistributedCumulative(
    deps,
    getAddress(gateway),
    channelId,
    getAddress(accept.payTo),
  );

  const fromWire =
    gatewayState?.distributedCumulative !== undefined
      ? BigInt(gatewayState.distributedCumulative)
      : undefined;
  const serverCharged = fromWire !== undefined && fromWire > distributed ? fromWire : distributed;

  const key = channelId.toLowerCase();
  const prev = (await deps.gatewayStorage.get(key)) ?? { servers: {} };
  const serverKey = getAddress(accept.payTo).toLowerCase();

  const next: GatewayClientChannelContext = {
    ...prev,
    balance: chBalance.toString(),
    totalClaimed: chTotalClaimed.toString(),
    aggregateChargedCumulativeAmount: chTotalClaimed.toString(),
    servers: {
      ...prev.servers,
      [serverKey]: { chargedCumulativeAmount: serverCharged.toString() },
    },
  };
  await deps.gatewayStorage.set(key, next);
  return true;
}

/**
 * Cold-starts gateway client storage from onchain channel + distributedCumulative.
 *
 * @param deps - Gateway client deps.
 * @param paymentRequirements - Server payment requirements.
 * @param gateway - Gateway contract address.
 * @returns Recovered channel context.
 */
export async function recoverGatewayChannel(
  deps: GatewayClientPaymentDeps,
  paymentRequirements: PaymentRequirements,
  gateway: `0x${string}`,
): Promise<GatewayClientChannelContext> {
  if (!deps.signer.readContract) {
    throw new Error("recoverGatewayChannel requires ClientEvmSigner.readContract");
  }

  const config = buildGatewayChannelConfig(deps, paymentRequirements, getAddress(gateway));
  const channelId = computeChannelId(config, paymentRequirements.network);

  const [chBalance, chTotalClaimed] = await readChannelBalanceAndTotalClaimed(
    deps.signer,
    channelId,
  );
  const distributed = await readDistributedCumulative(
    deps,
    getAddress(gateway),
    channelId,
    getAddress(paymentRequirements.payTo),
  );

  const key = channelId.toLowerCase();
  const prev = (await deps.gatewayStorage.get(key)) ?? { servers: {} };
  const serverKey = getAddress(paymentRequirements.payTo).toLowerCase();

  const ctx: GatewayClientChannelContext = {
    ...prev,
    balance: chBalance.toString(),
    totalClaimed: chTotalClaimed.toString(),
    aggregateChargedCumulativeAmount: chTotalClaimed.toString(),
    servers: {
      ...prev.servers,
      [serverKey]: { chargedCumulativeAmount: distributed.toString() },
    },
  };
  await deps.gatewayStorage.set(key, ctx);
  return ctx;
}

/**
 * Reads onchain `distributedCumulative(channelId, receiver)`.
 *
 * @param deps - Client deps with readContract.
 * @param gateway - Gateway address.
 * @param channelId - Channel id.
 * @param receiver - Server payTo.
 * @returns Distributed cumulative as bigint (0 on read failure).
 */
async function readDistributedCumulative(
  deps: GatewayClientPaymentDeps,
  gateway: `0x${string}`,
  channelId: `0x${string}`,
  receiver: `0x${string}`,
): Promise<bigint> {
  if (!deps.signer.readContract) {
    return 0n;
  }
  try {
    return (await deps.signer.readContract({
      address: gateway,
      abi: batchSettlementGatewayABI,
      functionName: "distributedCumulative",
      args: [channelId, receiver],
    })) as bigint;
  } catch {
    return 0n;
  }
}

/**
 * Writes recovered gateway storage from verified corrective fields.
 *
 * @param storage - Gateway client storage.
 * @param opts - Recovery field bundle.
 * @returns Always true after write.
 */
async function writeGatewayRecoveryState(
  storage: GatewayClientStorage,
  opts: {
    channelId: `0x${string}`;
    accept: PaymentRequirements;
    channelState:
      | {
          channelId?: string;
          balance?: string;
          totalClaimed?: string;
          chargedCumulativeAmount?: string;
        }
      | undefined;
    voucherState: { signedMaxClaimable?: string; signature?: `0x${string}` } | undefined;
    claimAuthorization: GatewayClaimAuthorization | undefined;
    gatewayState: GatewayStateInfo | undefined;
    deps: GatewayClientPaymentDeps;
    gateway: `0x${string}`;
  },
): Promise<boolean> {
  const key = opts.channelId.toLowerCase();
  const prev = (await storage.get(key)) ?? { servers: {} };
  const serverKey = getAddress(opts.accept.payTo).toLowerCase();

  let serverCharged =
    opts.claimAuthorization?.totalClaimed ??
    opts.gatewayState?.distributedCumulative ??
    prev.servers[serverKey]?.chargedCumulativeAmount ??
    "0";

  if (opts.deps.signer.readContract && !opts.claimAuthorization) {
    const distributed = await readDistributedCumulative(
      opts.deps,
      opts.gateway,
      opts.channelId,
      getAddress(opts.accept.payTo),
    );
    serverCharged = distributed.toString();
  }

  await storage.set(key, {
    ...prev,
    balance: opts.channelState?.balance ?? prev.balance,
    totalClaimed: opts.channelState?.totalClaimed ?? prev.totalClaimed,
    aggregateChargedCumulativeAmount:
      opts.channelState?.chargedCumulativeAmount ?? prev.aggregateChargedCumulativeAmount,
    aggregateMaxClaimable: opts.voucherState?.signedMaxClaimable ?? prev.aggregateMaxClaimable,
    aggregateSignature: opts.voucherState?.signature ?? prev.aggregateSignature,
    servers: {
      ...prev.servers,
      [serverKey]: { chargedCumulativeAmount: serverCharged },
    },
  });
  return true;
}
