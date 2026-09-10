import { describe, expect, it } from "vitest";
import { encodeFunctionData, keccak256, slice, toBytes } from "viem";
import { batchSettlementABI } from "../../../src/batch-settlement/abi";
import {
  CHARGE_COUNTS_MAGIC,
  composeClaimDataSuffix,
  encodeChargeCountsSuffix,
  parseChargeCountsFromCalldata,
  parseChargeCountsSuffix,
} from "../../../src/batch-settlement/facilitator/chargeCounts";
import { appendDataSuffix } from "../../../src/shared/extensions";
import type { ChannelConfig } from "../../../src/batch-settlement/types";
import { toContractChannelConfig } from "../../../src/batch-settlement/facilitator/utils";

const ZERO = "0x0000000000000000000000000000000000000000" as const;

const CHANNEL: ChannelConfig = {
  payer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  payerAuthorizer: ZERO,
  receiver: "0x9876543210987654321098765432109876543210",
  receiverAuthorizer: "0x1111111111111111111111111111111111111111",
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  withdrawDelay: 900,
  salt: `0x${"00".repeat(32)}`,
};

function claimCalldata(functionName: "claim" | "claimWithSignature"): `0x${string}` {
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

describe("CHARGE_COUNTS_MAGIC", () => {
  it('equals bytes4(keccak256("x402ChargeCounts(uint64[])"))', () => {
    expect(CHARGE_COUNTS_MAGIC).toBe(slice(keccak256(toBytes("x402ChargeCounts(uint64[])")), 0, 4));
    expect(CHARGE_COUNTS_MAGIC).toBe("0x50b180c6");
  });
});

describe("encodeChargeCountsSuffix / parseChargeCountsSuffix", () => {
  it("round-trips a non-empty count list", () => {
    const suffix = encodeChargeCountsSuffix([0, 4, 12]);
    expect(suffix.startsWith(CHARGE_COUNTS_MAGIC)).toBe(true);
    expect(parseChargeCountsSuffix(suffix)).toEqual([0n, 4n, 12n]);
  });

  it("round-trips an empty list", () => {
    expect(parseChargeCountsSuffix(encodeChargeCountsSuffix([]))).toEqual([]);
  });

  it("returns undefined when leftover is empty or has no magic", () => {
    expect(parseChargeCountsSuffix("0x")).toBeUndefined();
    expect(parseChargeCountsSuffix("0xdeadbeef")).toBeUndefined();
  });

  it("returns undefined when the encoded array is truncated or the length is unsafe", () => {
    expect(parseChargeCountsSuffix(`${CHARGE_COUNTS_MAGIC}${"00".repeat(16)}`)).toBeUndefined();
    expect(
      parseChargeCountsSuffix(`${CHARGE_COUNTS_MAGIC}${"00".repeat(32)}${"ff".repeat(32)}`),
    ).toBeUndefined();
    const oneShort = encodeChargeCountsSuffix([1]).slice(0, -2) as `0x${string}`;
    expect(parseChargeCountsSuffix(oneShort)).toBeUndefined();
  });

  it("accepts an uppercase 0X leftover prefix", () => {
    const suffix = encodeChargeCountsSuffix([8]);
    expect(parseChargeCountsSuffix(`0X${suffix.slice(2)}` as `0x${string}`)).toEqual([8n]);
  });
});

describe("composeClaimDataSuffix", () => {
  it("places charge counts before an optional builder-code suffix", () => {
    const builder = "0x8021abcd" as const;
    const composed = composeClaimDataSuffix([3, 7], builder);
    expect(composed.startsWith(CHARGE_COUNTS_MAGIC)).toBe(true);
    expect(composed.endsWith("8021abcd")).toBe(true);
    expect(parseChargeCountsSuffix(composed)).toEqual([3n, 7n]);
  });
});

describe("parseChargeCountsFromCalldata", () => {
  it("round-trips through claim and claimWithSignature encodings", () => {
    const suffix = encodeChargeCountsSuffix([2, 9]);
    for (const functionName of ["claim", "claimWithSignature"] as const) {
      const calldata = appendDataSuffix(claimCalldata(functionName), suffix);
      expect(parseChargeCountsFromCalldata(calldata)).toEqual([2n, 9n]);
    }
  });

  it("returns undefined when leftover is empty", () => {
    expect(parseChargeCountsFromCalldata(claimCalldata("claim"))).toBeUndefined();
  });

  it("returns undefined when leftover has no magic", () => {
    const calldata = appendDataSuffix(claimCalldata("claim"), "0xdeadbeef");
    expect(parseChargeCountsFromCalldata(calldata)).toBeUndefined();
  });

  it("stops before a trailing ERC-8021-style suffix", () => {
    const composed = composeClaimDataSuffix([5], "0x80218021802180218021802180218021");
    const calldata = appendDataSuffix(claimCalldata("claimWithSignature"), composed);
    expect(parseChargeCountsFromCalldata(calldata)).toEqual([5n]);
  });

  it("returns undefined for calldata that is not a function encoding", () => {
    expect(parseChargeCountsFromCalldata("0xabcd")).toBeUndefined();
  });

  it("returns undefined for a non-claim function", () => {
    const settle = encodeFunctionData({
      abi: batchSettlementABI,
      functionName: "settle",
      args: [CHANNEL.receiver, CHANNEL.token],
    });
    expect(
      parseChargeCountsFromCalldata(appendDataSuffix(settle, encodeChargeCountsSuffix([1]))),
    ).toBeUndefined();
  });
});
