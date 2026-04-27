import { describe, it, expect, beforeEach } from "vitest";
import { BatchSettlementEvmScheme } from "../../../src/batch-settlement/server/scheme";
import { BatchSettlementChannelManager } from "../../../src/batch-settlement/server/channelManager";
import { InMemoryChannelStorage, type Channel } from "../../../src/batch-settlement/server/storage";
import { computeChannelId } from "../../../src/batch-settlement/utils";
import type {
  ChannelConfig,
  AuthorizerSigner,
  BatchSettlementVoucherPayload,
  BatchSettlementDepositPayload,
  BatchSettlementRefundPayload,
} from "../../../src/batch-settlement/types";
import type {
  PaymentRequirements,
  PaymentPayload,
  VerifyResponse,
  SettleResponse,
} from "@x402/core/types";
import type { FacilitatorClient } from "@x402/core/server";
import { privateKeyToAccount } from "viem/accounts";

function buildManager(scheme: BatchSettlementEvmScheme): BatchSettlementChannelManager {
  return new BatchSettlementChannelManager({
    scheme,
    facilitator: {} as FacilitatorClient,
    receiver: RECEIVER,
    token: ASSET_BASE_SEPOLIA,
    network: NETWORK,
  });
}

const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as `0x${string}`;
const RECEIVER = "0x9876543210987654321098765432109876543210" as `0x${string}`;
const ASSET_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
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

function buildChannelConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    payer: PAYER,
    payerAuthorizer: PAYER,
    receiver: RECEIVER,
    receiverAuthorizer: "0x0000000000000000000000000000000000000000",
    token: ASSET_BASE_SEPOLIA,
    withdrawDelay: 900,
    salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
    ...overrides,
  };
}

function buildVoucherPayload(
  channelId: string,
  maxClaimableAmount: string,
  config: ChannelConfig,
): PaymentPayload {
  const payload: BatchSettlementVoucherPayload = {
    type: "voucher",
    channelConfig: config,
    voucher: {
      channelId: channelId as `0x${string}`,
      maxClaimableAmount,
      signature: "0xdeadbeef",
    },
  };
  return {
    x402Version: 2,
    accepted: makeRequirements(),
    payload: payload as unknown as Record<string, unknown>,
  };
}

function buildRefundPayload(
  channelId: string,
  maxClaimableAmount: string,
  config: ChannelConfig,
  amount?: string,
): PaymentPayload {
  const payload: BatchSettlementRefundPayload = {
    type: "refund",
    channelConfig: config,
    voucher: {
      channelId: channelId as `0x${string}`,
      maxClaimableAmount,
      signature: "0xdeadbeef",
    },
    ...(amount !== undefined ? { amount } : {}),
  };
  return {
    x402Version: 2,
    accepted: makeRequirements(),
    payload: payload as unknown as Record<string, unknown>,
  };
}

function buildDepositPayload(
  channelId: string,
  config: ChannelConfig,
  amount: string,
  maxClaimable: string,
): PaymentPayload {
  const payload: BatchSettlementDepositPayload = {
    type: "deposit",
    channelConfig: config,
    voucher: {
      channelId: channelId as `0x${string}`,
      maxClaimableAmount: maxClaimable,
      signature: "0xcafebabe",
    },
    deposit: {
      amount,
      authorization: {
        erc3009Authorization: {
          validAfter: "0",
          validBefore: "9999999999",
          salt: "0x0000000000000000000000000000000000000000000000000000000000000001",
          signature: "0xfeedbeef",
        },
      },
    },
  };
  return {
    x402Version: 2,
    accepted: makeRequirements(),
    payload: payload as unknown as Record<string, unknown>,
  };
}

function makeRequirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "batch-settlement",
    network: NETWORK,
    amount: "1000",
    asset: ASSET_BASE_SEPOLIA,
    payTo: RECEIVER,
    maxTimeoutSeconds: 3600,
    extra: {},
    ...overrides,
  };
}

