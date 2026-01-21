/**
 * Offer-Receipt Extension for x402ResourceServer
 *
 * This module provides the ResourceServerExtension implementation that uses
 * the extension hooks (onPaymentRequired, onSettlement) to add signed offers
 * and receipts to x402 payment flows.
 *
 * @example
 * ```typescript
 * import { createOfferReceiptExtension, createJWSSigner } from "@x402/extensions/offer-receipt";
 *
 * const signer = createJWSSigner("did:web:api.example.com#key-1", "ES256K", signFn);
 * const server = new x402ResourceServer(facilitator);
 * server.registerExtension(createOfferReceiptExtension(signer));
 *
 * app.use(paymentMiddleware(routes, server, paywallConfig));
 * ```
 */

import type {
  ResourceServerExtension,
  PaymentRequiredContext,
  SettleResultContext,
} from "@x402/core/types";
import type { PaymentRequirements, PaymentPayload } from "@x402/core/types";
import {
  OFFER_RECEIPT,
  type OfferReceiptSigner,
  type OfferReceiptDeclaration,
  type OfferInput,
  type SignedOffer,
  type SignedReceipt,
  type OfferPayload,
} from "./types";
import { extractOfferPayloadUnsafe } from "./signing";

/**
 * HTTP transport context interface
 * This matches what x402HTTPResourceServer provides
 */
interface HTTPTransportContext {
  adapter?: {
    getUrl?: () => string;
  };
  request?: {
    url?: string;
    method?: string;
  };
  requestUrl?: string;
}

/**
 * Extract resource URL from transport context
 *
 * @param transportContext
 */
function extractResourceUrl(transportContext: unknown): string | undefined {
  const ctx = transportContext as HTTPTransportContext | undefined;

  // Try adapter.getUrl() first (HTTPRequestContext from x402HTTPResourceServer)
  if (ctx?.adapter?.getUrl) {
    return ctx.adapter.getUrl();
  }

  // Try requestUrl (direct property)
  if (ctx?.requestUrl) {
    return ctx.requestUrl;
  }

  // Try request.url
  if (ctx?.request?.url) {
    return ctx.request.url;
  }

  return undefined;
}

/**
 * Convert PaymentRequirements to OfferInput
 *
 * @param requirements
 * @param acceptIndex - Index into accepts[] array
 * @param validitySeconds - Optional validity duration override
 */
function requirementsToOfferInput(
  requirements: PaymentRequirements,
  acceptIndex: number,
  validitySeconds?: number,
): OfferInput {
  return {
    acceptIndex,
    scheme: requirements.scheme,
    network: requirements.network,
    asset: requirements.asset,
    payTo: requirements.payTo,
    amount: requirements.amount,
    validitySeconds,
  };
}

/**
 * Extended PaymentRequirements with signedOffer
 */
interface PaymentRequirementsWithOffer extends PaymentRequirements {
  signedOffer?: SignedOffer;
}

/**
 * Creates an offer-receipt extension for use with x402ResourceServer.
 *
 * The extension uses the hook system to:
 * 1. Add signed offers to each PaymentRequirements in 402 responses
 * 2. Add signed receipts to settlement responses after successful payment
 *
 * @param signer - The signer to use for creating offers and receipts
 * @returns ResourceServerExtension that can be registered with x402ResourceServer
 *
 * @example
 * ```typescript
 * import { createOfferReceiptExtension, createJWSSigner } from "@x402/extensions/offer-receipt";
 *
 * // Create a JWS signer
 * const signer = createJWSSigner("did:web:api.example.com#key-1", "ES256K", signFn);
 *
 * // Register with server
 * const server = new x402ResourceServer(facilitator);
 * server.registerExtension(createOfferReceiptExtension(signer));
 *
 * // Use in route config
 * const routes = {
 *   "GET /api/data": {
 *     accepts: { ... },
 *     extensions: {
 *       ...declareOfferReceipt()
 *     }
 *   }
 * };
 * ```
 */
