/**
 * Receiver-authorizer binding carried by the canonical batch-settlement open.
 *
 * The client appends a Memo naming the challenged receiver authorizer. The
 * payer signature covers it, so a lost row is reconstructable in principle.
 */

import { isAddress } from "@solana/kit";

export const RECEIVER_BINDING_MEMO_PREFIX = "x402:batch-settlement:svm:rcvauth:v1:";

/**
 * Encode the binding memo text for a receiver authorizer.
 *
 * @param authorizer - Receiver-authorizer public key (base58)
 * @returns The Memo instruction text
 */
export function encodeReceiverBindingMemo(authorizer: string): string {
  return `${RECEIVER_BINDING_MEMO_PREFIX}${authorizer}`;
}

/**
 * Parse a binding memo back into its receiver-authorizer key.
 *
 * @param memo - Decoded Memo instruction text
 * @returns The key, or undefined when the memo is not a well-formed binding
 */
export function parseReceiverBindingMemo(memo: string): string | undefined {
  if (!memo.startsWith(RECEIVER_BINDING_MEMO_PREFIX)) return undefined;
  const authorizer = memo.slice(RECEIVER_BINDING_MEMO_PREFIX.length);
  return isAddress(authorizer) ? authorizer : undefined;
}