describe("BatchSettlementEvmScheme — construction", () => {
  it("uses an in-memory channel storage by default", () => {
    const server = new BatchSettlementEvmScheme(RECEIVER);
    expect(server.scheme).toBe("batch-settlement");
    expect(server.getStorage()).toBeInstanceOf(InMemoryChannelStorage);
    expect(server.getReceiverAddress()).toBe(RECEIVER);
    expect(server.getWithdrawDelay()).toBe(900);
    expect(server.getReceiverAuthorizerSigner()).toBeUndefined();
  });

  it("allows custom storage and withdrawDelay", () => {
    const storage = new InMemoryChannelStorage();
    const signer = buildAuthorizerSigner();
    const server = new BatchSettlementEvmScheme(RECEIVER, {
      storage,
      withdrawDelay: 1800,
      receiverAuthorizerSigner: signer,
    });
    expect(server.getStorage()).toBe(storage);
    expect(server.getWithdrawDelay()).toBe(1800);
    expect(server.getReceiverAuthorizerSigner()).toBe(signer);
  });
});

describe("BatchSettlementEvmScheme — parsePrice", () => {
  const server = new BatchSettlementEvmScheme(RECEIVER);

  it("converts $ strings to USDC base units on Base Sepolia", async () => {
    const result = await server.parsePrice("$0.10", NETWORK);
    expect(result.amount).toBe("100000");
    expect(result.asset).toBe(ASSET_BASE_SEPOLIA);
  });

  it("converts plain decimal strings", async () => {
    const result = await server.parsePrice("0.50", NETWORK);
    expect(result.amount).toBe("500000");
  });

  it("converts numeric prices", async () => {
    const result = await server.parsePrice(1, NETWORK);
    expect(result.amount).toBe("1000000");
  });

  it("returns AssetAmount as-is when an explicit asset is provided", async () => {
    const result = await server.parsePrice(
      {
        amount: "12345",
        asset: "0x1111111111111111111111111111111111111111",
        extra: { foo: "bar" },
      },
      NETWORK,
    );
    expect(result.amount).toBe("12345");
    expect(result.asset).toBe("0x1111111111111111111111111111111111111111");
    expect(result.extra).toEqual({ foo: "bar" });
  });

  it("throws when AssetAmount is missing the asset address", async () => {
    await expect(server.parsePrice({ amount: "100" } as never, NETWORK)).rejects.toThrow(
      /Asset address must be specified/,
    );
  });

  it("throws on invalid money strings", async () => {
    await expect(server.parsePrice("not-a-price!", NETWORK)).rejects.toThrow(
      /Invalid money format/,
    );
  });

  it("uses a registered custom money parser when it returns a result", async () => {
    const server2 = new BatchSettlementEvmScheme(RECEIVER);
    server2.registerMoneyParser(async (amount, network) => {
      if (network === NETWORK) {
        return {
          amount: (amount * 1_000_000_000_000_000_000).toString(),
          asset: "0x2222222222222222222222222222222222222222",
          extra: {},
        };
      }
      return null;
    });
    const result = await server2.parsePrice("1", NETWORK);
    expect(result.amount).toBe("1000000000000000000");
    expect(result.asset).toBe("0x2222222222222222222222222222222222222222");
  });

  it("falls back to default conversion when custom parser returns null", async () => {
    const server2 = new BatchSettlementEvmScheme(RECEIVER);
    server2.registerMoneyParser(async () => null);
    const result = await server2.parsePrice("1", NETWORK);
    expect(result.amount).toBe("1000000");
  });
});

