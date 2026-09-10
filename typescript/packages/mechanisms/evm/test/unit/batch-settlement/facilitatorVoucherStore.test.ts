import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MockedFunction } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

vi.mock("../../../src/multicall", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/multicall")>();
  return { ...actual, multicall: vi.fn() };
});

import { multicall } from "../../../src/multicall";
import {
  settleManaged,
  verifyManaged,
  type VoucherStoreDeps,
} from "../../../src/batch-settlement/facilitator/voucherStore";
import { InMemoryPendingSettlementStore } from "@x402/core/facilitator";
import { InMemoryChannelStorage } from "../../../src/batch-settlement/storage/channel";
import type { FacilitatorChannel } from "../../../src/batch-settlement/facilitator/types";
import type { AuthorizerSigner, ChannelConfig } from "../../../src/batch-settlement/types";
import type { FacilitatorEvmSigner } from "../../../src/signer";
import { computeChannelId } from "../../../src/batch-settlement/utils";
import * as Errors from "../../../src/batch-settlement/errors";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { BatchSettlementDepositPayload } from "../../../src/batch-settlement/types";
import { InMemoryDelegatedAuthStore } from "../../../src/batch-settlement/storage/delegatedAuth";
import { signRefund } from "../../../src/batch-settlement/authorizerSigner";
import { packRefundAuthorizerSalt } from "../../../src/batch-settlement/utils";
import * as sharedVoucherStore from "../../../src/batch-settlement/voucherStore";
import * as facilitatorVoucher from "../../../src/batch-settlement/facilitator/voucher";
import * as facilitatorDeposit from "../../../src/batch-settlement/facilitator/deposit";
import * as facilitatorRefund from "../../../src/batch-settlement/facilitator/refund";

const mockedMulticall = multicall as unknown as MockedFunction<typeof multicall>;

const NETWORK = "eip155:84532";
const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as `0x${string}`;
const RECEIVER = "0x9876543210987654321098765432109876543210" as `0x${string}`;
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
const RECEIVER_AUTHORIZER = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const FACILITATOR = "0xFAC11174700123456789012345678901234aBCDe" as `0x${string}`;

function buildAuthorizer(): AuthorizerSigner {
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

function buildConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    payer: PAYER,
    payerAuthorizer: "0x0000000000000000000000000000000000000000",
    receiver: RECEIVER,
    receiverAuthorizer: RECEIVER_AUTHORIZER,
    token: TOKEN,
    withdrawDelay: 900,
    salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
    ...overrides,
  };
}

function buildSigner(overrides: Partial<FacilitatorEvmSigner> = {}): FacilitatorEvmSigner {
  return {
    getAddresses: () => [FACILITATOR],
    readContract: vi.fn().mockImplementation(args => {
      if (args.functionName === "isValidSignature") return Promise.resolve("0x1626ba7e");
      return Promise.resolve(undefined);
    }),
    verifyTypedData: vi.fn().mockResolvedValue(true),
    writeContract: vi.fn().mockResolvedValue(("0x" + "ab".repeat(32)) as `0x${string}`),
    sendTransaction: vi.fn(),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
    getCode: vi.fn().mockResolvedValue("0x6080604052"),
    ...overrides,
  };
}

function managedRequirements(authorizer: AuthorizerSigner): PaymentRequirements {
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
      receiverAuthorizer: authorizer.address,
      assetTransferMethod: "eip3009",
      withdrawDelay: 900,
      voucherStore: true,
    },
  };
}

function buildDeps(
  storage: InMemoryChannelStorage<FacilitatorChannel>,
  authorizer: AuthorizerSigner,
  signer?: FacilitatorEvmSigner,
): VoucherStoreDeps {
  return {
    signer: signer ?? buildSigner(),
    authorizerSigner: authorizer,
    storage,
    lockStorage: storage,
    withdrawDelay: 900,
    eip6492AllowedFactories: [],
    pendingStore: new InMemoryPendingSettlementStore(),
  };
}

function envelope(payload: Record<string, unknown>): PaymentPayload {
  return {
    x402Version: 2,
    accepted: { scheme: "batch-settlement", network: NETWORK },
    payload,
  } as unknown as PaymentPayload;
}

beforeEach(() => {
  mockedMulticall.mockReset();
  mockedMulticall.mockResolvedValue([
    { status: "success", result: [10000n, 0n] },
    { status: "success", result: [0n, 0n] },
    { status: "success", result: 0n },
  ]);
});

