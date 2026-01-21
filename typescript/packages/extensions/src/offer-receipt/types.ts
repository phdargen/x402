/**
 * Type definitions for the x402 Offer/Receipt Extension
 *
 * Based on: x402/specs/extensions/extension-offer-and-receipt.md
 *
 * Offers prove payment requirements originated from a resource server.
 * Receipts prove service was delivered after payment (privacy-minimal).
 */

/**
 * Extension identifier constant
 */
export const OFFER_RECEIPT = "offer-receipt";

/**
 * Supported signature formats (§3.1)
 */
export type SignatureFormat = "jws" | "eip712";

// ============================================================================
// Signer Interfaces
// ============================================================================

/**
 * Base signer interface for pluggable signing backends
 */
export interface Signer {
  /** Key identifier DID (e.g., did:web:api.example.com#key-1) */
  kid: string;
  /** Sign payload and return signature string */
  sign: (payload: Uint8Array) => Promise<string>;
  /** Signature format */
  format: SignatureFormat;
}

/**
 * JWS-specific signer with algorithm info
 */
export interface JWSSigner extends Signer {
  format: "jws";
  /** JWS algorithm (e.g., ES256K, EdDSA) */
  algorithm: string;
}

/**
 * EIP-712 specific signer
 */
export interface EIP712Signer extends Signer {
  format: "eip712";
  /** Chain ID for EIP-712 domain */
  chainId: number;
}

// ============================================================================
// Offer Types (§4)
// ============================================================================

/**
 * Offer payload fields (§4.2)
 *
 * Required: version, acceptIndex, resourceUrl, scheme, network, asset, payTo, amount, validUntil
 * Optional: metadata
 */
export interface OfferPayload {
  /** Extension version (currently 1) */
  version: number;
  /** Index into accepts[] array this offer corresponds to (0-based) */
  acceptIndex: number;
  /** The paid resource URL */
  resourceUrl: string;
  /** Payment scheme identifier (e.g., "exact") */
  scheme: string;
  /** Blockchain network identifier (CAIP-2 format, e.g., "eip155:8453") */
  network: string;
  /** Token contract address or "native" */
  asset: string;
  /** Recipient wallet address */
  payTo: string;
  /** Required payment amount */
  amount: string;
  /** Unix timestamp when offer expires */
  validUntil: number;
  /** Custom metadata as JSON string (e.g., ToS, provider info) - signed */
  metadata: string;
}

/**
 * Signed offer in JWS format (§3.1.1)
 *
 * "When format = 'jws': payload MUST be omitted"
 */
export interface JWSSignedOffer {
  format: "jws";
  /** JWS Compact Serialization string (header.payload.signature) */
  signature: string;
}

/**
 * Signed offer in EIP-712 format (§3.1.1)
 *
 * "When format = 'eip712': payload is REQUIRED"
 */
export interface EIP712SignedOffer {
  format: "eip712";
  /** The canonical payload fields */
  payload: OfferPayload;
  /** Hex-encoded ECDSA signature (0x-prefixed, 65 bytes: r+s+v) */
  signature: string;
}

/**
 * Union type for signed offers
 */
export type SignedOffer = JWSSignedOffer | EIP712SignedOffer;

// ============================================================================
// Receipt Types (§5)
// ============================================================================

/**
 * Receipt payload fields (§5.2)
 *
 * Required: network, resourceUrl, payer, issuedAt
 * Optional: transaction (for stronger verifiability over privacy)
 */
export interface ReceiptPayload {
  /** Blockchain network identifier (CAIP-2 format, e.g., "eip155:8453") */
  network: string;
  /** The paid resource URL */
  resourceUrl: string;
  /** Payer identifier (commonly a wallet address) */
  payer: string;
  /** Unix timestamp (seconds) when receipt was issued */
  issuedAt: number;
  /** Blockchain transaction hash (optional - for verifiability over privacy) */
  transaction?: string;
  /** Custom metadata (e.g., ToS URL, version info) */
  metadata?: Record<string, unknown>;
}