describe("BatchSettlementEvmScheme — enhancePaymentRequirements", () => {
  const baseReqs = makeRequirements();

  it("injects withdrawDelay, receiverAuthorizer, name, version", async () => {
    const server = new BatchSettlementEvmScheme(RECEIVER, { withdrawDelay: 1800 });
    const enhanced = await server.enhancePaymentRequirements(
      baseReqs,
      { x402Version: 2, scheme: "batch-settlement", network: NETWORK },
      [],
    );

    expect(enhanced.extra?.withdrawDelay).toBe(1800);
    expect(enhanced.extra?.receiverAuthorizer).toBe("");
    expect(enhanced.extra?.name).toBe("USDC");
    expect(enhanced.extra?.version).toBe("2");
  });

  it("propagates receiver-authorizer from configured signer", async () => {
    const signer = buildAuthorizerSigner();
    const server = new BatchSettlementEvmScheme(RECEIVER, { receiverAuthorizerSigner: signer });
    const enhanced = await server.enhancePaymentRequirements(
      baseReqs,
      { x402Version: 2, scheme: "batch-settlement", network: NETWORK },
      [],
    );
    expect(enhanced.extra?.receiverAuthorizer).toBe(signer.address);
  });

  it("falls back to receiverAuthorizer from supportedKind.extra when no signer is configured", async () => {
    const server = new BatchSettlementEvmScheme(RECEIVER);
    const enhanced = await server.enhancePaymentRequirements(
      baseReqs,
      {
        x402Version: 2,
        scheme: "batch-settlement",
        network: NETWORK,
        extra: { receiverAuthorizer: "0xabcdefABCDef0000000000000000000000000001" },
      },
      [],
    );
    expect(enhanced.extra?.receiverAuthorizer).toBe("0xabcdefABCDef0000000000000000000000000001");
  });

  it("preserves existing extra entries", async () => {
    const server = new BatchSettlementEvmScheme(RECEIVER);
    const enhanced = await server.enhancePaymentRequirements(
      makeRequirements({ extra: { custom: "yes" } }),
      { x402Version: 2, scheme: "batch-settlement", network: NETWORK },
      [],
    );
    expect(enhanced.extra?.custom).toBe("yes");
  });
});

describe("BatchSettlementEvmScheme — onBeforeVerify", () => {
  let server: BatchSettlementEvmScheme;
  let storage: InMemoryChannelStorage;

  beforeEach(() => {
    storage = new InMemoryChannelStorage();
    server = new BatchSettlementEvmScheme(RECEIVER, { storage });
  });

  it("does nothing when scheme does not match", async () => {
    const reqs = makeRequirements({ scheme: "exact" });
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const result = await server.schemeHooks.onBeforeVerify!({
      paymentPayload: buildVoucherPayload(channelId, "1000", config),
      requirements: reqs,
    } as never);
    expect(result).toBeUndefined();
  });

  it("does nothing when payload is not a voucher", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const result = await server.schemeHooks.onBeforeVerify!({
      paymentPayload: buildDepositPayload(channelId, config, "10000", "1000"),
      requirements: makeRequirements(),
    } as never);
    expect(result).toBeUndefined();
  });

  it("does nothing when no channel record is stored yet", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const result = await server.schemeHooks.onBeforeVerify!({
      paymentPayload: buildVoucherPayload(channelId, "1000", config),
      requirements: makeRequirements(),
    } as never);
    expect(result).toBeUndefined();
  });

  it("does nothing when client cumulative matches expected", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storage.set(channelId, {
      channelId,
      channelConfig: config,
      payer: PAYER.toLowerCase(),
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0x",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    });

    const result = await server.schemeHooks.onBeforeVerify!({
      paymentPayload: buildVoucherPayload(channelId, "2000", config),
      requirements: makeRequirements({ amount: "1000" }),
    } as never);
    expect(result).toBeUndefined();
  });

  it("does nothing for a refund voucher when no channel record exists (defers to facilitator for on-chain recovery)", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const result = await server.schemeHooks.onBeforeVerify!({
      paymentPayload: buildRefundPayload(channelId, "0", config),
      requirements: makeRequirements({ amount: "0" }),
    } as never);

    expect(result).toBeUndefined();
  });

  it("accepts a zero-charge refund voucher whose maxClaimable equals chargedCumulativeAmount", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storage.set(channelId, {
      channelId,
      channelConfig: config,
      payer: PAYER.toLowerCase(),
      chargedCumulativeAmount: "1500",
      signedMaxClaimable: "1500",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    });

    const result = await server.schemeHooks.onBeforeVerify!({
      paymentPayload: buildRefundPayload(channelId, "1500", config),
      requirements: makeRequirements({ amount: "1000" }),
    } as never);

    expect(result).toBeUndefined();
  });

  it("aborts a refund voucher whose maxClaimable does not match chargedCumulativeAmount", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storage.set(channelId, {
      channelId,
      channelConfig: config,
      payer: PAYER.toLowerCase(),
      chargedCumulativeAmount: "1500",
      signedMaxClaimable: "1500",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    });

    const result = (await server.schemeHooks.onBeforeVerify!({
      paymentPayload: buildRefundPayload(channelId, "2500", config),
      requirements: makeRequirements({ amount: "0" }),
    } as never)) as { abort: true; reason: string };

    expect(result?.abort).toBe(true);
    expect(result?.reason).toBe("batch_settlement_stale_cumulative_amount");
  });

  it("aborts with stale_cumulative_amount when client cumulative is wrong", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storage.set(channelId, {
      channelId,
      channelConfig: config,
      payer: PAYER.toLowerCase(),
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    });

    const reqs = makeRequirements({ amount: "1000" });
    const result = (await server.schemeHooks.onBeforeVerify!({
      paymentPayload: buildVoucherPayload(channelId, "500", config),
      requirements: reqs,
    } as never)) as {
      abort: true;
      reason: string;
      errorDetails?: { recoverable?: boolean; data?: Record<string, unknown> };
    };

    expect(result?.abort).toBe(true);
    expect(result?.reason).toBe("batch_settlement_stale_cumulative_amount");
    expect(result.errorDetails?.recoverable).toBe(true);
    expect(result.errorDetails?.data).toMatchObject({
      channelId,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0xabcd",
    });
    expect(reqs.extra?.chargedCumulativeAmount).toBeUndefined();
  });
});

