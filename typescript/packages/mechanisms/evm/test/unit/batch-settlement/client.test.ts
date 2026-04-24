import { describe, it, expect, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import { BatchSettlementEvmScheme } from "../../../src/batch-settlement/client/scheme";
import {
  type BatchSettlementClientDeps,
  buildChannelConfig,
  getSession,
  hasSession,
  processSettleResponse,
  recoverSession,
} from "../../../src/batch-settlement/client/session";
import { processCorrectivePaymentRequired } from "../../../src/batch-settlement/client/recovery";
import { InMemoryClientSessionStorage } from "../../../src/batch-settlement/client/storage";
import { computeChannelId } from "../../../src/batch-settlement/utils";
import {
  isBatchSettlementDepositPayload,
  isBatchSettlementVoucherPayload,
} from "../../../src/batch-settlement/types";
import type { ClientEvmSigner } from "../../../src/signer";
import type { PaymentRequirements, SettleResponse, PaymentRequired } from "@x402/core/types";

const PAYER_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const VOUCHER_PRIVATE_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const RECEIVER_ADDRESS = "0x9876543210987654321098765432109876543210" as `0x${string}`;
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
const NETWORK = "eip155:84532";
const DEFAULT_SALT =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

function buildSigner(privateKey: `0x${string}`): ClientEvmSigner {
  const account = privateKeyToAccount(privateKey);
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

function buildSignerWithRead(
  privateKey: `0x${string}`,
  readContract: ClientEvmSigner["readContract"],
): ClientEvmSigner {
  const base = buildSigner(privateKey);
  return { ...base, readContract };
}

function makeRequirements(overrides?: Partial<PaymentRequirements>): PaymentRequirements {
  return {
    scheme: "batch-settlement",
    network: NETWORK,
    amount: "1000",
    asset: ASSET,
    payTo: RECEIVER_ADDRESS,
    maxTimeoutSeconds: 3600,
    extra: {
      name: "USDC",
      version: "2",
      withdrawDelay: 900,
    },
    ...overrides,
  };
}

interface ClientShape {
  signer: ClientEvmSigner;
  storage?: InMemoryClientSessionStorage;
  salt?: `0x${string}`;
  payerAuthorizer?: `0x${string}`;
  voucherSigner?: ClientEvmSigner;
}

function makeDeps(c: ClientShape): BatchSettlementClientDeps {
  return {
    signer: c.signer,
    storage: c.storage ?? new InMemoryClientSessionStorage(),
    salt: c.salt ?? DEFAULT_SALT,
    payerAuthorizer: c.payerAuthorizer,
    voucherSigner: c.voucherSigner,
  };
}

describe("BatchSettlementEvmScheme — construction", () => {
  it("exposes the batch-settlement scheme id", () => {
    const client = new BatchSettlementEvmScheme(buildSigner(PAYER_PRIVATE_KEY));
    expect(client.scheme).toBe("batch-settlement");
  });

  it("accepts a bare deposit policy as second argument", () => {
    const client = new BatchSettlementEvmScheme(buildSigner(PAYER_PRIVATE_KEY), {
      depositMultiplier: 5,
      maxDeposit: "1000000",
      autoTopUp: false,
    });
    expect(client).toBeDefined();
  });

  it("accepts full options object", () => {
    const storage = new InMemoryClientSessionStorage();
    const client = new BatchSettlementEvmScheme(buildSigner(PAYER_PRIVATE_KEY), {
      storage,
      depositPolicy: { depositMultiplier: 2 },
      salt: "0x0000000000000000000000000000000000000000000000000000000000000077",
    });
    expect(client).toBeDefined();
  });

  it("rejects non-integer depositMultiplier", () => {
    expect(
      () =>
        new BatchSettlementEvmScheme(buildSigner(PAYER_PRIVATE_KEY), {
          depositMultiplier: 1.5,
        }),
    ).toThrow(/depositMultiplier/);
  });

  it("rejects depositMultiplier < 1", () => {
    expect(
      () =>
        new BatchSettlementEvmScheme(buildSigner(PAYER_PRIVATE_KEY), {
          depositMultiplier: 0,
        }),
    ).toThrow(/depositMultiplier/);
  });

  it("rejects negative maxDeposit", () => {
    expect(
      () =>
        new BatchSettlementEvmScheme(buildSigner(PAYER_PRIVATE_KEY), {
          maxDeposit: "-1",
        }),
    ).toThrow(/maxDeposit/);
  });

  it("rejects non-integer maxDeposit string", () => {
    expect(
      () =>
        new BatchSettlementEvmScheme(buildSigner(PAYER_PRIVATE_KEY), {
          maxDeposit: "abc",
        }),
    ).toThrow(/maxDeposit/);
  });

  it("rejects payerAuthorizer that does not match voucherSigner", () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const voucherSigner = buildSigner(VOUCHER_PRIVATE_KEY);
    expect(
      () =>
        new BatchSettlementEvmScheme(signer, {
          payerAuthorizer: "0x0000000000000000000000000000000000000001",
          voucherSigner,
        }),
    ).toThrow(/payerAuthorizer address must match voucherSigner.address/);
  });

  it("accepts payerAuthorizer matching voucherSigner.address", () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const voucherSigner = buildSigner(VOUCHER_PRIVATE_KEY);
    expect(
      () =>
        new BatchSettlementEvmScheme(signer, {
          payerAuthorizer: voucherSigner.address,
          voucherSigner,
        }),
    ).not.toThrow();
  });
});

