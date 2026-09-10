import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MockedFunction } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  concat,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  isAddress,
  parseAbiParameters,
} from "viem";
import type { Log } from "viem";

vi.mock("../../../src/multicall", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/multicall")>();
  return { ...actual, multicall: vi.fn() };
});

vi.mock("../../../src/batch-settlement/facilitator/deposit-permit2", async importOriginal => {
  const actual =
    await importOriginal<
      typeof import("../../../src/batch-settlement/facilitator/deposit-permit2")
    >();
  return { ...actual, resolvePermit2DepositBranch: vi.fn(actual.resolvePermit2DepositBranch) };
});

import { multicall } from "../../../src/multicall";
import {
  buildDepositTransaction,
  buildPermit2DepositCollectorData,
  getPermit2DepositCollectorAddress,
  resolvePermit2DepositBranch,
  verifyPermit2DepositAuthorization,
} from "../../../src/batch-settlement/facilitator/deposit-permit2";
import { BatchSettlementEvmScheme } from "../../../src/batch-settlement/facilitator/scheme";
import type { FacilitatorChannel } from "../../../src/batch-settlement/facilitator/types";
import { InMemoryChannelStorage } from "../../../src/batch-settlement/storage/channel";
import { InMemoryDelegatedAuthStore } from "../../../src/batch-settlement/storage/delegatedAuth";
import {
  computeChannelId as computeChannelIdForNetwork,
  packRefundAuthorizerSalt,
} from "../../../src/batch-settlement/utils";
import {
  BATCH_SETTLEMENT_ADDRESS,
  ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
  PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
} from "../../../src/batch-settlement/constants";
import { batchSettlementABI } from "../../../src/batch-settlement/abi";
import { PERMIT2_ADDRESS } from "../../../src/constants";
import * as Errors from "../../../src/batch-settlement/errors";
import { ErrErc20ApprovalFromMismatch } from "../../../src/exact/facilitator/errors";
import type {
  ChannelConfig,
  AuthorizerSigner,
  BatchSettlementDepositPayload,
  BatchSettlementVoucherPayload,
  BatchSettlementRefundPayload,
  BatchSettlementClaimPayload,
  BatchSettlementSettlePayload,
  BatchSettlementEnrichedRefundPayload,
} from "../../../src/batch-settlement/types";
import type { FacilitatorEvmSigner } from "../../../src/signer";
import type { Erc20ApprovalGasSponsoringSigner } from "../../../src/exact/extensions";
import { ERC20_APPROVAL_GAS_SPONSORING_KEY } from "../../../src/exact/extensions";
import { signVoucher } from "../../../src/batch-settlement/client/voucher";
import { signRefund } from "../../../src/batch-settlement/authorizerSigner";
import type { FacilitatorContext, PaymentPayload, PaymentRequirements } from "@x402/core/types";

const mockedMulticall = multicall as unknown as MockedFunction<typeof multicall>;
const mockedResolvePermit2DepositBranch = resolvePermit2DepositBranch as unknown as MockedFunction<
  typeof resolvePermit2DepositBranch
>;

const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as `0x${string}`;
const RECEIVER = "0x9876543210987654321098765432109876543210" as `0x${string}`;
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
const FACILITATOR_ADDRESS = "0xFAC11174700123456789012345678901234aBCDe" as `0x${string}`;
const NETWORK = "eip155:84532";

function computeChannelId(config: ChannelConfig): `0x${string}` {
  return computeChannelIdForNetwork(config, NETWORK);
}

function buildAuthorizerSigner(): AuthorizerSigner {
  const account = privateKeyToAccount(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  );
  return {
    address: account.address,
    signTypedData: msg =>
      account.signTypedData({
        domain: msg.domain,
        types: msg.types,
        primaryType: msg.primaryType,
        message: msg.message,
      } as Parameters<typeof account.signTypedData>[0]),
  };
}

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const RECEIVER_AUTHORIZER = "0x1111111111111111111111111111111111111111" as `0x${string}`;

function buildChannelConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    payer: PAYER,
    payerAuthorizer: ZERO_ADDR,
    receiver: RECEIVER,
    receiverAuthorizer: RECEIVER_AUTHORIZER,
    token: ASSET,
    withdrawDelay: 900,
    salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
    ...overrides,
  };
}

function makeRequirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "batch-settlement",
    network: NETWORK,
    amount: "1000",
    asset: ASSET,
    payTo: RECEIVER,
    maxTimeoutSeconds: 3600,
    extra: {
      name: "USDC",
      version: "2",
      receiverAuthorizer: RECEIVER_AUTHORIZER,
      assetTransferMethod: "eip3009",
      withdrawDelay: 900,
    },
    ...overrides,
  };
}

function buildSigner(overrides: Partial<FacilitatorEvmSigner> = {}): FacilitatorEvmSigner {
  return {
    getAddresses: () => [FACILITATOR_ADDRESS],
    // The strict signature primitive added in the 7702 fix calls readContract
    // with functionName="isValidSignature". Return ERC-1271 magic by default so
    // existing tests' mock placeholder signatures pass through. Tests that need
    // an invalid signature override readContract to return "0xffffffff".
    readContract: vi.fn().mockImplementation(args => {
      if (args.functionName === "isValidSignature") return Promise.resolve("0x1626ba7e");
      if (args.functionName === "receivers") return Promise.resolve([2500n, 0n]);
      return Promise.resolve(undefined);
    }),
    verifyTypedData: vi.fn().mockResolvedValue(true),
    writeContract: vi.fn().mockResolvedValue(("0x" + "ab".repeat(32)) as `0x${string}`),
    sendTransaction: vi.fn(),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
    // Default: contract bytecode so the strict primitive takes the EIP-1271 path
    // and uses the readContract mock above. Tests that need an EOA path can
    // override getCode to return "0x".
    getCode: vi.fn().mockResolvedValue("0x6080604052"),
    ...overrides,
  };
}

function buildSettledLog(
  overrides: {
    receiver?: `0x${string}`;
    token?: `0x${string}`;
    sender?: `0x${string}`;
    amount?: string;
    address?: `0x${string}`;
  } = {},
): Log {
  const receiver = overrides.receiver ?? RECEIVER;
  const token = overrides.token ?? ASSET;
  const sender = overrides.sender ?? FACILITATOR_ADDRESS;

  return {
    address: overrides.address ?? BATCH_SETTLEMENT_ADDRESS,
    topics: encodeEventTopics({
      abi: batchSettlementABI,
      eventName: "Settled",
      args: { receiver, token, sender },
    }),
    data: encodeAbiParameters([{ type: "uint128" }], [BigInt(overrides.amount ?? "2500")]),
    blockHash: null,
    blockNumber: null,
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false,
  } as Log;
}

function envelopeVoucher(payload: BatchSettlementVoucherPayload): PaymentPayload {
  return {
    x402Version: 2,
    accepted: { scheme: "batch-settlement", network: NETWORK },
    payload: payload as unknown as Record<string, unknown>,
  } as unknown as PaymentPayload;
}

function envelopeRefund(payload: BatchSettlementRefundPayload): PaymentPayload {
  return {
    x402Version: 2,
    accepted: { scheme: "batch-settlement", network: NETWORK },
    payload: payload as unknown as Record<string, unknown>,
  } as unknown as PaymentPayload;
}

function envelopeDeposit(payload: BatchSettlementDepositPayload): PaymentPayload {
  return {
    x402Version: 2,
    accepted: { scheme: "batch-settlement", network: NETWORK },
    payload: payload as unknown as Record<string, unknown>,
  } as unknown as PaymentPayload;
}

function envelopeSettle(payload: Record<string, unknown>): PaymentPayload {
  return {
    x402Version: 2,
    accepted: { scheme: "batch-settlement", network: NETWORK },
    payload,
  } as unknown as PaymentPayload;
}

beforeEach(() => {
  mockedMulticall.mockReset();
  mockedResolvePermit2DepositBranch.mockClear();
});

describe("BatchSettlementEvmScheme (Facilitator) — construction & metadata", () => {
  const authorizer = buildAuthorizerSigner();

  it("exposes scheme id and CAIP family", () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    expect(scheme.scheme).toBe("batch-settlement");
    expect(scheme.caipFamily).toBe("eip155:*");
  });

  it("getExtra returns the receiver-authorizer address from authorizerSigner", () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    expect(scheme.getExtra(NETWORK)).toEqual({ receiverAuthorizer: authorizer.address });
  });

  it("getExtra returns undefined when no authorizerSigner is configured", () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner());
    expect(scheme.getExtra(NETWORK)).toBeUndefined();
  });

  it("getSigners returns the facilitator addresses", () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    expect(scheme.getSigners(NETWORK)).toEqual([FACILITATOR_ADDRESS]);
  });

  it("throws when submitMode is direct without authorizerSubmitter", () => {
    expect(
      () =>
        new BatchSettlementEvmScheme(buildSigner(), authorizer, {
          submitMode: "direct",
        }),
    ).toThrow('submitMode "direct" requires authorizerSubmitter');
  });

  it("throws when authorizerSubmitter is not exactly the authorizer address", () => {
    expect(
      () =>
        new BatchSettlementEvmScheme(buildSigner(), authorizer, {
          submitMode: "direct",
          authorizerSubmitter: buildSigner(),
        }),
    ).toThrow("authorizerSubmitter.getAddresses() must be exactly [authorizerSigner.address]");
  });

  it("advertises voucherStore and withdrawDelay when a managed store is configured", () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      voucherStore: { storage: new InMemoryChannelStorage() },
    });
    expect(scheme.getExtra(NETWORK)).toEqual({
      receiverAuthorizer: authorizer.address,
      withdrawDelay: 900,
      voucherStore: true,
    });
  });
});

describe("BatchSettlementEvmScheme (Facilitator) — verify routing", () => {
  const authorizer = buildAuthorizerSigner();

  it("rejects with InvalidScheme when accepted.scheme mismatches", async () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    const config = buildChannelConfig();
    const result = await scheme.verify(
      {
        x402Version: 2,
        accepted: { scheme: "exact", network: NETWORK },
        payload: { type: "voucher", channelConfig: config } as Record<string, unknown>,
      } as unknown as PaymentPayload,
      makeRequirements(),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrInvalidScheme);
  });

  it("rejects with NetworkMismatch when accepted.network mismatches requirements", async () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const voucher: BatchSettlementVoucherPayload = {
      type: "voucher",
      channelConfig: config,
      voucher: {
        channelId,
        maxClaimableAmount: "1000",
        signature: "0xdead",
      },
    };
    const result = await scheme.verify(
      {
        x402Version: 2,
        accepted: { scheme: "batch-settlement", network: "eip155:1" },
        payload: voucher as unknown as Record<string, unknown>,
      } as unknown as PaymentPayload,
      makeRequirements(),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrNetworkMismatch);
  });

  it("rejects with InvalidPayloadType for an unknown payload shape", async () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    const result = await scheme.verify(
      {
        x402Version: 2,
        accepted: { scheme: "batch-settlement", network: NETWORK },
        payload: { foo: "bar" } as Record<string, unknown>,
      } as unknown as PaymentPayload,
      makeRequirements(),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrInvalidPayloadType);
  });
});