describe("BatchSettlementEvmScheme — onAfterVerify", () => {
  let server: BatchSettlementEvmScheme;
  let storage: InMemoryChannelStorage;

  beforeEach(() => {
    storage = new InMemoryChannelStorage();
    server = new BatchSettlementEvmScheme(RECEIVER, { storage });
  });

  it("creates a channel record from a deposit payload after a successful verify", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const result: VerifyResponse = {
      isValid: true,
      payer: PAYER,
      extra: { balance: "10000", totalClaimed: "0", refundNonce: "0" },
    } as VerifyResponse;

    await server.schemeHooks.onAfterVerify!({
      paymentPayload: buildDepositPayload(channelId, config, "10000", "1000"),
      requirements: makeRequirements(),
      result,
    } as never);

    const channel = await storage.get(channelId);
    expect(channel?.payer).toBe(PAYER.toLowerCase());
    expect(channel?.balance).toBe("10000");
    expect(channel?.signedMaxClaimable).toBe("1000");
    expect(channel?.signature).toBe("0xcafebabe");
  });

  it("does not create channel record when result.isValid is false", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await server.schemeHooks.onAfterVerify!({
      paymentPayload: buildVoucherPayload(channelId, "1000", config),
      requirements: makeRequirements(),
      result: { isValid: false } as VerifyResponse,
    } as never);
    expect(await storage.get(channelId)).toBeUndefined();
  });

  it("returns a skipHandler directive for a refund voucher", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const result: VerifyResponse = {
      isValid: true,
      payer: PAYER,
      extra: { balance: "10000", totalClaimed: "0", refundNonce: "0" },
    } as VerifyResponse;

    const directive = await server.schemeHooks.onAfterVerify!({
      paymentPayload: buildRefundPayload(channelId, "0", config),
      requirements: makeRequirements({ amount: "0" }),
      result,
    } as never);

    expect(directive).toBeDefined();
    expect(directive!.skipHandler).toBe(true);
    expect(directive!.response?.contentType).toBe("application/json");
    expect((directive!.response?.body as { message: string }).message).toBe("Refund acknowledged");
    expect((directive!.response?.body as { channelId: string }).channelId).toBe(channelId);
  });

  it("does not return a skipHandler directive for a non-refund voucher", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const result: VerifyResponse = {
      isValid: true,
      payer: PAYER,
      extra: { balance: "10000", totalClaimed: "1000", refundNonce: "0" },
    } as VerifyResponse;

    const directive = await server.schemeHooks.onAfterVerify!({
      paymentPayload: buildVoucherPayload(channelId, "1000", config),
      requirements: makeRequirements(),
      result,
    } as never);

    expect(directive).toBeUndefined();
  });
});

