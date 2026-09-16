/**
 * @file Decoded claim attestation for batch-settlement transactions.
 *
 * Neutral single-helper entry point for facilitators, clients, and third-party indexers:
 * given full transaction input, receipt logs, and the settlement network, joins the
 * onchain `Claimed` events to the attested `voucherClaims` rows (including `claim+refund`
 * batches via `multicall`).
 */
import { decodeFunctionData, parseEventLogs, type Hex } from "viem";
import { batchSettlementABI } from "./abi";
import { computeChannelId } from "./utils";
import { extractClaimCalldata, parseChargeCountsFromCalldata } from "./chargeCounts";

/** One attested `voucherClaims` row joined to its onchain `Claimed` event. */
export type ClaimAttestationRow = {
  channelId: `0x${string}`;
  chargeCount?: string;
  claimAmount?: string;
  newTotalClaimed?: string;
};

/** Decoded attestation for a settlement transaction. */
export type ClaimAttestation = {
  /** Outer function name (`claim`, `multicall`, `refund`, …; `unknown` when undecodable). */
  functionName: string;
  /** Inner claim function name when a claim leg is present. */
  claimFunctionName?: "claim" | "claimWithSignature";
  /** Inner claim calldata (unwrapped from `multicall` when batched). */
  claimCalldata?: Hex;
  /** Attested charge-count deltas, in `voucherClaims` order. */
  chargeCounts?: bigint[];
  /** Joined rows, or `null` when the transaction carries no claim. */
  channels: ClaimAttestationRow[] | null;
};

/**
 * Decodes claim attestation from full transaction input and receipt logs.
 *
 * Handles both standalone `claim` / `claimWithSignature` transactions and bundled
 * `multicall([claim+suffix, refund])` transactions: the inner claim is unwrapped via
 * {@link extractClaimCalldata}, charge counts are read from the inner suffix, and each
 * `voucherClaims[i]` row is joined to its `Claimed` event by `channelId`.
 * Builder-code stays on the outer tx and is parsed separately with
 * `parseBuilderCodeSuffixFromCalldata`.
 *
 * Never throws: undecodable input yields `{ functionName: "unknown", channels: null }`,
 * and unparseable receipt logs yield rows without `claimAmount` / `newTotalClaimed`.
 *
 * @param calldata - Full transaction input.
 * @param receiptLogs - Receipt `logs` for the transaction.
 * @param network - CAIP-2 network identifier used to compute channel ids.
 * @returns Decoded attestation with joined channel rows.
 */
export function decodeClaimAttestation(
  calldata: Hex,
  receiptLogs: readonly unknown[],
  network: string,
): ClaimAttestation {
  let outerName = "unknown";
  try {
    const outer = decodeFunctionData({ abi: batchSettlementABI, data: calldata });
    outerName = outer.functionName;
  } catch {
    return { functionName: outerName, channels: null };
  }

  const chargeCounts = parseChargeCountsFromCalldata(calldata);
  const claimCalldata = extractClaimCalldata(calldata);
  if (claimCalldata === undefined) {
    return { functionName: outerName, chargeCounts, channels: null };
  }

  let claimFunctionName: "claim" | "claimWithSignature";
  let voucherClaims: readonly {
    voucher: {
      channel: {
        payer: `0x${string}`;
        payerAuthorizer: `0x${string}`;
        receiver: `0x${string}`;
        receiverAuthorizer: `0x${string}`;
        token: `0x${string}`;
        withdrawDelay: number | bigint;
        salt: `0x${string}`;
      };
    };
  }[];
  try {
    const decoded = decodeFunctionData({ abi: batchSettlementABI, data: claimCalldata });
    if (decoded.functionName !== "claim" && decoded.functionName !== "claimWithSignature") {
      return { functionName: outerName, chargeCounts, channels: null };
    }
    claimFunctionName = decoded.functionName;
    voucherClaims = decoded.args[0] as typeof voucherClaims;
  } catch {
    return { functionName: outerName, chargeCounts, channels: null };
  }

  let claimed: readonly {
    args: {
      channelId?: `0x${string}`;
      claimAmount?: bigint;
      newTotalClaimed?: bigint;
    };
  }[] = [];
  try {
    claimed = parseEventLogs({
      abi: batchSettlementABI,
      eventName: "Claimed",
      logs: receiptLogs as Parameters<typeof parseEventLogs>[0]["logs"],
    });
  } catch {
    claimed = [];
  }

  const channels: ClaimAttestationRow[] = voucherClaims.map((claim, index) => {
    const rawChannel = claim.voucher.channel;
    const channelId = computeChannelId(
      {
        payer: rawChannel.payer,
        payerAuthorizer: rawChannel.payerAuthorizer,
        receiver: rawChannel.receiver,
        receiverAuthorizer: rawChannel.receiverAuthorizer,
        token: rawChannel.token,
        withdrawDelay: Number(rawChannel.withdrawDelay),
        salt: rawChannel.salt,
      },
      network,
    );
    const log = claimed.find(
      entry => entry.args.channelId?.toLowerCase() === channelId.toLowerCase(),
    );
    return {
      channelId,
      chargeCount: chargeCounts?.[index]?.toString(),
      claimAmount: log?.args.claimAmount?.toString(),
      newTotalClaimed: log?.args.newTotalClaimed?.toString(),
    };
  });

  return {
    functionName: outerName,
    claimFunctionName,
    claimCalldata,
    chargeCounts,
    channels,
  };
}
