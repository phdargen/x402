import { getAddress } from "viem";
import type { FacilitatorEvmSigner } from "../../signer";
import type { AuthorizerSigner } from "../types";

/** How the facilitator submits `claim` / `refund` transactions. */
export type SubmitMode = "relay" | "direct";

/** Signers and mode used by claim and refund dispatchers. */
export type SubmitContext = {
  submitMode?: SubmitMode;
  signer: FacilitatorEvmSigner;
  authorizerSigner?: AuthorizerSigner;
  authorizerSubmitter?: FacilitatorEvmSigner;
};

/**
 * Validates a dedicated authorizer submitter when `submitMode` is `"direct"`.
 *
 * @param submitMode - Selected submit path.
 * @param authorizerSigner - Dedicated unrotated `receiverAuthorizer`.
 * @param authorizerSubmitter - Write-capable signer whose only address is the authorizer.
 * @throws When direct mode is missing a submitter or the submitter is not exactly the authorizer.
 */
export function assertDirectAuthorizerSubmitter(
  submitMode: SubmitMode | undefined,
  authorizerSigner: AuthorizerSigner | undefined,
  authorizerSubmitter: FacilitatorEvmSigner | undefined,
): void {
  if (submitMode !== "direct") {
    return;
  }
  if (!authorizerSigner) {
    throw new Error('submitMode "direct" requires authorizerSigner');
  }
  if (!authorizerSubmitter) {
    throw new Error('submitMode "direct" requires authorizerSubmitter');
  }
  const addresses = authorizerSubmitter.getAddresses();
  if (addresses.length !== 1 || getAddress(addresses[0]) !== getAddress(authorizerSigner.address)) {
    throw new Error(
      "authorizerSubmitter.getAddresses() must be exactly [authorizerSigner.address]",
    );
  }
}

/**
 * Returns whether this settle should use the relay (`*WithSignature`) path.
 *
 * A pre-signed payload always relays. Otherwise the configured `submitMode` applies
 * (`"relay"` when omitted).
 *
 * @param submitMode - Configured submit path.
 * @param hasAuthorizerSignature - Whether the payload already carries an authorizer signature.
 * @returns True when the relay function should be used.
 */
export function shouldRelaySubmit(
  submitMode: SubmitMode | undefined,
  hasAuthorizerSignature: boolean,
): boolean {
  return hasAuthorizerSignature || submitMode !== "direct";
}
