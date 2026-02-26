import type { FacilitatorContext, PaymentPayload } from "@x402/core/types";
import {
  BUILDER_CODE,
  type BuilderCodeExtension,
  type BuilderCodeFacilitatorExtension,
} from "./types";

/**
 * Creates a `BuilderCodeFacilitatorExtension` to register with the facilitator.
 *
 * @param codes - Network-to-code map, e.g. `{ "eip155:8453": "my-facilitator" }`
 * @returns A builder code facilitator extension to pass to `registerExtension`
 *
 * @example
 * ```typescript
 * facilitator.registerExtension(
 *   createBuilderCodeFacilitatorExtension({ "eip155:8453": "my-facilitator-app" }),
 * );
 * ```
 */
export function createBuilderCodeFacilitatorExtension(
  codes: Record<string, string>,
): BuilderCodeFacilitatorExtension {
  return {
    key: BUILDER_CODE.key,
    codes,
  };
}

/**
 * Extracts builder codes for a given network from the payment payload and facilitator context.
 *
 * Returns an array of 0-2 codes: server code first, facilitator code second.
 *
 * @param payload - The payment payload containing server-declared extensions
 * @param network - The settlement network (e.g., "eip155:8453")
 * @param context - Optional facilitator context with registered extensions
 * @returns Array of builder codes (server code first, then facilitator code if present)
 */
export function extractBuilderCodes(
  payload: PaymentPayload,
  network: string,
  context?: FacilitatorContext,
): string[] {
  const codes: string[] = [];

  const ext = payload.extensions?.[BUILDER_CODE.key] as BuilderCodeExtension | undefined;
  const serverCode = ext?.info?.[network];
  if (serverCode) {
    codes.push(serverCode);
  }

  const facExt = context?.getExtension<BuilderCodeFacilitatorExtension>(BUILDER_CODE.key);
  const facilitatorCode = facExt?.codes?.[network];
  if (facilitatorCode) {
    codes.push(facilitatorCode);
  }

  return codes;
}
