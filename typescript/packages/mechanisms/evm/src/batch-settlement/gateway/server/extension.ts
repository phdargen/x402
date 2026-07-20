import type { PaymentRequiredContext, ResourceServerExtension } from "@x402/core/types";
import { getAddress } from "viem";
import { VOUCHER_GATEWAY } from "../constants";
import { declareVoucherGatewayExtension, voucherGatewaySchema } from "../declare";
import type { VoucherGatewayExtension, VoucherGatewayExtensionInfo } from "../types";

/**
 * Creates a resource-server extension that copies facilitator `/supported`
 * `extensionInfo["voucher-gateway"].gateway` into PaymentRequired.extensions.
 *
 * Withdraw delay is applied by the batch-settlement server scheme via
 * `enhancePaymentRequirements` (base `accepts[].extra.withdrawDelay`).
 *
 * Corrective verify snapshots already merged onto `paymentRequiredResponse.extensions`
 * (e.g. `info.gatewayState`) are preserved.
 *
 * @returns ResourceServerExtension for `registerExtension`.
 */
export function createVoucherGatewayServerExtension(): ResourceServerExtension {
  return {
    key: VOUCHER_GATEWAY,
    enrichPaymentRequiredResponse: async (
      declaration: unknown,
      context: PaymentRequiredContext,
    ): Promise<VoucherGatewayExtension> => {
      const info = context.facilitatorExtensionInfo?.[VOUCHER_GATEWAY];
      const gatewayFromSupported =
        typeof info?.gateway === "string" ? getAddress(info.gateway as `0x${string}`) : undefined;

      const declared = declaration as VoucherGatewayExtension | undefined;
      const existing = context.paymentRequiredResponse.extensions?.[VOUCHER_GATEWAY] as
        | VoucherGatewayExtension
        | undefined;
      const existingInfo = existing?.info;

      const gateway =
        gatewayFromSupported ??
        (typeof existingInfo?.gateway === "string"
          ? getAddress(existingInfo.gateway)
          : undefined) ??
        (typeof declared?.info?.gateway === "string"
          ? getAddress(declared.info.gateway)
          : ("0x0000000000000000000000000000000000000000" as const));

      const mergedInfo: VoucherGatewayExtensionInfo = {
        ...(existingInfo ?? {}),
        gateway,
      };

      return {
        info: mergedInfo,
        schema: existing?.schema ?? declared?.schema ?? voucherGatewaySchema,
      };
    },
  };
}

export { declareVoucherGatewayExtension };