describe("BatchSettlementEvmScheme (Facilitator) — verifyVoucher", () => {
  const authorizer = buildAuthorizerSigner();

  function makeVoucherPayload(
    overrides: {
      config?: ChannelConfig;
      voucher?: Partial<BatchSettlementVoucherPayload["voucher"]>;
    } = {},
  ): { payload: PaymentPayload; channelId: `0x${string}`; config: ChannelConfig } {
    const config = overrides.config ?? buildChannelConfig();
    const channelId = computeChannelId(config);
    const voucher: BatchSettlementVoucherPayload = {
      type: "voucher",
      channelConfig: config,
      voucher: {
        channelId,
        maxClaimableAmount: overrides.voucher?.maxClaimableAmount ?? "1000",
        signature: overrides.voucher?.signature ?? ("0xdead" as `0x${string}`),
      },
    };
    return { payload: envelopeVoucher(voucher), channelId, config };
  }

  it("returns isValid=true with channel state in extra on happy path", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload, channelId } = makeVoucherPayload();

    const result = await scheme.verify(payload, makeRequirements());
    expect(result.isValid).toBe(true);
    expect(result.payer).toBe(PAYER);
    expect(result.extra?.channelId).toBe(channelId);
    expect(result.extra?.balance).toBe("10000");
    expect(result.extra?.totalClaimed).toBe("0");
  });

  it("returns InvalidVoucherSignature when isValidSignature returns failure", async () => {
    const signer = buildSigner({
      readContract: vi.fn().mockImplementation(async (args: { functionName: string }) => {
        if (args.functionName === "isValidSignature") return "0xffffffff";
        if (args.functionName === "receivers") return [2500n, 0n];
        return undefined;
      }),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig({
      payerAuthorizer: "0x0000000000000000000000000000000000000000",
    });
    const channelId = computeChannelId(config);
    const payload = envelopeVoucher({
      type: "voucher",
      channelConfig: config,
      voucher: {
        channelId,
        maxClaimableAmount: "1000",
        signature: "0xdead",
      },
    });

    const result = await scheme.verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrInvalidVoucherSignature);
  });

  it("uses ECDSA path (not ERC-1271) when payerAuthorizer is non-zero", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const account = privateKeyToAccount(
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    );
    const config = buildChannelConfig({ payerAuthorizer: account.address });
    const channelId = computeChannelId(config);
    const sig = await account.signTypedData({
      domain: {
        name: "x402 Batch Settlement",
        version: "1",
        chainId: 84532,
        verifyingContract: getAddress(BATCH_SETTLEMENT_ADDRESS),
      },
      types: {
        Voucher: [
          { name: "channelId", type: "bytes32" },
          { name: "maxClaimableAmount", type: "uint128" },
        ],
      },
      primaryType: "Voucher",
      message: { channelId, maxClaimableAmount: 1000n },
    });

    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);

    const payload = envelopeVoucher({
      type: "voucher",
      channelConfig: config,
      voucher: {
        channelId,
        maxClaimableAmount: "1000",
        signature: sig,
      },
    });

    const result = await scheme.verify(payload, makeRequirements());
    expect(result.isValid).toBe(true);
    expect(signer.verifyTypedData).not.toHaveBeenCalled();
  });

  it("propagates ErrRpcReadFailed when multicall reads fail", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "failure", error: new Error("revert") },
      { status: "failure", error: new Error("revert") },
      { status: "failure", error: new Error("revert") },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = makeVoucherPayload();

    await expect(scheme.verify(payload, makeRequirements())).rejects.toThrow(
      Errors.ErrRpcReadFailed,
    );
  });

  it("returns ChannelNotFound when balance is zero", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [0n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = makeVoucherPayload();

    const result = await scheme.verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrChannelNotFound);
  });

  it("returns CumulativeExceedsBalance when maxClaimable > balance", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [500n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = makeVoucherPayload({ voucher: { maxClaimableAmount: "1000" } });

    const result = await scheme.verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrCumulativeExceedsBalance);
  });

  it("returns CumulativeAmountBelowClaimed when maxClaimable <= totalClaimed", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 1000n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = makeVoucherPayload({ voucher: { maxClaimableAmount: "1000" } });

    const result = await scheme.verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrCumulativeAmountBelowClaimed);
  });

  it("accepts a refund payload whose maxClaimable equals totalClaimed", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 1000n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const refundVoucher: BatchSettlementRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: {
        channelId,
        maxClaimableAmount: "1000",
        signature: "0xdead",
      },
    };

    const result = await scheme.verify(envelopeRefund(refundVoucher), makeRequirements());
    expect(result.isValid).toBe(true);
  });

  it("still rejects a refund payload whose maxClaimable is below totalClaimed", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 1000n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const refundVoucher: BatchSettlementRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: {
        channelId,
        maxClaimableAmount: "500",
        signature: "0xdead",
      },
    };

    const result = await scheme.verify(envelopeRefund(refundVoucher), makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrCumulativeAmountBelowClaimed);
  });

  it("returns ChannelIdMismatch when payload channelId does not match config", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig();
    const payload = envelopeVoucher({
      type: "voucher",
      channelConfig: config,
      voucher: {
        channelId:
          "0x0000000000000000000000000000000000000000000000000000000000000099" as `0x${string}`,
        maxClaimableAmount: "1000",
        signature: "0xdead",
      },
    });

    const result = await scheme.verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrChannelIdMismatch);
  });
});

describe("BatchSettlementEvmScheme (Facilitator) — verifyDeposit", () => {
  const authorizer = buildAuthorizerSigner();

  function buildDeposit(overrides: Partial<BatchSettlementDepositPayload["deposit"]> = {}): {
    payload: PaymentPayload;
    channelId: `0x${string}`;
  } {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const now = Math.floor(Date.now() / 1000);
    const dp: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: {
        channelId,
        maxClaimableAmount: "1000",
        signature: "0xcafebabe",
      },
      deposit: {
        amount: "10000",
        authorization: {
          erc3009Authorization: {
            validAfter: String(now - 600),
            validBefore: String(now + 3600),
            salt: "0x0000000000000000000000000000000000000000000000000000000000000001",
            signature: "0xfeedface",
          },
        },
        ...overrides,
      },
    };
    return { payload: envelopeDeposit(dp), channelId };
  }

  it("returns isValid=true on the happy path", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 1_000_000n },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload, channelId } = buildDeposit();

    const result = await scheme.verify(payload, makeRequirements());
    expect(result.isValid).toBe(true);
    expect(result.payer).toBe(PAYER);
    expect(result.extra?.channelId).toBe(channelId);
  });

  it("returns InsufficientBalance when payer balance < deposit amount", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 1n },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = buildDeposit();

    const result = await scheme.verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrInsufficientBalance);
  });

  it("returns InvalidReceiveAuthorizationSignature when isValidSignature returns failure", async () => {
    const signer = buildSigner({
      readContract: vi.fn().mockImplementation(async (args: { functionName: string }) => {
        if (args.functionName === "isValidSignature") return "0xffffffff";
        if (args.functionName === "receivers") return [2500n, 0n];
        return undefined;
      }),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = buildDeposit();

    const result = await scheme.verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrInvalidReceiveAuthorizationSignature);
  });

  it("returns ErrErc3009AuthorizationRequired when authorization is absent", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const dp: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: {
        amount: "10000",
        authorization: {} as BatchSettlementDepositPayload["deposit"]["authorization"],
      },
    };
    const result = await scheme.verify(envelopeDeposit(dp), makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrErc3009AuthorizationRequired);
  });

  it("returns ErrMissingEip712Domain when extra lacks name/version", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = buildDeposit();
    const reqs = makeRequirements({
      extra: { receiverAuthorizer: RECEIVER_AUTHORIZER, assetTransferMethod: "eip3009" },
    });
    const result = await scheme.verify(payload, reqs);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrMissingEip712Domain);
  });

  it("returns ErrInvalidPayloadType when assetTransferMethod is not eip3009", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = buildDeposit();
    const reqs = makeRequirements({
      extra: {
        name: "USDC",
        version: "2",
        receiverAuthorizer: RECEIVER_AUTHORIZER,
        assetTransferMethod: "permit2",
      },
    });
    const result = await scheme.verify(payload, reqs);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrInvalidPayloadType);
  });

  it("returns ErrValidBeforeExpired when validBefore is in the past", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = buildDeposit({
      authorization: {
        erc3009Authorization: {
          validAfter: "0",
          validBefore: "1",
          salt: "0x0000000000000000000000000000000000000000000000000000000000000001",
          signature: "0xfeedface",
        },
      },
    });
    const result = await scheme.verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrValidBeforeExpired);
  });

  function buildPermit2Deposit(
    overrides: Partial<
      NonNullable<BatchSettlementDepositPayload["deposit"]["authorization"]["permit2Authorization"]>
    > = {},
  ): { payload: PaymentPayload; channelId: `0x${string}` } {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      from: PAYER,
      permitted: { token: ASSET, amount: "10000" },
      spender: PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
      nonce: "123",
      deadline: String(now + 3600),
      witness: { channelId },
      signature: "0xfeedface" as `0x${string}`,
      ...overrides,
    };
    const dp: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: {
        amount: "10000",
        authorization: { permit2Authorization: authorization },
      },
    };
    return { payload: envelopeDeposit(dp), channelId };
  }

  it("accepts a Permit2 deposit and simulates with the Permit2 collector", async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "isValidSignature") return "0x1626ba7e";
      if (functionName === "allowance") return 1_000_000n;
      return undefined;
    });
    const signer = buildSigner({ readContract });
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 1_000_000n },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = buildPermit2Deposit();

    const result = await scheme.verify(
      payload,
      makeRequirements({
        extra: {
          assetTransferMethod: "permit2",
          name: "USDC",
          version: "2",
          receiverAuthorizer: RECEIVER_AUTHORIZER,
        },
      }),
    );

    expect(result.isValid).toBe(true);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "deposit",
        args: expect.arrayContaining([getAddress(PERMIT2_DEPOSIT_COLLECTOR_ADDRESS)]),
      }),
    );
  });

  it("rejects Permit2 deposits with a wrong spender", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = buildPermit2Deposit({
      spender: "0x0000000000000000000000000000000000000001",
    });

    const result = await scheme.verify(
      payload,
      makeRequirements({
        extra: {
          assetTransferMethod: "permit2",
          name: "USDC",
          version: "2",
          receiverAuthorizer: RECEIVER_AUTHORIZER,
        },
      }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrPermit2InvalidSpender);
  });

  it("rejects Permit2 deposits whose amount differs from deposit.amount", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = buildPermit2Deposit({
      permitted: { token: ASSET, amount: "9999" },
    });

    const result = await scheme.verify(
      payload,
      makeRequirements({
        extra: {
          assetTransferMethod: "permit2",
          name: "USDC",
          version: "2",
          receiverAuthorizer: RECEIVER_AUTHORIZER,
        },
      }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrPermit2AmountMismatch);
  });

  it("rejects Permit2 deposits without Permit2 allowance or sponsoring data", async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "isValidSignature") return "0x1626ba7e";
      if (functionName === "allowance") return 1n;
      return undefined;
    });
    const signer = buildSigner({ readContract });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = buildPermit2Deposit();

    const result = await scheme.verify(
      payload,
      makeRequirements({
        extra: {
          assetTransferMethod: "permit2",
          name: "USDC",
          version: "2",
          receiverAuthorizer: RECEIVER_AUTHORIZER,
        },
      }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrPermit2AllowanceRequired);
  });

  it("rejects Permit2 deposits whose from does not match the channel payer", async () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    const { payload } = buildPermit2Deposit({
      from: "0x0000000000000000000000000000000000000001",
    });
    const result = await scheme.verify(
      payload,
      makeRequirements({
        extra: {
          assetTransferMethod: "permit2",
          name: "USDC",
          version: "2",
          receiverAuthorizer: RECEIVER_AUTHORIZER,
        },
      }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrPermit2InvalidSignature);
  });

  it("rejects Permit2 deposits whose token does not match requirements.asset", async () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    const { payload } = buildPermit2Deposit({
      permitted: { token: "0x0000000000000000000000000000000000000001", amount: "10000" },
    });
    const result = await scheme.verify(
      payload,
      makeRequirements({
        extra: {
          assetTransferMethod: "permit2",
          name: "USDC",
          version: "2",
          receiverAuthorizer: RECEIVER_AUTHORIZER,
        },
      }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrTokenMismatch);
  });

  it("rejects Permit2 deposits whose witness channelId does not match the voucher", async () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    const { payload } = buildPermit2Deposit({
      witness: { channelId: ("0x" + "11".repeat(32)) as `0x${string}` },
    });
    const result = await scheme.verify(
      payload,
      makeRequirements({
        extra: {
          assetTransferMethod: "permit2",
          name: "USDC",
          version: "2",
          receiverAuthorizer: RECEIVER_AUTHORIZER,
        },
      }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrChannelIdMismatch);
  });

  it("rejects Permit2 deposits whose deadline is already expired", async () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    const { payload } = buildPermit2Deposit({ deadline: "1" });
    const result = await scheme.verify(
      payload,
      makeRequirements({
        extra: {
          assetTransferMethod: "permit2",
          name: "USDC",
          version: "2",
          receiverAuthorizer: RECEIVER_AUTHORIZER,
        },
      }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrPermit2DeadlineExpired);
  });

  it("rejects a Permit2 deposit when the typed-data signature is invalid", async () => {
    const signer = buildSigner({
      getCode: vi.fn().mockResolvedValue("0x6080604052"),
      readContract: vi.fn().mockImplementation(args => {
        if (args.functionName === "isValidSignature") return Promise.resolve("0xffffffff");
        return Promise.resolve(undefined);
      }),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = buildPermit2Deposit();
    const result = await scheme.verify(
      payload,
      makeRequirements({
        extra: {
          assetTransferMethod: "permit2",
          name: "USDC",
          version: "2",
          receiverAuthorizer: RECEIVER_AUTHORIZER,
        },
      }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrPermit2InvalidSignature);
  });

  it("maps an allowance RPC failure to permit2_allowance_required", async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "isValidSignature") return "0x1626ba7e";
      if (functionName === "allowance") throw new Error("rpc down");
      return undefined;
    });
    const signer = buildSigner({ readContract });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = buildPermit2Deposit();
    const result = await scheme.verify(
      payload,
      makeRequirements({
        extra: {
          assetTransferMethod: "permit2",
          name: "USDC",
          version: "2",
          receiverAuthorizer: RECEIVER_AUTHORIZER,
        },
      }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrPermit2AllowanceRequired);
  });
});