describe("buildChannelConfig", () => {
  it("uses signer's address as payer and payerAuthorizer when not overridden", () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const config = buildChannelConfig(makeDeps({ signer }), makeRequirements());

    expect(config.payer).toBe(signer.address);
    expect(config.payerAuthorizer).toBe(getAddress(signer.address));
    expect(config.receiver).toBe(RECEIVER_ADDRESS);
    expect(config.token).toBe(ASSET);
    expect(config.withdrawDelay).toBe(900);
    expect(config.salt).toBe("0x0000000000000000000000000000000000000000000000000000000000000000");
  });

  it("uses payerAuthorizer override when provided", () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const voucherSigner = buildSigner(VOUCHER_PRIVATE_KEY);
    const config = buildChannelConfig(
      makeDeps({ signer, voucherSigner, payerAuthorizer: voucherSigner.address }),
      makeRequirements(),
    );
    expect(config.payerAuthorizer).toBe(getAddress(voucherSigner.address));
  });

  it("falls back to voucherSigner.address when payerAuthorizer is not set", () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const voucherSigner = buildSigner(VOUCHER_PRIVATE_KEY);
    const config = buildChannelConfig(makeDeps({ signer, voucherSigner }), makeRequirements());
    expect(config.payerAuthorizer).toBe(getAddress(voucherSigner.address));
  });

  it("uses receiverAuthorizer from extra when present, else zero", () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const recv = "0x1111111111111111111111111111111111111111" as `0x${string}`;
    const cfg = buildChannelConfig(
      makeDeps({ signer }),
      makeRequirements({ extra: { receiverAuthorizer: recv } }),
    );
    expect(cfg.receiverAuthorizer).toBe(recv);
    const cfgZero = buildChannelConfig(makeDeps({ signer }), makeRequirements({ extra: {} }));
    expect(cfgZero.receiverAuthorizer).toBe("0x0000000000000000000000000000000000000000");
  });

  it("defaults withdrawDelay to 900 when not in extra", () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const cfg = buildChannelConfig(makeDeps({ signer }), makeRequirements({ extra: {} }));
    expect(cfg.withdrawDelay).toBe(900);
  });

  it("respects custom salt from options", () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const salt =
      "0xabc1230000000000000000000000000000000000000000000000000000000099" as `0x${string}`;
    const cfg = buildChannelConfig(makeDeps({ signer, salt }), makeRequirements());
    expect(cfg.salt).toBe(salt);
  });
});

