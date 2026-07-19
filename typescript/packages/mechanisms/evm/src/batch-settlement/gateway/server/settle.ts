import type { SettleContext, SettleResponse } from "@x402/core/types";
import type { PaymentPayload } from "@x402/core/types";
import { getAddress } from "viem";
import { isBatchSettlementDepositPayload, isBatchSettlementVoucherPayload } from "../../types";
import { VOUCHER_GATEWAY } from "../constants";
import * as GwErrors from "../errors";
import {
  computeGatewayVoucherDigest,
  readVoucherGatewayInfo,
  signGatewayClaimAuthorization,
} from "../utils";
import type { GatewayServerScheme } from "./types";

/**
 * Gateway settle hook: sign GatewayClaimAuthorization, attach to payload extensions,
 * and always proceed to facilitator /settle (never local skip).
 *
 * @param scheme - Owning server scheme (receiver authorizer signer).
 * @param ctx - Settle context (requirements.amount is the actual charge after overrides).
 * @returns Void to continue; abort when signing is impossible.
 */
export async function handleGatewayBeforeSettle(
  scheme: GatewayServerScheme,
  ctx: SettleContext,
): Promise<
  void | { abort: true; reason: string; message?: string } | { skip: true; result: SettleResponse }
> {
  const { paymentPayload, requirements } = ctx;
  const raw = paymentPayload.payload;

  if (!isBatchSettlementDepositPayload(raw) && !isBatchSettlementVoucherPayload(raw)) {
    return;
  }

  const info = readVoucherGatewayInfo(
    paymentPayload.extensions as Record<string, unknown> | undefined,
  );
  if (!info?.gateway || !info.gatewayConfig || !info.gatewayVoucher) {
    return {
      abort: true,
      reason: GwErrors.ErrVoucherPayload,
      message: "Missing voucher-gateway fields on settle",
    };
  }

  const authorizer = scheme.getReceiverAuthorizerSigner();
  if (!authorizer) {
    return {
      abort: true,
      reason: GwErrors.ErrClaimAuthorizationSignature,
      message: "receiverAuthorizerSigner required to sign GatewayClaimAuthorization",
    };
  }

  const authorizedAmount = BigInt(paymentPayload.accepted.amount);
  const actualPrice = BigInt(requirements.amount);
  if (actualPrice > authorizedAmount) {
    return {
      abort: true,
      reason: GwErrors.ErrServerSettlementPayload,
      message: "actualPrice exceeds authorized amount",
    };
  }

  const totalClaimed = (
    BigInt(info.gatewayVoucher.maxClaimableAmount) -
    authorizedAmount +
    actualPrice
  ).toString();

  const digest = computeGatewayVoucherDigest(
    info.gatewayVoucher.gatewayId,
    info.gatewayVoucher.maxClaimableAmount,
    requirements.network,
    getAddress(info.gateway),
  );

  const claimAuthorization = await signGatewayClaimAuthorization(
    params =>
      authorizer.signTypedData({
        domain: params.domain,
        types: params.types,
        primaryType: params.primaryType,
        message: params.message,
      }),
    digest,
    totalClaimed,
    requirements.network,
    getAddress(info.gateway),
  );

  // Attach claimAuthorization under the extension (mutable request payload).
  const mutable = paymentPayload as PaymentPayload;
  mutable.extensions = {
    ...(mutable.extensions ?? {}),
    [VOUCHER_GATEWAY]: {
      info: {
        ...info,
        claimAuthorization,
      },
    },
  };
}

/**
 * Gateway after-settle: no local channel storage updates (facilitator owns state).
 *
 * @param scheme - Owning server scheme.
 * @param ctx - Settle result context.
 */
export async function handleGatewayAfterSettle(
  scheme: GatewayServerScheme,
  ctx: unknown,
): Promise<void> {
  void scheme;
  void ctx;
  // Stateless server path — nothing to persist locally.
}