describe("deposit-permit2 helpers", () => {
  it("throws when collector data is requested without a Permit2 authorization", () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const payload: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: { amount: "10000", authorization: {} },
    };
    expect(() => buildPermit2DepositCollectorData(payload)).toThrow(
      Errors.ErrPermit2AuthorizationRequired,
    );
  });

  it("builds a deposit transaction targeting the batch contract and Permit2 collector", () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const now = Math.floor(Date.now() / 1000);
    const payload: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: {
        amount: "10000",
        authorization: {
          permit2Authorization: {
            from: PAYER,
            permitted: { token: ASSET, amount: "10000" },
            spender: PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
            nonce: "123",
            deadline: String(now + 3600),
            witness: { channelId },
            signature: "0xfeedface",
          },
        },
      },
    };
    const tx = buildDepositTransaction(payload, "0xabcd", "0xef");
    expect(tx.to).toBe(getAddress(BATCH_SETTLEMENT_ADDRESS));
    expect(tx.data.endsWith("ef")).toBe(true);
    expect(tx.gas).toBe(300_000n);
    expect(getPermit2DepositCollectorAddress()).toBe(getAddress(PERMIT2_DEPOSIT_COLLECTOR_ADDRESS));
  });

  it("rejects an EIP-2612 branch whose approved amount does not match the deposit", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const now = Math.floor(Date.now() / 1000);
    const payload: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: {
        amount: "10000",
        authorization: {
          permit2Authorization: {
            from: PAYER,
            permitted: { token: ASSET, amount: "10000" },
            spender: PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
            nonce: "123",
            deadline: String(now + 3600),
            witness: { channelId },
            signature: "0xfeedface",
          },
        },
      },
    };
    const payment = envelopeDeposit(payload);
    payment.extensions = {
      eip2612GasSponsoring: {
        info: {
          from: PAYER,
          asset: ASSET,
          spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
          amount: "1",
          nonce: "1",
          deadline: String(now + 3600),
          signature: `0x${"aa".repeat(65)}`,
          version: "1",
        },
      },
    };
    const result = await resolvePermit2DepositBranch(
      buildSigner(),
      payment,
      payload,
      makeRequirements(),
    );
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: Errors.ErrEip2612AmountMismatch,
      payer: PAYER,
    });
  });

  it("rejects an EIP-2612 branch whose owner does not match the payer", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const now = Math.floor(Date.now() / 1000);
    const payload: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: {
        amount: "10000",
        authorization: {
          permit2Authorization: {
            from: PAYER,
            permitted: { token: ASSET, amount: "10000" },
            spender: PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
            nonce: "123",
            deadline: String(now + 3600),
            witness: { channelId },
            signature: "0xfeedface",
          },
        },
      },
    };
    const payment = envelopeDeposit(payload);
    payment.extensions = {
      eip2612GasSponsoring: {
        info: {
          from: "0x0000000000000000000000000000000000000001",
          asset: ASSET,
          spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
          amount: "10000",
          nonce: "1",
          deadline: String(now + 3600),
          signature: `0x${"aa".repeat(65)}`,
          version: "1",
        },
      },
    };
    const result = await resolvePermit2DepositBranch(
      buildSigner(),
      payment,
      payload,
      makeRequirements(),
    );
    expect(result).toMatchObject({ isValid: false, payer: PAYER });
  });

  it("verifyPermit2DepositAuthorization fails closed when the authorization is missing", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const payload: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: { amount: "10000", authorization: {} },
    };
    const result = await verifyPermit2DepositAuthorization(
      buildSigner(),
      envelopeDeposit(payload),
      payload,
      makeRequirements(),
      84532,
    );
    expect(result).toEqual({
      isValid: false,
      invalidReason: Errors.ErrPermit2AuthorizationRequired,
      payer: PAYER,
    });
  });

  it("rejects an ERC-20 approval branch when the extension signer is not registered", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const now = Math.floor(Date.now() / 1000);
    const payload: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: {
        amount: "10000",
        authorization: {
          permit2Authorization: {
            from: PAYER,
            permitted: { token: ASSET, amount: "10000" },
            spender: PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
            nonce: "123",
            deadline: String(now + 3600),
            witness: { channelId },
            signature: "0xfeedface",
          },
        },
      },
    };
    const payment = envelopeDeposit(payload);
    payment.extensions = {
      erc20ApprovalGasSponsoring: {
        info: {
          from: PAYER,
          asset: ASSET,
          spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
          amount: "10000",
          signedTransaction: "0x01",
          version: "1",
        },
        schema: {},
      },
    };
    const result = await resolvePermit2DepositBranch(
      buildSigner(),
      payment,
      payload,
      makeRequirements(),
    );
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: Errors.ErrErc20ApprovalUnavailable,
      payer: PAYER,
    });
  });

  it("rejects an ERC-20 approval branch with malformed extension info", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const now = Math.floor(Date.now() / 1000);
    const payload: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: {
        amount: "10000",
        authorization: {
          permit2Authorization: {
            from: PAYER,
            permitted: { token: ASSET, amount: "10000" },
            spender: PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
            nonce: "123",
            deadline: String(now + 3600),
            witness: { channelId },
            signature: "0xfeedface",
          },
        },
      },
    };
    const payment = envelopeDeposit(payload);
    payment.extensions = {
      erc20ApprovalGasSponsoring: {
        info: {
          from: PAYER,
          asset: ASSET,
          spender: PERMIT2_ADDRESS,
          amount: "10000",
          signedTransaction: "not-a-transaction",
          version: "1",
        },
        schema: {},
      },
    };
    const context = {
      getExtension: vi.fn().mockImplementation((key: string) => {
        if (key === ERC20_APPROVAL_GAS_SPONSORING_KEY) {
          return {
            signer: {
              sendTransactions: vi.fn(),
              waitForTransactionReceipt: vi.fn(),
            },
          };
        }
        return undefined;
      }),
    } as unknown as FacilitatorContext;
    const result = await resolvePermit2DepositBranch(
      buildSigner(),
      payment,
      payload,
      makeRequirements(),
      context,
    );
    expect(result).toMatchObject({ isValid: false, payer: PAYER });
  });

  it("rejects an ERC-20 approval branch when the registered signer payload does not match the payer", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const now = Math.floor(Date.now() / 1000);
    const payload: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: {
        amount: "10000",
        authorization: {
          permit2Authorization: {
            from: PAYER,
            permitted: { token: ASSET, amount: "10000" },
            spender: PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
            nonce: "123",
            deadline: String(now + 3600),
            witness: { channelId },
            signature: "0xfeedface",
          },
        },
      },
    };
    const payment = envelopeDeposit(payload);
    payment.extensions = {
      erc20ApprovalGasSponsoring: {
        info: {
          from: "0x0000000000000000000000000000000000000001",
          asset: ASSET,
          spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
          amount: "10000",
          signedTransaction: "0x01",
          version: "1",
        },
        schema: {},
      },
    };
    const context = {
      getExtension: vi.fn().mockImplementation((key: string) => {
        if (key === ERC20_APPROVAL_GAS_SPONSORING_KEY) {
          return {
            signer: {
              sendTransactions: vi.fn(),
              waitForTransactionReceipt: vi.fn(),
            },
          };
        }
        return undefined;
      }),
    } as unknown as FacilitatorContext;
    const result = await resolvePermit2DepositBranch(
      buildSigner(),
      payment,
      payload,
      makeRequirements(),
      context,
    );
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: ErrErc20ApprovalFromMismatch,
      payer: PAYER,
    });
  });

  it("rejects an EIP-2612 branch with malformed extension fields", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const now = Math.floor(Date.now() / 1000);
    const payload: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: {
        amount: "10000",
        authorization: {
          permit2Authorization: {
            from: PAYER,
            permitted: { token: ASSET, amount: "10000" },
            spender: PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
            nonce: "123",
            deadline: String(now + 3600),
            witness: { channelId },
            signature: "0xfeedface",
          },
        },
      },
    };
    const payment = envelopeDeposit(payload);
    payment.extensions = {
      eip2612GasSponsoring: {
        info: {
          from: PAYER,
          asset: ASSET,
          spender: PERMIT2_ADDRESS,
          amount: "not-an-integer",
          nonce: "1",
          deadline: String(now + 3600),
          signature: `0x${"aa".repeat(65)}`,
          version: "1",
        },
      },
    };
    const result = await resolvePermit2DepositBranch(
      buildSigner(),
      payment,
      payload,
      makeRequirements(),
    );
    expect(result).toMatchObject({ isValid: false, payer: PAYER });
  });

  it("rejects an EIP-2612 branch whose spender is not Permit2", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const now = Math.floor(Date.now() / 1000);
    const payload: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: {
        amount: "10000",
        authorization: {
          permit2Authorization: {
            from: PAYER,
            permitted: { token: ASSET, amount: "10000" },
            spender: PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
            nonce: "123",
            deadline: String(now + 3600),
            witness: { channelId },
            signature: "0xfeedface",
          },
        },
      },
    };
    const payment = envelopeDeposit(payload);
    payment.extensions = {
      eip2612GasSponsoring: {
        info: {
          from: PAYER,
          asset: ASSET,
          spender: "0x0000000000000000000000000000000000000002",
          amount: "10000",
          nonce: "1",
          deadline: String(now + 3600),
          signature: `0x${"aa".repeat(65)}`,
          version: "1",
        },
      },
    };
    const result = await resolvePermit2DepositBranch(
      buildSigner(),
      payment,
      payload,
      makeRequirements(),
    );
    expect(result).toMatchObject({ isValid: false, payer: PAYER });
  });

  it("rejects an EIP-2612 branch whose token does not match the payment asset", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const now = Math.floor(Date.now() / 1000);
    const payload: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: {
        amount: "10000",
        authorization: {
          permit2Authorization: {
            from: PAYER,
            permitted: { token: ASSET, amount: "10000" },
            spender: PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
            nonce: "123",
            deadline: String(now + 3600),
            witness: { channelId },
            signature: "0xfeedface",
          },
        },
      },
    };
    const payment = envelopeDeposit(payload);
    payment.extensions = {
      eip2612GasSponsoring: {
        info: {
          from: PAYER,
          asset: "0x0000000000000000000000000000000000000001",
          spender: PERMIT2_ADDRESS,
          amount: "10000",
          nonce: "1",
          deadline: String(now + 3600),
          signature: `0x${"aa".repeat(65)}`,
          version: "1",
        },
      },
    };
    const result = await resolvePermit2DepositBranch(
      buildSigner(),
      payment,
      payload,
      makeRequirements(),
    );
    expect(result).toMatchObject({ isValid: false, payer: PAYER });
  });

  it("rejects an EIP-2612 branch whose deadline is too soon", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const now = Math.floor(Date.now() / 1000);
    const payload: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: {
        amount: "10000",
        authorization: {
          permit2Authorization: {
            from: PAYER,
            permitted: { token: ASSET, amount: "10000" },
            spender: PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
            nonce: "123",
            deadline: String(now + 3600),
            witness: { channelId },
            signature: "0xfeedface",
          },
        },
      },
    };
    const payment = envelopeDeposit(payload);
    payment.extensions = {
      eip2612GasSponsoring: {
        info: {
          from: PAYER,
          asset: ASSET,
          spender: PERMIT2_ADDRESS,
          amount: "10000",
          nonce: "1",
          deadline: String(now),
          signature: `0x${"aa".repeat(65)}`,
          version: "1",
        },
      },
    };
    const result = await resolvePermit2DepositBranch(
      buildSigner(),
      payment,
      payload,
      makeRequirements(),
    );
    expect(result).toMatchObject({ isValid: false, payer: PAYER });
  });

  it("uses the EIP-2612 gas sponsoring branch when the bundled permit matches the deposit", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const now = Math.floor(Date.now() / 1000);
    const payload: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: {
        amount: "10000",
        authorization: {
          permit2Authorization: {
            from: PAYER,
            permitted: { token: ASSET, amount: "10000" },
            spender: PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
            nonce: "123",
            deadline: String(now + 3600),
            witness: { channelId },
            signature: "0xfeedface",
          },
        },
      },
    };
    const payment = envelopeDeposit(payload);
    payment.extensions = {
      eip2612GasSponsoring: {
        info: {
          from: PAYER,
          asset: ASSET,
          spender: PERMIT2_ADDRESS,
          amount: "10000",
          nonce: "1",
          deadline: String(now + 3600),
          signature: `0x${"aa".repeat(65)}`,
          version: "1",
        },
      },
    };
    const result = await resolvePermit2DepositBranch(
      buildSigner(),
      payment,
      payload,
      makeRequirements(),
    );
    expect(result).toMatchObject({ kind: "eip2612" });
    if ("kind" in result && result.kind === "eip2612") {
      expect(result.collectorData.startsWith("0x")).toBe(true);
      expect(result.collectorData.length).toBeGreaterThan(2);
    }
  });

  it("uses the standard branch when Permit2 allowance already covers the deposit", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const now = Math.floor(Date.now() / 1000);
    const payload: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: {
        amount: "10000",
        authorization: {
          permit2Authorization: {
            from: PAYER,
            permitted: { token: ASSET, amount: "10000" },
            spender: PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
            nonce: "123",
            deadline: String(now + 3600),
            witness: { channelId },
            signature: "0xfeedface",
          },
        },
      },
    };
    const signer = buildSigner({
      readContract: vi.fn().mockResolvedValue(20_000n),
    });
    const result = await resolvePermit2DepositBranch(
      signer,
      envelopeDeposit(payload),
      payload,
      makeRequirements(),
    );
    expect(result).toMatchObject({ kind: "standard" });
  });

  it("rejects the standard branch when Permit2 allowance is below the deposit amount", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const now = Math.floor(Date.now() / 1000);
    const payload: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: {
        amount: "10000",
        authorization: {
          permit2Authorization: {
            from: PAYER,
            permitted: { token: ASSET, amount: "10000" },
            spender: PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
            nonce: "123",
            deadline: String(now + 3600),
            witness: { channelId },
            signature: "0xfeedface",
          },
        },
      },
    };
    const signer = buildSigner({
      readContract: vi.fn().mockResolvedValue(100n),
    });
    const result = await resolvePermit2DepositBranch(
      signer,
      envelopeDeposit(payload),
      payload,
      makeRequirements(),
    );
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: Errors.ErrPermit2AllowanceRequired,
      payer: PAYER,
    });
  });
});

