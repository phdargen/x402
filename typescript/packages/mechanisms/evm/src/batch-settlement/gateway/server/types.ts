import type { AuthorizerSigner } from "../../types";

/** Minimal server scheme surface used by gateway lifecycle hooks. */
export interface GatewayServerScheme {
  getReceiverAuthorizerSigner(): AuthorizerSigner | undefined;
}