describe("BatchSettlementEvmScheme — createPaymentPayload", () => {
  it("returns a deposit-then-voucher payload on first request (no balance)", async () => {
    const signer = buildSignerWithRead(PAYER_PRIVATE_KEY, async () => [0n, 0n]);
    const client = new BatchSettlementEvmScheme(signer);

    const result = await client.createPaymentPayload(2, makeRequirements());
    expect(result.x402Version).toBe(2);
    expect(isBatchSettlementDepositPayload(result.payload as Record<string, unknown>)).toBe(true);
  });

  it("voucher.maxClaimableAmount equals charged + amount on first request", async () => {
    const signer = buildSignerWithRead(PAYER_PRIVATE_KEY, async () => [0n, 0n]);
    const client = new BatchSettlementEvmScheme(signer);

    const result = await client.createPaymentPayload(2, makeRequirements({ amount: "5000" }));
    const payload = result.payload as { voucher: { maxClaimableAmount: string } };
    expect(payload.voucher.maxClaimableAmount).toBe("5000");
  });

  it("returns a voucher-only payload when balance is sufficient", async () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const storage = new InMemoryClientSessionStorage();
    const client = new BatchSettlementEvmScheme(signer, { storage });

    const config = buildChannelConfig(makeDeps({ signer }), makeRequirements());
    const channelId = computeChannelId(config);
    await storage.set(channelId.toLowerCase(), {
      chargedCumulativeAmount: "0",
      balance: "10000",
      totalClaimed: "0",
    });

    const result = await client.createPaymentPayload(2, makeRequirements({ amount: "1000" }));
    expect(isBatchSettlementVoucherPayload(result.payload as Record<string, unknown>)).toBe(true);
    expect((result.payload as { maxClaimableAmount: string }).maxClaimableAmount).toBe("1000");
  });

  it("creates a top-up deposit when balance is insufficient and autoTopUp is on", async () => {
    const readContract = vi.fn().mockResolvedValue([100n, 0n]);
    const signer = buildSignerWithRead(PAYER_PRIVATE_KEY, readContract);
    const storage = new InMemoryClientSessionStorage();
    const client = new BatchSettlementEvmScheme(signer, { storage });

    const config = buildChannelConfig(makeDeps({ signer }), makeRequirements());
    const channelId = computeChannelId(config);
    await storage.set(channelId.toLowerCase(), {
      chargedCumulativeAmount: "100",
      balance: "100",
      totalClaimed: "0",
    });

    const result = await client.createPaymentPayload(2, makeRequirements({ amount: "1000" }));
    expect(isBatchSettlementDepositPayload(result.payload as Record<string, unknown>)).toBe(true);
  });

  it("does not auto-top-up when autoTopUp is false (returns voucher even if low balance)", async () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const storage = new InMemoryClientSessionStorage();
    const client = new BatchSettlementEvmScheme(signer, {
      storage,
      depositPolicy: { autoTopUp: false },
    });

    const config = buildChannelConfig(makeDeps({ signer }), makeRequirements());
    const channelId = computeChannelId(config);
    await storage.set(channelId.toLowerCase(), {
      chargedCumulativeAmount: "0",
      balance: "100",
      totalClaimed: "0",
    });

    const result = await client.createPaymentPayload(2, makeRequirements({ amount: "1000" }));
    expect(isBatchSettlementVoucherPayload(result.payload as Record<string, unknown>)).toBe(true);
  });

  it("createPaymentPayload no longer attaches refund flags (refund() handles it)", async () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const storage = new InMemoryClientSessionStorage();
    const client = new BatchSettlementEvmScheme(signer, { storage });

    const config = buildChannelConfig(makeDeps({ signer }), makeRequirements());
    const channelId = computeChannelId(config);
    await storage.set(channelId.toLowerCase(), {
      chargedCumulativeAmount: "0",
      balance: "10000",
      totalClaimed: "0",
    });

    const result = await client.createPaymentPayload(2, makeRequirements());
    expect((result.payload as { refund?: boolean }).refund).toBeUndefined();
    expect(
      (client as unknown as { requestRefund?: (id: string) => void }).requestRefund,
    ).toBeUndefined();
  });

  it("uses voucherSigner to sign the voucher when provided", async () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const voucherSigner = buildSigner(VOUCHER_PRIVATE_KEY);
    const storage = new InMemoryClientSessionStorage();
    const client = new BatchSettlementEvmScheme(signer, { storage, voucherSigner });

    const config = buildChannelConfig(makeDeps({ signer, voucherSigner }), makeRequirements());
    const channelId = computeChannelId(config);
    await storage.set(channelId.toLowerCase(), {
      chargedCumulativeAmount: "0",
      balance: "10000",
      totalClaimed: "0",
    });

    const result = await client.createPaymentPayload(2, makeRequirements());
    expect(isBatchSettlementVoucherPayload(result.payload as Record<string, unknown>)).toBe(true);
  });

  it("computed channelId matches the on-the-wire payload channelId", async () => {
    const signer = buildSignerWithRead(PAYER_PRIVATE_KEY, async () => [0n, 0n]);
    const client = new BatchSettlementEvmScheme(signer);

    const config = buildChannelConfig(makeDeps({ signer }), makeRequirements());
    const expectedId = computeChannelId(config);

    const result = await client.createPaymentPayload(2, makeRequirements());
    const payload = result.payload as { voucher: { channelId: string } };
    expect(payload.voucher.channelId.toLowerCase()).toBe(expectedId.toLowerCase());
  });

  it("throws when EIP-712 domain (name/version) is missing for deposit flow", async () => {
    const signer = buildSignerWithRead(PAYER_PRIVATE_KEY, async () => [0n, 0n]);
    const client = new BatchSettlementEvmScheme(signer);

    await expect(
      client.createPaymentPayload(2, makeRequirements({ extra: { withdrawDelay: 900 } })),
    ).rejects.toThrow(/EIP-712 domain parameters/);
  });

  it("respects depositMultiplier in deposit amount", async () => {
    const signer = buildSignerWithRead(PAYER_PRIVATE_KEY, async () => [0n, 0n]);
    const client = new BatchSettlementEvmScheme(signer, { depositMultiplier: 7 });

    const result = await client.createPaymentPayload(2, makeRequirements({ amount: "1000" }));
    const payload = result.payload as { deposit: { amount: string } };
    expect(payload.deposit.amount).toBe("7000");
  });

  it("caps deposit amount at maxDeposit", async () => {
    const signer = buildSignerWithRead(PAYER_PRIVATE_KEY, async () => [0n, 0n]);
    const client = new BatchSettlementEvmScheme(signer, {
      depositMultiplier: 100,
      maxDeposit: "5000",
    });
    const result = await client.createPaymentPayload(2, makeRequirements({ amount: "1000" }));
    const payload = result.payload as { deposit: { amount: string } };
    expect(payload.deposit.amount).toBe("5000");
  });
});

