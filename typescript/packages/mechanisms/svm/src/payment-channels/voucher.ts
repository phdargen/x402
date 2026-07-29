/**
 * Canonical payment-channel voucher payload + Ed25519 verifier.
 *
 * The 50-byte voucher message is the exact byte layout the onchain
 * payment-channels program signs over:
 *   magic             (2 bytes, constant [0x56, 0x01])
 *   channel_id        (32 bytes, base58-decoded pubkey)
 *   cumulative_amount (u64 little-endian)
 *   expires_at        (i64 little-endian)
 *
 * Single source of truth so client and server agree on the bytes they
 * sign / verify. Mirrors the Rust `VoucherData::message_bytes`
 * (rust/crates/mpp/src/protocol/intents/session.rs) and `pc::voucher_message_bytes`.
 */

import { getBase58Encoder, getI64Encoder, getU64Encoder } from "@solana/kit";

/**
 * Constant 2-byte magic prefix of the signed voucher payload. The program
 * rejects vouchers without it (`voucherBadMagic`). Wire JSON never carries it —
 * it exists only in the signed bytes.
 */
export const VOUCHER_MAGIC: readonly [number, number] = [0x56, 0x01];

/**
 * Encode the canonical 50-byte voucher payload.
 *
 * @param args - The voucher fields
 * @param args.channelId - Channel PDA (base58); must decode to 32 bytes
 * @param args.cumulativeAmount - Cumulative settled amount (base units)
 * @param args.expiresAt - Voucher deadline (Unix seconds, i64)
 * @returns The 50-byte message the authorized signer signs
 */
export function encodeVoucherMessageBytes(args: {
  channelId: string;
  cumulativeAmount: bigint;
  expiresAt: bigint;
}): Uint8Array {
  const channelBytes = getBase58Encoder().encode(args.channelId);
  if (channelBytes.byteLength !== 32) {
    throw new Error(`channelId must decode to 32 bytes; got ${channelBytes.byteLength}`);
  }
  const out = new Uint8Array(50);
  out[0] = VOUCHER_MAGIC[0];
  out[1] = VOUCHER_MAGIC[1];
  out.set(channelBytes as Uint8Array, 2);
  out.set(getU64Encoder().encode(args.cumulativeAmount) as Uint8Array, 34);
  out.set(getI64Encoder().encode(args.expiresAt) as Uint8Array, 42);
  return out;
}

/**
 * Verify an Ed25519 voucher signature against the authorized signer.
 * Both the signature and signer are base58-encoded (Solana wire format).
 *
 * @param args - Verification inputs
 * @param args.signatureBase58 - 64-byte signature, base58
 * @param args.signerBase58 - 32-byte verifying key, base58
 * @param args.message - The canonical 50-byte voucher payload
 * @returns Whether the signature is valid
 */
export async function verifyVoucherSignature(args: {
  signatureBase58: string;
  signerBase58: string;
  message: Uint8Array;
}): Promise<boolean> {
  const base58 = getBase58Encoder();
  const signatureBytes = toArrayBufferBacked(base58.encode(args.signatureBase58) as Uint8Array);
  if (signatureBytes.byteLength !== 64) {
    throw new Error(`signature must decode to 64 bytes; got ${signatureBytes.byteLength}`);
  }
  const pubkeyBytes = toArrayBufferBacked(base58.encode(args.signerBase58) as Uint8Array);
  if (pubkeyBytes.byteLength !== 32) {
    throw new Error(`signer must decode to 32 bytes; got ${pubkeyBytes.byteLength}`);
  }
  const message = toArrayBufferBacked(args.message);
  const key = await crypto.subtle.importKey("raw", pubkeyBytes, "Ed25519", false, ["verify"]);
  return await crypto.subtle.verify("Ed25519", key, signatureBytes, message);
}

/**
 * Copy a Uint8Array-like into a fresh `ArrayBuffer`-backed view. The base58
 * codec returns `ReadonlyUint8Array<ArrayBufferLike>`, which `crypto.subtle.*`
 * rejects under DOM lib types because `SharedArrayBuffer` is not assignable
 * to `ArrayBuffer`.
 *
 * @param bytes - The source bytes
 * @returns A fresh ArrayBuffer-backed copy
 */
function toArrayBufferBacked(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  for (let i = 0; i < bytes.byteLength; i++) copy[i] = bytes[i] ?? 0;
  return copy;
}
