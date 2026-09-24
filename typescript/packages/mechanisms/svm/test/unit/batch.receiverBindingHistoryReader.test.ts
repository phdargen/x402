import { generateKeyPairSigner } from "@solana/kit";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { buildOpenPaymentChannelTransaction } from "../../src/payment-channels/open";
import { readReceiverAuthorizer } from "../../src/batch-settlement/facilitator/bindingSource";
import { InMemoryBatchReceiverAuthorizerStore } from "../../src/batch-settlement/facilitator/receiverAuthorizerStore";
import type { BatchReceiverBindingHistoryReader } from "../../src/batch-settlement/facilitator/receiverBindingHistoryReader";
import { BatchSvmScheme } from "../../src/batch-settlement/facilitator/scheme";
import {
  encodeReceiverBindingMemo,
  readReceiverBindingFromOpen,
} from "../../src/batch-settlement/receiverBinding";
import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";

const NETWORK = SOLANA_DEVNET_CAIP2;
const MINT = USDC_DEVNET_ADDRESS;
const RECEIVER = USDC_MAINNET_ADDRESS;

let payer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let feePayer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let server: Awaited<ReturnType<typeof generateKeyPairSigner>>;

beforeAll(async () => {
  payer = await generateKeyPairSigner();
  feePayer = await generateKeyPairSigner();
  server = await generateKeyPairSigner();
});

function openArgs(overrides: { bindingMemo?: string; memo?: string } = {}) {
  return {
    authorizedSigner: payer.address,
    bindingMemo: encodeReceiverBindingMemo(server.address),
    blockhash: { blockhash: RECEIVER, lastValidBlockHeight: 1n },
    deposit: 10_000n,
    feePayer: feePayer.address,
    gracePeriod: 900,
    mint: MINT,
    openSlot: 123n,
    payee: feePayer.address,
    payer,
    recipients: [{ bps: 10_000, recipient: RECEIVER }],
    salt: 0n,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    ...overrides,
  };
}

function signer() {
  return {
    getAccountInfo: vi.fn(),
    getAddresses: () => [feePayer.address],
    getSigner: () => feePayer,
  };
}

describe("readReceiverBindingFromOpen", () => {
  it("reads the single binding memo on the channel's open", async () => {
    const open = await buildOpenPaymentChannelTransaction(openArgs());
    expect(readReceiverBindingFromOpen(open.transaction, open.channelId)).toBe(server.address);
    expect(readReceiverBindingFromOpen(open.transaction, payer.address)).toBeUndefined();
    expect(readReceiverBindingFromOpen("not-a-transaction", open.channelId)).toBeUndefined();
  });

  it("returns undefined when the open has no binding memo or more than one", async () => {
    const missing = await buildOpenPaymentChannelTransaction(openArgs({ bindingMemo: undefined }));
    expect(readReceiverBindingFromOpen(missing.transaction, missing.channelId)).toBeUndefined();
    const doubled = await buildOpenPaymentChannelTransaction(
      openArgs({ memo: encodeReceiverBindingMemo(payer.address) }),
    );
    expect(readReceiverBindingFromOpen(doubled.transaction, doubled.channelId)).toBeUndefined();
  });
});

describe("batch-settlement binding source", () => {
  it("rejects a facilitator with neither a store nor a history reader", () => {
    expect(() => new BatchSvmScheme(signer() as never)).toThrow(/receiverAuthorizerStore/);
    expect(
      () =>
        new BatchSvmScheme(signer() as never, {
          receiverBindingHistoryReader: {
            getSignaturesForAddress: vi.fn(),
          } as unknown as BatchReceiverBindingHistoryReader,
        }),
    ).toThrow(/getTransaction/);
  });

  it("resolves an open from history, skips a failed transaction, and writes the store back", async () => {
    const open = await buildOpenPaymentChannelTransaction(openArgs());
    const store = new InMemoryBatchReceiverAuthorizerStore();
    const fetched: string[] = [];
    const historyReader: BatchReceiverBindingHistoryReader = {
      getSignaturesForAddress: async (_network, _address, options) => {
        if (options?.before === undefined) {
          return [
            ...Array.from({ length: 999 }, (_, index) => ({
              err: { InstructionError: [0, "Custom"] },
              signature: `failed-${index}`,
            })),
            { err: null, signature: "not-the-open" },
          ];
        }
        expect(options.before).toBe("not-the-open");
        return [{ err: null, signature: "the-open" }];
      },
      getTransaction: async (_network, signature) => {
        fetched.push(signature);
        if (signature === "not-the-open") return missingMemo();
        return open.transaction;
      },
    };
    await expect(
      readReceiverAuthorizer(store, historyReader, NETWORK, open.channelId),
    ).resolves.toBe(server.address);
    expect(fetched).toEqual(["the-open"]);
    expect((await store.get(NETWORK, open.channelId))?.receiverAuthorizer).toBe(server.address);
  });

  it("does not write a store row when the open has no single binding memo", async () => {
    const missing = await buildOpenPaymentChannelTransaction(openArgs({ bindingMemo: undefined }));
    const doubled = await buildOpenPaymentChannelTransaction(
      openArgs({ memo: encodeReceiverBindingMemo(payer.address) }),
    );
    let wire = missing.transaction;
    const store = new InMemoryBatchReceiverAuthorizerStore();
    const historyReader: BatchReceiverBindingHistoryReader = {
      getSignaturesForAddress: async () => [{ err: null, signature: "only" }],
      getTransaction: async () => wire,
    };

    await expect(
      readReceiverAuthorizer(store, historyReader, NETWORK, missing.channelId),
    ).resolves.toBeUndefined();
    wire = doubled.transaction;
    await expect(
      readReceiverAuthorizer(store, historyReader, NETWORK, doubled.channelId),
    ).resolves.toBeUndefined();
    expect(await store.get(NETWORK, missing.channelId)).toBeUndefined();
    expect(await store.get(NETWORK, doubled.channelId)).toBeUndefined();
  });
});

function missingMemo(): Promise<string> {
  return buildOpenPaymentChannelTransaction(openArgs({ bindingMemo: undefined })).then(
    open => open.transaction,
  );
}
