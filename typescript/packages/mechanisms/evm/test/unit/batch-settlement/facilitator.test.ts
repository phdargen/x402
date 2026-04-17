import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MockedFunction } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";

vi.mock("../../../src/multicall", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/multicall")>();
  return { ...actual, multicall: vi.fn() };
});

import { multicall } from "../../../src/multicall";
import { BatchSettlementEvmScheme } from "../../../src/batch-settlement/facilitator/scheme";
import { computeChannelId } from "../../../src/batch-settlement/utils";
import {
  BATCH_SETTLEMENT_ADDRESS,
  ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
} from "../../../src/batch-settlement/constants";
import * as Errors from "../../../src/batch-settlement/facilitator/errors";
import type {
  ChannelConfig,
  AuthorizerSigner,
  BatchSettlementDepositPayload,
  BatchSettlementVoucherPayload,
  BatchSettlementClaimWithSignaturePayload,
  BatchSettlementSettleActionPayload,
  BatchSettlementRefundWithSignaturePayload,
} from "../../../src/batch-settlement/types";
import type { FacilitatorEvmSigner } from "../../../src/signer";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

const mockedMulticall = multicall as unknown as MockedFunction<typeof multicall>;

const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as `0x${string}`;
const RECEIVER = "0x9876543210987654321098765432109876543210" as `0x${string}`;
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
const FACILITATOR_ADDRESS = "0xFAC11174700123456789012345678901234aBCDe" as `0x${string}`;
const NETWORK = "eip155:84532";

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

function buildChannelConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    payer: PAYER,
    payerAuthorizer: ZERO_ADDR,
    receiver: RECEIVER,
    receiverAuthorizer: ZERO_ADDR,
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
      assetTransferMethod: "eip3009",
      withdrawDelay: 900,
    },
    ...overrides,
  };
}

function buildSigner(overrides: Partial<FacilitatorEvmSigner> = {}): FacilitatorEvmSigner {
  return {
    getAddresses: () => [FACILITATOR_ADDRESS],
    readContract: vi.fn().mockResolvedValue(undefined),
    verifyTypedData: vi.fn().mockResolvedValue(true),
    writeContract: vi.fn().mockResolvedValue("0xtxhash" as `0x${string}`),
    sendTransaction: vi.fn(),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
    getCode: vi.fn(),
    ...overrides,
  };
}

function envelopeVoucher(payload: BatchSettlementVoucherPayload): PaymentPayload {
  return {
    x402Version: 2,
    accepted: { scheme: "batch-settlement", network: NETWORK },
    payload: payload as unknown as Record<string, unknown>,
  } as PaymentPayload;
}

function envelopeDeposit(payload: BatchSettlementDepositPayload): PaymentPayload {
  return {
    x402Version: 2,
    accepted: { scheme: "batch-settlement", network: NETWORK },
    payload: payload as unknown as Record<string, unknown>,
  } as PaymentPayload;
}

function envelopeSettle(payload: Record<string, unknown>): PaymentPayload {
  return {
    x402Version: 2,
    accepted: { scheme: "batch-settlement", network: NETWORK },
    payload,
  } as PaymentPayload;
}

beforeEach(() => {
  mockedMulticall.mockReset();
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

  it("getSigners returns the facilitator addresses", () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    expect(scheme.getSigners(NETWORK)).toEqual([FACILITATOR_ADDRESS]);
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
      } as PaymentPayload,
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
      channelId,
      maxClaimableAmount: "1000",
      signature: "0xdead",
    };
    const result = await scheme.verify(
      {
        x402Version: 2,
        accepted: { scheme: "batch-settlement", network: "eip155:1" },
        payload: voucher as unknown as Record<string, unknown>,
      } as PaymentPayload,
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
      } as PaymentPayload,
      makeRequirements(),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrInvalidPayloadType);
  });
});