describe("BatchSettlementEvmScheme (Facilitator) — settle routing", () => {
  const authorizer = buildAuthorizerSigner();

  it("returns InvalidPayloadType for an unknown settle payload", async () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    const result = await scheme.settle(envelopeSettle({ unknown: true }), makeRequirements());
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrInvalidPayloadType);
  });

  it("dispatches deposit settle payloads via settleDeposit", async () => {
    const signer = buildSigner();
    // verifyDeposit uses a 4-call batch; post-tx readChannelState uses 3 calls with a
    // different shape — reusing the 4-tuple for the second batch mis-associates
    // token balance with pendingWithdrawals and throws.
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1_000_000n },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ])
      .mockResolvedValue([
        { status: "success", result: [10_000n, 0n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const now = Math.floor(Date.now() / 1000);

    const dp: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: {
        amount: "10000",
        authorization: {
          erc3009Authorization: {
            validAfter: String(now - 600),
            validBefore: String(now + 3600),
            salt: "0x0000000000000000000000000000000000000000000000000000000000000001",
            signature: "0xfeedface",
          },
        },
      },
    };

    const result = await scheme.settle(envelopeDeposit(dp), makeRequirements());
    expect(result.success).toBe(true);
    expect(result.amount).toBe("10000");
    expect(result.extra).toMatchObject({
      channelState: {
        channelId,
        balance: "10000",
        totalClaimed: "0",
        withdrawRequestedAt: 0,
        refundNonce: "0",
      },
    });
    expect(signer.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: getAddress(BATCH_SETTLEMENT_ADDRESS),
        functionName: "deposit",
      }),
    );
  });

  it("maps a deposit broadcast failure after verify succeeds", async () => {
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 1_000_000n },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const signer = buildSigner({
      writeContract: vi.fn().mockRejectedValue(new Error("replacement underpriced")),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const now = Math.floor(Date.now() / 1000);
    const dp: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: {
        amount: "10000",
        authorization: {
          erc3009Authorization: {
            validAfter: String(now - 600),
            validBefore: String(now + 3600),
            salt: "0x0000000000000000000000000000000000000000000000000000000000000001",
            signature: "0xfeedface",
          },
        },
      },
    };

    const result = await scheme.settle(envelopeDeposit(dp), makeRequirements());
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrDepositTransactionFailed);
    expect(result.errorMessage).toContain("replacement underpriced");
  });

  it("keeps a successful deposit when the post-receipt channel-state read fails", async () => {
    const signer = buildSigner();
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1_000_000n },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ])
      .mockRejectedValueOnce(new Error("rpc: channel state unavailable"));
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const now = Math.floor(Date.now() / 1000);
    const dp: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: {
        amount: "10000",
        authorization: {
          erc3009Authorization: {
            validAfter: String(now - 600),
            validBefore: String(now + 3600),
            salt: "0x0000000000000000000000000000000000000000000000000000000000000001",
            signature: "0xfeedface",
          },
        },
      },
    };

    const result = await scheme.settle(envelopeDeposit(dp), makeRequirements());

    expect(result.success).toBe(true);
    expect(result.transaction).toBe("0x" + "ab".repeat(32));
    expect(result.extra).toMatchObject({
      channelState: {
        channelId,
        balance: "10000",
        totalClaimed: "0",
        withdrawRequestedAt: 0,
        refundNonce: "0",
      },
    });
  });

  it("returns settlement_pending when the deposit receipt wait fails", async () => {
    const signer = buildSigner({
      waitForTransactionReceipt: vi.fn().mockRejectedValue(new Error("rpc: timeout")),
    });
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 1_000_000n },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const now = Math.floor(Date.now() / 1000);

    const dp: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: {
        amount: "10000",
        authorization: {
          erc3009Authorization: {
            validAfter: String(now - 600),
            validBefore: String(now + 3600),
            salt: "0x0000000000000000000000000000000000000000000000000000000000000003",
            signature: "0xfeedface",
          },
        },
      },
    };

    const result = await scheme.settle(envelopeDeposit(dp), makeRequirements());
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("settlement_pending");
    expect(result.transaction).toBe("0x" + "ab".repeat(32));
  });

  function buildErc20ApprovalPermit2Deposit(): {
    config: ChannelConfig;
    channelId: `0x${string}`;
    dp: BatchSettlementDepositPayload;
    reqs: PaymentRequirements;
  } {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const now = Math.floor(Date.now() / 1000);
    const dp: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: {
        amount: "10000",
        authorization: {
          permit2Authorization: {
            from: PAYER,
            permitted: { token: ASSET, amount: "10000" },
            spender: PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
            nonce: "123",
            deadline: String(now + 3600),
            witness: { channelId },
            signature: "0xfeedface",
          },
        },
      },
    };
    const reqs = makeRequirements({
      extra: {
        assetTransferMethod: "permit2",
        name: "USDC",
        version: "2",
        receiverAuthorizer: RECEIVER_AUTHORIZER,
      },
    });
    return { config, channelId, dp, reqs };
  }

  /**
   * Mocks `resolvePermit2DepositBranch` (consumed twice per settle call — once via
   * `verifyDeposit`, once via `settleDeposit`'s own execution resolution) to force the
   * erc20Approval branch without needing a full ERC-20-approval-extension payload.
   */
  function mockErc20ApprovalBranch(sendTransactions: () => Promise<`0x${string}`[]>): void {
    const branch = {
      kind: "erc20Approval" as const,
      collectorData: "0x" as `0x${string}`,
      signedTransaction: "0xsigned" as `0x${string}`,
      extensionSigner: {
        ...buildSigner(),
        sendTransactions: vi.fn(sendTransactions),
      } as Erc20ApprovalGasSponsoringSigner,
    };
    mockedResolvePermit2DepositBranch.mockResolvedValueOnce(branch);
    mockedResolvePermit2DepositBranch.mockResolvedValueOnce(branch);
  }

  it("accepts a single extension-signer hash for an erc20-approval deposit bundle when the balance confirms", async () => {
    const signer = buildSigner();
    const bundleTxHash = ("0x" + "ab".repeat(32)) as `0x${string}`;
    let sent = false;
    mockErc20ApprovalBranch(async () => {
      sent = true;
      return [bundleTxHash];
    });
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1_000_000n },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ])
      .mockImplementation(async () => [
        { status: "success", result: [sent ? 10_000n : 0n, 0n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ]);
    const scheme = new BatchSettlementEvmScheme(signer, buildAuthorizerSigner());
    const { dp, reqs } = buildErc20ApprovalPermit2Deposit();

    const result = await scheme.settle(envelopeDeposit(dp), reqs);

    expect(result.success).toBe(true);
    expect(result.transaction).toBe(bundleTxHash);
  });

  it("fails settle when deposit execution cannot be resolved after verify succeeded", async () => {
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 1_000_000n },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    mockedResolvePermit2DepositBranch
      .mockResolvedValueOnce({ kind: "standard", collectorData: "0x" })
      .mockResolvedValueOnce({
        isValid: false,
        invalidReason: Errors.ErrPermit2AllowanceRequired,
        payer: PAYER,
      });
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    const { dp, reqs } = buildErc20ApprovalPermit2Deposit();
    const result = await scheme.settle(envelopeDeposit(dp), reqs);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrPermit2AllowanceRequired);
  });

  it("fails a deposit when the extension signer returns an unexpected hash count", async () => {
    const signer = buildSigner();
    mockErc20ApprovalBranch(async () => [
      ("0x" + "11".repeat(32)) as `0x${string}`,
      ("0x" + "22".repeat(32)) as `0x${string}`,
      ("0x" + "33".repeat(32)) as `0x${string}`,
    ]);
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 1_000_000n },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, buildAuthorizerSigner());
    const { dp, reqs } = buildErc20ApprovalPermit2Deposit();

    const result = await scheme.settle(envelopeDeposit(dp), reqs);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrDepositTransactionFailed);
    expect(result.errorMessage).toMatch(/expected 1 \(atomic bundle\) or 2/);
  });

  it("fails an erc20-approval deposit bundle when a single extension-signer hash's balance never confirms", async () => {
    const signer = buildSigner();
    const bundleTxHash = ("0x" + "ab".repeat(32)) as `0x${string}`;
    mockErc20ApprovalBranch(async () => [bundleTxHash]);
    // Balance never reflects the deposit — e.g. because the single hash only
    // broadcast the approve and the deposit call never ran.
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1_000_000n },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ])
      .mockResolvedValue([
        { status: "success", result: [0n, 0n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ]);
    const scheme = new BatchSettlementEvmScheme(signer, buildAuthorizerSigner());
    const { dp, reqs } = buildErc20ApprovalPermit2Deposit();

    const result = await scheme.settle(envelopeDeposit(dp), reqs);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrDepositTransactionFailed);
  }, 10_000);

  it("returns settlement_pending for a single-hash erc20-approval bundle when the balance read errors", async () => {
    const signer = buildSigner();
    const bundleTxHash = ("0x" + "ab".repeat(32)) as `0x${string}`;
    mockErc20ApprovalBranch(async () => [bundleTxHash]);
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1_000_000n },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ])
      .mockRejectedValue(new Error("rpc: channel state unavailable"));
    const scheme = new BatchSettlementEvmScheme(signer, buildAuthorizerSigner());
    const { dp, reqs } = buildErc20ApprovalPermit2Deposit();

    const result = await scheme.settle(envelopeDeposit(dp), reqs);

    // The bundle receipt only proves some tx did not revert, not that the deposit
    // landed. With the confirming read failing, the outcome is unconfirmed rather than
    // a success, so settlement is pending with the broadcast hash for reconciliation.
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("settlement_pending");
    expect(result.transaction).toBe(bundleTxHash);
  }, 10_000);

  it('rejects voucher-less type:"deposit" envelopes as unknown payload type', async () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    const config = buildChannelConfig();
    const now = Math.floor(Date.now() / 1000);

    const voucherLessDeposit = {
      type: "deposit",
      channelConfig: config,
      deposit: {
        amount: "10000",
        authorization: {
          erc3009Authorization: {
            validAfter: String(now - 600),
            validBefore: String(now + 3600),
            salt: "0x0000000000000000000000000000000000000000000000000000000000000002",
            signature: "0xfeedface",
          },
        },
      },
    };

    const result = await scheme.settle(
      envelopeSettle(voucherLessDeposit as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrInvalidPayloadType);
  });

  it("dispatches settle payloads via executeSettle", async () => {
    const signer = buildSigner({
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: "success",
        logs: [buildSettledLog({ amount: "4321" })],
      }),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const sp: BatchSettlementSettlePayload = {
      type: "settle",
      receiver: RECEIVER,
      token: ASSET,
    };
    const result = await scheme.settle(
      envelopeSettle(sp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(true);
    expect(result.amount).toBe("4321");
    expect(signer.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "settle",
      }),
    );
  });

  it("submits settle with an explicit gas limit (not an auto-estimate)", async () => {
    // `settle` is bimodal on-chain — a no-op early-return when nothing is
    // claimed, an ERC-20 transfer otherwise. An auto-estimate that races a
    // node lagging the just-mined `claim` budgets the no-op path and reverts
    // out of gas. executeSettle must pass an explicit `gas`.
    const signer = buildSigner({
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: "success",
        logs: [buildSettledLog({ amount: "4321" })],
      }),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const sp: BatchSettlementSettlePayload = {
      type: "settle",
      receiver: RECEIVER,
      token: ASSET,
    };
    const result = await scheme.settle(
      envelopeSettle(sp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(true);
    const settleCall = (signer.writeContract as ReturnType<typeof vi.fn>).mock.calls.find(
      ([arg]) => arg?.functionName === "settle",
    );
    expect(settleCall).toBeDefined();
    expect(typeof settleCall?.[0].gas).toBe("bigint");
    expect(settleCall?.[0].gas).toBeGreaterThan(0n);
  });

  it("returns zero amount for no-op settle receipts without a Settled event", async () => {
    const signer = buildSigner({
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success", logs: [] }),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const sp: BatchSettlementSettlePayload = {
      type: "settle",
      receiver: RECEIVER,
      token: ASSET,
    };
    const result = await scheme.settle(
      envelopeSettle(sp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(true);
    expect(result.amount).toBe("0");
  });

  it("returns ErrNothingToSettle without submitting when receiver has no pending settlement", async () => {
    const signer = buildSigner({
      readContract: vi.fn().mockImplementation(args => {
        if (args.functionName === "receivers") return Promise.resolve([2500n, 2500n]);
        return Promise.resolve(undefined);
      }),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const sp: BatchSettlementSettlePayload = {
      type: "settle",
      receiver: RECEIVER,
      token: ASSET,
    };

    const result = await scheme.settle(
      envelopeSettle(sp as unknown as Record<string, unknown>),
      makeRequirements(),
    );

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrNothingToSettle);
    expect(signer.writeContract).not.toHaveBeenCalled();
  });

  it("returns empty amount when settle receipt logs are unavailable", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const sp: BatchSettlementSettlePayload = {
      type: "settle",
      receiver: RECEIVER,
      token: ASSET,
    };
    const result = await scheme.settle(
      envelopeSettle(sp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(true);
    expect(result.amount).toBe("");
  });

  it("returns settlement_pending when the settle receipt wait fails", async () => {
    const signer = buildSigner({
      waitForTransactionReceipt: vi.fn().mockRejectedValue(new Error("rpc: timeout")),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const sp: BatchSettlementSettlePayload = {
      type: "settle",
      receiver: RECEIVER,
      token: ASSET,
    };
    const result = await scheme.settle(
      envelopeSettle(sp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("settlement_pending");
    expect(result.transaction).toBe("0x" + "ab".repeat(32));
  });

  it("fails terminally (not settlement_pending) when the settle broadcast returns an invalid hash", async () => {
    const signer = buildSigner({
      writeContract: vi.fn().mockResolvedValue("not-a-hash" as `0x${string}`),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const sp: BatchSettlementSettlePayload = {
      type: "settle",
      receiver: RECEIVER,
      token: ASSET,
    };
    const result = await scheme.settle(
      envelopeSettle(sp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrSettleTransactionFailed);
    expect(result.transaction).toBe("");
  });

  it("returns settlement_pending when the settle receipt wait throws a programmer error", async () => {
    const signer = buildSigner({
      waitForTransactionReceipt: vi
        .fn()
        .mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'status')")),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const sp: BatchSettlementSettlePayload = {
      type: "settle",
      receiver: RECEIVER,
      token: ASSET,
    };
    const result = await scheme.settle(
      envelopeSettle(sp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("settlement_pending");
    expect(result.transaction).toBe("0x" + "ab".repeat(32));
  });

  it("dispatches claim payloads via executeClaimWithSignature", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const cp: BatchSettlementClaimPayload = {
      type: "claim",
      claims: [
        {
          voucher: { channel: config, maxClaimableAmount: "1000" },
          signature: "0xcafe",
          totalClaimed: "1000",
        },
      ],
    };
    const result = await scheme.settle(
      envelopeSettle(cp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(true);
    expect(result.amount).toBeUndefined();
    expect(signer.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "claimWithSignature" }),
    );
  });

  it("returns settlement_pending when the claim receipt wait fails", async () => {
    const signer = buildSigner({
      waitForTransactionReceipt: vi.fn().mockRejectedValue(new Error("rpc: timeout")),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const cp: BatchSettlementClaimPayload = {
      type: "claim",
      claims: [
        {
          voucher: { channel: config, maxClaimableAmount: "1000" },
          signature: "0xcafe",
          totalClaimed: "1000",
        },
      ],
    };
    const result = await scheme.settle(
      envelopeSettle(cp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("settlement_pending");
    expect(result.transaction).toBe("0x" + "ab".repeat(32));
  });

  it("returns ErrClaimSimulationFailed when claimWithSignature simulation reverts", async () => {
    const signer = buildSigner({
      readContract: vi.fn().mockImplementation(args => {
        if (args.functionName === "isValidSignature") return Promise.resolve("0x1626ba7e");
        if (args.functionName === "claimWithSignature") {
          return Promise.reject(new Error("execution reverted: InvalidClaim"));
        }
        return Promise.resolve(undefined);
      }),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const cp: BatchSettlementClaimPayload = {
      type: "claim",
      claims: [
        {
          voucher: { channel: config, maxClaimableAmount: "1000" },
          signature: "0xcafe",
          totalClaimed: "1000",
        },
      ],
    };
    const result = await scheme.settle(
      envelopeSettle(cp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrClaimSimulationFailed);
    expect(signer.writeContract).not.toHaveBeenCalled();
  });

  it("returns ErrClaimTransactionFailed when claim broadcast throws", async () => {
    const signer = buildSigner({
      writeContract: vi.fn().mockRejectedValue(new Error("nonce too low")),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const cp: BatchSettlementClaimPayload = {
      type: "claim",
      claims: [
        {
          voucher: { channel: config, maxClaimableAmount: "1000" },
          signature: "0xcafe",
          totalClaimed: "1000",
        },
      ],
    };
    const result = await scheme.settle(
      envelopeSettle(cp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrClaimTransactionFailed);
  });

  it("returns AuthorizerAddressMismatch when claim authorizer doesn't match config", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig({
      receiverAuthorizer: "0x1111111111111111111111111111111111111111",
    });
    const cp: BatchSettlementClaimPayload = {
      type: "claim",
      claims: [
        {
          voucher: { channel: config, maxClaimableAmount: "1000" },
          signature: "0xcafe",
          totalClaimed: "1000",
        },
      ],
    };
    const result = await scheme.settle(
      envelopeSettle(cp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrAuthorizerAddressMismatch);
  });

  it("dispatches unsigned claims via claim() when submitMode is direct", async () => {
    const pool = buildSigner();
    const authorizerSubmitter = buildSigner({
      getAddresses: () => [authorizer.address],
    });
    const scheme = new BatchSettlementEvmScheme(pool, authorizer, {
      submitMode: "direct",
      authorizerSubmitter,
    });
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const cp: BatchSettlementClaimPayload = {
      type: "claim",
      claims: [
        {
          voucher: { channel: config, maxClaimableAmount: "1000" },
          signature: "0xcafe",
          totalClaimed: "1000",
        },
      ],
    };
    const result = await scheme.settle(
      envelopeSettle(cp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(true);
    expect(authorizerSubmitter.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "claim" }),
    );
    expect(pool.writeContract).not.toHaveBeenCalled();
  });

  it("relays a pre-signed claim even when submitMode is direct", async () => {
    const pool = buildSigner();
    const authorizerSubmitter = buildSigner({
      getAddresses: () => [authorizer.address],
    });
    const scheme = new BatchSettlementEvmScheme(pool, authorizer, {
      submitMode: "direct",
      authorizerSubmitter,
    });
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const cp: BatchSettlementClaimPayload = {
      type: "claim",
      claims: [
        {
          voucher: { channel: config, maxClaimableAmount: "1000" },
          signature: "0xcafe",
          totalClaimed: "1000",
        },
      ],
      claimAuthorizerSignature: "0xpresigned",
    };
    const result = await scheme.settle(
      envelopeSettle(cp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(true);
    expect(pool.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "claimWithSignature" }),
    );
    expect(authorizerSubmitter.writeContract).not.toHaveBeenCalled();
  });

  it("returns ErrClaimSimulationFailed for a stale direct claim without broadcasting", async () => {
    const authorizerSubmitter = buildSigner({
      getAddresses: () => [authorizer.address],
      readContract: vi.fn().mockImplementation(args => {
        if (args.functionName === "claim") {
          return Promise.reject(new Error("execution reverted: NothingToClaim"));
        }
        return Promise.resolve(undefined);
      }),
    });
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      submitMode: "direct",
      authorizerSubmitter,
    });
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const cp: BatchSettlementClaimPayload = {
      type: "claim",
      claims: [
        {
          voucher: { channel: config, maxClaimableAmount: "1000" },
          signature: "0xcafe",
          totalClaimed: "1000",
        },
      ],
    };
    const result = await scheme.settle(
      envelopeSettle(cp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrClaimSimulationFailed);
    expect(authorizerSubmitter.writeContract).not.toHaveBeenCalled();
  });

  it("dispatches enriched refund payloads via executeRefundWithSignature", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config);
    const rp: BatchSettlementEnrichedRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: {
        channelId,
        maxClaimableAmount: "0",
        signature: "0xdead",
      },
      amount: "9000",
      refundNonce: "0",
      claims: [],
    };
    const result = await scheme.settle(
      envelopeSettle(rp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(true);
    expect(result.amount).toBe("9000");
    expect(result.extra).toMatchObject({
      channelState: {
        channelId,
        balance: "1000",
        totalClaimed: "0",
        withdrawRequestedAt: 0,
        refundNonce: "1",
      },
    });
    expect(mockedMulticall).toHaveBeenCalledTimes(1);
    expect(signer.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "refundWithSignature" }),
    );
  });

  it("dispatches unsigned refunds via refund() when submitMode is direct", async () => {
    const pool = buildSigner();
    const authorizerSubmitter = buildSigner({
      getAddresses: () => [authorizer.address],
    });
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(pool, authorizer, {
      submitMode: "direct",
      authorizerSubmitter,
    });
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config);
    const rp: BatchSettlementEnrichedRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: {
        channelId,
        maxClaimableAmount: "0",
        signature: "0xdead",
      },
      amount: "9000",
      refundNonce: "0",
      claims: [],
    };
    const result = await scheme.settle(
      envelopeSettle(rp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(true);
    expect(authorizerSubmitter.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "refund" }),
    );
    expect(pool.writeContract).not.toHaveBeenCalled();
  });

  it("returns settlement_pending when the refund receipt wait fails", async () => {
    const signer = buildSigner({
      waitForTransactionReceipt: vi.fn().mockRejectedValue(new Error("rpc: timeout")),
    });
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config);
    const rp: BatchSettlementEnrichedRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: {
        channelId,
        maxClaimableAmount: "0",
        signature: "0xdead",
      },
      amount: "9000",
      refundNonce: "0",
      claims: [],
    };
    const result = await scheme.settle(
      envelopeSettle(rp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("settlement_pending");
    expect(result.transaction).toBe("0x" + "ab".repeat(32));
  });

  it("returns ErrRefundSimulationFailed when refundWithSignature simulation reverts", async () => {
    const signer = buildSigner({
      readContract: vi.fn().mockImplementation(args => {
        if (args.functionName === "isValidSignature") return Promise.resolve("0x1626ba7e");
        if (args.functionName === "refundWithSignature") {
          return Promise.reject(new Error("execution reverted: RefundExpired"));
        }
        return Promise.resolve(undefined);
      }),
    });
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config);
    const rp: BatchSettlementEnrichedRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "0", signature: "0xdead" },
      amount: "9000",
      refundNonce: "0",
      claims: [],
    };
    const result = await scheme.settle(
      envelopeSettle(rp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrRefundSimulationFailed);
    expect(signer.writeContract).not.toHaveBeenCalled();
  });

  it("batches claim+refund via multicall and maps a simulation revert", async () => {
    const signer = buildSigner({
      readContract: vi.fn().mockImplementation(args => {
        if (args.functionName === "isValidSignature") return Promise.resolve("0x1626ba7e");
        if (args.functionName === "multicall") {
          return Promise.reject(new Error("execution reverted: ClaimFailed"));
        }
        return Promise.resolve(undefined);
      }),
    });
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config);
    const rp: BatchSettlementEnrichedRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "0", signature: "0xdead" },
      amount: "1000",
      refundNonce: "0",
      claims: [
        {
          voucher: { channel: config, maxClaimableAmount: "1000" },
          signature: "0xcafe",
          totalClaimed: "0",
        },
      ],
    };
    const failed = await scheme.settle(
      envelopeSettle(rp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(failed.success).toBe(false);
    expect(failed.errorReason).toBe(Errors.ErrRefundSimulationFailed);

    const okSigner = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const ok = await new BatchSettlementEvmScheme(okSigner, authorizer).settle(
      envelopeSettle(rp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(ok.success).toBe(true);
    expect(okSigner.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "multicall" }),
    );
  });

  it("returns AuthorizerAddressMismatch when refund authorizer doesn't match config", async () => {
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    const config = buildChannelConfig({
      receiverAuthorizer: "0x1111111111111111111111111111111111111111",
    });
    const channelId = computeChannelId(config);
    const rp: BatchSettlementEnrichedRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "0", signature: "0xdead" },
      amount: "9000",
      refundNonce: "0",
      claims: [],
    };
    const result = await scheme.settle(
      envelopeSettle(rp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrAuthorizerAddressMismatch);
  });

  it("returns RefundNoBalance without submitting when a refund would transfer zero tokens", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 10000n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config);
    const rp: BatchSettlementEnrichedRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: {
        channelId,
        maxClaimableAmount: "10000",
        signature: "0xdead",
      },
      amount: "9000",
      refundNonce: "0",
      claims: [],
    };

    const result = await scheme.settle(
      envelopeSettle(rp as unknown as Record<string, unknown>),
      makeRequirements(),
    );

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrRefundNoBalance);
    expect(signer.writeContract).not.toHaveBeenCalled();
  });

  it("polls post-refund state when a withdrawal is pending", async () => {
    const signer = buildSigner();
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [10000n, 0n] },
        { status: "success", result: [5000n, 1234n] },
        { status: "success", result: 7n },
      ])
      .mockResolvedValueOnce([
        { status: "success", result: [8000n, 0n] },
        { status: "success", result: [3000n, 1234n] },
        { status: "success", result: 8n },
      ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config);
    const rp: BatchSettlementEnrichedRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: {
        channelId,
        maxClaimableAmount: "0",
        signature: "0xdead",
      },
      amount: "2000",
      refundNonce: "7",
      claims: [],
    };

    const result = await scheme.settle(
      envelopeSettle(rp as unknown as Record<string, unknown>),
      makeRequirements(),
    );

    expect(result.success).toBe(true);
    expect(result.amount).toBe("2000");
    expect(result.extra).toMatchObject({
      channelState: {
        channelId,
        balance: "8000",
        withdrawRequestedAt: 1234,
        refundNonce: "8",
      },
    });
    expect(mockedMulticall).toHaveBeenCalledTimes(2);
  });

  it("returns ErrRpcReadFailed when the receivers() read throws", async () => {
    const signer = buildSigner({
      readContract: vi.fn().mockRejectedValue(new Error("rpc timeout")),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const result = await scheme.settle(
      envelopeSettle({ type: "settle", receiver: RECEIVER, token: ASSET }),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrRpcReadFailed);
  });

  it("returns ErrSettleSimulationFailed when settle simulation reverts", async () => {
    const signer = buildSigner({
      readContract: vi.fn().mockImplementation(args => {
        if (args.functionName === "receivers") return Promise.resolve([2500n, 0n]);
        return Promise.reject(new Error("revert"));
      }),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const sp: BatchSettlementSettlePayload = {
      type: "settle",
      receiver: RECEIVER,
      token: ASSET,
    };
    const result = await scheme.settle(
      envelopeSettle(sp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrSettleSimulationFailed);
  });

  it("maps a settle broadcast throw to ErrSettleTransactionFailed", async () => {
    const signer = buildSigner({
      writeContract: vi.fn().mockRejectedValue(new Error("replacement underpriced")),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const result = await scheme.settle(
      envelopeSettle({ type: "settle", receiver: RECEIVER, token: ASSET }),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrSettleTransactionFailed);
    expect(result.errorMessage).toContain("replacement underpriced");
  });

  it("stringifies a non-Error settle broadcast rejection", async () => {
    const signer = buildSigner({
      writeContract: vi.fn().mockRejectedValue("replacement underpriced"),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const result = await scheme.settle(
      envelopeSettle({ type: "settle", receiver: RECEIVER, token: ASSET }),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrSettleTransactionFailed);
    expect(result.errorMessage).toBe("replacement underpriced");
  });

  it("returns ErrSettleTransactionFailed when settle receipt is not success", async () => {
    const signer = buildSigner({
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "reverted" }),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const sp: BatchSettlementSettlePayload = {
      type: "settle",
      receiver: RECEIVER,
      token: ASSET,
    };
    const result = await scheme.settle(
      envelopeSettle(sp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrSettleTransactionFailed);
  });
});

describe("BatchSettlementEvmScheme (Facilitator) — managed HTTP afterClaim", () => {
  const authorizer = buildAuthorizerSigner();

  function buildStoredChannel(
    config: ChannelConfig,
    overrides: Partial<FacilitatorChannel> = {},
  ): FacilitatorChannel {
    const channelId = computeChannelId(config);
    return {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0xcafe",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
      network: NETWORK,
      chargeCount: 4,
      ...overrides,
    };
  }

  it("applies afterClaim on a successful managed type:claim", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      voucherStore: { storage },
    });
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const stored = buildStoredChannel(config);
    await storage.updateChannel(stored.channelId, () => stored);

    const result = await scheme.settle(
      envelopeSettle({
        type: "claim",
        claims: [
          {
            voucher: { channel: config, maxClaimableAmount: "1000" },
            signature: "0xcafe",
            totalClaimed: "1000",
          },
        ],
      }),
      makeRequirements({
        extra: {
          ...makeRequirements().extra,
          voucherStore: true,
        },
      }),
    );

    expect(result.success).toBe(true);
    const updated = await storage.get(stored.channelId);
    expect(updated?.totalClaimed).toBe("1000");
    expect(updated?.chargeCount).toBe(0);
    expect(updated).toBeDefined();
  });

  it("leaves the store unchanged when a managed claim fails simulation", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const signer = buildSigner({
      readContract: vi.fn().mockImplementation(args => {
        if (args.functionName === "claimWithSignature") {
          return Promise.reject(new Error("execution reverted: NothingToClaim"));
        }
        return Promise.resolve(undefined);
      }),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer, {
      voucherStore: { storage },
    });
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const stored = buildStoredChannel(config);
    await storage.updateChannel(stored.channelId, () => stored);

    const result = await scheme.settle(
      envelopeSettle({
        type: "claim",
        claims: [
          {
            voucher: { channel: config, maxClaimableAmount: "1000" },
            signature: "0xcafe",
            totalClaimed: "1000",
          },
        ],
      }),
      makeRequirements({
        extra: {
          ...makeRequirements().extra,
          voucherStore: true,
        },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrClaimSimulationFailed);
    const updated = await storage.get(stored.channelId);
    expect(updated?.totalClaimed).toBe("0");
    expect(updated?.chargeCount).toBe(4);
  });
});

describe("BatchSettlementEvmScheme (Facilitator) — managed watermark after prior claim", () => {
  const authorizer = buildAuthorizerSigner();

  function managedRequirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
    return makeRequirements({
      amount: "10000",
      extra: {
        name: "USDC",
        version: "2",
        receiverAuthorizer: authorizer.address,
        assetTransferMethod: "eip3009",
        withdrawDelay: 900,
        voucherStore: true,
      },
      ...overrides,
    });
  }

  function buildManagedDeposit(maxClaimableAmount: string): {
    payload: PaymentPayload;
    channelId: `0x${string}`;
    config: ChannelConfig;
  } {
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config);
    const now = Math.floor(Date.now() / 1000);
    const dp: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount, signature: "0xcafebabe" },
      deposit: {
        amount: "100000",
        authorization: {
          erc3009Authorization: {
            validAfter: String(now - 600),
            validBefore: String(now + 3600),
            salt: "0x0000000000000000000000000000000000000000000000000000000000000001",
            signature: "0xfeedface",
          },
        },
      },
    };
    return { payload: envelopeDeposit(dp), channelId, config };
  }

  function mockClaimedChannelMulticall(totalClaimed: bigint, balance = totalClaimed): void {
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [balance, totalClaimed] },
        { status: "success", result: 1_000_000n },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1n },
      ])
      .mockResolvedValue([
        { status: "success", result: [balance + 100_000n, totalClaimed] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1n },
      ]);
  }

  it("accepts a top-up deposit whose voucher continues from onchain totalClaimed", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      voucherStore: { storage },
    });
    mockClaimedChannelMulticall(19_200n);
    const { payload } = buildManagedDeposit("29200");

    const result = await scheme.verify(payload, managedRequirements());
    expect(result.isValid).toBe(true);
    expect(result.extra?.chargedCumulativeAmount).toBe("19200");
  });

  it("rejects a top-up deposit whose voucher does not continue from onchain totalClaimed", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      voucherStore: { storage },
    });
    mockClaimedChannelMulticall(19_200n);
    // Passes the onchain "above claimed" check (24200 > 19200) but is not
    // charged(19200) + amount(10000).
    const { payload, channelId } = buildManagedDeposit("24200");

    const result = await scheme.verify(payload, managedRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrCumulativeAmountMismatch);
    expect(result.extra).toMatchObject({
      channelState: {
        channelId,
        chargedCumulativeAmount: "19200",
        totalClaimed: "19200",
      },
    });
  });

  it("commits a managed deposit charge from onchain totalClaimed, not zero", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      voucherStore: { storage },
    });
    mockClaimedChannelMulticall(19_200n);
    const { payload, channelId } = buildManagedDeposit("29200");

    const result = await scheme.settle(payload, managedRequirements());
    expect(result.success).toBe(true);
    expect(result.extra).toMatchObject({
      chargedAmount: "10000",
      chargeCount: 1,
      channelState: {
        channelId,
        chargedCumulativeAmount: "29200",
        totalClaimed: "19200",
      },
    });
    expect(Object.keys(result.extra ?? {})).toEqual([
      "channelState",
      "chargedAmount",
      "chargeCount",
    ]);
    const stored = await storage.get(channelId);
    expect(stored?.chargedCumulativeAmount).toBe("29200");
    expect(stored?.totalClaimed).toBe("19200");
  });

  it("overlays a stored row with the post-deposit confirm snapshot on top-up", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const { payload, channelId, config } = buildManagedDeposit("29200");
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "19200",
      signedMaxClaimable: "19200",
      signature: "0xold",
      balance: "19200",
      totalClaimed: "19200",
      withdrawRequestedAt: 0,
      refundNonce: 1,
      lastRequestTimestamp: 1,
      network: NETWORK,
      chargeCount: 3,
    }));
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      voucherStore: { storage },
    });
    mockClaimedChannelMulticall(19_200n);

    const result = await scheme.settle(payload, managedRequirements());
    expect(result.success).toBe(true);
    expect(result.extra).toMatchObject({
      chargedAmount: "10000",
      chargeCount: 4,
      channelState: {
        channelId,
        balance: "119200",
        chargedCumulativeAmount: "29200",
        totalClaimed: "19200",
        refundNonce: "1",
      },
    });
    expect(Object.keys(result.extra ?? {})).toEqual([
      "channelState",
      "chargedAmount",
      "chargeCount",
    ]);
    const stored = await storage.get(channelId);
    expect(stored?.balance).toBe("119200");
    expect(stored?.chargedCumulativeAmount).toBe("29200");
    expect(stored?.chargeCount).toBe(4);
  });

  it("still returns onchain deposit success when the managed charge would exceed the signed cap", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      voucherStore: { storage },
    });
    mockClaimedChannelMulticall(19_200n);
    const { payload, channelId, config } = buildManagedDeposit("20100");
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "20000",
      signedMaxClaimable: "20000",
      signature: "0xold",
      balance: "119200",
      totalClaimed: "19200",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
      network: NETWORK,
      chargeCount: 2,
    }));

    const result = await scheme.settle(payload, managedRequirements());
    expect(result.success).toBe(true);
    expect((await storage.get(channelId))?.chargedCumulativeAmount).toBe("20000");
    expect((await storage.get(channelId))?.chargeCount).toBe(2);
  });
});

