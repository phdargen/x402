import { BUILDER_CODE, type BuilderCodeExtension } from "./types";

const builderCodeSchema: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  patternProperties: {
    "^eip155:[0-9]+$": {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-zA-Z0-9_-]+$",
    },
  },
  additionalProperties: false,
};

/**
 * Declares the builder-code extension for inclusion in PaymentRequired.extensions.
 *
 * @param codes - Network-to-code map, e.g. `{ "eip155:8453": "my-app" }`
 * @returns An object keyed by `"builder-code"` containing the extension declaration
 *
 * @example
 * ```typescript
 * import { declareBuilderCodeExtension } from "@x402/extensions";
 *
 * const routes = [
 *   {
 *     path: "/api/data",
 *     price: "$0.01",
 *     network: "eip155:8453",
 *     extensions: {
 *       ...declareBuilderCodeExtension({ "eip155:8453": "my-server-app" }),
 *     },
 *   },
 * ];
 * ```
 */
export function declareBuilderCodeExtension(
  codes: Record<string, string>,
): Record<string, BuilderCodeExtension> {
  return {
    [BUILDER_CODE.key]: {
      info: codes,
      schema: builderCodeSchema,
    },
  };
}