describe("processSettleResponse / schemeHooks", () => {
  it("updates session fields from settle response extras", async () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const storage = new InMemoryClientSessionStorage();

    const channelId = "0xabc1230000000000000000000000000000000000000000000000000000000001";

    const settle: SettleResponse = {
      success: true,
      transaction: "0x",
      network: NETWORK,
      payer: signer.address,
      extra: {
        channelId,
        chargedCumulativeAmount: "1000",
        balance: "9000",
        totalClaimed: "500",
      },
    };

    await processSettleResponse(storage, settle);
    const ctx = await storage.get(channelId.toLowerCase());
    expect(ctx?.chargedCumulativeAmount).toBe("1000");
    expect(ctx?.balance).toBe("9000");
    expect(ctx?.totalClaimed).toBe("500");
  });

  it("ignores settle responses with no channelId", async () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const storage = new InMemoryClientSessionStorage();

    await processSettleResponse(storage, {
      success: true,
      transaction: "0x",
      network: NETWORK,
      payer: signer.address,
      extra: {},
    } as SettleResponse);

    const all = await Promise.all(
      ["0xabc1230000000000000000000000000000000000000000000000000000000001"].map(id =>
        storage.get(id),
      ),
    );
    expect(all.every(c => c === undefined)).toBe(true);
  });

  it("deletes session when refund flag is set in settle response", async () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const storage = new InMemoryClientSessionStorage();

    const channelId = "0xabc1230000000000000000000000000000000000000000000000000000000002";
    await storage.set(channelId.toLowerCase(), { chargedCumulativeAmount: "1000" });

    await processSettleResponse(storage, {
      success: true,
      transaction: "0x",
      network: NETWORK,
      payer: signer.address,
      extra: { channelId, refund: true },
    } as SettleResponse);

    expect(await storage.get(channelId.toLowerCase())).toBeUndefined();
  });

  it("schemeHooks.onPaymentResponse delegates to processSettleResponse", async () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const storage = new InMemoryClientSessionStorage();
    const client = new BatchSettlementEvmScheme(signer, { storage });

    const channelId = "0xabc1230000000000000000000000000000000000000000000000000000000003";
    await client.schemeHooks.onPaymentResponse!({
      settleResponse: {
        success: true,
        transaction: "0x",
        network: NETWORK,
        payer: signer.address,
        extra: { channelId, chargedCumulativeAmount: "42" },
      } as SettleResponse,
    } as Parameters<NonNullable<typeof client.schemeHooks.onPaymentResponse>>[0]);

    const ctx = await storage.get(channelId.toLowerCase());
    expect(ctx?.chargedCumulativeAmount).toBe("42");
  });
});

