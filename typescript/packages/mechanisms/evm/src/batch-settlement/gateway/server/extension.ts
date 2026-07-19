import type { PaymentRequiredContext, ResourceServerExtension } from "@x402/core/types";
import { getAddress } from "viem";
import { VOUCHER_GATEWAY } from "../constants";
import { declareVoucherGatewayExtension, voucherGatewaySchema } from "../declare";
import type { VoucherGatewayExtension } from "../types";

/**
 * Creates a resource-server extension that copies facilitator `/supported`
 * `extensionInfo["voucher-gateway"].gateway` into PaymentRequired.extensions.
 *
 * Withdraw delay is applied by the batch-settlement server scheme via
 * `enhancePaymentRequirements` (base `accepts[].extra.withdrawDelay`).
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
      const gateway =
        typeof info?.gateway === "string" ? getAddress(info.gateway as `0x${string}`) : undefined;

      const declared = declaration as VoucherGatewayExtension | undefined;
      return {
        info: {
          gateway:
            gateway ??
            (typeof declared?.info?.gateway === "string"
              ? getAddress(declared.info.gateway as `0x${string}`)
              : ("0x0000000000000000000000000000000000000000" as const)),
        },
        schema: declared?.schema ?? voucherGatewaySchema,
      };
    },
  };
}

export { declareVoucherGatewayExtension };
