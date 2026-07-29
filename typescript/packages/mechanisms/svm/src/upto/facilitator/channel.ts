/**
 * Channel-flow glue for the `upto` facilitator: voucher signing, co-signing,
 * broadcasting the client `open` (idempotent), and submitting settle+distribute.
 *
 * Kept separate from the scheme orchestration so the onchain mechanics stay
 * readable. All RPC access is threaded in by the caller.
 */

import { createHash } from "node:crypto";
import {
  address,
  appendTransactionMessageInstructions,
  type Blockhash,
  createSignableMessage,
  createTransactionMessage,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Codec,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  type MessagePartialSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Signature,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from "@solana/kit";

import { fetchChannel, type Channel } from "../../payment-channels/generated/accounts/channel";
import { type ServerInstruction } from "../../payment-channels/onchain";
import type { ChannelSplit } from "../../payment-channels/open";
import { encodeVoucherMessageBytes } from "../../payment-channels/voucher";
import { createRpcClient } from "../../utils";

const CHANNEL_ACCOUNT_DISCRIMINATOR = 0;
const CHANNEL_STATUS_OPEN = 0;

/** Signer capable of signing Solana transactions and raw Ed25519 messages. */
export type UptoSvmSigner = TransactionSigner & MessagePartialSigner;

/** RPC client shape used by the channel helpers. */
export type ChannelRpc = ReturnType<typeof createRpcClient>;

/**
 * Sign a payment-channel voucher and return the base58 signature.
 *
 * @param receiverAuthorizer - The channel's authorized signer
 * @param voucher - The voucher fields
 * @param voucher.channelId - Channel PDA (base58)
 * @param voucher.cumulativeAmount - Cumulative settled amount (base units)
 * @param voucher.expiresAt - Voucher deadline (Unix seconds, i64)
 * @returns The base58-encoded 64-byte Ed25519 signature
 */
export async function signVoucher(
  receiverAuthorizer: UptoSvmSigner,
  voucher: { channelId: string; cumulativeAmount: bigint; expiresAt: bigint },
): Promise<string> {
  const message = encodeVoucherMessageBytes(voucher);
  const [dict] = await receiverAuthorizer.signMessages([createSignableMessage(message)]);
  const signature = dict[receiverAuthorizer.address];
  if (!signature) throw new Error("receiverAuthorizer did not return a voucher signature");
  return getBase58Decoder().decode(signature as Uint8Array);
}

/**
 * Whether the channel account already exists onchain (open already broadcast).
 *
 * @param rpc - The RPC client
 * @param channelId - Channel PDA (base58)
 * @returns Whether the account exists
 */
export async function channelExists(rpc: ChannelRpc, channelId: string): Promise<boolean> {
  const info = await rpc.getAccountInfo(address(channelId), { encoding: "base64" }).send();
  return info.value !== null;
}

/** Challenge-bound terms that must match the confirmed channel account. */
export interface ExpectedOpenChannel {
  authorizedSigner: string;
  deposit: bigint;
  gracePeriod: number;
  mint: string;
  payee: string;
  payer: string;
  rentPayer: string;
  splits: readonly ChannelSplit[];
}

/** Onchain channel facts retained from verification through settlement. */
export interface VerifiedOpenChannel {
  channelId: string;
  deposit: bigint;
  mint: string;
  payee: string;
  payer: string;
  rentPayer: string;
  splits: readonly ChannelSplit[];
}

/**
 * Fetch and bind the confirmed channel account before the resource is served.
 *
 * @param rpc - RPC client used to read the channel
 * @param channelId - Channel PDA
 * @param expected - Challenge-bound channel terms
 * @returns Verified channel facts for settlement
 */
export async function fetchAndVerifyOpenChannel(
  rpc: ChannelRpc,
  channelId: string,
  expected: ExpectedOpenChannel,
): Promise<VerifiedOpenChannel> {
  const account = await fetchChannel(rpc, address(channelId));
  return verifyOpenChannelAccount(channelId, account.data, expected);
}

/**
 * Bind a decoded channel account to the terms verified in the submitted open.
 *
 * @param channelId - Channel PDA
 * @param channel - Decoded onchain channel
 * @param expected - Challenge-bound channel terms
 * @returns Verified channel facts for settlement
 */
export function verifyOpenChannelAccount(
  channelId: string,
  channel: Channel,
  expected: ExpectedOpenChannel,
): VerifiedOpenChannel {
  if (channel.discriminator !== CHANNEL_ACCOUNT_DISCRIMINATOR) {
    throw new Error(`channel ${channelId} has an invalid account discriminator`);
  }
  if (channel.status !== CHANNEL_STATUS_OPEN) {
    throw new Error(`channel ${channelId} is not open`);
  }

  assertChannelAddress("mint", channel.mint, expected.mint);
  assertChannelAddress("payee", channel.payee, expected.payee);
  assertChannelAddress("authorized signer", channel.authorizedSigner, expected.authorizedSigner);
  assertChannelAddress("rent payer", channel.rentPayer, expected.rentPayer);
  assertChannelAddress("payer", channel.payer, expected.payer);

  if (channel.gracePeriod !== expected.gracePeriod) {
    throw new Error(
      `channel grace period ${channel.gracePeriod} != expected ${expected.gracePeriod}`,
    );
  }
  if (channel.deposit !== expected.deposit) {
    throw new Error(`channel deposit ${channel.deposit} != expected ${expected.deposit}`);
  }

  const expectedDistributionHash = getChannelDistributionHash(expected.splits);
  if (
    channel.distributionHash.length !== expectedDistributionHash.length ||
    channel.distributionHash.some((value, index) => value !== expectedDistributionHash[index])
  ) {
    throw new Error("channel distribution does not match the expected recipient split");
  }

  return {
    channelId,
    deposit: channel.deposit,
    mint: channel.mint,
    payee: channel.payee,
    payer: channel.payer,
    rentPayer: channel.rentPayer,
    splits: expected.splits,
  };
}

/**
 * Co-sign the fee-payer slot of a partially-signed open transaction,
 * broadcast it, and wait for confirmation. No-op skip is the caller's job
 * (see {@link channelExists}).
 *
 * @param feePayer - The fee-payer signer
 * @param rpc - The RPC client
 * @param openTransactionBase64 - The client-signed open transaction
 * @returns The broadcast signature
 */
export async function broadcastOpen(
  feePayer: UptoSvmSigner,
  rpc: ChannelRpc,
  openTransactionBase64: string,
): Promise<Signature> {
  const tx = getTransactionDecoder().decode(getBase64Codec().encode(openTransactionBase64));
  const signable = { content: tx.messageBytes, signatures: tx.signatures };
  const [dict] = await feePayer.signMessages([signable as never]);
  const fullySigned = {
    ...tx,
    signatures: { ...tx.signatures, ...dict },
  };
  const wire = getBase64EncodedWireTransaction(
    fullySigned as Parameters<typeof getBase64EncodedWireTransaction>[0],
  );
  const signature = await rpc.sendTransaction(wire, { encoding: "base64" }).send();
  await confirmSignature(rpc, signature);
  return signature;
}

/**
 * Compile the settle+distribute instructions into a transaction signed by the
 * fee payer, broadcast it, and confirm. Other signers, such as the channel
 * payee on `settle_and_seal`, are carried by the instruction list.
 *
 * @param feePayer - The fee-payer signer
 * @param rpc - The RPC client
 * @param instructions - settle_and_seal (+ optional Ed25519 precompile) then distribute
 * @returns The broadcast signature
 */
export async function submitSettle(
  feePayer: UptoSvmSigner,
  rpc: ChannelRpc,
  instructions: readonly ServerInstruction[],
): Promise<Signature> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayerSigner(feePayer, m),
    m =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: latestBlockhash.blockhash as Blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        },
        m,
      ),
    m => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const wire = getBase64EncodedWireTransaction(signed);
  const signature = await rpc.sendTransaction(wire, { encoding: "base64" }).send();
  await confirmSignature(rpc, signature);
  return signature;
}

