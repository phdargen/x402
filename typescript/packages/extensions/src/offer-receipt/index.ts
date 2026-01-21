/**
 * x402 Offer/Receipt Extension
 *
 * This extension adds cryptographically signed offers and receipts to x402 payment flows.
 * - Offers prove payment requirements originated from a specific resource server
 * - Receipts prove service was delivered after payment (privacy-minimal)
 *
 * @example
 * ```typescript
 * import {
 *   createOfferReceiptExtension,
 *   createJWSSigner,
 *   declareOfferReceipt
 * } from "@x402/extensions/offer-receipt";
 *
 * // Create signer
 * const signer = createJWSSigner("did:web:api.example.com#key-1", "ES256K", signFn);
 *
 * // Register extension
 * const server = new x402ResourceServer(facilitator);
 * server.registerExtension(createOfferReceiptExtension(signer));
 *
 * // Configure routes with offer-receipt
 * const routes = {
 *   "GET /api/data": {
 *     accepts: { scheme: "exact", price: "$0.01", network: "eip155:84532", payTo: "0x..." },
 *     extensions: { ...declareOfferReceipt() }
 *   }
 * };
 * ```
 */

// Extension identifier
export { OFFER_RECEIPT } from "./types";

// Types
export type {
  SignatureFormat,
  Signer,
  JWSSigner,
  EIP712Signer,
  OfferPayload,
  SignedOffer,
  JWSSignedOffer,
  EIP712SignedOffer,
  ReceiptPayload,
  SignedReceipt,
  JWSSignedReceipt,
  EIP712SignedReceipt,
  OfferReceiptConfig,
  OfferReceiptDeclaration,
  OfferReceiptSigner,
  OfferInput,
} from "./types";

// Type guards
export {
  isJWSSignedOffer,
  isEIP712SignedOffer,
  isJWSSignedReceipt,
  isEIP712SignedReceipt,
  isJWSSigner,
  isEIP712Signer,
} from "./types";

// Extension factory and declaration helper
export {
  createOfferReceiptExtension,
  declareOfferReceipt,
  offerValidationHook,
  validateOfferFromPayload,
} from "./extension";

// Signer factories
export { createJWSSigner, createEIP712Signer } from "./signers";

// Signing utilities (for advanced usage)
export {
  // Canonicalization
  canonicalize,
  hashCanonical,
  getCanonicalBytes,
  // JWS
  signJWS,
  extractJWSHeader,
  extractJWSPayloadUnsafe,
  // EIP-712
  createOfferDomain,
  createReceiptDomain,
  OFFER_TYPES,
  RECEIPT_TYPES,
  prepareOfferForEIP712,
  prepareReceiptForEIP712,
  hashOfferTypedData,
  hashReceiptTypedData,
  signOfferEIP712,
  signReceiptEIP712,
  type SignTypedDataFn,
  // Network utilities
  extractChainId,
  parseNetworkToCAIP2,
  extractChainIdFromCAIP2,
  // Payload extraction
  extractPayload,
  // Offer creation
  createOfferJWS,
  createOfferEIP712,
  extractOfferPayloadUnsafe,
  // Receipt creation
  createReceiptJWS,
  createReceiptEIP712,
  extractReceiptPayloadUnsafe,
  type ReceiptInput,
} from "./signing";

// Client utilities
export {
  createOfferReceiptExtractor,
  extractOfferFromPaymentRequired,
  extractAllOffers,
  extractReceiptFromSettlement,
  type OfferReceiptMetadata,
  type OfferReceiptResponse,
  type PaymentCompleteContext,
} from "./client";
