import { beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("../../../src/multicall", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/multicall")>();
  return { ...actual, multicall: vi.fn() };
});

import { multicall } from "../../../src/multicall";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { verifyDeposit } from "../../../src/batch-settlement/facilitator/deposit";
import * as depositEip3009 from "../../../src/batch-settlement/facilitator/deposit-eip3009";
import * as facilitatorUtils from "../../../src/batch-settlement/facilitator/utils";
import * as Errors from "../../../src/batch-settlement/errors";
import type {
  BatchSettlementDepositPayload,
  ChannelConfig,
} from "../../../src/batch-settlement/types";
import type { FacilitatorEvmSigner } from "../../../src/signer";
import { computeChannelId } from "../../../src/batch-settlement/utils";

const NETWORK = "eip155:84532";
const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as `0x${string}`;
const RECEIVER = "0x9876543210987654321098765432109876543210" as `0x${string}`;
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
const mockedMulticall = multicall as unknown as ReturnType<typeof vi.fn>;

function buildConfig(): ChannelConfig {
  return {
    payer: PAYER,
    payerAuthorizer: PAYER,
    receiver: RECEIVER,
    receiverAuthorizer: "0x1111111111111111111111111111111111111111",
    token: TOKEN,
    withdrawDelay: 900,
    salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
  };
}

function buildSigner(overrides: Partial<FacilitatorEvmSigner> = {}): FacilitatorEvmSigner {
  return {
    getAddresses: () => [PAYER],
    readContract: vi.fn().mockResolvedValue(undefined),
    verifyTypedData: vi.fn().mockResolvedValue(true),
    writeContract: vi.fn(),
    sendTransaction: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    getCode: vi.fn().mockResolvedValue("0x6080604052"),
    ...overrides,
  };
}

function requirements(extra: Record<string, unknown> = {}): PaymentRequirements {
  return {
    scheme: "batch-settlement",
    network: NETWORK,
    amount: "1000",
    asset: TOKEN,
    payTo: RECEIVER,
    maxTimeoutSeconds: 3600,
    extra: {
      name: "USDC",
      version: "2",
      receiverAuthorizer: "0x1111111111111111111111111111111111111111",
      withdrawDelay: 900,
      ...extra,
    },
  };
}

function depositPayload(
  config: ChannelConfig,
  channelId: `0x${string}`,
  authorization: BatchSettlementDepositPayload["deposit"]["authorization"],
): BatchSettlementDepositPayload {
  return {
    type: "deposit",
    channelConfig: config,
    voucher: { channelId, maxClaimableAmount: "5000", signature: "0xdeadbeef" },
    deposit: { amount: "1000", authorization },
  };
}

function envelope(payload: BatchSettlementDepositPayload): PaymentPayload {
  return {
    x402Version: 2,
    accepted: { scheme: "batch-settlement", network: NETWORK },
    payload,
  } as PaymentPayload;
}

