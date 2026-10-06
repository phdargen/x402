/**
 * @file Decoded claim attestation for batch-settlement transactions.
 *
 * Neutral single-helper entry point for facilitators, clients, and third-party indexers:
 * given full transaction input, the parsed ERC-8021 `m` metadata, receipt logs, and the
 * settlement network, joins the attested `x402ChargeCounts` to channels.
 *
 * The join is a row join: claim rows are ABI-decoded from the calldata (unwrapping
 * `multicall`), each row's `channelId` is recomputed, and the row is matched to the
 * `Claimed` event of the same `channelId`. Counts are never paired with logs by position,
 * so a no-op row cannot shift attribution onto other channels.
 */
import { decodeFunctionData, parseEventLogs, type Hex } from "viem";
import { batchSettlementABI } from "./abi";
import { BATCH_SETTLEMENT_ADDRESS } from "./constants";
import { parseChargeCountsMetadata, type ChargeCountsMetadata } from "./chargeCounts";
import { computeChannelId } from "./utils";

/** One claim row decoded from `claim` / `claimWithSignature` calldata. */
type ClaimRow = {
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
};

/** Fields of a `Claimed` event keyed by its (lowercase) `channelId`. */
type ClaimedEntry = { claimAmount: bigint; newTotalClaimed: bigint };

/**
 * One claim row joined to its onchain `Claimed` event. A row without the event was a no-op
 * and carries nothing else.
 */
export type ClaimAttestationRow =
  | { channelId: `0x${string}`; claimed: false }
  | {
      channelId: `0x${string}`;
      claimed: true;
      claimAmount: string;
      newTotalClaimed: string;
      /** Attested charge-count delta; absent when `m` has no valid counts for this calldata. */
      chargeCount?: string;
    };

/** Decoded attestation for a settlement transaction. */
export type ClaimAttestation = {
  /** Outer function name (`claim`, `multicall`, `refund`, …; `unknown` when undecodable). */
  functionName: string;
  /** Charge-count deltas from `m.x402ChargeCounts`, in claim-row order, when valid for this calldata. */
  chargeCounts?: bigint[];
  /** Joined rows in claim-row order, or `null` when the transaction carries no claim row. */
  channels: ClaimAttestationRow[] | null;
};

/**
 * Collects the claim rows of a transaction in call order.
 *
 * Handles a direct `claim` / `claimWithSignature` call and a (possibly nested)
 * `multicall(bytes[])`; non-claim legs such as `refund` contribute no rows.
 *
 * @param calldata - Calldata of the call to inspect.
 * @returns Rows in call order, or `undefined` when any leg cannot be ABI-decoded.
 */
function collectClaimRows(calldata: Hex): ClaimRow[] | undefined {
  let decoded: ReturnType<typeof decodeFunctionData<typeof batchSettlementABI>>;
  try {
    decoded = decodeFunctionData({ abi: batchSettlementABI, data: calldata });
  } catch {
    return undefined;
  }

  if (decoded.functionName === "claim" || decoded.functionName === "claimWithSignature") {
    return [...(decoded.args[0] as readonly ClaimRow[])];
  }

  if (decoded.functionName === "multicall") {
    const rows: ClaimRow[] = [];
    for (const inner of decoded.args[0] as readonly Hex[]) {
      const innerRows = collectClaimRows(inner);
      if (innerRows === undefined) {
        return undefined;
      }
      rows.push(...innerRows);
    }
    return rows;
  }

  return [];
}

/**
 * Reads the `Claimed` events emitted by the `x402BatchSettlement` contract.
 *
 * Logs from other emitters are ignored, so an unrelated contract in the same
 * transaction cannot forge a `Claimed` for a channel.
 *
 * @param receiptLogs - Receipt `logs` for the transaction.
 * @returns `Claimed` fields keyed by lowercase `channelId`.
 */