describe("facilitator verifyManaged / settleManaged", () => {
  const authorizer = buildAuthorizer();

  it("rejects verify when another request already holds the admission lock", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    await storage.acquire(channelId, "0xother", 60_000);

    const result = await verifyManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "1000", signature: "0xfeedface" },
      }),
      managedRequirements(authorizer),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrChannelBusy);
  });

  it("rejects a concurrent same-signature verify as busy", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0xfeedface",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
      network: NETWORK,
      chargeCount: 0,
    }));
    const verifySpy = vi.spyOn(facilitatorVoucher, "verifyVoucher").mockResolvedValue({
      isValid: true,
      payer: config.payer,
      extra: { totalClaimed: "0", balance: "10000" },
    });
    const payload = envelope({
      type: "voucher",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "2000", signature: "0xfeedface" },
    });
    const requirements = managedRequirements(authorizer);
    const deps = buildDeps(storage, authorizer);

    const results = await Promise.all([
      verifyManaged(deps, payload, requirements),
      verifyManaged(deps, payload, requirements),
    ]);
    verifySpy.mockRestore();

    const valid = results.filter(result => result.isValid);
    const busy = results.filter(result => result.invalidReason === Errors.ErrChannelBusy);
    expect(valid).toHaveLength(1);
    expect(busy).toHaveLength(1);
    expect(valid[0]?.extra?.pendingId).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  it("releases the nonce lock when settle echoes verify pendingId", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const signature = "0xfeedface" as `0x${string}`;
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature,
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
      network: NETWORK,
      chargeCount: 0,
    }));
    const verifySpy = vi.spyOn(facilitatorVoucher, "verifyVoucher").mockResolvedValue({
      isValid: true,
      payer: config.payer,
      extra: { totalClaimed: "0", balance: "10000" },
    });
    const deps = buildDeps(storage, authorizer);
    const verified = await verifyManaged(
      deps,
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "2000", signature },
      }),
      { ...managedRequirements(authorizer), amount: "1000" },
    );
    const pendingId = verified.extra?.pendingId;
    expect(verified.isValid).toBe(true);
    expect(typeof pendingId).toBe("string");

    const settled = await settleManaged(
      deps,
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "2000", signature },
        pendingId,
      }),
      { ...managedRequirements(authorizer), amount: "500" },
    );
    verifySpy.mockRestore();

    expect(settled.success).toBe(true);
    expect(await storage.isHeld(channelId)).toBe(false);
    expect(await storage.acquire(channelId, "0xnext", 60_000)).toBe(true);
  });

  it("rejects verify when requirements advertise the wrong withdrawDelay", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const result = await verifyManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "1000", signature: "0xfeedface" },
      }),
      {
        ...managedRequirements(authorizer),
        extra: { ...managedRequirements(authorizer).extra, withdrawDelay: 600 },
      },
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrWithdrawDelayMismatch);
  });

  it("rejects verify for unsupported managed payload types", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const result = await verifyManaged(
      buildDeps(storage, authorizer),
      envelope({ type: "claim", claims: [] }),
      managedRequirements(authorizer),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrInvalidPayloadType);
  });

  it("maps store read failures during verify to RpcReadFailed", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    vi.spyOn(storage, "get").mockRejectedValueOnce(new Error("store unavailable"));
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const result = await verifyManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "1000", signature: "0xfeedface" },
      }),
      managedRequirements(authorizer),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrRpcReadFailed);
  });

  it("rejects settle for unsupported managed payload types", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const result = await settleManaged(
      buildDeps(storage, authorizer),
      envelope({ type: "settle", receiver: RECEIVER, token: TOKEN }),
      managedRequirements(authorizer),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrInvalidPayloadType);
  });

  it("rejects voucher settle when signature verification fails without a prior verify lock", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const signer = buildSigner({
      readContract: vi.fn().mockImplementation(args => {
        if (args.functionName === "isValidSignature") return Promise.resolve("0xffffffff");
        return Promise.resolve(undefined);
      }),
    });
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const result = await settleManaged(
      buildDeps(storage, authorizer, signer),
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "1000", signature: "0xfeedface" },
      }),
      managedRequirements(authorizer),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrInvalidVoucherSignature);
  });

  it("rejects managed refund settle when the voucher watermark does not match storage", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      signature: "0xdead",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
      network: NETWORK,
      chargeCount: 0,
    }));
    const deps = buildDeps(storage, authorizer);
    deps.resolveCallerIdentity = async () => "service-a";
    await storage.updateChannel(channelId, current =>
      current ? { ...current, callerIdentity: "service-a" } : current,
    );
    const result = await settleManaged(
      deps,
      envelope({
        type: "refund",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "4000", signature: "0xdead" },
        amount: "1000",
      }),
      { ...managedRequirements(authorizer), amount: "0" },
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrCumulativeAmountMismatch);
  });

  it("rejects voucher settle when the admission lock is held but channel id binding fails", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const deps = buildDeps(storage, authorizer);
    await verifyManaged(
      deps,
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "1000", signature: "0xfeedface" },
      }),
      managedRequirements(authorizer),
    );
    const wrongId = ("0x" + "cd".repeat(32)) as `0x${string}`;
    const result = await settleManaged(
      deps,
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId: wrongId, maxClaimableAmount: "1000", signature: "0xfeedface" },
      }),
      managedRequirements(authorizer),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrChannelIdMismatch);
  });

  it("commits a managed voucher charge using onchain totalClaimed when the store is empty", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const result = await settleManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "1000", signature: "0xfeedface" },
      }),
      managedRequirements(authorizer),
    );
    expect(result.success).toBe(true);
    expect((await storage.get(channelId))?.chargedCumulativeAmount).toBe("1000");
  });

  it("returns corrective channel state but no voucherState when the store has no row", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const result = await verifyManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "2000", signature: "0xfeedface" },
      }),
      managedRequirements(authorizer),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrCumulativeAmountMismatch);
    expect(result.extra?.channelState).toMatchObject({
      channelId,
      chargedCumulativeAmount: "0",
    });
    expect(result.extra?.voucherState).toEqual({});
  });

  it("accepts a managed deposit verify when the voucher continues from onchain totalClaimed", async () => {
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [19_200n, 19_200n] },
        { status: "success", result: 1_000_000n },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1n },
      ])
      .mockResolvedValue([
        { status: "success", result: [119_200n, 19_200n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1n },
      ]);
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const now = Math.floor(Date.now() / 1000);
    const deposit: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "29200", signature: "0xcafebabe" },
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
    const result = await verifyManaged(
      buildDeps(storage, authorizer),
      envelope(deposit as unknown as Record<string, unknown>),
      { ...managedRequirements(authorizer), amount: "10000" },
    );
    expect(result.isValid).toBe(true);
    expect(result.extra?.chargedCumulativeAmount).toBe("19200");
  });

  it("allows managed refund settle via delegated auth when the row has no callerIdentity", async () => {
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [10_000n, 5_000n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ])
      .mockResolvedValue([
        { status: "success", result: [5_000n, 5_000n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1n },
      ]);
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const delegatedAuthStore = new InMemoryDelegatedAuthStore();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      signature: "0xdead",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
      network: NETWORK,
      chargeCount: 0,
    }));
    await delegatedAuthStore.bind({
      channelId,
      network: NETWORK,
      callerIdentity: "service-bound",
    });
    const deps = buildDeps(storage, authorizer);
    deps.delegatedAuthStore = delegatedAuthStore;
    deps.resolveCallerIdentity = async () => "service-bound";

    const result = await settleManaged(
      deps,
      envelope({
        type: "refund",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "5000", signature: "0xdead" },
      }),
      { ...managedRequirements(authorizer), amount: "0" },
    );
    expect(result.success).toBe(true);
    expect(await storage.get(channelId)).toBeUndefined();
  });

  it("derives the refund amount from escrow remainder when the payload omits amount", async () => {
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [10_000n, 5_000n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ])
      .mockResolvedValue([
        { status: "success", result: [5_000n, 5_000n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1n },
      ]);
    const refundAuthorizer = privateKeyToAccount(
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    );
    const salt = packRefundAuthorizerSalt(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      refundAuthorizer.address,
    );
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address, salt });
    const channelId = computeChannelId(config, NETWORK);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      signature: "0xdead",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
      network: NETWORK,
      chargeCount: 0,
    }));
    const refundAmount = "5000";
    const refundAuthorizerSignature = await signRefund(
      {
        address: refundAuthorizer.address,
        signTypedData: msg =>
          refundAuthorizer.signTypedData({
            domain: msg.domain,
            types: msg.types,
            primaryType: msg.primaryType,
            message: msg.message,
          } as Parameters<typeof refundAuthorizer.signTypedData>[0]),
      },
      channelId,
      refundAmount,
      "0",
      NETWORK,
    );
    const result = await settleManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "refund",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "5000", signature: "0xdead" },
        refundAuthorizerSignature,
      }),
      {
        ...managedRequirements(authorizer),
        amount: "0",
        extra: {
          ...managedRequirements(authorizer).extra,
          refundAuthorizer: refundAuthorizer.address,
        },
      },
    );
    expect(result.success).toBe(true);
  });

  it("maps post-verify storage failures to RpcReadFailed and releases the admission lock", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const deps = buildDeps(storage, authorizer);
    vi.spyOn(storage, "get")
      .mockRejectedValueOnce(new Error("redis down"))
      .mockImplementation(InMemoryChannelStorage.prototype.get.bind(storage));

    const result = await verifyManaged(
      deps,
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "1000", signature: "0xfeedface" },
      }),
      managedRequirements(authorizer),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrRpcReadFailed);
    expect(await storage.isHeld(channelId)).toBe(false);
  });

  it("bundles an outstanding voucher claim when refunding a channel with unclaimed charges", async () => {
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [10_000n, 3_000n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ])
      .mockResolvedValue([
        { status: "success", result: [5_000n, 5_000n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1n },
      ]);
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      signature: "0xdead",
      balance: "10000",
      totalClaimed: "3000",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
      network: NETWORK,
      chargeCount: 1,
      callerIdentity: "tenant-1",
    }));
    const signer = buildSigner();
    const deps = buildDeps(storage, authorizer, signer);
    deps.resolveCallerIdentity = async () => "tenant-1";

    const result = await settleManaged(
      deps,
      envelope({
        type: "refund",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "5000", signature: "0xdead" },
        amount: "5000",
      }),
      { ...managedRequirements(authorizer), amount: "0" },
    );
    expect(result.success).toBe(true);
    expect(signer.writeContract).toHaveBeenCalled();
  });

  it("rejects managed refund settle when caller identity resolution throws", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      signature: "0xdead",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
      network: NETWORK,
      chargeCount: 0,
      callerIdentity: "tenant-1",
    }));
    const deps = buildDeps(storage, authorizer);
    deps.resolveCallerIdentity = async () => {
      throw new Error("auth middleware unavailable");
    };

    const result = await settleManaged(
      deps,
      envelope({
        type: "refund",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "5000", signature: "0xdead" },
        amount: "1000",
      }),
      { ...managedRequirements(authorizer), amount: "0" },
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrRefundAuthorizerSignature);
  });

  it("returns RpcReadFailed when storage fails after a successful voucher verify", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const verifySpy = vi.spyOn(facilitatorVoucher, "verifyVoucher").mockResolvedValueOnce({
      isValid: true,
      payer: config.payer,
      extra: { totalClaimed: "0", balance: "10000" },
    });
    vi.spyOn(storage, "get").mockRejectedValueOnce(new Error("store unavailable"));

    const result = await verifyManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "1000", signature: "0xfeedface" },
      }),
      managedRequirements(authorizer),
    );
    verifySpy.mockRestore();
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrRpcReadFailed);
    expect(await storage.isHeld(channelId)).toBe(false);
  });

  it("still commits a voucher charge when releasing the verify lock fails", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const signature = "0xfeedface" as `0x${string}`;
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "5000",
      signature,
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
      network: NETWORK,
      chargeCount: 0,
    }));
    await storage.acquire(channelId, "0xpending", 60_000);
    vi.spyOn(storage, "release").mockRejectedValueOnce(new Error("lock store unavailable"));

    const result = await settleManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "5000", signature },
        pendingId: "0xpending",
      }),
      { ...managedRequirements(authorizer), amount: "500" },
    );
    expect(result.success).toBe(true);
    expect((await storage.get(channelId))?.chargedCumulativeAmount).toBe("1500");
  });

  it("accepts verify when onchain totalClaimed is numeric and storage is empty", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const verifySpy = vi.spyOn(facilitatorVoucher, "verifyVoucher").mockResolvedValueOnce({
      isValid: true,
      payer: config.payer,
      extra: { totalClaimed: 2000, balance: "10000" },
    });

    const result = await verifyManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "3000", signature: "0xfeedface" },
      }),
      managedRequirements(authorizer),
    );
    verifySpy.mockRestore();
    expect(result.isValid).toBe(true);
    expect(result.extra?.chargedCumulativeAmount).toBe("2000");
    expect(result.extra?.pendingId).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  it("accepts managed refund verify when the voucher matches the stored watermark", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      signature: "0xdead",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
      network: NETWORK,
      chargeCount: 0,
    }));
    const result = await verifyManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "refund",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "5000", signature: "0xdead" },
      }),
      { ...managedRequirements(authorizer), amount: "0" },
    );
    expect(result.isValid).toBe(true);
    expect(result.extra?.chargedCumulativeAmount).toBe("5000");
  });

  it("forwards invalid deposit verification and releases the admission lock", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const now = Math.floor(Date.now() / 1000);
    const deposit: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafe" },
      deposit: {
        amount: "1000",
        authorization: {
          erc3009Authorization: {
            validAfter: String(now - 600),
            validBefore: String(now + 3600),
            salt: "0x01",
            signature: "0xbad",
          },
        },
      },
    };
    const verifySpy = vi.spyOn(facilitatorDeposit, "verifyDeposit").mockResolvedValueOnce({
      isValid: false,
      invalidReason: Errors.ErrInvalidVoucherSignature,
      payer: config.payer,
    });

    const result = await verifyManaged(
      buildDeps(storage, authorizer),
      envelope(deposit as unknown as Record<string, unknown>),
      { ...managedRequirements(authorizer), amount: "1000" },
    );
    verifySpy.mockRestore();
    expect(result.isValid).toBe(false);
    expect(await storage.isHeld(channelId)).toBe(false);
  });

  it("defaults voucher settle errors when verify omits an invalidReason", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const verifySpy = vi.spyOn(facilitatorVoucher, "verifyVoucher").mockResolvedValueOnce({
      isValid: false,
    });

    const result = await settleManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "1000", signature: "0xfeedface" },
      }),
      managedRequirements(authorizer),
    );
    verifySpy.mockRestore();
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrInvalidVoucherSignature);
  });

  it("returns MissingChannel when the charge commit sees no durable row", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const commitSpy = vi
      .spyOn(sharedVoucherStore, "commitVoucherCharge")
      .mockResolvedValueOnce({ status: "missing" });

    const result = await settleManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "1000", signature: "0xfeedface" },
      }),
      managedRequirements(authorizer),
    );
    commitSpy.mockRestore();
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrMissingChannel);
  });

  it("commits an offchain voucher charge when verify already holds the admission lock", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const signature = "0xfeedface" as `0x${string}`;
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "5000",
      signature,
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
      network: NETWORK,
      chargeCount: 1,
    }));
    await storage.acquire(channelId, "0xpending", 60_000);
    const verifySpy = vi.spyOn(facilitatorVoucher, "verifyVoucher");

    const result = await settleManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "5000", signature },
        pendingId: "0xpending",
      }),
      { ...managedRequirements(authorizer), amount: "500" },
    );
    verifySpy.mockRestore();

    expect(result.success).toBe(true);
    expect(verifySpy).not.toHaveBeenCalled();
    expect((await storage.get(channelId))?.chargedCumulativeAmount).toBe("1500");
    expect(result.extra?.chargedAmount).toBe("500");
  });

  it("rejects voucher settle when the charge would exceed the signed cumulative cap", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const signature = "0xfeedface" as `0x${string}`;
    await storage.acquire(channelId, "0xpending", 60_000);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "4500",
      signedMaxClaimable: "5000",
      signature,
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
      network: NETWORK,
      chargeCount: 0,
    }));

    const result = await settleManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "5000", signature },
        pendingId: "0xpending",
      }),
      { ...managedRequirements(authorizer), amount: "1000" },
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrChargeExceedsSignedCumulative);
    expect((await storage.get(channelId))?.chargedCumulativeAmount).toBe("4500");
  });

  it("rejects voucher settle under verify lock when the channel id does not match the config", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const wrongId = `${channelId.slice(0, -2)}ff` as `0x${string}`;
    const signature = "0xfeedface" as `0x${string}`;
    await storage.acquire(channelId, "0xpending", 60_000);

    const result = await settleManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId: wrongId, maxClaimableAmount: "1000", signature },
        pendingId: "0xpending",
      }),
      managedRequirements(authorizer),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrChannelIdMismatch);
  });

  it("returns ChannelBusy when the charge commit conflicts with a concurrent writer", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const commitSpy = vi
      .spyOn(sharedVoucherStore, "commitVoucherCharge")
      .mockResolvedValueOnce({ status: "conflict" });

    const result = await settleManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "1000", signature: "0xfeedface" },
      }),
      managedRequirements(authorizer),
    );
    commitSpy.mockRestore();
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrChannelBusy);
  });

  it("returns the onchain deposit failure without attempting a managed charge commit", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const now = Math.floor(Date.now() / 1000);
    const deposit: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafe" },
      deposit: {
        amount: "1000",
        authorization: {
          erc3009Authorization: {
            validAfter: String(now - 600),
            validBefore: String(now + 3600),
            salt: "0x01",
            signature: "0xbad",
          },
        },
      },
    };
    const settleSpy = vi.spyOn(facilitatorDeposit, "settleDeposit").mockResolvedValueOnce({
      success: false,
      errorReason: Errors.ErrDepositSimulationFailed,
      transaction: "",
      network: NETWORK,
    });
    const commitSpy = vi.spyOn(sharedVoucherStore, "commitVoucherCharge");

    const result = await settleManaged(
      buildDeps(storage, authorizer),
      envelope(deposit as unknown as Record<string, unknown>),
      { ...managedRequirements(authorizer), amount: "1000" },
    );
    settleSpy.mockRestore();
    commitSpy.mockRestore();
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrDepositSimulationFailed);
    expect(commitSpy).not.toHaveBeenCalled();
  });

  it("surfaces refund submit failures without mutating the stored watermark", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      signature: "0xdead",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
      network: NETWORK,
      chargeCount: 0,
      callerIdentity: "svc",
    }));
    const deps = buildDeps(storage, authorizer);
    deps.resolveCallerIdentity = async () => "svc";
    const signer = deps.signer;
    vi.spyOn(signer, "writeContract").mockRejectedValueOnce(new Error("broadcast failed"));

    const result = await settleManaged(
      deps,
      envelope({
        type: "refund",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "5000", signature: "0xdead" },
        amount: "1000",
      }),
      { ...managedRequirements(authorizer), amount: "0" },
    );
    expect(result.success).toBe(false);
    expect((await storage.get(channelId))?.chargedCumulativeAmount).toBe("5000");
  });

  it("rejects managed refund consent when no caller identity hook is configured", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      signature: "0xdead",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
      network: NETWORK,
      chargeCount: 0,
    }));

    const result = await settleManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "refund",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "5000", signature: "0xdead" },
        amount: "1000",
      }),
      { ...managedRequirements(authorizer), amount: "0" },
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrRefundAuthorizerSignature);
  });

  it("uses numeric totalClaimed from verify extras when bootstrapping an empty store row", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const verifySpy = vi.spyOn(facilitatorVoucher, "verifyVoucher").mockResolvedValueOnce({
      isValid: true,
      payer: config.payer,
      extra: { totalClaimed: 2500, balance: "10000" },
    });

    const result = await verifyManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "3500", signature: "0xfeedface" },
      }),
      managedRequirements(authorizer),
    );
    verifySpy.mockRestore();
    expect(result.isValid).toBe(true);
    expect(result.extra?.chargedCumulativeAmount).toBe("2500");
  });

  it("rejects verify when refundAuthorizer in requirements cannot be unpacked from salt", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({
      receiverAuthorizer: authorizer.address,
      salt: "0x0000000000000000000000000000000000000000000000000000000000000001",
    });
    const channelId = computeChannelId(config, NETWORK);
    const result = await verifyManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "1000", signature: "0xfeedface" },
      }),
      {
        ...managedRequirements(authorizer),
        extra: {
          ...managedRequirements(authorizer).extra,
          refundAuthorizer: authorizer.address,
        },
      },
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrRefundAuthorizerMismatch);
  });

  it("rejects refund settle when caller identity resolves to undefined", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      signature: "0xdead",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
      network: NETWORK,
      chargeCount: 0,
      callerIdentity: "tenant-a",
    }));
    const deps = buildDeps(storage, authorizer);
    deps.resolveCallerIdentity = async () => undefined;

    const result = await settleManaged(
      deps,
      envelope({
        type: "refund",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "5000", signature: "0xdead" },
        amount: "1000",
      }),
      { ...managedRequirements(authorizer), amount: "0" },
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrRefundAuthorizerSignature);
  });

  it("rejects refund settle when delegated auth lookup fails", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const delegatedAuthStore = new InMemoryDelegatedAuthStore();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      signature: "0xdead",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
      network: NETWORK,
      chargeCount: 0,
    }));
    const deps = buildDeps(storage, authorizer);
    deps.delegatedAuthStore = delegatedAuthStore;
    deps.resolveCallerIdentity = async () => "tenant-a";
    vi.spyOn(delegatedAuthStore, "get").mockRejectedValueOnce(new Error("redis unavailable"));

    const result = await settleManaged(
      deps,
      envelope({
        type: "refund",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "5000", signature: "0xdead" },
        amount: "1000",
      }),
      { ...managedRequirements(authorizer), amount: "0" },
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrRefundAuthorizerSignature);
  });

  it("returns deposit settle success with charge extras when confirm state is flat on the extra root", async () => {
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [19_200n, 19_200n] },
        { status: "success", result: 1_000_000n },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1n },
      ])
      .mockResolvedValue([
        { status: "success", result: [119_200n, 19_200n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1n },
      ]);
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const now = Math.floor(Date.now() / 1000);
    const deposit: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "29200", signature: "0xcafebabe" },
      deposit: {
        amount: "10000",
        authorization: {
          erc3009Authorization: {
            validAfter: String(now - 600),
            validBefore: String(now + 3600),
            salt: "0x01",
            signature: "0xfeedface",
          },
        },
      },
    };
    const settleSpy = vi.spyOn(facilitatorDeposit, "settleDeposit").mockResolvedValueOnce({
      success: true,
      transaction: "0xdep",
      network: NETWORK,
      payer: config.payer,
      amount: "10000",
      extra: {
        balance: "119200",
        totalClaimed: "19200",
        withdrawRequestedAt: 0,
        refundNonce: 0,
      },
    });

    const result = await settleManaged(
      buildDeps(storage, authorizer),
      envelope(deposit as unknown as Record<string, unknown>),
      { ...managedRequirements(authorizer), amount: "10000" },
    );
    settleSpy.mockRestore();
    expect(result.success).toBe(true);
    expect(result.extra?.chargeCount).toBe(1);
    expect(result.extra?.channelState?.balance).toBe("119200");
  });

  it("omits chargeCount on deposit settle when the managed charge hits the signed cap", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const now = Math.floor(Date.now() / 1000);
    const deposit: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "20000", signature: "0xcafe" },
      deposit: {
        amount: "10000",
        authorization: {
          erc3009Authorization: {
            validAfter: String(now - 600),
            validBefore: String(now + 3600),
            salt: "0x01",
            signature: "0xfeedface",
          },
        },
      },
    };
    const settleSpy = vi.spyOn(facilitatorDeposit, "settleDeposit").mockResolvedValueOnce({
      success: true,
      transaction: "0xdep",
      network: NETWORK,
      extra: { channelState: { balance: "10000", totalClaimed: "0" } },
    });
    const commitSpy = vi
      .spyOn(sharedVoucherStore, "commitVoucherCharge")
      .mockResolvedValueOnce({ status: "cap_exceeded", charged: "21000" });

    const result = await settleManaged(
      buildDeps(storage, authorizer),
      envelope(deposit as unknown as Record<string, unknown>),
      { ...managedRequirements(authorizer), amount: "10000" },
    );
    settleSpy.mockRestore();
    commitSpy.mockRestore();
    expect(result.success).toBe(true);
    expect(result.extra?.chargeCount).toBeUndefined();
  });

  it("continues settle when lock release fails after a successful voucher charge", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    vi.spyOn(storage, "release").mockRejectedValueOnce(new Error("lock store unavailable"));

    const result = await settleManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "1000", signature: "0xfeedface" },
      }),
      managedRequirements(authorizer),
    );
    expect(result.success).toBe(true);
  });

  it("rejects voucher settle under a held verify lock when channel id binding fails", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const deps = buildDeps(storage, authorizer);
    await verifyManaged(
      deps,
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "1000", signature: "0xfeedface" },
      }),
      managedRequirements(authorizer),
    );
    const wrongId = ("0x" + "ee".repeat(32)) as `0x${string}`;
    const result = await settleManaged(
      deps,
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId: wrongId, maxClaimableAmount: "1000", signature: "0xfeedface" },
      }),
      managedRequirements(authorizer),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrChannelIdMismatch);
  });

  it("rejects verify when requirements advertise a non-address receiverAuthorizer", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const result = await verifyManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "1000", signature: "0xfeedface" },
      }),
      {
        ...managedRequirements(authorizer),
        extra: {
          ...managedRequirements(authorizer).extra,
          receiverAuthorizer: 123,
        },
      },
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrReceiverAuthorizerMismatch);
  });

  it("updates stored refund metadata from facilitator channelState extras after a partial refund", async () => {
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [10_000n, 5_000n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ])
      .mockResolvedValue([
        { status: "success", result: [6_000n, 5_000n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 2n },
      ]);
    const refundAuthorizer = privateKeyToAccount(
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    );
    const salt = packRefundAuthorizerSalt(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      refundAuthorizer.address,
    );
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address, salt });
    const channelId = computeChannelId(config, NETWORK);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      signature: "0xdead",
      balance: "10000",
      totalClaimed: "5000",
      withdrawRequestedAt: 0,
      refundNonce: 1,
      lastRequestTimestamp: Date.now(),
      network: NETWORK,
      chargeCount: 0,
    }));
    const refundAmount = "4000";
    const refundAuthorizerSignature = await signRefund(
      {
        address: refundAuthorizer.address,
        signTypedData: msg =>
          refundAuthorizer.signTypedData({
            domain: msg.domain,
            types: msg.types,
            primaryType: msg.primaryType,
            message: msg.message,
          } as Parameters<typeof refundAuthorizer.signTypedData>[0]),
      },
      channelId,
      refundAmount,
      "1",
      NETWORK,
    );

    const result = await settleManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "refund",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "5000", signature: "0xdead" },
        amount: refundAmount,
        refundAuthorizerSignature,
      }),
      {
        ...managedRequirements(authorizer),
        amount: "0",
        extra: {
          ...managedRequirements(authorizer).extra,
          refundAuthorizer: refundAuthorizer.address,
        },
      },
    );
    expect(result.success).toBe(true);
    const stored = await storage.get(channelId);
    expect(stored?.balance).toBe("6000");
    expect(stored?.totalClaimed).toBe("5000");
    expect(stored?.refundNonce).toBeGreaterThanOrEqual(1);
  });

  it("rejects refund authorizer consent when the signature cannot be recovered", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const refundAuthorizer = privateKeyToAccount(
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    );
    const salt = packRefundAuthorizerSalt(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      refundAuthorizer.address,
    );
    const config = buildConfig({ receiverAuthorizer: authorizer.address, salt });
    const channelId = computeChannelId(config, NETWORK);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      signature: "0xdead",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
      network: NETWORK,
      chargeCount: 0,
    }));

    const result = await settleManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "refund",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "5000", signature: "0xdead" },
        amount: "1000",
        refundAuthorizerSignature: "0x0123",
      }),
      {
        ...managedRequirements(authorizer),
        amount: "0",
        extra: {
          ...managedRequirements(authorizer).extra,
          refundAuthorizer: refundAuthorizer.address,
        },
      },
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrRefundAuthorizerSignature);
  });

  it("reads nested channelState confirm fields when committing a managed deposit charge", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const now = Math.floor(Date.now() / 1000);
    const deposit: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "29200", signature: "0xcafe" },
      deposit: {
        amount: "10000",
        authorization: {
          erc3009Authorization: {
            validAfter: String(now - 600),
            validBefore: String(now + 3600),
            salt: "0x01",
            signature: "0xfeedface",
          },
        },
      },
    };
    const settleSpy = vi.spyOn(facilitatorDeposit, "settleDeposit").mockResolvedValueOnce({
      success: true,
      transaction: "0xdep",
      network: NETWORK,
      extra: {
        channelState: {
          balance: "119200",
          totalClaimed: "19200",
          withdrawRequestedAt: 1,
          refundNonce: 3,
        },
      },
    });

    const result = await settleManaged(
      buildDeps(storage, authorizer),
      envelope(deposit as unknown as Record<string, unknown>),
      { ...managedRequirements(authorizer), amount: "10000" },
    );
    settleSpy.mockRestore();
    expect(result.success).toBe(true);
    expect((await storage.get(channelId))?.balance).toBe("119200");
    expect((await storage.get(channelId))?.refundNonce).toBe(3);
  });

  it("coerces string channelState numeric fields after a managed deposit charge", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const now = Math.floor(Date.now() / 1000);
    const deposit: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "15000", signature: "0xcafe" },
      deposit: {
        amount: "5000",
        authorization: {
          erc3009Authorization: {
            validAfter: String(now - 600),
            validBefore: String(now + 3600),
            salt: "0x01",
            signature: "0xfeedface",
          },
        },
      },
    };
    const settleSpy = vi.spyOn(facilitatorDeposit, "settleDeposit").mockResolvedValueOnce({
      success: true,
      transaction: "0xdep",
      network: NETWORK,
      extra: {
        channelState: {
          balance: 15000,
          totalClaimed: "5000",
          withdrawRequestedAt: "7",
          refundNonce: "2",
        },
      },
    });

    const result = await settleManaged(
      buildDeps(storage, authorizer),
      envelope(deposit as unknown as Record<string, unknown>),
      { ...managedRequirements(authorizer), amount: "5000" },
    );
    settleSpy.mockRestore();
    expect(result.success).toBe(true);
    const stored = await storage.get(channelId);
    expect(stored?.balance).toBe("15000");
    expect(stored?.withdrawRequestedAt).toBe(7);
    expect(stored?.refundNonce).toBe(2);
  });

  it("preserves the prior chargeCount when a deposit charge commit conflicts", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "20000",
      signature: "0xold",
      balance: "5000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
      network: NETWORK,
      chargeCount: 4,
    }));
    const now = Math.floor(Date.now() / 1000);
    const deposit: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "20000", signature: "0xcafe" },
      deposit: {
        amount: "10000",
        authorization: {
          erc3009Authorization: {
            validAfter: String(now - 600),
            validBefore: String(now + 3600),
            salt: "0x01",
            signature: "0xfeedface",
          },
        },
      },
    };
    vi.spyOn(facilitatorDeposit, "settleDeposit").mockResolvedValueOnce({
      success: true,
      transaction: "0xdep",
      network: NETWORK,
      extra: { channelState: { balance: "15000", totalClaimed: "0" } },
    });
    vi.spyOn(sharedVoucherStore, "commitVoucherCharge").mockResolvedValueOnce({
      status: "conflict",
    });

    const result = await settleManaged(
      buildDeps(storage, authorizer),
      envelope(deposit as unknown as Record<string, unknown>),
      { ...managedRequirements(authorizer), amount: "10000" },
    );
    expect(result.success).toBe(true);
    expect(result.extra?.chargeCount).toBe(4);
  });

  it("deletes the store row after a full managed refund closes the channel", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      signature: "0xdead",
      balance: "10000",
      totalClaimed: "5000",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
      network: NETWORK,
      chargeCount: 0,
      callerIdentity: "tenant-1",
    }));
    const deps = buildDeps(storage, authorizer);
    deps.resolveCallerIdentity = async () => "tenant-1";
    vi.spyOn(facilitatorRefund, "submitRefund").mockResolvedValueOnce({
      success: true,
      transaction: "0xrefund",
      network: NETWORK,
      extra: {
        channelState: {
          balance: "5000",
          totalClaimed: "5000",
          refundNonce: "1",
          withdrawRequestedAt: 0,
        },
      },
    });

    const result = await settleManaged(
      deps,
      envelope({
        type: "refund",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "5000", signature: "0xdead" },
        amount: "5000",
      }),
      { ...managedRequirements(authorizer), amount: "0" },
    );
    expect(result.success).toBe(true);
    expect(await storage.get(channelId)).toBeUndefined();
    expect(result.extra?.chargeCount).toBe(0);
  });

  it("returns stored voucher proof on verify mismatch when a replica row exists", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      signature: "0xstoredsig",
      balance: "10000",
      totalClaimed: "1000",
      withdrawRequestedAt: 2,
      refundNonce: 3,
      lastRequestTimestamp: Date.now(),
      network: NETWORK,
      chargeCount: 1,
    }));

    const result = await verifyManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "7000", signature: "0xfeedface" },
      }),
      managedRequirements(authorizer),
    );
    expect(result.isValid).toBe(false);
    expect(result.extra?.voucherState).toEqual({
      signedMaxClaimable: "5000",
      signature: "0xstoredsig",
    });
    expect(result.extra?.channelState).toMatchObject({
      channelId,
      balance: "10000",
      totalClaimed: "1000",
      chargedCumulativeAmount: "5000",
    });
  });

  it("accepts numeric confirm fields when committing a managed deposit charge", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const now = Math.floor(Date.now() / 1000);
    const deposit: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "20000", signature: "0xcafe" },
      deposit: {
        amount: "10000",
        authorization: {
          erc3009Authorization: {
            validAfter: String(now - 600),
            validBefore: String(now + 3600),
            salt: "0x01",
            signature: "0xfeedface",
          },
        },
      },
    };
    vi.spyOn(facilitatorDeposit, "settleDeposit").mockResolvedValueOnce({
      success: true,
      transaction: "0xdep",
      network: NETWORK,
      extra: {
        channelState: {
          balance: 15_000,
          totalClaimed: 0,
          withdrawRequestedAt: 0,
          refundNonce: 1,
        },
      },
    });
    vi.spyOn(sharedVoucherStore, "commitVoucherCharge").mockResolvedValueOnce({
      status: "committed",
      previous: undefined,
      current: {
        channelId,
        channelConfig: config,
        chargedCumulativeAmount: "10000",
        signedMaxClaimable: "20000",
        signature: "0xcafe",
        balance: "15000",
        totalClaimed: "0",
        withdrawRequestedAt: 0,
        refundNonce: 1,
        lastRequestTimestamp: Date.now(),
        network: NETWORK,
        chargeCount: 1,
      },
    });

    const result = await settleManaged(
      buildDeps(storage, authorizer),
      envelope(deposit as unknown as Record<string, unknown>),
      { ...managedRequirements(authorizer), amount: "10000" },
    );
    expect(result.success).toBe(true);
    expect(result.extra?.channelState).toMatchObject({
      balance: "15000",
      totalClaimed: "0",
      refundNonce: "1",
    });
  });

  it("includes corrective onchain hints on verify mismatch when the store row is absent", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config, NETWORK);
    const verifySpy = vi.spyOn(facilitatorVoucher, "verifyVoucher").mockResolvedValueOnce({
      isValid: true,
      payer: config.payer,
      extra: {
        balance: 10_000,
        totalClaimed: "3000",
        withdrawRequestedAt: 1,
        refundNonce: 2,
      },
    });

    const result = await verifyManaged(
      buildDeps(storage, authorizer),
      envelope({
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "5000", signature: "0xfeedface" },
      }),
      managedRequirements(authorizer),
    );
    verifySpy.mockRestore();
    expect(result.isValid).toBe(false);
    expect(result.extra?.channelState).toMatchObject({
      channelId,
      balance: "10000",
      totalClaimed: "3000",
      refundNonce: "2",
    });
  });
});
