import type { VerifyContext, VerifyResponse } from "@x402/core/types";
import type { GatewayServerScheme } from "./types";

/**
 * Gateway verify hook: always proxy to the facilitator (no local voucher skip).
 *
 * @param scheme - Owning server scheme (unused; reserved for parity).
 * @param ctx - Verify context.
 * @returns Void to continue to facilitator /verify.
 */
export async function handleGatewayBeforeVerify(
  scheme: GatewayServerScheme,
  ctx: VerifyContext,
): Promise<
  void | { abort: true; reason: string; message?: string } | { skip: true; result: VerifyResponse }
> {
  void scheme;
  void ctx;
  // No local verification or skip — facilitator owns gateway channel state.
}