/**
 * Poll `getSignatureStatuses` until the signature reaches at least 'confirmed'.
 *
 * @param rpc - The RPC client
 * @param signature - The transaction signature
 * @param timeoutMs - Total time budget (default 30s)
 * @throws If the transaction failed onchain or the timeout elapses
 */
export async function confirmSignature(
  rpc: ChannelRpc,
  signature: Signature,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status) {
      if (status.err) {
        throw new Error(`tx ${signature} failed onchain: ${JSON.stringify(status.err)}`);
      }
      const level = status.confirmationStatus;
      if (level === undefined || level === null || level === "confirmed" || level === "finalized") {
        return;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for tx ${signature} confirmation`);
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
}

/**
 * Assert one decoded channel address matches its challenge-bound value.
 *
 * @param label - Field name used in the error
 * @param actual - Decoded onchain address
 * @param expected - Challenge-bound address
 */
function assertChannelAddress(label: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(`channel ${label} ${actual} != expected ${expected}`);
  }
}

/**
 * Compute the distribution commitment stored by the payment-channels program.
 *
 * @param splits - Ordered recipient splits
 * @returns SHA-256 of the program's canonical distribution preimage
 */
export function getChannelDistributionHash(splits: readonly ChannelSplit[]): Uint8Array {
  const hasher = createHash("sha256");
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, splits.length, true);
  hasher.update(count);

  for (const split of splits) {
    hasher.update(Uint8Array.from(getBase58Encoder().encode(split.recipient)));
    const bps = new Uint8Array(2);
    new DataView(bps.buffer).setUint16(0, split.bps, true);
    hasher.update(bps);
  }

  return hasher.digest();
}