describe("BatchSettlementEvmScheme (Facilitator) — managed voucher store edge cases", () => {
  const authorizer = buildAuthorizerSigner();
  const refundAuthorizer = buildAuthorizerSigner();

  function managedRequirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
    return makeRequirements({
      amount: "1000",
      extra: {
        name: "USDC",
        version: "2",
        receiverAuthorizer: authorizer.address,
        assetTransferMethod: "eip3009",
        withdrawDelay: 900,
        voucherStore: true,
      },
      ...overrides,
    });
  }

  function mockOpenChannelMulticall(balance = 10_000n, totalClaimed = 0n): void {
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [balance, totalClaimed] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
  }

  function buildManagedVoucher(
    maxClaimableAmount: string,
    configOverrides: Partial<ChannelConfig> = {},
  ): { payload: PaymentPayload; channelId: `0x${string}`; config: ChannelConfig } {
    const config = buildChannelConfig({
      receiverAuthorizer: authorizer.address,
      ...configOverrides,
    });
    const channelId = computeChannelId(config);
    const vp: BatchSettlementVoucherPayload = {
      type: "voucher",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount, signature: "0xfeedface" },
    };
    return { payload: envelopeVoucher(vp), channelId, config };
  }

  async function seedStoredChannel(
    storage: InMemoryChannelStorage<FacilitatorChannel>,
    config: ChannelConfig,
    overrides: Partial<FacilitatorChannel> = {},
  ): Promise<FacilitatorChannel> {
    const channelId = computeChannelId(config);
    const row: FacilitatorChannel = {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      signature: "0xoldsig",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
      network: NETWORK,
      chargeCount: 2,
      ...overrides,
    };
    await storage.updateChannel(channelId, () => row);
    return row;
  }

  it("rejects verify when another admission lock is already held on the channel", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      voucherStore: { storage },
    });
    mockOpenChannelMulticall();
    const { payload, channelId } = buildManagedVoucher("6000");
    await storage.acquire(channelId, "other-pending", 60_000);

    const result = await scheme.verify(payload, managedRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrChannelBusy);
  });

  it("rejects verify when advertised receiverAuthorizer does not match the facilitator key", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      voucherStore: { storage },
    });
    mockOpenChannelMulticall();
    const { payload } = buildManagedVoucher("6000");

    const result = await scheme.verify(
      payload,
      managedRequirements({
        extra: {
          name: "USDC",
          version: "2",
          receiverAuthorizer: RECEIVER_AUTHORIZER,
          assetTransferMethod: "eip3009",
          withdrawDelay: 900,
          voucherStore: true,
        },
      }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrReceiverAuthorizerMismatch);
  });

  it("rejects verify when withdrawDelay disagrees with the facilitator store config", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      voucherStore: { storage, withdrawDelay: 1800 },
    });
    mockOpenChannelMulticall();
    const { payload } = buildManagedVoucher("6000");

    const result = await scheme.verify(payload, managedRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrWithdrawDelayMismatch);
  });

  it("rejects verify when packed refundAuthorizer in salt disagrees with the 402", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      voucherStore: { storage },
    });
    mockOpenChannelMulticall();
    const salt = packRefundAuthorizerSalt(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      refundAuthorizer.address,
    );
    const { payload } = buildManagedVoucher("6000", { salt });

    const result = await scheme.verify(
      payload,
      managedRequirements({
        extra: {
          name: "USDC",
          version: "2",
          receiverAuthorizer: authorizer.address,
          assetTransferMethod: "eip3009",
          withdrawDelay: 900,
          voucherStore: true,
          refundAuthorizer: RECEIVER_AUTHORIZER,
        },
      }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrRefundAuthorizerMismatch);
  });

  it("requires a refund voucher ceiling equal to the stored watermark, not watermark plus amount", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      voucherStore: { storage },
    });
    mockOpenChannelMulticall();
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    await seedStoredChannel(storage, config);
    const channelId = computeChannelId(config);
    const payload = envelopeRefund({
      type: "refund",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "6000", signature: "0xdead" },
    });

    const result = await scheme.verify(payload, managedRequirements({ amount: "0" }));
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrCumulativeAmountMismatch);
  });

  it("rejects managed voucher settle when the charge would exceed the signed cumulative cap", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      voucherStore: { storage },
    });
    const { payload, config, channelId } = buildManagedVoucher("3000");
    await seedStoredChannel(storage, config, { chargedCumulativeAmount: "2500" });
    await storage.acquire(channelId, "0xpending", 60_000);

    const result = await scheme.settle(
      {
        ...payload,
        payload: { ...payload.payload, pendingId: "0xpending" },
      },
      managedRequirements({ amount: "1000" }),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrChargeExceedsSignedCumulative);
  });

  it("increments chargeCount on a successful managed voucher settle", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      voucherStore: { storage },
    });
    const { payload, config, channelId } = buildManagedVoucher("6000");
    await seedStoredChannel(storage, config);
    await storage.acquire(channelId, "0xpending", 60_000);

    const result = await scheme.settle(
      {
        ...payload,
        payload: { ...payload.payload, pendingId: "0xpending" },
      },
      managedRequirements({ amount: "1000" }),
    );
    expect(result.success).toBe(true);
    expect(result.extra?.chargeCount).toBe(3);
    expect(result.transaction).toBe("");
    const stored = await storage.get(channelId);
    expect(stored?.chargedCumulativeAmount).toBe("6000");
  });

  it("rejects managed refund settle without refundAuthorizer consent signature", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      voucherStore: { storage },
    });
    const salt = packRefundAuthorizerSalt(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      refundAuthorizer.address,
    );
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address, salt });
    const channelId = computeChannelId(config);
    await seedStoredChannel(storage, config);
    const payload = envelopeRefund({
      type: "refund",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "5000", signature: "0xdead" },
      amount: "1000",
    });

    const result = await scheme.settle(
      payload,
      managedRequirements({
        amount: "0",
        extra: {
          name: "USDC",
          version: "2",
          receiverAuthorizer: authorizer.address,
          assetTransferMethod: "eip3009",
          withdrawDelay: 900,
          voucherStore: true,
          refundAuthorizer: refundAuthorizer.address,
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrRefundAuthorizerSignature);
  });

  it("settles a managed refund when refundAuthorizer EIP-712 consent matches the request", async () => {
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [10000n, 5000n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ])
      .mockResolvedValue([
        { status: "success", result: [5000n, 5000n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1n },
      ]);
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const salt = packRefundAuthorizerSalt(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      refundAuthorizer.address,
    );
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address, salt });
    const channelId = computeChannelId(config);
    await seedStoredChannel(storage, config, {
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      balance: "10000",
      totalClaimed: "0",
      chargeCount: 0,
      signature: "0xdead",
    });
    const refundAmount = "5000";
    const refundAuthorizerSignature = await signRefund(
      refundAuthorizer,
      channelId,
      refundAmount,
      "0",
      NETWORK,
    );
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      voucherStore: { storage },
    });
    const payload = envelopeRefund({
      type: "refund",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "5000", signature: "0xdead" },
      amount: refundAmount,
      refundAuthorizerSignature,
    });

    const result = await scheme.settle(
      payload,
      managedRequirements({
        amount: "0",
        extra: {
          name: "USDC",
          version: "2",
          receiverAuthorizer: authorizer.address,
          assetTransferMethod: "eip3009",
          withdrawDelay: 900,
          voucherStore: true,
          refundAuthorizer: refundAuthorizer.address,
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(await storage.get(channelId)).toBeUndefined();
  });

  it("allows a managed refund without authorizer signature when caller identity matches the store", async () => {
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [10000n, 5000n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ])
      .mockResolvedValue([
        { status: "success", result: [5000n, 5000n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1n },
      ]);
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config);
    await seedStoredChannel(storage, config, {
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      balance: "10000",
      totalClaimed: "0",
      chargeCount: 0,
      callerIdentity: "tenant-42",
      signature: "0xdead",
    });
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      voucherStore: { storage },
      resolveCallerIdentity: async () => "tenant-42",
    });
    const payload = envelopeRefund({
      type: "refund",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "5000", signature: "0xdead" },
      amount: "5000",
    });

    const result = await scheme.settle(payload, managedRequirements({ amount: "0" }));
    expect(result.success).toBe(true);
    expect(await storage.get(channelId)).toBeUndefined();
  });

  it("charges the first managed voucher against onchain totalClaimed when the store is empty", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      voucherStore: { storage },
    });
    mockOpenChannelMulticall();
    const { payload, channelId } = buildManagedVoucher("1000");

    const result = await scheme.settle(payload, managedRequirements({ amount: "1000" }));
    expect(result.success).toBe(true);
    expect((await storage.get(channelId))?.chargedCumulativeAmount).toBe("1000");
  });

  it("rejects managed refund settle when EIP-712 consent does not match the requested amount", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const salt = packRefundAuthorizerSalt(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      refundAuthorizer.address,
    );
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address, salt });
    const channelId = computeChannelId(config);
    await seedStoredChannel(storage, config, {
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      signature: "0xdead",
    });
    const refundAuthorizerSignature = await signRefund(
      refundAuthorizer,
      channelId,
      "4999",
      "0",
      NETWORK,
    );
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      voucherStore: { storage },
    });
    const payload = envelopeRefund({
      type: "refund",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "5000", signature: "0xdead" },
      amount: "5000",
      refundAuthorizerSignature,
    });

    const result = await scheme.settle(
      payload,
      managedRequirements({
        amount: "0",
        extra: {
          name: "USDC",
          version: "2",
          receiverAuthorizer: authorizer.address,
          assetTransferMethod: "eip3009",
          withdrawDelay: 900,
          voucherStore: true,
          refundAuthorizer: refundAuthorizer.address,
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrRefundAuthorizerSignature);
  });

  it("updates the store after a partial managed refund instead of deleting the row", async () => {
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [10000n, 5000n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ])
      .mockResolvedValue([
        { status: "success", result: [6000n, 5000n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1n },
      ]);
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const salt = packRefundAuthorizerSalt(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      refundAuthorizer.address,
    );
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address, salt });
    const channelId = computeChannelId(config);
    await seedStoredChannel(storage, config, {
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      balance: "10000",
      totalClaimed: "0",
      chargeCount: 1,
      signature: "0xdead",
    });
    const refundAmount = "4000";
    const refundAuthorizerSignature = await signRefund(
      refundAuthorizer,
      channelId,
      refundAmount,
      "0",
      NETWORK,
    );
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      voucherStore: { storage },
    });
    const payload = envelopeRefund({
      type: "refund",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "5000", signature: "0xdead" },
      amount: refundAmount,
      refundAuthorizerSignature,
    });

    const result = await scheme.settle(
      payload,
      managedRequirements({
        amount: "0",
        extra: {
          name: "USDC",
          version: "2",
          receiverAuthorizer: authorizer.address,
          assetTransferMethod: "eip3009",
          withdrawDelay: 900,
          voucherStore: true,
          refundAuthorizer: refundAuthorizer.address,
        },
      }),
    );
    expect(result.success).toBe(true);
    const stored = await storage.get(channelId);
    expect(stored?.balance).toBe("6000");
    expect(stored?.totalClaimed).toBe("5000");
    expect(stored?.chargeCount).toBe(1);
  });

  it("returns voucherState on managed verify when the watermark disagrees with a stored row", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      voucherStore: { storage },
    });
    mockOpenChannelMulticall();
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    await seedStoredChannel(storage, config, {
      signedMaxClaimable: "5000",
      signature: "0xstoredsig",
    });
    const channelId = computeChannelId(config);
    const payload = envelopeVoucher({
      type: "voucher",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "7000", signature: "0xfeedface" },
    });

    const result = await scheme.verify(payload, managedRequirements({ amount: "1000" }));
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrCumulativeAmountMismatch);
    expect(result.extra?.voucherState).toEqual({
      signedMaxClaimable: "5000",
      signature: "0xstoredsig",
    });
  });

  it("rejects managed refund settle when caller identity does not match the stored binding", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config);
    await seedStoredChannel(storage, config, {
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      callerIdentity: "tenant-a",
      signature: "0xdead",
    });
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      voucherStore: { storage },
      resolveCallerIdentity: async () => "tenant-b",
    });
    const payload = envelopeRefund({
      type: "refund",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "5000", signature: "0xdead" },
      amount: "1000",
    });

    const result = await scheme.settle(payload, managedRequirements({ amount: "0" }));
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrRefundAuthorizerSignature);
  });

  it("rejects managed verify for payload types the voucher store does not admit", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      voucherStore: { storage },
    });
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const cp: BatchSettlementClaimPayload = {
      type: "claim",
      claims: [
        {
          voucher: { channel: config, maxClaimableAmount: "1000" },
          signature: "0xcafe",
          totalClaimed: "1000",
        },
      ],
    };

    const result = await scheme.verify(
      envelopeSettle(cp as unknown as Record<string, unknown>),
      managedRequirements(),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrInvalidPayloadType);
  });
});

