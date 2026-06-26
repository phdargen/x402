import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const infoExecute = vi.fn();
const setInfoAccountId = vi.fn(function (this: unknown) {
  return this;
});

vi.mock("@hiero-ledger/sdk", async () => {
  const actual = await vi.importActual<typeof import("@hiero-ledger/sdk")>("@hiero-ledger/sdk");
  class AccountInfoQuery {
    setAccountId = setInfoAccountId;
    execute = infoExecute;
  }
  return { ...actual, AccountInfoQuery };
});

import {
  AccountId,
  Client,
  Hbar,
  type Key,
  KeyList,
  PrivateKey,
  TokenId,
  TopicCreateTransaction,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import {
  createClientHederaSigner,
  createHederaSignAndSubmitTransaction,
  createHederaVerifyPayerSignature,
} from "../../src/signer";
import { inspectHederaTransaction } from "../../src/utils";
import { HEDERA_TESTNET_USDC } from "../../src/constants";

describe("Hedera signer helpers", () => {
  it("creates default SDK-backed client signer", async () => {
    const privateKey = PrivateKey.generateED25519();
    const signer = createClientHederaSigner("0.0.1001", privateKey, {
      network: "hedera:testnet",
    });

    const txBase64 = await signer.createPartiallySignedTransferTransaction({
      scheme: "exact",
      network: "hedera:testnet",
      asset: "0.0.0",
      amount: "1000",
      payTo: "0.0.1002",
      maxTimeoutSeconds: 120,
      extra: {
        feePayer: "0.0.1003",
      },
    });

    expect(typeof txBase64).toBe("string");
    expect(txBase64.length).toBeGreaterThan(0);
  });

  it("creates token transfer transaction for HTS assets", async () => {
    const privateKey = PrivateKey.generateED25519();
    const signer = createClientHederaSigner("0.0.1001", privateKey, {
      network: "hedera:testnet",
    });

    const txBase64 = await signer.createPartiallySignedTransferTransaction({
      scheme: "exact",
      network: "hedera:testnet",
      asset: "0.0.6001",
      amount: "2500",
      payTo: "0.0.1002",
      maxTimeoutSeconds: 120,
      extra: {
        feePayer: "0.0.1003",
      },
    });
    const inspected = inspectHederaTransaction(txBase64);

    expect(inspected.tokenTransfers["0.0.6001"]).toBeDefined();
    expect(inspected.hbarTransfers.length).toBe(0);
  });

  it("requires feePayer in requirements.extra", async () => {
    const privateKey = PrivateKey.generateED25519();
    const signer = createClientHederaSigner("0.0.1001", privateKey, {
      network: "hedera:testnet",
    });

    await expect(
      signer.createPartiallySignedTransferTransaction({
        scheme: "exact",
        network: "hedera:testnet",
        asset: "0.0.0",
        amount: "1000",
        payTo: "0.0.1002",
        maxTimeoutSeconds: 120,
        extra: {},
      }),
    ).rejects.toThrow("feePayer is required");
  });

  it("rejects zero/negative transfer amounts", async () => {
    const privateKey = PrivateKey.generateED25519();
    const signer = createClientHederaSigner("0.0.1001", privateKey, {
      network: "hedera:testnet",
    });

    await expect(
      signer.createPartiallySignedTransferTransaction({
        scheme: "exact",
        network: "hedera:testnet",
        asset: "0.0.0",
        amount: "0",
        payTo: "0.0.1002",
        maxTimeoutSeconds: 120,
        extra: {
          feePayer: "0.0.1003",
        },
      }),
    ).rejects.toThrow("amount must be greater than zero");
  });

  it("rejects invalid payTo account format", async () => {
    const privateKey = PrivateKey.generateED25519();
    const signer = createClientHederaSigner("0.0.1001", privateKey, {
      network: "hedera:testnet",
    });

    await expect(
      signer.createPartiallySignedTransferTransaction({
        scheme: "exact",
        network: "hedera:testnet",
        asset: "0.0.0",
        amount: "1",
        payTo: "not-an-account",
        maxTimeoutSeconds: 120,
        extra: {
          feePayer: "0.0.1003",
        },
      }),
    ).rejects.toThrow();
  });

  it("supports repeated signing calls on the same signer instance", async () => {
    const privateKey = PrivateKey.generateED25519();
    const signer = createClientHederaSigner("0.0.1001", privateKey, {
      network: "hedera:testnet",
    });

    const requirements = {
      scheme: "exact" as const,
      network: "hedera:testnet",
      asset: "0.0.0",
      amount: "1000",
      payTo: "0.0.1002",
      maxTimeoutSeconds: 120,
      extra: { feePayer: "0.0.1003" },
    };

    const first = await signer.createPartiallySignedTransferTransaction(requirements);
    const second = await signer.createPartiallySignedTransferTransaction(requirements);

    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
  });

  it("supports custom node URL client configuration", async () => {
    const privateKey = PrivateKey.generateED25519();
    const signer = createClientHederaSigner("0.0.1001", privateKey, {
      network: "hedera:testnet",
      nodeUrl: "127.0.0.1:50211",
    });

    const txBase64 = await signer.createPartiallySignedTransferTransaction({
      scheme: "exact",
      network: "hedera:testnet",
      asset: "0.0.0",
      amount: "1",
      payTo: "0.0.1002",
      maxTimeoutSeconds: 120,
      extra: {
        feePayer: "0.0.1003",
      },
    });

    expect(typeof txBase64).toBe("string");
    expect(txBase64.length).toBeGreaterThan(0);
  });
});

describe("createHederaSignAndSubmitTransaction", () => {
  const feePayerKey = PrivateKey.generateED25519();
  const feePayerAccount = "0.0.5001";

  async function buildTransferBase64(asset: string): Promise<string> {
    const tx = new TransferTransaction();
    const amount = BigInt("10000");
    if (asset === "0.0.0") {
      tx.addHbarTransfer(AccountId.fromString("0.0.9001"), Hbar.fromTinybars((-amount).toString()));
      tx.addHbarTransfer(AccountId.fromString("0.0.7001"), Hbar.fromTinybars(amount.toString()));
    } else {
      const tokenId = TokenId.fromString(asset);
      tx.addTokenTransfer(tokenId, AccountId.fromString("0.0.9001"), (-amount).toString());
      tx.addTokenTransfer(tokenId, AccountId.fromString("0.0.7001"), amount.toString());
    }
    tx.setTransactionId(TransactionId.generate(AccountId.fromString(feePayerAccount)));
    await tx.freezeWith(Client.forTestnet());
    return Buffer.from(tx.toBytes()).toString("base64");
  }

  function fakeClient(): Client {
    return { close: vi.fn() } as unknown as Client;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the transactionId when the receipt reports SUCCESS", async () => {
    const closeSpy = vi.fn();
    const builtClient = { close: closeSpy } as unknown as Client;
    const expectedId = "0.0.5001@1700000002.000000000";
    const getReceipt = vi.fn().mockResolvedValue({ status: "SUCCESS" });
    vi.spyOn(TransferTransaction.prototype, "execute").mockResolvedValue({
      transactionId: { toString: () => expectedId },
      getReceipt,
    } as never);

    const submit = createHederaSignAndSubmitTransaction(() => builtClient, feePayerKey);
    const result = await submit(
      await buildTransferBase64(HEDERA_TESTNET_USDC),
      feePayerAccount,
      "hedera:testnet",
    );

    expect(result).toEqual({ transactionId: expectedId });
    expect(getReceipt).toHaveBeenCalledWith(builtClient);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["TOKEN_NOT_ASSOCIATED_TO_ACCOUNT", HEDERA_TESTNET_USDC],
    ["INSUFFICIENT_ACCOUNT_BALANCE", "0.0.0"],
  ])("surfaces %s when getReceipt rejects (asset %s)", async (statusCode, asset) => {
    const closeSpy = vi.fn();
    const builtClient = { close: closeSpy } as unknown as Client;
    const getReceipt = vi
      .fn()
      .mockRejectedValue(
        new Error(
          `receipt for transaction 0.0.5001@1700000002.000000000 contained error status ${statusCode}`,
        ),
      );
    vi.spyOn(TransferTransaction.prototype, "execute").mockResolvedValue({
      transactionId: { toString: () => "0.0.5001@1700000002.000000000" },
      getReceipt,
    } as never);

    const submit = createHederaSignAndSubmitTransaction(() => builtClient, feePayerKey);

    await expect(
      submit(await buildTransferBase64(asset), feePayerAccount, "hedera:testnet"),
    ).rejects.toThrow(new RegExp(statusCode));
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("closes the client when execute itself rejects (pre-check failure)", async () => {
    const closeSpy = vi.fn();
    const builtClient = { close: closeSpy } as unknown as Client;
    vi.spyOn(TransferTransaction.prototype, "execute").mockRejectedValue(
      new Error("transaction precheck failed: INVALID_SIGNATURE"),
    );

    const submit = createHederaSignAndSubmitTransaction(() => builtClient, feePayerKey);

    await expect(
      submit(await buildTransferBase64("0.0.0"), feePayerAccount, "hedera:testnet"),
    ).rejects.toThrow(/INVALID_SIGNATURE/);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects payloads that are not TransferTransactions", async () => {
    const tx = new TopicCreateTransaction();
    tx.setTopicMemo("not-a-transfer");
    tx.setTransactionId(TransactionId.generate(AccountId.fromString(feePayerAccount)));
    const key = PrivateKey.generateED25519();
    tx.setSubmitKey(key.publicKey);
    await tx.freezeWith(Client.forTestnet());
    const base64 = Buffer.from(tx.toBytes()).toString("base64");

    const submit = createHederaSignAndSubmitTransaction(() => fakeClient(), feePayerKey);
    await expect(submit(base64, feePayerAccount, "hedera:testnet")).rejects.toThrow(
      /expected TransferTransaction/,
    );
  });
});

describe("createHederaVerifyPayerSignature", () => {
  const PAYER = "0.0.9001";
  const PAY_TO = "0.0.7001";
  const FEE_PAYER = "0.0.5001";

  function fakeClient(): Client {
    return { close: vi.fn() } as unknown as Client;
  }

  async function buildTransaction(
    signers: PrivateKey[],
  ): Promise<{ transaction: string; client: Client }> {
    const tx = new TransferTransaction();
    tx.addHbarTransfer(AccountId.fromString(PAYER), Hbar.fromTinybars("-1000"));
    tx.addHbarTransfer(AccountId.fromString(PAY_TO), Hbar.fromTinybars("1000"));
    tx.setTransactionId(TransactionId.generate(AccountId.fromString(FEE_PAYER)));
    await tx.freezeWith(Client.forTestnet());
    for (const signer of signers) {
      await tx.sign(signer);
    }
    return {
      transaction: Buffer.from(tx.toBytes()).toString("base64"),
      client: fakeClient(),
    };
  }

  function withKey(key: Key, client: Client): (network: string) => Client {
    infoExecute.mockResolvedValue({ key });
    return () => client;
  }

  beforeEach(() => {
    infoExecute.mockReset();
    setInfoAccountId.mockClear();
  });

  it("ok when the payer signed with their account key", async () => {
    const key = PrivateKey.generateED25519();
    const { transaction, client } = await buildTransaction([key]);
    const verify = createHederaVerifyPayerSignature(withKey(key.publicKey, client));

    const result = await verify({ payer: PAYER, transaction, network: "hedera:testnet" });
    expect(result).toEqual({ ok: true });
    expect((client as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
  });

  it("fails when signed with a different key", async () => {
    const signingKey = PrivateKey.generateED25519();
    const accountKey = PrivateKey.generateED25519();
    const { transaction, client } = await buildTransaction([signingKey]);
    const verify = createHederaVerifyPayerSignature(withKey(accountKey.publicKey, client));

    const result = await verify({ payer: PAYER, transaction, network: "hedera:testnet" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature_invalid");
  });

  it("fails for an unsigned transaction", async () => {
    const accountKey = PrivateKey.generateED25519();
    const { transaction, client } = await buildTransaction([]);
    const verify = createHederaVerifyPayerSignature(withKey(accountKey.publicKey, client));

    const result = await verify({ payer: PAYER, transaction, network: "hedera:testnet" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature_invalid");
  });

  it("ok when a KeyList threshold is met", async () => {
    const key1 = PrivateKey.generateED25519();
    const key2 = PrivateKey.generateED25519();
    const key3 = PrivateKey.generateED25519();
    const { transaction, client } = await buildTransaction([key1, key2]);
    const keyList = new KeyList([key1.publicKey, key2.publicKey, key3.publicKey], 2);
    const verify = createHederaVerifyPayerSignature(withKey(keyList, client));

    const result = await verify({ payer: PAYER, transaction, network: "hedera:testnet" });
    expect(result).toEqual({ ok: true });
  });

  it("fails when a KeyList threshold is not met", async () => {
    const key1 = PrivateKey.generateED25519();
    const key2 = PrivateKey.generateED25519();
    const key3 = PrivateKey.generateED25519();
    const { transaction, client } = await buildTransaction([key1]);
    const keyList = new KeyList([key1.publicKey, key2.publicKey, key3.publicKey], 2);
    const verify = createHederaVerifyPayerSignature(withKey(keyList, client));

    const result = await verify({ payer: PAYER, transaction, network: "hedera:testnet" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature_invalid");
  });

  it("closes the client even when the account query throws", async () => {
    const client = fakeClient();
    infoExecute.mockRejectedValue(new Error("account info down"));
    const { transaction } = await buildTransaction([PrivateKey.generateED25519()]);
    const verify = createHederaVerifyPayerSignature(() => client);

    await expect(verify({ payer: PAYER, transaction, network: "hedera:testnet" })).rejects.toThrow(
      "account info down",
    );
    expect((client as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
  });
});