/**
 * Signed receipt in JWS format (§3.1.1)
 */
export interface JWSSignedReceipt {
  format: "jws";
  /** JWS Compact Serialization string */
  signature: string;
}

/**
 * Signed receipt in EIP-712 format (§3.1.1)
 */
export interface EIP712SignedReceipt {
  format: "eip712";
  /** The receipt payload */
  payload: ReceiptPayload;
  /** Hex-encoded ECDSA signature */
  signature: string;
}

/**
 * Union type for signed receipts
 */
export type SignedReceipt = JWSSignedReceipt | EIP712SignedReceipt;

// ============================================================================
// Extension-specific Types
// ============================================================================

/**
 * Configuration for the offer-receipt extension
 */
export interface OfferReceiptConfig {
  /** Whether to include offers in 402 responses (default: true) */
  includeOffers?: boolean;
  /** Whether to include receipts in settlement responses (default: true) */
  includeReceipts?: boolean;
}

/**
 * Declaration for the offer-receipt extension in route config
 * Used by servers to declare that a route uses offer-receipt
 */
export interface OfferReceiptDeclaration {
  /** Include transaction hash in receipt (default: true). Set to false for enhanced privacy. */
  includeTxHash?: boolean;
  /** Offer validity duration in seconds (default: 300 = 5 minutes) */
  validitySeconds?: number;
  /** Custom metadata to include in offers and receipts (e.g., { tos: "https://..." }) */
  metadata?: Record<string, unknown>;
}

/**
 * Offer-receipt signer interface for use with the extension
 * Supports both JWS and EIP-712 signing
 */
export interface OfferReceiptSigner {
  /** Key identifier DID */
  kid: string;
  /** Signature format */
  format: SignatureFormat;
  /** Sign an offer for a resource */
  signOffer(
    resourceUrl: string,
    input: OfferInput,
    metadata?: Record<string, unknown>,
  ): Promise<SignedOffer>;
  /** Sign a receipt for a completed payment */
  signReceipt(
    resourceUrl: string,
    payer: string,
    network: string,
    transaction?: string,
    metadata?: Record<string, unknown>,
  ): Promise<SignedReceipt>;
}

/**
 * Input for creating an offer (derived from PaymentRequirements)
 */
export interface OfferInput {
  /** Index into accepts[] array this offer corresponds to (0-based) */
  acceptIndex: number;
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  amount: string;
  /** Offer validity duration in seconds (default: 300 = 5 minutes) */
  validitySeconds?: number;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if an offer is JWS format
 *
 * @param offer
 */
export function isJWSSignedOffer(offer: SignedOffer): offer is JWSSignedOffer {
  return offer.format === "jws";
}

/**
 * Check if an offer is EIP-712 format
 *
 * @param offer
 */
export function isEIP712SignedOffer(offer: SignedOffer): offer is EIP712SignedOffer {
  return offer.format === "eip712";
}

/**
 * Check if a receipt is JWS format
 *
 * @param receipt
 */
export function isJWSSignedReceipt(receipt: SignedReceipt): receipt is JWSSignedReceipt {
  return receipt.format === "jws";
}

/**
 * Check if a receipt is EIP-712 format
 *
 * @param receipt
 */
export function isEIP712SignedReceipt(receipt: SignedReceipt): receipt is EIP712SignedReceipt {
  return receipt.format === "eip712";
}

/**
 * Check if a signer is JWS format
 *
 * @param signer
 */
export function isJWSSigner(signer: Signer): signer is JWSSigner {
  return signer.format === "jws";
}

/**
 * Check if a signer is EIP-712 format
 *
 * @param signer
 */
export function isEIP712Signer(signer: Signer): signer is EIP712Signer {
  return signer.format === "eip712";
}