describe("BatchSettlementEvmScheme (Facilitator) — verifyVoucher", () => {
  const authorizer = buildAuthorizerSigner();

  function makeVoucherPayload(
    overrides: Partial<BatchSettlementVoucherPayload> & { config?: ChannelConfig } = {},
  ): { payload: PaymentPayload; channelId: `0x${string}`; config: ChannelConfig } {
    const config = overrides.config ?? buildChannelConfig();
    const channelId = computeChannelId(config);
    const voucher: BatchSettlementVoucherPayload = {
      type: "voucher",
      channelConfig: config,
      channelId,
      maxClaimableAmount: overrides.maxClaimableAmount ?? "1000",
      signature: overrides.signature ?? ("0xdead" as `0x${string}`),
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

  it("returns InvalidVoucherSignature when verifyTypedData fails", async () => {
    const signer = buildSigner({ verifyTypedData: vi.fn().mockResolvedValue(false) });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig({
      payerAuthorizer: "0x0000000000000000000000000000000000000000",
    });
    const channelId = computeChannelId(config);
    const payload = envelopeVoucher({
      type: "voucher",
      channelConfig: config,
      channelId,
      maxClaimableAmount: "1000",
      signature: "0xdead",
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
      channelId,
      maxClaimableAmount: "1000",
      signature: sig,
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
    const { payload } = makeVoucherPayload({ maxClaimableAmount: "1000" });

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
    const { payload } = makeVoucherPayload({ maxClaimableAmount: "1000" });

    const result = await scheme.verify(payload, makeRequirements());
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
      channelId:
        "0x0000000000000000000000000000000000000000000000000000000000000099" as `0x${string}`,
      maxClaimableAmount: "1000",
      signature: "0xdead",
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
      deposit: {
        channelConfig: config,
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
      voucher: {
        channelId,
        maxClaimableAmount: "1000",
        signature: "0xcafebabe",
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

  it("returns InvalidReceiveAuthorizationSignature when verifyTypedData fails", async () => {
    const signer = buildSigner({ verifyTypedData: vi.fn().mockResolvedValue(false) });
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
      deposit: { channelConfig: config, amount: "10000", authorization: {} },
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
    };
    const result = await scheme.verify(envelopeDeposit(dp), makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrErc3009AuthorizationRequired);
  });

  it("returns ErrMissingEip712Domain when extra lacks name/version", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = buildDeposit();
    const reqs = makeRequirements({ extra: { assetTransferMethod: "eip3009" } });
    const result = await scheme.verify(payload, reqs);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrMissingEip712Domain);
  });

  it("returns ErrInvalidPayloadType when assetTransferMethod is not eip3009", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = buildDeposit();
    const reqs = makeRequirements({
      extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" },
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
      deposit: {
        channelConfig: config,
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
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
    };

    const result = await scheme.settle(envelopeDeposit(dp), makeRequirements());
    expect(result.success).toBe(true);
    expect(signer.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: getAddress(BATCH_SETTLEMENT_ADDRESS),
        functionName: "deposit",
      }),
    );
  });

  it('rejects voucher-less settleAction:"deposit" envelopes as unknown payload type', async () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    const config = buildChannelConfig();
    const now = Math.floor(Date.now() / 1000);

    const voucherLessDeposit = {
      settleAction: "deposit",
      deposit: {
        channelConfig: config,
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

  it("dispatches settle-action payloads via executeSettle", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const sp: BatchSettlementSettleActionPayload = {
      settleAction: "settle",
      receiver: RECEIVER,
      token: ASSET,
    };
    const result = await scheme.settle(
      envelopeSettle(sp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(true);
    expect(signer.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "settle",
      }),
    );
  });

  it("dispatches claim-with-signature payloads via executeClaimWithSignature", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const cp: BatchSettlementClaimWithSignaturePayload = {
      settleAction: "claimWithSignature",
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

  it("returns AuthorizerAddressMismatch when claim authorizer doesn't match config", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig({
      receiverAuthorizer: "0x1111111111111111111111111111111111111111",
    });
    const cp: BatchSettlementClaimWithSignaturePayload = {
      settleAction: "claimWithSignature",
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

  it("dispatches refund-with-signature payloads via executeRefundWithSignature", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const rp: BatchSettlementRefundWithSignaturePayload = {
      settleAction: "refundWithSignature",
      config,
      amount: "9000",
      nonce: "0",
      claims: [],
    };
    const result = await scheme.settle(
      envelopeSettle(rp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(true);
    expect(signer.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "refundWithSignature" }),
    );
  });

  it("returns ErrSettleSimulationFailed when settle simulation reverts", async () => {
    const signer = buildSigner({
      readContract: vi.fn().mockRejectedValue(new Error("revert")),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const sp: BatchSettlementSettleActionPayload = {
      settleAction: "settle",
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

  it("returns ErrSettleTransactionFailed when settle receipt is not success", async () => {
    const signer = buildSigner({
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "reverted" }),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const sp: BatchSettlementSettleActionPayload = {
      settleAction: "settle",
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

describe("BatchSettlementEvmScheme (Facilitator) — constants used in handlers", () => {
  it("contract addresses match the documented values", () => {
    expect(BATCH_SETTLEMENT_ADDRESS).toBe("0x4020e07E964De72a79367828c9C6140fcaE00003");
    expect(ERC3009_DEPOSIT_COLLECTOR_ADDRESS).toBe("0x402064ac4dA4f510EeC7D71fDc23A7D47fb10004");
  });
});