export function createOfferReceiptExtension(signer: OfferReceiptSigner): ResourceServerExtension {
  // Store the current resource URL during declaration enrichment for use in hooks
  let currentResourceUrl: string | undefined;

  return {
    key: OFFER_RECEIPT,

    /**
     * Enrich declaration with transport context
     * Captures the resource URL for later use in hooks
     *
     * @param declaration
     * @param transportContext
     */
    enrichDeclaration: (declaration: unknown, transportContext: unknown): unknown => {
      // Capture resource URL from transport context
      currentResourceUrl = extractResourceUrl(transportContext);
      return declaration;
    },

    /**
     * Add signed offers to 402 PaymentRequired response.
     * Returns extension data with signed offers (one per requirement).
     *
     * @param declaration
     * @param context
     */
    enrichPaymentRequiredResponse: async (
      declaration: unknown,
      context: PaymentRequiredContext,
    ) => {
      const config = declaration as OfferReceiptDeclaration | undefined;

      // Get resource URL - prefer from context, fall back to captured URL
      const resourceUrl = context.paymentRequiredResponse.resource?.url || currentResourceUrl;

      if (!resourceUrl) {
        console.warn("[offer-receipt] No resource URL available for signing offers");
        return undefined;
      }

      // Sign offers for each payment requirement
      const offers: SignedOffer[] = [];

      for (let i = 0; i < context.requirements.length; i++) {
        const requirement = context.requirements[i];
        try {
          const offerInput = requirementsToOfferInput(requirement, i, config?.validitySeconds);
          const signedOffer = await signer.signOffer(resourceUrl, offerInput, config?.metadata);
          offers.push(signedOffer);
        } catch (error) {
          console.error(`[offer-receipt] Failed to sign offer for requirement ${i}:`, error);
        }
      }

      // Return extension data per spec structure
      return {
        info: {
          version: 1,
          offers,
        },
      };
    },

    /**
     * Add signed receipt to settlement response.
     * Returns extension data with signed receipt proving service delivery.
     *
     * @param declaration
     * @param context
     */
    enrichSettlementResponse: async (declaration: unknown, context: SettleResultContext) => {
      const config = declaration as OfferReceiptDeclaration | undefined;

      // Skip if settlement failed
      if (!context.result.success) {
        return undefined;
      }

      // Get payer from settlement result
      const payer = context.result.payer;
      if (!payer) {
        console.warn("[offer-receipt] No payer available for signing receipt");
        return undefined;
      }

      // Get network and transaction from settlement result
      const network = context.result.network;
      const transaction = context.result.transaction;

      // Get resource URL from various sources
      let resourceUrl: string | undefined;

      // Try to get URL from the signed offer in accepted requirements
      const acceptedRequirements = context.paymentPayload.accepted as PaymentRequirementsWithOffer;
      if (acceptedRequirements?.signedOffer) {
        const offer = acceptedRequirements.signedOffer;
        if (offer.format === "eip712" && offer.payload) {
          resourceUrl = offer.payload.resourceUrl;
        }
        // For JWS, would need to decode - skip for now
      }

      // Fall back to captured URL from declaration enrichment
      if (!resourceUrl) {
        resourceUrl = currentResourceUrl;
      }

      if (!resourceUrl) {
        console.warn("[offer-receipt] No resource URL available for signing receipt");
        return undefined;
      }

      // Determine whether to include transaction hash (default: true)
      const includeTxHash = config?.includeTxHash !== false;
      const txHashToInclude = includeTxHash ? transaction || undefined : undefined;

      try {
        const signedReceipt: SignedReceipt = await signer.signReceipt(
          resourceUrl,
          payer,
          network,
          txHashToInclude,
          config?.metadata,
        );
        // Return extension data per spec structure
        return {
          info: {
            version: 1,
            receipt: signedReceipt,
          },
        };
      } catch (error) {
        console.error("[offer-receipt] Failed to sign receipt:", error);
        return undefined;
      }
    },
  };
}

/**
 * Declare offer-receipt extension for a route
 *
 * Use this in route configuration to enable offer-receipt for a specific endpoint.
 *
 * @param config
 * @example
 * ```typescript
 * const routes = {
 *   "GET /api/data": {
 *     accepts: { ... },
 *     extensions: {
 *       ...declareOfferReceipt(),
 *     }
 *   }
 * };
 * ```
 */