describe("BatchSettlementEvmScheme — onBeforeSettle", () => {
  let server: BatchSettlementEvmScheme;
  let storage: InMemoryChannelStorage;

  beforeEach(() => {
    storage = new InMemoryChannelStorage();
    server = new BatchSettlementEvmScheme(RECEIVER, { storage });
  });

  it("aborts a voucher payload when no channel record exists", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const result = (await server.schemeHooks.onBeforeSettle!({
      paymentPayload: buildVoucherPayload(channelId, "1000", config),
      requirements: makeRequirements({ amount: "1000" }),
    } as never)) as { abort: true; reason: string };
    expect(result?.abort).toBe(true);
    expect(result?.reason).toBe("missing_batch_settlement_channel");
  });

  it("aborts when charged exceeds the signed cap", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storage.set(channelId, {
      channelId,
      channelConfig: config,
      payer: PAYER.toLowerCase(),
      chargedCumulativeAmount: "900",
      signedMaxClaimable: "1000",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    });
    const result = (await server.schemeHooks.onBeforeSettle!({
      paymentPayload: buildVoucherPayload(channelId, "1000", config),
      requirements: makeRequirements({ amount: "500" }),
    } as never)) as { abort: true; reason: string };
    expect(result?.abort).toBe(true);
    expect(result?.reason).toBe("batch_settlement_charge_exceeds_signed_cumulative");
  });

  it("returns skip+result for a normal voucher and updates channel record", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storage.set(channelId, {
      channelId,
      channelConfig: config,
      payer: PAYER.toLowerCase(),
      chargedCumulativeAmount: "0",
      signedMaxClaimable: "0",
      signature: "0x",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    });

    const result = (await server.schemeHooks.onBeforeSettle!({
      paymentPayload: buildVoucherPayload(channelId, "1000", config),
      requirements: makeRequirements({ amount: "1000" }),
    } as never)) as { skip: true; result: SettleResponse };

    expect(result?.skip).toBe(true);
    expect(result?.result.success).toBe(true);
    expect(Object.keys(result?.result ?? {}).slice(0, 5)).toEqual([
      "success",
      "payer",
      "transaction",
      "network",
      "amount",
    ]);
    expect(result?.result.extra?.channelId).toBe(channelId);
    expect(result?.result.extra?.chargedCumulativeAmount).toBe("1000");
    expect(Object.keys(result?.result.extra ?? {}).at(-1)).toBe("chargedCumulativeAmount");

    const updated = await storage.get(channelId);
    expect(updated?.chargedCumulativeAmount).toBe("1000");
    expect(updated?.signedMaxClaimable).toBe("1000");
  });

  it("enriches a zero-charge refund voucher into a full refundWithSignature payload", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storage.set(channelId, {
      channelId,
      channelConfig: config,
      payer: PAYER.toLowerCase(),
      chargedCumulativeAmount: "500",
      signedMaxClaimable: "500",
      signature: "0xdeadbeef",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 1,
      lastRequestTimestamp: 0,
    });

    // Zero-charge voucher: maxClaimableAmount equals the existing chargedCumulativeAmount.
    const payload = buildRefundPayload(channelId, "500", config);
    const ret = await server.schemeHooks.onBeforeSettle!({
      paymentPayload: payload,
      requirements: makeRequirements({ amount: "0" }),
    } as never);
    expect(ret).toBeUndefined();

    const enrichment = await server.enrichSettlementPayload({
      paymentPayload: payload,
      requirements: makeRequirements({ amount: "0" }),
    } as never);
    expect(enrichment?.amount).toBe("9500");
    expect(enrichment?.refundNonce).toBe("1");
  });

  it("recovers a refund voucher channel record from facilitator extras when local state was lost", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);

    // Local server state is empty (channel record loss scenario).
    expect(await storage.get(channelId)).toBeUndefined();

    // 1. handleBeforeVerify must not abort — it should defer to the facilitator.
    const beforeVerify = await server.schemeHooks.onBeforeVerify!({
      paymentPayload: buildRefundPayload(channelId, "1500", config),
      requirements: makeRequirements({ amount: "0" }),
    } as never);
    expect(beforeVerify).toBeUndefined();

    // 2. handleAfterVerify rebuilds the channel record from on-chain snapshot returned by the facilitator.
    const verifyResult: VerifyResponse = {
      isValid: true,
      payer: PAYER,
      extra: { balance: "10000", totalClaimed: "1500", refundNonce: "3" },
    } as VerifyResponse;
    await server.schemeHooks.onAfterVerify!({
      paymentPayload: buildRefundPayload(channelId, "1500", config),
      requirements: makeRequirements({ amount: "0" }),
      result: verifyResult,
    } as never);
    const recovered = await storage.get(channelId);
    expect(recovered).toBeDefined();
    expect(recovered?.balance).toBe("10000");
    expect(recovered?.totalClaimed).toBe("1500");
    expect(recovered?.chargedCumulativeAmount).toBe("1500");
    expect(recovered?.refundNonce).toBe(3);

    // 3. Settlement enrichment builds a refundWithSignature payload with amount = balance - totalClaimed.
    const settlePayload = buildRefundPayload(channelId, "1500", config);
    const settleRet = await server.schemeHooks.onBeforeSettle!({
      paymentPayload: settlePayload,
      requirements: makeRequirements({ amount: "0" }),
    } as never);
    expect(settleRet).toBeUndefined();

    const enrichment = await server.enrichSettlementPayload({
      paymentPayload: settlePayload,
      requirements: makeRequirements({ amount: "0" }),
    } as never);
    expect(enrichment?.amount).toBe("8500");
    expect(enrichment?.refundNonce).toBe("3");
  });

  it("aborts a recovered refund voucher with refund_no_balance when channel is fully drained", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);

    // Local state is empty; on-chain shows the channel was already drained (balance == totalClaimed).
    const verifyResult: VerifyResponse = {
      isValid: true,
      payer: PAYER,
      extra: { balance: "61800", totalClaimed: "61800", refundNonce: "1" },
    } as VerifyResponse;
    await server.schemeHooks.onAfterVerify!({
      paymentPayload: buildRefundPayload(channelId, "61800", config),
      requirements: makeRequirements({ amount: "0" }),
      result: verifyResult,
    } as never);

    const settlePayload = buildRefundPayload(channelId, "61800", config);
    const ret = await server.schemeHooks.onBeforeSettle!({
      paymentPayload: settlePayload,
      requirements: makeRequirements({ amount: "0" }),
    } as never);
    expect(ret).toBeUndefined();

    await expect(
      server.enrichSettlementPayload({
        paymentPayload: settlePayload,
        requirements: makeRequirements({ amount: "0" }),
      } as never),
    ).rejects.toThrow("batch_settlement_refund_no_balance");
  });

  it("honors refund amount on a partial refund payload", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storage.set(channelId, {
      channelId,
      channelConfig: config,
      payer: PAYER.toLowerCase(),
      chargedCumulativeAmount: "500",
      signedMaxClaimable: "500",
      signature: "0xdeadbeef",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    });

    const payload = buildRefundPayload(channelId, "500", config, "1000");

    const ret = await server.schemeHooks.onBeforeSettle!({
      paymentPayload: payload,
      requirements: makeRequirements({ amount: "0" }),
    } as never);
    expect(ret).toBeUndefined();

    const enrichment = await server.enrichSettlementPayload({
      paymentPayload: payload,
      requirements: makeRequirements({ amount: "0" }),
    } as never);
    expect(enrichment?.amount).toBeUndefined();
    expect(enrichment?.refundNonce).toBe("0");
  });
});

