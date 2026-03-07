import { PaymentRequiredCodec } from "./paymentRequired";
import { PaymentPayloadCodec } from "./paymentPayload";
import { SettlementResponseCodec } from "./settlementResponse";

export { PaymentRequiredCodec } from "./paymentRequired";
export { PaymentPayloadCodec } from "./paymentPayload";
export { SettlementResponseCodec } from "./settlementResponse";

/**
 * All x402 XMTP content codecs, ready to register with any XMTP SDK client.
 *
 * @example
 * ```typescript
 * import { Agent } from "@xmtp/agent-sdk";
 * import { x402Codecs } from "@x402/xmtp";
 *
 * const agent = await Agent.create(signer, { codecs: x402Codecs });
 * ```
 */
export const x402Codecs = [
  new PaymentRequiredCodec(),
  new PaymentPayloadCodec(),
  new SettlementResponseCodec(),
];
