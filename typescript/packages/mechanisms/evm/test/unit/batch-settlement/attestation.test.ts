import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, type Log } from "viem";
import { batchSettlementABI } from "../../../src/batch-settlement/abi";
import { decodeClaimAttestation } from "../../../src/batch-settlement/attestation";
import {
  encodeChargeCountsSuffix,
  parseChargeCountsFromCalldata,
} from "../../../src/batch-settlement/chargeCounts";
import { appendDataSuffix } from "../../../src/shared/extensions";
import type { ChannelConfig } from "../../../src/batch-settlement/types";
import { toContractChannelConfig } from "../../../src/batch-settlement/facilitator/utils";
import { computeChannelId } from "../../../src/batch-settlement/utils";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const NETWORK = "eip155:84532";

const CHANNEL: ChannelConfig = {
  payer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  payerAuthorizer: ZERO,
  receiver: "0x9876543210987654321098765432109876543210",
  receiverAuthorizer: "0x1111111111111111111111111111111111111111",
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  withdrawDelay: 900,
  salt: `0x${"00".repeat(32)}`,
};

function claimCalldata(functionName: "claim" | "claimWithSignature" = "claim"): `0x${string}` {
  const claims = [
    {
      voucher: {
        channel: toContractChannelConfig(CHANNEL),
        maxClaimableAmount: 1000n,
      },
      signature: "0xcafe" as `0x${string}`,
      totalClaimed: 1000n,
    },
  ];
  return functionName === "claim"
    ? encodeFunctionData({ abi: batchSettlementABI, functionName, args: [claims] })
    : encodeFunctionData({
        abi: batchSettlementABI,
        functionName,
        args: [claims, "0xdead"],
      });
}

const BATCH_SETTLEMENT_ADDRESS = "0x0000000000000000000000000000000000000001" as const;

function buildClaimedLog(
  channelId: `0x${string}`,
  claimAmount: bigint,
  newTotalClaimed: bigint,
): Log {
  return {
    address: BATCH_SETTLEMENT_ADDRESS,
    topics: encodeEventTopics({
      abi: batchSettlementABI,
      eventName: "Claimed",
      args: {
        channelId,
        sender: CHANNEL.receiver,
      },
    }),
    data: encodeAbiParameters(
      [{ type: "uint128" }, { type: "uint128" }],
      [claimAmount, newTotalClaimed],
    ),
    blockHash: null,
    blockNumber: null,
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false,
  } as Log;
}

describe("decodeClaimAttestation", () => {
  it("decodes a standalone claim with charge counts and channel rows", () => {
    const calldata = appendDataSuffix(claimCalldata(), encodeChargeCountsSuffix([4]));
    const attestation = decodeClaimAttestation(calldata, [], NETWORK);
    expect(attestation.functionName).toBe("claim");
    expect(attestation.claimFunctionName).toBe("claim");
    expect(attestation.chargeCounts).toEqual([4n]);
    expect(attestation.channels).toHaveLength(1);
    expect(attestation.channels?.[0].channelId.toLowerCase()).toBe(
      computeChannelId(CHANNEL, NETWORK).toLowerCase(),
    );
    expect(attestation.channels?.[0].chargeCount).toBe("4");
  });

  it("unwraps multicall([claim+suffix, refund]) into claim rows", () => {
    const innerClaim = appendDataSuffix(claimCalldata(), encodeChargeCountsSuffix([4]));
    const refund = encodeFunctionData({
      abi: batchSettlementABI,
      functionName: "refund",
      args: [toContractChannelConfig(CHANNEL), 100n],
    });
    const outer = encodeFunctionData({
      abi: batchSettlementABI,
      functionName: "multicall",
      args: [[innerClaim, refund]],
    });
    // Sanity: the shared parser also sees the inner suffix from the outer input.
    expect(parseChargeCountsFromCalldata(outer)).toEqual([4n]);

    const attestation = decodeClaimAttestation(outer, [], NETWORK);
    expect(attestation.functionName).toBe("multicall");
    expect(attestation.claimFunctionName).toBe("claim");
    expect(attestation.chargeCounts).toEqual([4n]);
    expect(attestation.channels).toHaveLength(1);
    expect(attestation.channels?.[0].chargeCount).toBe("4");
  });

  it("returns null channels for refund-only multicall", () => {
    const refund = encodeFunctionData({
      abi: batchSettlementABI,
      functionName: "refund",
      args: [toContractChannelConfig(CHANNEL), 100n],
    });
    const outer = encodeFunctionData({
      abi: batchSettlementABI,
      functionName: "multicall",
      args: [[refund]],
    });
    const attestation = decodeClaimAttestation(outer, [], NETWORK);
    expect(attestation.functionName).toBe("multicall");
    expect(attestation.channels).toBeNull();
  });

  it("returns unknown for undecodable calldata without throwing", () => {
    const attestation = decodeClaimAttestation("0xabcd", [], NETWORK);
    expect(attestation.functionName).toBe("unknown");
    expect(attestation.channels).toBeNull();
  });

  it("omits claim amounts when receipt logs cannot be parsed", () => {
    const calldata = appendDataSuffix(claimCalldata(), encodeChargeCountsSuffix([1]));
    const attestation = decodeClaimAttestation(calldata, [{ not: "a log" }], NETWORK);
    expect(attestation.channels?.[0].claimAmount).toBeUndefined();
    expect(attestation.channels?.[0].newTotalClaimed).toBeUndefined();
  });

  it("returns null channels when multicall inner calldata is not a claim", () => {
    const outer = encodeFunctionData({
      abi: batchSettlementABI,
      functionName: "multicall",
      args: [["0xdeadbeef"]],
    });
    const attestation = decodeClaimAttestation(outer, [], NETWORK);
    expect(attestation.functionName).toBe("multicall");
    expect(attestation.channels).toBeNull();
  });

  it("decodes claimWithSignature and joins Claimed receipt logs", () => {
    const calldata = appendDataSuffix(
      claimCalldata("claimWithSignature"),
      encodeChargeCountsSuffix([2]),
    );
    const channelId = computeChannelId(CHANNEL, NETWORK);
    const logs = [buildClaimedLog(channelId, 500n, 1500n)];
    const attestation = decodeClaimAttestation(calldata, logs, NETWORK);
    expect(attestation.functionName).toBe("claimWithSignature");
    expect(attestation.claimFunctionName).toBe("claimWithSignature");
    expect(attestation.channels?.[0].claimAmount).toBe("500");
    expect(attestation.channels?.[0].newTotalClaimed).toBe("1500");
  });

  it("decodes claim rows without a charge-count suffix", () => {
    const calldata = claimCalldata();
    const attestation = decodeClaimAttestation(calldata, [], NETWORK);
    expect(attestation.chargeCounts).toBeUndefined();
    expect(attestation.channels?.[0].chargeCount).toBeUndefined();
  });
});