describe("BatchSettlementEvmScheme — onAfterSettle", () => {
  let server: BatchSettlementEvmScheme;
  let storage: InMemoryChannelStorage;

  beforeEach(() => {
    storage = new InMemoryChannelStorage();
    server = new BatchSettlementEvmScheme(RECEIVER, { storage });
  });

  it("updates channel record and exposes deposit response enrichment", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const payload = buildDepositPayload(channelId, config, "10000", "1000");
    const result: SettleResponse = {
      success: true,
      transaction: "0xtx",
      network: NETWORK,
      payer: PAYER,
      extra: { balance: "10000", totalClaimed: "0", refundNonce: "0" },
    } as SettleResponse;

    await server.schemeHooks.onAfterSettle!({
      paymentPayload: payload,
      requirements: makeRequirements({ amount: "1000" }),
      result,
    } as never);

    const channel = await storage.get(channelId);
    expect(channel?.chargedCumulativeAmount).toBe("1000");
    expect(channel?.balance).toBe("10000");
    expect((result.extra as Record<string, string>).chargedCumulativeAmount).toBeUndefined();

    const enrichment = await server.enrichSettlementResponse({
      paymentPayload: payload,
      requirements: makeRequirements({ amount: "1000" }),
      result,
    } as never);
    expect(enrichment).toEqual({ chargedCumulativeAmount: "1000" });
  });

  it("deletes channel record and exposes refund response enrichment after a full refund", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const channel: Channel = {
      channelId,
      channelConfig: config,
      payer: PAYER.toLowerCase(),
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    };
    await storage.set(channelId, channel);

    const refundPayload = {
      x402Version: 2,
      scheme: "batch-settlement",
      network: NETWORK,
      payload: {
        type: "refund",
        channelConfig: config,
        voucher: {
          channelId: channelId as `0x${string}`,
          maxClaimableAmount: "1000",
          signature: "0xabcd",
        },
        amount: "9000",
        refundNonce: "0",
        claims: [
          {
            voucher: { channel: config, maxClaimableAmount: "1000" },
            signature: "0xabcd" as `0x${string}`,
            totalClaimed: "1000",
          },
        ],
      } as unknown as Record<string, unknown>,
    } as unknown as PaymentPayload;
    server.rememberChannelSnapshot(refundPayload, channel);

    const result: SettleResponse = {
      success: true,
      transaction: "0xref",
      network: NETWORK,
      payer: PAYER,
      extra: {
        channelId,
        balance: "1000",
        totalClaimed: "1000",
        withdrawRequestedAt: 0,
        refundNonce: "1",
      },
    } as SettleResponse;

    await server.schemeHooks.onAfterSettle!({
      paymentPayload: refundPayload,
      requirements: makeRequirements(),
      result,
    } as never);

    expect(await storage.get(channelId)).toBeUndefined();
    expect((result.extra as Record<string, unknown>).refund).toBeUndefined();

    const enrichment = await server.enrichSettlementResponse({
      paymentPayload: refundPayload,
      requirements: makeRequirements(),
      result,
    } as never);
    expect(enrichment).toEqual({ chargedCumulativeAmount: "1000" });
  });

  it("retains channel record and increments refundNonce on a partial refundWithSignature", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const channel: Channel = {
      channelId,
      channelConfig: config,
      payer: PAYER.toLowerCase(),
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 2,
      lastRequestTimestamp: 0,
    };
    await storage.set(channelId, channel);

    const refundPayload = {
      x402Version: 2,
      scheme: "batch-settlement",
      network: NETWORK,
      payload: {
        type: "refund",
        channelConfig: config,
        voucher: {
          channelId: channelId as `0x${string}`,
          maxClaimableAmount: "1000",
          signature: "0xabcd",
        },
        amount: "2000",
        refundNonce: "2",
        claims: [
          {
            voucher: { channel: config, maxClaimableAmount: "1000" },
            signature: "0xabcd" as `0x${string}`,
            totalClaimed: "1000",
          },
        ],
      } as unknown as Record<string, unknown>,
    } as unknown as PaymentPayload;
    server.rememberChannelSnapshot(refundPayload, channel);

    const result: SettleResponse = {
      success: true,
      transaction: "0xref",
      network: NETWORK,
      payer: PAYER,
      extra: {
        channelId,
        balance: "8000",
        totalClaimed: "1000",
        withdrawRequestedAt: 0,
        refundNonce: "3",
        refundedAmount: "2000",
      },
    } as SettleResponse;

    await server.schemeHooks.onAfterSettle!({
      paymentPayload: refundPayload,
      requirements: makeRequirements(),
      result,
    } as never);

    const updated = await storage.get(channelId);
    expect(updated).toBeDefined();
    expect(updated?.balance).toBe("8000");
    expect(updated?.refundNonce).toBe(3);
    expect((result.extra as Record<string, unknown>).refundedAmount).toBe("2000");

    const enrichment = await server.enrichSettlementResponse({
      paymentPayload: refundPayload,
      requirements: makeRequirements(),
      result,
    } as never);
    expect(enrichment).toEqual({ chargedCumulativeAmount: "1000" });
  });

  it("does not modify state when result.success is false", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await server.schemeHooks.onAfterSettle!({
      paymentPayload: buildDepositPayload(channelId, config, "10000", "1000"),
      requirements: makeRequirements(),
      result: { success: false } as SettleResponse,
    } as never);
    expect(await storage.get(channelId)).toBeUndefined();
  });
});