describe("recoverSession / hasSession / getSession", () => {
  it("recoverSession reads on-chain channels() and stores context", async () => {
    const readContract = vi.fn().mockResolvedValue([5000n, 1000n]);
    const signer = buildSignerWithRead(PAYER_PRIVATE_KEY, readContract);
    const storage = new InMemoryClientSessionStorage();

    const ctx = await recoverSession(makeDeps({ signer, storage }), makeRequirements());
    expect(ctx.balance).toBe("5000");
    expect(ctx.totalClaimed).toBe("1000");
    expect(ctx.chargedCumulativeAmount).toBe("1000");

    const config = buildChannelConfig(makeDeps({ signer }), makeRequirements());
    const id = computeChannelId(config);
    expect((await storage.get(id.toLowerCase()))?.balance).toBe("5000");
  });

  it("recoverSession throws when readContract is unavailable", async () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const storage = new InMemoryClientSessionStorage();
    await expect(recoverSession(makeDeps({ signer, storage }), makeRequirements())).rejects.toThrow(
      /readContract/,
    );
  });

  it("hasSession / getSession reflect storage state", async () => {
    const storage = new InMemoryClientSessionStorage();

    const id = "0xabc1230000000000000000000000000000000000000000000000000000000010";
    expect(await hasSession(storage, id)).toBe(false);
    expect(await getSession(storage, id)).toBeUndefined();

    await storage.set(id.toLowerCase(), { chargedCumulativeAmount: "100" });
    expect(await hasSession(storage, id)).toBe(true);
    expect((await getSession(storage, id))?.chargedCumulativeAmount).toBe("100");
  });
});

