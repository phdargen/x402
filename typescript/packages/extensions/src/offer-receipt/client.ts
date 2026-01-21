/**
 * Client-side utilities for extracting offers and receipts from x402 responses
 *
 * This module provides utilities for clients who want to access signed offers
 * and receipts from x402 payment flows. These are useful for:
 * - Creating verified user reviews (OMATrust)
 * - Audit trails and compliance
 * - Dispute resolution
 *
 * @example
 * ```typescript
 * import { wrapFetchWithPayment } from "@x402/fetch";
 * import { createOfferReceiptExtractor, type OfferReceiptResponse } from "@x402/extensions/offer-receipt";
 *
 * const fetchWithPay = wrapFetchWithPayment(fetch, client, {
 *   onPaymentComplete: createOfferReceiptExtractor()
 * });
 * const response = await fetchWithPay(url, { method: "GET" }) as OfferReceiptResponse;
 *
 * if (response.offerReceipt?.receipt) {
 *   // Use receipt for verified review, audit trail, etc.
 * }
 * ```
 */

import { decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, SettleResponse } from "@x402/core/types";
import type { SignedOffer, SignedReceipt } from "./types";

/**
 * Offer-receipt extension data in PaymentRequired.extensions
 */
interface OfferReceiptExtensionData {
  kid?: string;
  format?: string;
  offers?: Array<{ index: number; signedOffer: SignedOffer }>;
}

/**
 * Context passed from wrapFetchWithPayment's onPaymentComplete callback
 */
export interface PaymentCompleteContext {
  paymentRequired: PaymentRequired;
  paymentPayload: PaymentPayload;
  response: Response;
}

/**
 * Metadata extracted from an x402 payment flow
 */
export interface OfferReceiptMetadata {
  /** All signed offers from the 402 response */
  offers?: SignedOffer[];
  /** The accepted offer used for payment */
  acceptedOffer?: SignedOffer;
  /** Signed receipt from settlement response */
  receipt?: SignedReceipt;
  /** The full settlement response */
  settlementResponse?: SettleResponse;
}

/**
 * Response type with offerReceipt metadata attached
 */
export type OfferReceiptResponse = Response & { offerReceipt?: OfferReceiptMetadata };

/**
 * Creates an extractor function for use with wrapFetchWithPayment's onPaymentComplete option.
 * The extractor attaches offerReceipt metadata to the response object.
 *
 * @example
 * ```typescript
 * const fetchWithPay = wrapFetchWithPayment(fetch, client, {
 *   onPaymentComplete: createOfferReceiptExtractor()
 * });
 * const response = await fetchWithPay(url, { method: "GET" }) as OfferReceiptResponse;
 * ```
 */
export function createOfferReceiptExtractor(): (context: PaymentCompleteContext) => void {
  return (context: PaymentCompleteContext): void => {
    const { paymentRequired, response } = context;
    const metadata: OfferReceiptMetadata = {};

    // Extract offers from extensions["offer-receipt"].offers[]
    const extData = paymentRequired.extensions?.["offer-receipt"] as
      | OfferReceiptExtensionData
      | undefined;
    if (extData?.offers && extData.offers.length > 0) {
      metadata.offers = extData.offers.map(o => o.signedOffer);
      // Use first offer as accepted
      metadata.acceptedOffer = extData.offers[0].signedOffer;
    }

    // Extract settlement response and receipt from response header
    try {
      const paymentResponse =
        response.headers.get("PAYMENT-RESPONSE") || response.headers.get("X-PAYMENT-RESPONSE");

      if (paymentResponse) {
        const settlementResponse = decodePaymentResponseHeader(
          paymentResponse,
        ) as SettleResponse & { extensions?: { "offer-receipt"?: { receipt?: SignedReceipt } } };
        metadata.settlementResponse = settlementResponse;

        // Extract receipt from extensions
        const receipt = settlementResponse.extensions?.["offer-receipt"]?.receipt;
        if (receipt) {
          metadata.receipt = receipt;
        }
      }
    } catch {
      // Header parsing failed - continue without settlement data
    }

    // Attach metadata to response
    (response as OfferReceiptResponse).offerReceipt = metadata;
  };
}

/**
 * Extract offer from a PaymentRequired response for a specific network/scheme
 *
 * @param paymentRequired - The 402 response from the server
 * @param network - Network to match (e.g., "eip155:8453")
 * @param scheme - Scheme to match (e.g., "exact")
 * @returns The signed offer if found, undefined otherwise
 */
export function extractOfferFromPaymentRequired(
  paymentRequired: PaymentRequired,
  network?: string,
  scheme?: string,
): SignedOffer | undefined {
  const extData = paymentRequired.extensions?.["offer-receipt"] as
    | OfferReceiptExtensionData
    | undefined;
  if (!extData?.offers) {
    return undefined;
  }

  // Find matching requirement index
  for (let i = 0; i < paymentRequired.accepts.length; i++) {
    const req = paymentRequired.accepts[i];
    const matchesNetwork = !network || req.network === network;
    const matchesScheme = !scheme || req.scheme === scheme;

    if (matchesNetwork && matchesScheme) {
      const offerEntry = extData.offers.find(o => o.index === i);
      if (offerEntry) {
        return offerEntry.signedOffer;
      }
    }
  }
  return undefined;
}

/**
 * Extract all offers from a PaymentRequired response
 *
 * @param paymentRequired - The 402 response from the server
 * @returns Array of signed offers
 */
export function extractAllOffers(paymentRequired: PaymentRequired): SignedOffer[] {
  const extData = paymentRequired.extensions?.["offer-receipt"] as
    | OfferReceiptExtensionData
    | undefined;
  if (!extData?.offers) {
    return [];
  }
  return extData.offers.map(o => o.signedOffer);
}

/**
 * Extract receipt from a settlement response
 *
 * @param settlementResponse - The settlement response from the facilitator
 * @returns The signed receipt if present, undefined otherwise
 */
export function extractReceiptFromSettlement(
  settlementResponse: SettleResponse,
): SignedReceipt | undefined {
  const extensions = settlementResponse.extensions as
    | { "offer-receipt"?: { receipt?: SignedReceipt } }
    | undefined;
  return extensions?.["offer-receipt"]?.receipt;
}