describe("BatchSettlementEvmScheme (Facilitator) — managed store availability", () => {
  it("returns VoucherStoreUnavailable when managed verify is requested without a store", async () => {
    const authorizer = buildAuthorizerSigner();
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config);
    const payload = envelopeVoucher({
      type: "voucher",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xfeedface" },
    });

    const result = await scheme.verify(
      payload,
      makeRequirements({
        extra: {
          name: "USDC",
          version: "2",
          receiverAuthorizer: authorizer.address,
          assetTransferMethod: "eip3009",
          withdrawDelay: 900,
          voucherStore: true,
        },
      }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrVoucherStoreUnavailable);
  });

  it("returns VoucherStoreUnavailable when managed settle is requested without a store", async () => {
    const authorizer = buildAuthorizerSigner();
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config);
    const payload = envelopeVoucher({
      type: "voucher",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xfeedface" },
    });

    const result = await scheme.settle(
      payload,
      makeRequirements({
        extra: {
          name: "USDC",
          version: "2",
          receiverAuthorizer: authorizer.address,
          assetTransferMethod: "eip3009",
          withdrawDelay: 900,
          voucherStore: true,
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrVoucherStoreUnavailable);
  });

  it("exposes createChannelManager only when the voucher store is configured", () => {
    const authorizer = buildAuthorizerSigner();
    const withoutStore = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    expect(() => withoutStore.createChannelManager()).toThrow(/voucherStore/);

    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const withStore = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      voucherStore: { storage },
    });
    expect(withStore.createChannelManager()).toBeDefined();
  });
});