describe("BatchSettlementChannelManager — getClaimableVouchers", () => {
  let server: BatchSettlementEvmScheme;
  let manager: BatchSettlementChannelManager;
  let storage: InMemoryChannelStorage;

  beforeEach(() => {
    storage = new InMemoryChannelStorage();
    server = new BatchSettlementEvmScheme(RECEIVER, { storage });
    manager = buildManager(server);
  });

  it("returns [] when no channel records exist", async () => {
    expect(await manager.getClaimableVouchers()).toEqual([]);
  });

  it("filters out channel records that have nothing to claim", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storage.set(channelId, {
      channelId,
      channelConfig: config,
      payer: PAYER.toLowerCase(),
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "1000",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
    });
    expect(await manager.getClaimableVouchers()).toEqual([]);
  });

  it("returns claimable vouchers when charged > totalClaimed", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storage.set(channelId, {
      channelId,
      channelConfig: config,
      payer: PAYER.toLowerCase(),
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "1000",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
    });

    const claims = await manager.getClaimableVouchers();
    expect(claims).toHaveLength(1);
    expect(claims[0].voucher.maxClaimableAmount).toBe("5000");
    expect(claims[0].totalClaimed).toBe("5000");
    expect(claims[0].signature).toBe("0xabcd");
    expect(claims[0].voucher.channel).toEqual(config);
  });

  it("respects idleSecs filter", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storage.set(channelId, {
      channelId,
      channelConfig: config,
      payer: PAYER.toLowerCase(),
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "1000",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
    });

    expect(await manager.getClaimableVouchers({ idleSecs: 60 })).toEqual([]);
  });
});

describe("BatchSettlementChannelManager — getWithdrawalPendingSessions", () => {
  it("returns channel records with withdrawRequestedAt > 0", async () => {
    const storage = new InMemoryChannelStorage();
    const server = new BatchSettlementEvmScheme(RECEIVER, { storage });
    const manager = buildManager(server);

    const config1 = buildChannelConfig();
    const id1 = computeChannelId(config1);
    const config2 = buildChannelConfig({
      salt: "0x0000000000000000000000000000000000000000000000000000000000000099",
    });
    const id2 = computeChannelId(config2);

    await storage.set(id1, {
      channelId: id1,
      channelConfig: config1,
      payer: PAYER.toLowerCase(),
      chargedCumulativeAmount: "0",
      signedMaxClaimable: "0",
      signature: "0x",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    });
    await storage.set(id2, {
      channelId: id2,
      channelConfig: config2,
      payer: PAYER.toLowerCase(),
      chargedCumulativeAmount: "0",
      signedMaxClaimable: "0",
      signature: "0x",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 12345,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    });

    const result = await manager.getWithdrawalPendingSessions();
    expect(result).toHaveLength(1);
    expect(result[0].channelId).toBe(id2);
  });
});