function readClaimedEvents(receiptLogs: readonly unknown[]): Map<string, ClaimedEntry> {
  const contract = BATCH_SETTLEMENT_ADDRESS.toLowerCase();
  const fromContract = receiptLogs.filter(log => {
    const address = (log as { address?: unknown } | null)?.address;
    return typeof address === "string" && address.toLowerCase() === contract;
  });

  const claimed = new Map<string, ClaimedEntry>();
  try {
    const events = parseEventLogs({
      abi: batchSettlementABI,
      eventName: "Claimed",
      logs: fromContract as Parameters<typeof parseEventLogs>[0]["logs"],
    });
    for (const { args } of events) {
      claimed.set(args.channelId.toLowerCase(), {
        claimAmount: args.claimAmount,
        newTotalClaimed: args.newTotalClaimed,
      });
    }
  } catch {
    return new Map();
  }
  return claimed;
}

/**
 * Returns the `channelId`s that emitted `Claimed` in a receipt.
 *
 * Facilitators use this to subtract an attested `chargeCount` only for rows that were
 * actually claimed.
 *
 * @param receiptLogs - Receipt `logs` for the transaction.
 * @returns Lowercase `channelId`s with a `Claimed` event from `x402BatchSettlement`.
 */
export function claimedChannelIdsFromLogs(
  receiptLogs: readonly unknown[] | undefined,
): Set<string> {
  return new Set(readClaimedEvents(receiptLogs ?? []).keys());
}

/**
 * Decodes claim attestation from full transaction input, parsed `m`, and receipt logs.
 *
 * Handles standalone `claim` / `claimWithSignature` transactions and bundled
 * `multicall([claim, refund])` transactions. `metadata` is the `m` field of the ERC-8021
 * suffix on the top-level input (for example
 * `parseBuilderCodeSuffixFromCalldata(input)?.m` from `@x402/extensions/builder-code`).
 * No builder code is needed: a suffix carrying only `m` is enough.
 *
 * Rows are joined to `Claimed` events by `channelId`. A row without a `Claimed` event was a
 * no-op and attests nothing. Counts whose length differs from the number of claim rows
 * are ignored.
 *
 * Never throws: undecodable input yields `{ functionName: "unknown", channels: null }`,
 * and unparseable receipt logs yield rows with `claimed: false`.
 *
 * @param calldata - Full transaction input.
 * @param receiptLogs - Receipt `logs` for the transaction.
 * @param network - CAIP-2 network identifier used to compute channel ids.
 * @param metadata - Parsed ERC-8021 `m` field of the top-level suffix, when present.
 * @returns Decoded attestation with joined channel rows.
 */
export function decodeClaimAttestation(
  calldata: Hex,
  receiptLogs: readonly unknown[],
  network: string,
  metadata?: ChargeCountsMetadata,
): ClaimAttestation {
  let functionName: string;
  try {
    functionName = decodeFunctionData({ abi: batchSettlementABI, data: calldata }).functionName;
  } catch {
    return { functionName: "unknown", channels: null };
  }

  const rows = collectClaimRows(calldata);
  if (rows === undefined || rows.length === 0) {
    return { functionName, channels: null };
  }

  const parsedCounts = parseChargeCountsMetadata(metadata);
  const chargeCounts = parsedCounts?.length === rows.length ? parsedCounts : undefined;
  const claimedEvents = readClaimedEvents(receiptLogs);

  const channels = rows.map((row, index): ClaimAttestationRow => {
    const channel = row.voucher.channel;
    const channelId = computeChannelId(
      {
        payer: channel.payer,
        payerAuthorizer: channel.payerAuthorizer,
        receiver: channel.receiver,
        receiverAuthorizer: channel.receiverAuthorizer,
        token: channel.token,
        withdrawDelay: Number(channel.withdrawDelay),
        salt: channel.salt,
      },
      network,
    );
    const event = claimedEvents.get(channelId.toLowerCase());
    if (!event) {
      return { channelId, claimed: false };
    }
    return {
      channelId,
      claimed: true,
      claimAmount: event.claimAmount.toString(),
      newTotalClaimed: event.newTotalClaimed.toString(),
      chargeCount: chargeCounts?.[index].toString(),
    };
  });

  return { functionName, ...(chargeCounts ? { chargeCounts } : {}), channels };
}