describe("processCorrectivePaymentRequired", () => {
  function makeAccept(extra: Record<string, unknown>): PaymentRequirements {
    return makeRequirements({ extra: { ...makeRequirements().extra, ...extra } });
  }

  it("returns false for unrelated error codes", async () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const storage = new InMemoryClientSessionStorage();

    const ok = await processCorrectivePaymentRequired(makeDeps({ signer, storage }), {
      x402Version: 2,
      error: "some_other_error",
      accepts: [makeRequirements()],
    } as PaymentRequired);
    expect(ok).toBe(false);
  });

  it("returns false when no batch-settlement accept entry is present", async () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const storage = new InMemoryClientSessionStorage();

    const ok = await processCorrectivePaymentRequired(makeDeps({ signer, storage }), {
      x402Version: 2,
      error: "batch_settlement_stale_cumulative_amount",
      accepts: [{ ...makeRequirements(), scheme: "exact" }],
    } as PaymentRequired);
    expect(ok).toBe(false);
  });

  it("recoverFromOnChainState updates session when no signature is present", async () => {
    const readContract = vi.fn().mockResolvedValue([10000n, 2500n]);
    const signer = buildSignerWithRead(PAYER_PRIVATE_KEY, readContract);
    const storage = new InMemoryClientSessionStorage();

    const ok = await processCorrectivePaymentRequired(makeDeps({ signer, storage }), {
      x402Version: 2,
      error: "batch_settlement_stale_cumulative_amount",
      accepts: [makeRequirements()],
    } as PaymentRequired);

    expect(ok).toBe(true);
    const id = computeChannelId(buildChannelConfig(makeDeps({ signer }), makeRequirements()));
    const ctx = await storage.get(id.toLowerCase());
    expect(ctx?.chargedCumulativeAmount).toBe("2500");
    expect(ctx?.balance).toBe("10000");
  });

  it("recoverFromSignature succeeds when signature comes from this client's signer", async () => {
    const readContract = vi.fn().mockResolvedValue([10000n, 500n]);
    const signer = buildSignerWithRead(PAYER_PRIVATE_KEY, readContract);
    const storage = new InMemoryClientSessionStorage();

    const config = buildChannelConfig(makeDeps({ signer }), makeRequirements());
    const channelId = computeChannelId(config);

    const { signVoucher } = await import("../../../src/batch-settlement/client/voucher");
    const signed = await signVoucher(signer, channelId, "1500", NETWORK);

    const accept = makeAccept({
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: signed.maxClaimableAmount,
      signature: signed.signature,
    });

    const ok = await processCorrectivePaymentRequired(makeDeps({ signer, storage }), {
      x402Version: 2,
      error: "batch_settlement_stale_cumulative_amount",
      accepts: [accept],
    } as PaymentRequired);

    expect(ok).toBe(true);
    const ctx = await storage.get(channelId.toLowerCase());
    expect(ctx?.chargedCumulativeAmount).toBe("1000");
    expect(ctx?.signedMaxClaimable).toBe("1500");
    expect(ctx?.balance).toBe("10000");
    expect(ctx?.totalClaimed).toBe("500");
  });

  it("recoverFromSignature returns false when signature is from a different signer", async () => {
    const readContract = vi.fn().mockResolvedValue([10000n, 500n]);
    const signer = buildSignerWithRead(PAYER_PRIVATE_KEY, readContract);
    const storage = new InMemoryClientSessionStorage();

    const otherSigner = buildSigner(VOUCHER_PRIVATE_KEY);
    const config = buildChannelConfig(makeDeps({ signer }), makeRequirements());
    const channelId = computeChannelId(config);
    const { signVoucher } = await import("../../../src/batch-settlement/client/voucher");
    const signed = await signVoucher(otherSigner, channelId, "1500", NETWORK);

    const accept = makeAccept({
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: signed.maxClaimableAmount,
      signature: signed.signature,
    });

    const ok = await processCorrectivePaymentRequired(makeDeps({ signer, storage }), {
      x402Version: 2,
      error: "batch_settlement_stale_cumulative_amount",
      accepts: [accept],
    } as PaymentRequired);
    expect(ok).toBe(false);
  });

  it("recoverFromSignature returns false when charged > signedMaxClaimable", async () => {
    const readContract = vi.fn().mockResolvedValue([10000n, 500n]);
    const signer = buildSignerWithRead(PAYER_PRIVATE_KEY, readContract);
    const storage = new InMemoryClientSessionStorage();

    const accept = makeAccept({
      chargedCumulativeAmount: "2000",
      signedMaxClaimable: "1500",
      signature: "0xdead",
    });

    const ok = await processCorrectivePaymentRequired(makeDeps({ signer, storage }), {
      x402Version: 2,
      error: "batch_settlement_stale_cumulative_amount",
      accepts: [accept],
    } as PaymentRequired);
    expect(ok).toBe(false);
  });

  it("recoverFromSignature returns false when charged < on-chain totalClaimed", async () => {
    const readContract = vi.fn().mockResolvedValue([10000n, 5000n]);
    const signer = buildSignerWithRead(PAYER_PRIVATE_KEY, readContract);
    const storage = new InMemoryClientSessionStorage();

    const config = buildChannelConfig(makeDeps({ signer }), makeRequirements());
    const channelId = computeChannelId(config);
    const { signVoucher } = await import("../../../src/batch-settlement/client/voucher");
    const signed = await signVoucher(signer, channelId, "2000", NETWORK);

    const accept = makeAccept({
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: signed.maxClaimableAmount,
      signature: signed.signature,
    });

    const ok = await processCorrectivePaymentRequired(makeDeps({ signer, storage }), {
      x402Version: 2,
      error: "batch_settlement_stale_cumulative_amount",
      accepts: [accept],
    } as PaymentRequired);
    expect(ok).toBe(false);
  });

  it("schemeHooks.onPaymentResponse returns { recovered: true } on a successful corrective", async () => {
    const readContract = vi.fn().mockResolvedValue([10000n, 0n]);
    const signer = buildSignerWithRead(PAYER_PRIVATE_KEY, readContract);
    const client = new BatchSettlementEvmScheme(signer);

    const result = await client.schemeHooks.onPaymentResponse!({
      paymentRequired: {
        x402Version: 2,
        error: "batch_settlement_stale_cumulative_amount",
        accepts: [makeRequirements()],
      } as PaymentRequired,
    } as Parameters<NonNullable<typeof client.schemeHooks.onPaymentResponse>>[0]);

    expect(result).toEqual({ recovered: true });
  });
});