describe("BatchSettlementEvmScheme (Facilitator) — self-managed refund identity", () => {
  it("rejects an unsigned self-managed refund when delegated auth disagrees with the caller", async () => {
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const authorizer = buildAuthorizerSigner();
    const delegatedAuthStore = new InMemoryDelegatedAuthStore();
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await delegatedAuthStore.bind({
      channelId,
      network: NETWORK,
      callerIdentity: "bound-service",
    });
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer, {
      resolveCallerIdentity: async () => "other-service",
      delegatedAuthStore,
    });
    const rp: BatchSettlementEnrichedRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "0", signature: "0xdead" },
      amount: "1000",
      refundNonce: "0",
      claims: [],
    };

    const result = await scheme.settle(
      envelopeSettle(rp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrRefundAuthorizerSignature);
  });
});

describe("BatchSettlementEvmScheme (Facilitator) — no authorizer configured", () => {
  it("returns AuthorizerNotConfigured for a claim without a client signature", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer);
    const config = buildChannelConfig();
    const cp: BatchSettlementClaimPayload = {
      type: "claim",
      claims: [
        {
          voucher: { channel: config, maxClaimableAmount: "1000" },
          signature: "0xcafe",
          totalClaimed: "1000",
        },
      ],
    };

    const result = await scheme.settle(
      envelopeSettle(cp as unknown as Record<string, unknown>),
      makeRequirements(),
    );

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrAuthorizerNotConfigured);
    expect(signer.writeContract).not.toHaveBeenCalled();
  });

  it("submits a claim that carries a server-supplied authorizer signature", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer);
    const config = buildChannelConfig();
    const cp: BatchSettlementClaimPayload = {
      type: "claim",
      claimAuthorizerSignature: "0xserversig" as `0x${string}`,
      claims: [
        {
          voucher: { channel: config, maxClaimableAmount: "1000" },
          signature: "0xcafe",
          totalClaimed: "1000",
        },
      ],
    };

    const result = await scheme.settle(
      envelopeSettle(cp as unknown as Record<string, unknown>),
      makeRequirements(),
    );

    expect(result.success).toBe(true);
    expect(signer.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "claimWithSignature" }),
    );
  });

  it("returns AuthorizerNotConfigured for a refund without a client signature", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer);
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const rp: BatchSettlementEnrichedRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "0", signature: "0xdead" },
      amount: "9000",
      refundNonce: "0",
      claims: [],
    };

    const result = await scheme.settle(
      envelopeSettle(rp as unknown as Record<string, unknown>),
      makeRequirements(),
    );

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrAuthorizerNotConfigured);
    expect(signer.writeContract).not.toHaveBeenCalled();
  });

  it("submits a refund that carries a server-supplied authorizer signature", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer);
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const rp: BatchSettlementEnrichedRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "0", signature: "0xdead" },
      amount: "9000",
      refundNonce: "0",
      refundAuthorizerSignature: "0xserversig" as `0x${string}`,
      claims: [],
    };

    const result = await scheme.settle(
      envelopeSettle(rp as unknown as Record<string, unknown>),
      makeRequirements(),
    );

    expect(result.success).toBe(true);
    expect(result.amount).toBe("9000");
    expect(signer.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "refundWithSignature" }),
    );
  });

  it("returns AuthorizerNotConfigured when claims are present but no claim authorizer is available", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer);
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const rp: BatchSettlementEnrichedRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "0", signature: "0xdead" },
      amount: "1000",
      refundNonce: "0",
      refundAuthorizerSignature: "0xserversig" as `0x${string}`,
      claims: [
        {
          voucher: { channel: config, maxClaimableAmount: "1000" },
          signature: "0xcafe",
          totalClaimed: "0",
        },
      ],
    };

    const result = await scheme.settle(
      envelopeSettle(rp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrAuthorizerNotConfigured);
    expect(signer.writeContract).not.toHaveBeenCalled();
  });

  it("maps a refund broadcast failure after a successful simulation", async () => {
    const signer = buildSigner({
      writeContract: vi.fn().mockRejectedValue(new Error("nonce too low")),
    });
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer);
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const rp: BatchSettlementEnrichedRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "0", signature: "0xdead" },
      amount: "9000",
      refundNonce: "0",
      refundAuthorizerSignature: "0xserversig" as `0x${string}`,
      claims: [],
    };

    const result = await scheme.settle(
      envelopeSettle(rp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrRefundTransactionFailed);
    expect(result.errorMessage).toContain("nonce too low");
  });

  it("still broadcasts a refund whose requested amount is zero after claims are considered", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer);
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const rp: BatchSettlementEnrichedRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "0", signature: "0xdead" },
      amount: "0",
      refundNonce: "0",
      refundAuthorizerSignature: "0xserversig" as `0x${string}`,
      claims: [],
    };

    const result = await scheme.settle(
      envelopeSettle(rp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    // getRefundableAmount returns null for a zero request (not 0n), so the
    // ErrRefundNoBalance short-circuit does not fire and the signed refund is submitted.
    expect(result.success).toBe(true);
    expect(signer.writeContract).toHaveBeenCalled();
  });

  it("ignores claims for a different channel when computing refundable amount", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer);
    const config = buildChannelConfig();
    const other = buildChannelConfig({
      salt: "0x0000000000000000000000000000000000000000000000000000000000000001",
    });
    const channelId = computeChannelId(config);
    const rp: BatchSettlementEnrichedRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "0", signature: "0xdead" },
      amount: "9000",
      refundNonce: "0",
      refundAuthorizerSignature: "0xserversig" as `0x${string}`,
      claimAuthorizerSignature: "0xclaimsig" as `0x${string}`,
      claims: [
        {
          voucher: { channel: other, maxClaimableAmount: "10000" },
          signature: "0xcafe",
          totalClaimed: "10000",
        },
      ],
    };

    const result = await scheme.settle(
      envelopeSettle(rp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(true);
    expect(signer.writeContract).toHaveBeenCalled();
    // Cross-channel claims are ignored for the pre-flight refundable check, so
    // the refund still broadcasts instead of aborting as RefundNoBalance.
  });

  it("still broadcasts when bundled claims exceed channel balance so refundable amount is unknown", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer);
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const rp: BatchSettlementEnrichedRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "15000", signature: "0xdead" },
      amount: "1000",
      refundNonce: "0",
      refundAuthorizerSignature: "0xserversig" as `0x${string}`,
      claimAuthorizerSignature: "0xclaimsig" as `0x${string}`,
      claims: [
        {
          voucher: { channel: config, maxClaimableAmount: "15000" },
          signature: "0xcafe",
          totalClaimed: "15000",
        },
      ],
    };

    const result = await scheme.settle(
      envelopeSettle(rp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(true);
    expect(signer.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "multicall" }),
    );
  });

  it("refuses a refund whose bundled claims already consume the channel balance", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer);
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const rp: BatchSettlementEnrichedRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "10000", signature: "0xdead" },
      amount: "1000",
      refundNonce: "0",
      refundAuthorizerSignature: "0xserversig" as `0x${string}`,
      claimAuthorizerSignature: "0xclaimsig" as `0x${string}`,
      claims: [
        {
          voucher: { channel: config, maxClaimableAmount: "10000" },
          signature: "0xcafe",
          totalClaimed: "10000",
        },
      ],
    };

    const result = await scheme.settle(
      envelopeSettle(rp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrRefundNoBalance);
    expect(signer.writeContract).not.toHaveBeenCalled();
  });

  it("reads post-refund channel state when a withdrawal is already pending", async () => {
    const signer = buildSigner();
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [10000n, 0n] },
        { status: "success", result: [0n, 50n] },
        { status: "success", result: 0n },
      ])
      .mockResolvedValue([
        { status: "success", result: [1000n, 1000n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1n },
      ]);
    const scheme = new BatchSettlementEvmScheme(signer);
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const rp: BatchSettlementEnrichedRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "0", signature: "0xdead" },
      amount: "9000",
      refundNonce: "0",
      refundAuthorizerSignature: "0xserversig" as `0x${string}`,
      claims: [],
    };

    const result = await scheme.settle(
      envelopeSettle(rp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(true);
    expect(result.amount).toBe("9000");
    expect(result.extra).toMatchObject({
      channelState: {
        channelId,
        balance: "1000",
        totalClaimed: "1000",
        withdrawRequestedAt: 0,
        refundNonce: "1",
      },
    });
  });

  it("falls back to the pre-refund snapshot when the post-refund state read fails", async () => {
    const signer = buildSigner();
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [10000n, 0n] },
        { status: "success", result: [0n, 50n] },
        { status: "success", result: 0n },
      ])
      .mockRejectedValueOnce(new Error("rpc lag"));
    const scheme = new BatchSettlementEvmScheme(signer);
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const rp: BatchSettlementEnrichedRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "0", signature: "0xdead" },
      amount: "9000",
      refundNonce: "0",
      refundAuthorizerSignature: "0xserversig" as `0x${string}`,
      claims: [],
    };

    const result = await scheme.settle(
      envelopeSettle(rp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(true);
    expect(result.amount).toBe("9000");
    expect(result.extra).toMatchObject({
      channelState: {
        channelId,
        balance: "1000",
        withdrawRequestedAt: 0,
      },
    });
  });
});