export function declareOfferReceipt(
  config?: OfferReceiptDeclaration,
): Record<string, OfferReceiptDeclaration> {
  return {
    [OFFER_RECEIPT]: {
      includeTxHash: config?.includeTxHash,
      validitySeconds: config?.validitySeconds,
      metadata: config?.metadata,
    },
  };
}

// ============================================================================
// Offer Validation
// ============================================================================

/**
 * Structure of offer-receipt extension data in PaymentPayload.extensions
 */
interface OfferReceiptExtensionData {
  info?: {
    version?: number;
    offers?: SignedOffer[];
  };
}

/**
 * Find the offer matching the accepted payment requirements
 *
 * @param offers - Array of signed offers from the extension
 * @param accepted - The accepted payment requirements
 * @returns Matching offer and payload, or undefined if not found
 */
function findMatchingOffer(
  offers: SignedOffer[],
  accepted: PaymentRequirements,
): { offer: SignedOffer; payload: OfferPayload } | undefined {
  for (const offer of offers) {
    try {
      const payload = extractOfferPayloadUnsafe(offer);
      // Match by payment terms (network, scheme, asset, payTo, amount)
      if (
        payload.network === accepted.network &&
        payload.scheme === accepted.scheme &&
        payload.asset === accepted.asset &&
        payload.payTo === accepted.payTo &&
        payload.amount === accepted.amount
      ) {
        return { offer, payload };
      }
    } catch {
      // Continue if extraction fails
    }
  }
  return undefined;
}

/**
 * Validate an offer from the payment payload
 *
 * @param paymentPayload - The payment payload containing extensions
 * @param requirements - The accepted payment requirements
 * @returns Validation result with reason if invalid
 */
export function validateOfferFromPayload(
  paymentPayload: PaymentPayload,
  requirements: PaymentRequirements,
): { valid: true } | { valid: false; reason: string } {
  // Extract offers from payment payload extensions
  const extData = paymentPayload.extensions?.[OFFER_RECEIPT] as
    | OfferReceiptExtensionData
    | undefined;
  const offers = extData?.info?.offers;

  // If no offers present, skip validation
  if (!offers || offers.length === 0) {
    return { valid: true };
  }

  // Find matching offer
  const match = findMatchingOffer(offers, requirements);
  if (!match) {
    return { valid: false, reason: "No matching signed offer found for accepted payment" };
  }

  const { payload } = match;

  // Check validUntil expiration
  const now = Math.floor(Date.now() / 1000);
  if (payload.validUntil && now > payload.validUntil) {
    return {
      valid: false,
      reason: `Offer expired at ${new Date(payload.validUntil * 1000).toISOString()}`,
    };
  }

  return { valid: true };
}

/**
 * BeforeVerify hook context type
 */
interface BeforeVerifyContext {
  paymentPayload: PaymentPayload;
  requirements: PaymentRequirements;
}

/**
 * BeforeVerify hook for offer validation (validUntil check)
 *
 * Use this with server.onBeforeVerify() to enable server-side offer validation.
 * Validates:
 * 1. A matching signed offer exists for the accepted payment
 * 2. The offer has not expired (validUntil check)
 *
 * @param context - The verify context with paymentPayload and requirements
 * @returns Abort result if validation fails, undefined otherwise
 *
 * @example
 * ```typescript
 * import { createOfferReceiptExtension, offerValidationHook } from "@x402/extensions/offer-receipt";
 *
 * const server = new x402ResourceServer(facilitator)
 *   .registerExtension(createOfferReceiptExtension(signer))
 *   .onBeforeVerify(offerValidationHook);
 * ```
 */
export async function offerValidationHook(
  context: BeforeVerifyContext,
): Promise<void | { abort: true; reason: string }> {
  const result = validateOfferFromPayload(context.paymentPayload, context.requirements);
  if (!result.valid) {
    return { abort: true, reason: result.reason };
  }
  return undefined;
}
