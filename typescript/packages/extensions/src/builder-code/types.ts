import type { FacilitatorExtension } from "@x402/core/types";

export const BUILDER_CODE = { key: "builder-code" } as const;

export interface BuilderCodeFacilitatorExtension extends FacilitatorExtension {
  key: "builder-code";
  codes: Record<string, string>; // network -> builder code (e.g., "eip155:8453" -> "my-app")
}

export interface BuilderCodeExtension {
  info: Record<string, string>; // network -> builder code
  schema: Record<string, unknown>;
}