describe("verifyDeposit", () => {
  beforeEach(() => {
    mockedMulticall.mockReset();
  });

  it("rejects an EIP-3009 deposit when the payer token balance is too low", async () => {
    vi.spyOn(depositEip3009, "verifyEip3009DepositAuthorization").mockResolvedValueOnce({
      counterfactual: null,
    });
    vi.spyOn(facilitatorUtils, "verifyBatchSettlementVoucherTypedData").mockResolvedValueOnce(true);
    mockedMulticall.mockResolvedValueOnce([
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 100n },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const signer = buildSigner({
      readContract: vi.fn().mockImplementation(args => {
        if (args.functionName === "isValidSignature") return Promise.resolve("0x1626ba7e");
        return Promise.resolve(undefined);
      }),
    });
    const config = buildConfig();
    const channelId = computeChannelId(config, NETWORK);
    const now = Math.floor(Date.now() / 1000);
    const payload = depositPayload(config, channelId, {
      erc3009Authorization: {
        validAfter: String(now - 600),
        validBefore: String(now + 3600),
        salt: "0x01",
        signature: "0xfeedface",
      },
    });
    const result = await verifyDeposit(
      signer,
      envelope(payload),
      payload,
      requirements({ assetTransferMethod: "eip3009" }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrInsufficientBalance);
  });

  it("rejects an EIP-3009 deposit when max claimable exceeds post-deposit balance", async () => {
    vi.spyOn(depositEip3009, "verifyEip3009DepositAuthorization").mockResolvedValueOnce({
      counterfactual: null,
    });
    vi.spyOn(facilitatorUtils, "verifyBatchSettlementVoucherTypedData").mockResolvedValueOnce(true);
    mockedMulticall.mockResolvedValueOnce([
      { status: "success", result: [1000n, 0n] },
      { status: "success", result: 10_000n },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const signer = buildSigner({
      readContract: vi.fn().mockImplementation(args => {
        if (args.functionName === "isValidSignature") return Promise.resolve("0x1626ba7e");
        return Promise.resolve(undefined);
      }),
    });
    const config = buildConfig();
    const channelId = computeChannelId(config, NETWORK);
    const now = Math.floor(Date.now() / 1000);
    const payload = depositPayload(config, channelId, {
      erc3009Authorization: {
        validAfter: String(now - 600),
        validBefore: String(now + 3600),
        salt: "0x01",
        signature: "0xfeedface",
      },
    });
    const result = await verifyDeposit(
      signer,
      envelope(payload),
      payload,
      requirements({ assetTransferMethod: "eip3009" }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrCumulativeExceedsBalance);
  });

  it("returns RpcReadFailed when onchain deposit preflight reads fail", async () => {
    vi.spyOn(depositEip3009, "verifyEip3009DepositAuthorization").mockResolvedValueOnce({
      counterfactual: null,
    });
    vi.spyOn(facilitatorUtils, "verifyBatchSettlementVoucherTypedData").mockResolvedValueOnce(true);
    mockedMulticall.mockResolvedValueOnce([
      { status: "failure", error: new Error("revert") },
      { status: "success", result: 10_000n },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const signer = buildSigner({
      readContract: vi.fn().mockImplementation(args => {
        if (args.functionName === "isValidSignature") return Promise.resolve("0x1626ba7e");
        return Promise.resolve(undefined);
      }),
    });
    const config = buildConfig();
    const channelId = computeChannelId(config, NETWORK);
    const now = Math.floor(Date.now() / 1000);
    const payload = depositPayload(config, channelId, {
      erc3009Authorization: {
        validAfter: String(now - 600),
        validBefore: String(now + 3600),
        salt: "0x01",
        signature: "0xfeedface",
      },
    });
    const result = await verifyDeposit(
      signer,
      envelope(payload),
      payload,
      requirements({ assetTransferMethod: "eip3009" }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrRpcReadFailed);
  });

  it("forwards EIP-3009 authorization failures without running shared preflight", async () => {
    vi.spyOn(depositEip3009, "verifyEip3009DepositAuthorization").mockResolvedValueOnce({
      response: {
        isValid: false,
        invalidReason: Errors.ErrInvalidPayloadType,
        payer: PAYER,
      },
    });
    const config = buildConfig();
    const channelId = computeChannelId(config, NETWORK);
    const now = Math.floor(Date.now() / 1000);
    const payload = depositPayload(config, channelId, {
      erc3009Authorization: {
        validAfter: String(now - 600),
        validBefore: String(now + 3600),
        salt: "0x01",
        signature: "0xfeedface",
      },
    });
    const result = await verifyDeposit(
      buildSigner(),
      envelope(payload),
      payload,
      requirements({ assetTransferMethod: "eip3009" }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrInvalidPayloadType);
    expect(mockedMulticall).not.toHaveBeenCalled();
  });

  it("returns DepositSimulationFailed when direct deposit simulation reverts", async () => {
    vi.spyOn(depositEip3009, "verifyEip3009DepositAuthorization").mockResolvedValueOnce({
      counterfactual: null,
    });
    vi.spyOn(facilitatorUtils, "verifyBatchSettlementVoucherTypedData").mockResolvedValueOnce(true);
    mockedMulticall.mockResolvedValueOnce([
      { status: "success", result: [5000n, 0n] },
      { status: "success", result: 10_000n },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const signer = buildSigner({
      readContract: vi.fn().mockImplementation(args => {
        if (args.functionName === "deposit") {
          return Promise.reject(new Error("execution reverted"));
        }
        return Promise.resolve(undefined);
      }),
    });
    const config = buildConfig();
    const channelId = computeChannelId(config, NETWORK);
    const now = Math.floor(Date.now() / 1000);
    const payload = depositPayload(config, channelId, {
      erc3009Authorization: {
        validAfter: String(now - 600),
        validBefore: String(now + 3600),
        salt: "0x01",
        signature: "0xfeedface",
      },
    });
    const result = await verifyDeposit(
      signer,
      envelope(payload),
      payload,
      requirements({ assetTransferMethod: "eip3009" }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrDepositSimulationFailed);
  });

  it("rejects a deposit with an invalid voucher signature", async () => {
    vi.spyOn(depositEip3009, "verifyEip3009DepositAuthorization").mockResolvedValueOnce({
      counterfactual: null,
    });
    vi.spyOn(facilitatorUtils, "verifyBatchSettlementVoucherTypedData").mockResolvedValueOnce(
      false,
    );
    const config = buildConfig();
    const channelId = computeChannelId(config, NETWORK);
    const now = Math.floor(Date.now() / 1000);
    const payload = depositPayload(config, channelId, {
      erc3009Authorization: {
        validAfter: String(now - 600),
        validBefore: String(now + 3600),
        salt: "0x01",
        signature: "0xfeedface",
      },
    });
    const result = await verifyDeposit(
      buildSigner(),
      envelope(payload),
      payload,
      requirements({ assetTransferMethod: "eip3009" }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrInvalidVoucherSignature);
  });

  it("rejects a permit2 deposit that omits permit2 authorization", async () => {
    const config = buildConfig();
    const channelId = computeChannelId(config, NETWORK);
    const payload = depositPayload(config, channelId, {});
    const result = await verifyDeposit(
      buildSigner(),
      envelope(payload),
      payload,
      requirements({ assetTransferMethod: "permit2" }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrInvalidPayloadType);
  });

  it("rejects when max claimable is not above onchain total claimed", async () => {
    vi.spyOn(depositEip3009, "verifyEip3009DepositAuthorization").mockResolvedValueOnce({
      counterfactual: null,
    });
    vi.spyOn(facilitatorUtils, "verifyBatchSettlementVoucherTypedData").mockResolvedValueOnce(true);
    mockedMulticall.mockResolvedValueOnce([
      { status: "success", result: [5000n, 5000n] },
      { status: "success", result: 10_000n },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const config = buildConfig();
    const channelId = computeChannelId(config, NETWORK);
    const now = Math.floor(Date.now() / 1000);
    const payload = depositPayload(config, channelId, {
      erc3009Authorization: {
        validAfter: String(now - 600),
        validBefore: String(now + 3600),
        salt: "0x01",
        signature: "0xfeedface",
      },
    });
    const result = await verifyDeposit(
      buildSigner(),
      envelope(payload),
      payload,
      requirements({ assetTransferMethod: "eip3009" }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrCumulativeAmountBelowClaimed);
  });

  it("rejects a deposit whose channel id does not match the config", async () => {
    const config = buildConfig();
    const channelId = computeChannelId(config, NETWORK);
    const wrongId = `${channelId.slice(0, -2)}ff` as `0x${string}`;
    const now = Math.floor(Date.now() / 1000);
    const payload = depositPayload(config, wrongId, {
      erc3009Authorization: {
        validAfter: String(now - 600),
        validBefore: String(now + 3600),
        salt: "0x01",
        signature: "0xfeedface",
      },
    });
    const result = await verifyDeposit(
      buildSigner(),
      envelope(payload),
      payload,
      requirements({ assetTransferMethod: "eip3009" }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrChannelIdMismatch);
  });
});
