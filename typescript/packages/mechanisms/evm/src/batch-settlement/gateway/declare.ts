import { VOUCHER_GATEWAY } from "./constants";
import type { VoucherGatewayExtension } from "./types";

/** JSON Schema for voucher-gateway extension info (PaymentRequired). */
export const voucherGatewaySchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    gateway: { type: "string" },
    gatewayConfig: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        receiver: { type: "string" },
        receiverAuthorizer: { type: "string" },
      },
      required: ["channelId", "receiver", "receiverAuthorizer"],
    },
    gatewayVoucher: {
      type: "object",
      properties: {
        gatewayId: { type: "string" },
        maxClaimableAmount: { type: "string" },
        signature: { type: "string" },
      },
      required: ["gatewayId", "maxClaimableAmount", "signature"],
    },
    claimAuthorization: {
      type: "object",
      properties: {
        totalClaimed: { type: "string" },
        signature: { type: "string" },
      },
      required: ["totalClaimed", "signature"],
    },
  },
  required: ["gateway"],
} as const;

/**
 * Declares the voucher-gateway extension for inclusion in PaymentRequired.extensions.
 *
 * The gateway address is filled by {@link createVoucherGatewayServerExtension} from
 * facilitator `/supported` extensionInfo when enriching the 402 response.
 *
 * @param gateway - Optional gateway address to advertise immediately (usually omitted).
 * @returns Extension declaration for route `extensions`.
 */
export function declareVoucherGatewayExtension(gateway?: `0x${string}`): VoucherGatewayExtension {
  return {
    info: {
      gateway: gateway ?? ("0x0000000000000000000000000000000000000000" as const),
    },
    schema: voucherGatewaySchema,
  };
}

export { VOUCHER_GATEWAY };