describe("BatchSettlementEvmScheme — refund()", () => {
  const REFUND_URL = "https://example.test/protected";

  function buildRefundRequirements(): PaymentRequirements {
    return makeRequirements({
      extra: {
        name: "USDC",
        version: "2",
        withdrawDelay: 900,
        receiverAuthorizer: "0x1111111111111111111111111111111111111111",
      },
    });
  }

  function makeFetch(
    handlers: Array<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>,
  ): typeof fetch {
    let i = 0;
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const handler = handlers[i++] ?? handlers[handlers.length - 1];
      return handler(input, init);
    }) as typeof fetch;
  }

  async function probe402Response(): Promise<Response> {
    const { encodePaymentRequiredHeader } = await import("@x402/core/http");
    const reqs = buildRefundRequirements();
    const header = encodePaymentRequiredHeader({ x402Version: 2, accepts: [reqs] });
    return new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": header } });
  }

  async function refundSuccessResponse(extra: Record<string, unknown>): Promise<Response> {
    const { encodePaymentResponseHeader } = await import("@x402/core/http");
    const settle: SettleResponse = {
      success: true,
      transaction: "0xtx",
      network: NETWORK,
      payer: privateKeyToAccount(PAYER_PRIVATE_KEY).address,
      extra,
    } as SettleResponse;
    const header = encodePaymentResponseHeader(settle);
    return new Response(null, { status: 200, headers: { "PAYMENT-RESPONSE": header } });
  }

  it("performs a full refund: probes, sends voucher, deletes session", async () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const storage = new InMemoryClientSessionStorage();
    const client = new BatchSettlementEvmScheme(signer, { storage });

    const config = buildChannelConfig(makeDeps({ signer }), buildRefundRequirements());
    const channelId = computeChannelId(config);
    await storage.set(channelId.toLowerCase(), {
      chargedCumulativeAmount: "500",
      balance: "10000",
      totalClaimed: "0",
    });

    let capturedSig: string | undefined;
    const fetchImpl = makeFetch([
      async () => probe402Response(),
      async (_url, init) => {
        capturedSig = (init?.headers as Record<string, string> | undefined)?.["PAYMENT-SIGNATURE"];
        return refundSuccessResponse({ channelId, refund: true, balance: "0" });
      },
    ]);

    const settle = await client.refund(REFUND_URL, { fetch: fetchImpl });
    expect(settle.success).toBe(true);
    expect(capturedSig).toBeTruthy();
    expect(await storage.get(channelId.toLowerCase())).toBeUndefined();
  });

  it("performs a partial refund: keeps the session and updates balance", async () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const storage = new InMemoryClientSessionStorage();
    const client = new BatchSettlementEvmScheme(signer, { storage });

    const config = buildChannelConfig(makeDeps({ signer }), buildRefundRequirements());
    const channelId = computeChannelId(config);
    await storage.set(channelId.toLowerCase(), {
      chargedCumulativeAmount: "500",
      balance: "10000",
      totalClaimed: "0",
    });

    const fetchImpl = makeFetch([
      async () => probe402Response(),
      async () =>
        refundSuccessResponse({
          channelId,
          refund: true,
          refundedAmount: "2000",
          balance: "8000",
          chargedCumulativeAmount: "500",
          totalClaimed: "0",
        }),
    ]);

    const settle = await client.refund(REFUND_URL, { amount: "2000", fetch: fetchImpl });
    expect(settle.success).toBe(true);

    const ctx = await storage.get(channelId.toLowerCase());
    expect(ctx?.balance).toBe("8000");
    expect(ctx?.chargedCumulativeAmount).toBe("500");
  });

  it("rejects an invalid refund amount before contacting the server", async () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const client = new BatchSettlementEvmScheme(signer);
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(client.refund(REFUND_URL, { amount: "0", fetch: fetchImpl })).rejects.toThrow(
      /Invalid refund amount/,
    );
    await expect(client.refund(REFUND_URL, { amount: "1.5", fetch: fetchImpl })).rejects.toThrow(
      /Invalid refund amount/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("recovers from a corrective 402 and retries once", async () => {
    const readContract = vi.fn().mockResolvedValue([10000n, 500n]);
    const signer = buildSignerWithRead(PAYER_PRIVATE_KEY, readContract);
    const storage = new InMemoryClientSessionStorage();
    const client = new BatchSettlementEvmScheme(signer, { storage });

    const config = buildChannelConfig(makeDeps({ signer }), buildRefundRequirements());
    const channelId = computeChannelId(config);

    const { encodePaymentRequiredHeader } = await import("@x402/core/http");
    const correctiveHeader = encodePaymentRequiredHeader({
      x402Version: 2,
      error: "batch_settlement_evm_cumulative_below_claimed",
      accepts: [buildRefundRequirements()],
    } as PaymentRequired);

    const fetchImpl = makeFetch([
      async () => probe402Response(),
      async () =>
        new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": correctiveHeader } }),
      async () => refundSuccessResponse({ channelId, refund: true, balance: "0" }),
    ]);

    const settle = await client.refund(REFUND_URL, { fetch: fetchImpl });
    expect(settle.success).toBe(true);
    expect(readContract).toHaveBeenCalled();
  });

  it("throws when the probe receives a non-402 response", async () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const client = new BatchSettlementEvmScheme(signer);
    const fetchImpl = makeFetch([async () => new Response("ok", { status: 200 })]);

    await expect(client.refund(REFUND_URL, { fetch: fetchImpl })).rejects.toThrow(
      /Refund probe expected 402/,
    );
  });

  it("fails fast (no retry) when server returns 402 with batch_settlement_refund_no_balance", async () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const storage = new InMemoryClientSessionStorage();
    const client = new BatchSettlementEvmScheme(signer, { storage });

    const config = buildChannelConfig(makeDeps({ signer }), buildRefundRequirements());
    const channelId = computeChannelId(config);
    await storage.set(channelId.toLowerCase(), {
      chargedCumulativeAmount: "500",
      balance: "10000",
      totalClaimed: "0",
    });

    const { encodePaymentResponseHeader } = await import("@x402/core/http");
    const failureSettle: SettleResponse = {
      success: false,
      transaction: "",
      network: NETWORK,
      payer: signer.address,
      errorReason: "batch_settlement_refund_no_balance",
      errorMessage: "Channel has no remaining balance to refund",
    } as SettleResponse;
    const failureHeader = encodePaymentResponseHeader(failureSettle);

    const refundCall = vi.fn(async () => {
      return new Response(null, { status: 402, headers: { "PAYMENT-RESPONSE": failureHeader } });
    });
    const fetchImpl = makeFetch([async () => probe402Response(), refundCall]);

    await expect(client.refund(REFUND_URL, { fetch: fetchImpl })).rejects.toThrow(
      /batch_settlement_refund_no_balance/,
    );
    expect(refundCall).toHaveBeenCalledTimes(1);
  });

  it("fails fast on a verify-side 402 with a non-recoverable refund error", async () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const storage = new InMemoryClientSessionStorage();
    const client = new BatchSettlementEvmScheme(signer, { storage });

    const config = buildChannelConfig(makeDeps({ signer }), buildRefundRequirements());
    const channelId = computeChannelId(config);
    await storage.set(channelId.toLowerCase(), {
      chargedCumulativeAmount: "500",
      balance: "10000",
      totalClaimed: "0",
    });

    const { encodePaymentRequiredHeader } = await import("@x402/core/http");
    const requiredHeader = encodePaymentRequiredHeader({
      x402Version: 2,
      error: "batch_settlement_refund_no_balance",
      accepts: [buildRefundRequirements()],
    } as PaymentRequired);

    const refundCall = vi.fn(async () => {
      return new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": requiredHeader } });
    });
    const fetchImpl = makeFetch([async () => probe402Response(), refundCall]);

    await expect(client.refund(REFUND_URL, { fetch: fetchImpl })).rejects.toThrow(
      /batch_settlement_refund_no_balance/,
    );
    expect(refundCall).toHaveBeenCalledTimes(1);
  });

  it("throws before any PAYMENT-SIGNATURE request when local session shows the channel is drained", async () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const storage = new InMemoryClientSessionStorage();
    const client = new BatchSettlementEvmScheme(signer, { storage });

    const config = buildChannelConfig(makeDeps({ signer }), buildRefundRequirements());
    const channelId = computeChannelId(config);
    await storage.set(channelId.toLowerCase(), {
      chargedCumulativeAmount: "61800",
      balance: "61800",
      totalClaimed: "61800",
    });

    const refundCall = vi.fn(async () => {
      throw new Error("refund request should not have been sent");
    });
    const fetchImpl = makeFetch([async () => probe402Response(), refundCall]);

    await expect(client.refund(REFUND_URL, { fetch: fetchImpl })).rejects.toThrow(
      /channel has no remaining balance/,
    );
    expect(refundCall).not.toHaveBeenCalled();
  });

  it("throws when the receiver lacks a configured receiverAuthorizer", async () => {
    const signer = buildSigner(PAYER_PRIVATE_KEY);
    const client = new BatchSettlementEvmScheme(signer);

    const { encodePaymentRequiredHeader } = await import("@x402/core/http");
    const reqs = makeRequirements({ extra: { name: "USDC", version: "2", withdrawDelay: 900 } });
    const header = encodePaymentRequiredHeader({ x402Version: 2, accepts: [reqs] });
    const fetchImpl = makeFetch([
      async () => new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": header } }),
    ]);

    await expect(client.refund(REFUND_URL, { fetch: fetchImpl })).rejects.toThrow(
      /receiverAuthorizer/,
    );
  });
});