describe("BatchSettlementEvmScheme (Facilitator) — ERC-6492 deposit", () => {
  const authorizer = buildAuthorizerSigner();
  const FACTORY = "0xca11bde05977b3631167028862be2a173976ca11" as `0x${string}`;
  const ERC6492_MAGIC =
    "0x6492649264926492649264926492649264926492649264926492649264926492" as const;

  function wrapErc6492(
    factory: `0x${string}`,
    factoryCalldata: `0x${string}`,
    inner: `0x${string}`,
  ): `0x${string}` {
    const encoded = encodeAbiParameters(parseAbiParameters("address, bytes, bytes"), [
      factory,
      factoryCalldata,
      inner,
    ]);
    return concat([encoded, ERC6492_MAGIC]);
  }

  async function buildCounterfactualDeposit() {
    const config = buildChannelConfig({ payerAuthorizer: authorizer.address });
    const channelId = computeChannelId(config);
    const voucher = await signVoucher(
      { address: authorizer.address, signTypedData: authorizer.signTypedData },
      channelId,
      "1000",
      NETWORK,
    );
    const now = Math.floor(Date.now() / 1000);
    const payload: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher,
      deposit: {
        amount: "10000",
        authorization: {
          erc3009Authorization: {
            validAfter: String(now - 600),
            validBefore: String(now + 3600),
            salt: "0x0000000000000000000000000000000000000000000000000000000000000001",
            signature: wrapErc6492(
              FACTORY,
              "0xdeadbeef",
              ("0x" + "33".repeat(65)) as `0x${string}`,
            ),
          },
        },
      },
    };
    return { payload: envelopeDeposit(payload), channelId };
  }

  it("rejects a counterfactual deposit when the deploy+deposit simulation reverts", async () => {
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1_000_000n },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ])
      .mockResolvedValueOnce([
        { status: "success", result: undefined },
        { status: "failure", error: new Error("inner signature rejected") },
      ]);
    const signer = buildSigner({
      getCode: vi
        .fn()
        .mockImplementation(({ address }: { address: `0x${string}` }) =>
          Promise.resolve(address.toLowerCase() === PAYER.toLowerCase() ? "0x" : "0x6080604052"),
        ),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer, {
      eip6492AllowedFactories: [FACTORY],
    });
    const { payload } = await buildCounterfactualDeposit();
    const result = await scheme.verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrDepositSimulationFailed);
  });

  it("accepts a counterfactual deposit when the deploy+deposit simulation succeeds", async () => {
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1_000_000n },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ])
      .mockResolvedValueOnce([
        { status: "success", result: undefined },
        { status: "success", result: undefined },
      ]);
    const signer = buildSigner({
      getCode: vi
        .fn()
        .mockImplementation(({ address }: { address: `0x${string}` }) =>
          Promise.resolve(address.toLowerCase() === PAYER.toLowerCase() ? "0x" : "0x6080604052"),
        ),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer, {
      eip6492AllowedFactories: [FACTORY],
    });
    const { payload, channelId } = await buildCounterfactualDeposit();
    const result = await scheme.verify(payload, makeRequirements());
    expect(result.isValid).toBe(true);
    expect(result.extra?.channelId).toBe(channelId);
  });

  it("deploys an undeployed ERC-6492 wallet before settling the deposit", async () => {
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1_000_000n },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ])
      .mockResolvedValueOnce([
        { status: "success", result: undefined },
        { status: "success", result: undefined },
      ])
      .mockResolvedValue([
        { status: "success", result: [10_000n, 0n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ]);
    const signer = buildSigner({
      getCode: vi
        .fn()
        .mockImplementation(({ address }: { address: `0x${string}` }) =>
          Promise.resolve(address.toLowerCase() === PAYER.toLowerCase() ? "0x" : "0x6080604052"),
        ),
      sendTransaction: vi.fn().mockResolvedValue(("0x" + "dd".repeat(32)) as `0x${string}`),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer, {
      eip6492AllowedFactories: [FACTORY],
    });
    const { payload } = await buildCounterfactualDeposit();
    const result = await scheme.settle(payload, makeRequirements());
    expect(result.success).toBe(true);
    expect(signer.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ to: getAddress(FACTORY), data: "0xdeadbeef" }),
    );
    expect(signer.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "deposit" }),
    );
  });

  it("fails settle when the ERC-6492 factory transaction reverts", async () => {
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1_000_000n },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ])
      .mockResolvedValueOnce([
        { status: "success", result: undefined },
        { status: "success", result: undefined },
      ]);
    const signer = buildSigner({
      getCode: vi
        .fn()
        .mockImplementation(({ address }: { address: `0x${string}` }) =>
          Promise.resolve(address.toLowerCase() === PAYER.toLowerCase() ? "0x" : "0x6080604052"),
        ),
      sendTransaction: vi.fn().mockResolvedValue(("0x" + "dd".repeat(32)) as `0x${string}`),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "reverted" }),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer, {
      eip6492AllowedFactories: [FACTORY],
    });
    const { payload } = await buildCounterfactualDeposit();
    const result = await scheme.settle(payload, makeRequirements());
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrSmartWalletDeploymentFailed);
    expect(signer.writeContract).not.toHaveBeenCalled();
  });

  it("skips factory deployment when getCode later reports the wallet is already deployed", async () => {
    let payerLookups = 0;
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1_000_000n },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ])
      .mockResolvedValueOnce([
        { status: "success", result: undefined },
        { status: "success", result: undefined },
      ])
      .mockResolvedValue([
        { status: "success", result: [10_000n, 0n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ]);
    const signer = buildSigner({
      getCode: vi.fn().mockImplementation(({ address }: { address: `0x${string}` }) => {
        if (address.toLowerCase() !== PAYER.toLowerCase()) {
          return Promise.resolve("0x6080604052");
        }
        payerLookups += 1;
        // First lookup (verify) is undeployed; settle's deploy check sees code.
        return Promise.resolve(payerLookups === 1 ? "0x" : "0x6080604052");
      }),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer, {
      eip6492AllowedFactories: [FACTORY],
    });
    const { payload } = await buildCounterfactualDeposit();
    const result = await scheme.settle(payload, makeRequirements());
    expect(result.success).toBe(true);
    expect(signer.sendTransaction).not.toHaveBeenCalled();
  });

  it("treats a getCode RPC failure as undeployed and still deploys when the factory is allowlisted", async () => {
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1_000_000n },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ])
      .mockResolvedValueOnce([
        { status: "success", result: undefined },
        { status: "success", result: undefined },
      ])
      .mockResolvedValue([
        { status: "success", result: [10_000n, 0n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ]);
    let payerLookups = 0;
    const signer = buildSigner({
      getCode: vi.fn().mockImplementation(({ address }: { address: `0x${string}` }) => {
        if (address.toLowerCase() !== PAYER.toLowerCase()) {
          return Promise.resolve("0x6080604052");
        }
        payerLookups += 1;
        if (payerLookups === 1) return Promise.resolve("0x");
        return Promise.reject(new Error("eth_getCode timeout"));
      }),
      sendTransaction: vi.fn().mockResolvedValue(("0x" + "dd".repeat(32)) as `0x${string}`),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer, {
      eip6492AllowedFactories: [FACTORY],
    });
    const { payload } = await buildCounterfactualDeposit();
    const result = await scheme.settle(payload, makeRequirements());
    expect(result.success).toBe(true);
    expect(signer.sendTransaction).toHaveBeenCalled();
  });

  it("rejects settle when verify saw a deployed wallet but settle's getCode reports undeployed and the factory is not allowlisted", async () => {
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1_000_000n },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ])
      .mockResolvedValue([
        { status: "success", result: [10_000n, 0n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ]);
    let payerLookups = 0;
    const signer = buildSigner({
      getCode: vi.fn().mockImplementation(({ address }: { address: `0x${string}` }) => {
        if (address.toLowerCase() !== PAYER.toLowerCase()) {
          return Promise.resolve("0x6080604052");
        }
        payerLookups += 1;
        // Verify's classify + ERC-1271 lookups see a deployed wallet; settle's
        // later deploy check sees it undeployed (RPC race) and then gates the factory.
        return Promise.resolve(payerLookups <= 2 ? "0x6080604052" : "0x");
      }),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = await buildCounterfactualDeposit();
    const result = await scheme.settle(payload, makeRequirements());
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrFactoryNotAllowed);
    expect(signer.sendTransaction).not.toHaveBeenCalled();
  });
});

describe("BatchSettlementEvmScheme (Facilitator) — handler contract constants", () => {
  it("exposes well-formed distinct contract addresses", () => {
    const addrs = [
      BATCH_SETTLEMENT_ADDRESS,
      ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
      PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
    ];
    for (const a of addrs) {
      expect(isAddress(a)).toBe(true);
    }
    expect(new Set(addrs.map(a => getAddress(a))).size).toBe(3);
  });
});
