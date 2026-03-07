/**
 * Payment wrapper for XMTP agent message handlers.
 *
 * Provides a stateless payment flow using XMTP's reply chain for correlation.
 * The middleware intercepts x402/payment-payload messages, traces the reply chain
 * to recover the original request, verifies and settles payment, then delivers
 * the service response.
 */

import { x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload } from "@x402/core/types";

import type {
  XMTPPaymentWrapperConfig,
  XMTPPaymentWrapperResult,
  XMTPAgentMiddleware,
  XMTPMessageContext,
  XMTPMessage,
  XMTPOriginalMessage,
  XMTPServerHookContext,
  XMTPAfterExecutionContext,
  XMTPSettlementContext,
} from "../types";
import { PaymentRequiredCodec } from "../codecs/paymentRequired";
import { SettlementResponseCodec } from "../codecs/settlementResponse";
import { isPaymentPayloadMessage, isPaymentPayloadContent, createResourceUrl } from "../utils";

const paymentRequiredCodec = new PaymentRequiredCodec();
const settlementResponseCodec = new SettlementResponseCodec();

/**
 * Creates a payment wrapper for XMTP agent message handlers.
 *
 * Returns middleware that intercepts x402/payment-payload messages and a
 * requestPayment function that sends x402/payment-required as a reply.
 *
 * The flow is completely stateless: the reply chain in XMTP's message store
 * links payment-payload -> payment-required -> original message. The middleware
 * traces this chain at processing time via conversation.messages().
 *
 * @param resourceServer - The x402 resource server for payment verification/settlement
 * @param config - Payment wrapper configuration
 * @returns Object with middleware and requestPayment function
 *
 * @example
 * ```typescript
 * const { middleware, requestPayment } = createPaymentWrapper(resourceServer, {
 *   accepts,
 *   handler: async (originalMessage) => {
 *     const analysis = await performAnalysis(originalMessage.content);
 *     return { text: analysis };
 *   },
 * });
 *
 * agent.use(middleware);
 *
 * agent.on("text", async (ctx) => {
 *   if (ctx.message.content.startsWith("/help")) {
 *     await ctx.sendText("Free help: ...");
 *     return;
 *   }
 *   await requestPayment(ctx);
 * });
 * ```
 */
export function createPaymentWrapper(
  resourceServer: x402ResourceServer,
  config: XMTPPaymentWrapperConfig,
): XMTPPaymentWrapperResult {
  if (!config.accepts || config.accepts.length === 0) {
    throw new Error("XMTPPaymentWrapperConfig.accepts must have at least one payment requirement");
  }

  const middleware: XMTPAgentMiddleware = async (ctx, next) => {
    if (!isPaymentPayloadMessage(ctx.message)) {
      await next();
      return;
    }

    try {
      await handlePaymentPayload(resourceServer, config, ctx);
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : "An unexpected error occurred during payment";
      await ctx.sendText(`Error: ${errorMsg}`);
    }
  };

  const requestPayment = async (ctx: XMTPMessageContext): Promise<void> => {
    const agentAddress = ctx.client.accountAddress;
    const resourceInfo = {
      url: config.resource?.url || createResourceUrl(agentAddress, "service"),
      description: config.resource?.description,
      mimeType: config.resource?.mimeType,
    };

    const paymentRequired = await resourceServer.createPaymentRequiredResponse(
      config.accepts,
      resourceInfo,
      "Payment required for this service",
    );

    const encoded = paymentRequiredCodec.encode(paymentRequired);

    await ctx.conversation.sendReply({
      content: encoded,
      reference: ctx.message.id,
      referenceInboxId: ctx.message.senderInboxId,
    });
  };

  return { middleware, requestPayment };
}

/**
 * Handles an incoming x402/payment-payload message.
 *
 * Traces the reply chain to recover the original request message,
 * verifies payment, runs the handler, settles, and sends responses.
 *
 * @param resourceServer - The x402 resource server
 * @param config - The payment wrapper configuration
 * @param ctx - The XMTP message context
 */
async function handlePaymentPayload(
  resourceServer: x402ResourceServer,
  config: XMTPPaymentWrapperConfig,
  ctx: XMTPMessageContext,
): Promise<void> {
  const paymentPayload = ctx.message.content as PaymentPayload;

  if (!isPaymentPayloadContent(paymentPayload)) {
    await ctx.sendText("Error: Invalid payment payload format");
    return;
  }

  const matchingRequirements = resourceServer.findMatchingRequirements(
    config.accepts,
    paymentPayload,
  );

  if (!matchingRequirements) {
    await sendSettlementFailure(ctx, "No matching payment requirements found", paymentPayload);
    return;
  }

  const verifyResult = await resourceServer.verifyPayment(paymentPayload, matchingRequirements);
  if (!verifyResult.isValid) {
    await sendSettlementFailure(
      ctx,
      verifyResult.invalidReason || "Payment verification failed",
      paymentPayload,
    );
    return;
  }

  const originalMessage = await traceOriginalMessage(ctx);

  const hookContext: XMTPServerHookContext = {
    paymentPayload,
    paymentRequirements: matchingRequirements,
    originalMessage,
  };

  if (config.hooks?.onBeforeExecution) {
    const hookResult = await config.hooks.onBeforeExecution(hookContext);
    if (hookResult === false) {
      await sendSettlementFailure(ctx, "Execution blocked by server hook", paymentPayload);
      return;
    }
  }

  const paymentContext = {
    paymentPayload,
    paymentRequirements: matchingRequirements,
    senderAddress: await ctx.getSenderAddress(),
  };

  const result = await config.handler(originalMessage, paymentContext);

  if (config.hooks?.onAfterExecution) {
    const afterExecContext: XMTPAfterExecutionContext = {
      ...hookContext,
      result,
    };
    await config.hooks.onAfterExecution(afterExecContext);
  }

  try {
    const settleResult = await resourceServer.settlePayment(paymentPayload, matchingRequirements);

    if (config.hooks?.onAfterSettlement) {
      const settlementContext: XMTPSettlementContext = {
        ...hookContext,
        settlement: settleResult,
      };
      await config.hooks.onAfterSettlement(settlementContext);
    }

    const settlementEncoded = settlementResponseCodec.encode(settleResult);
    await ctx.conversation.sendReply({
      content: settlementEncoded,
      reference: ctx.message.id,
      referenceInboxId: ctx.message.senderInboxId,
    });

    await ctx.conversation.sendText(result.text);
  } catch (settleError) {
    const errorMsg = settleError instanceof Error ? settleError.message : "Settlement failed";
    await sendSettlementFailure(ctx, `Payment settlement failed: ${errorMsg}`, paymentPayload);
  }
}

/**
 * Traces the reply chain to recover the original text message that triggered the payment flow.
 *
 * payment-payload (current) -> replies to -> payment-required -> replies to -> original message
 *
 * If the chain cannot be traced (e.g., unsolicited payment), returns the payment-payload
 * message itself as context.
 *
 * @param ctx - The XMTP message context (for the payment-payload message)
 * @returns The original message or a fallback
 */
async function traceOriginalMessage(ctx: XMTPMessageContext): Promise<XMTPOriginalMessage> {
  try {
    const messages = await ctx.conversation.messages();
    const messageMap = new Map<string, XMTPMessage>();
    for (const msg of messages) {
      messageMap.set(msg.id, msg);
    }

    const paymentPayloadMsg = ctx.message;

    const paymentRequiredMsg = findReplyTarget(paymentPayloadMsg, messageMap);
    if (!paymentRequiredMsg) {
      return fallbackOriginalMessage(ctx);
    }

    const originalMsg = findReplyTarget(paymentRequiredMsg, messageMap);
    if (!originalMsg) {
      return fallbackOriginalMessage(ctx);
    }

    return {
      id: originalMsg.id,
      content: typeof originalMsg.content === "string" ? originalMsg.content : "",
      senderInboxId: originalMsg.senderInboxId,
    };
  } catch {
    return fallbackOriginalMessage(ctx);
  }
}

/**
 * Finds the message that a reply message is replying to.
 *
 * XMTP reply messages have content with a `referenceId` or `reference` field
 * pointing to the parent message ID.
 *
 * @param replyMsg - The reply message
 * @param messageMap - Map of message ID to message
 * @returns The target message or undefined
 */
function findReplyTarget(
  replyMsg: XMTPMessage,
  messageMap: Map<string, XMTPMessage>,
): XMTPMessage | undefined {
  const content = replyMsg.content as Record<string, unknown> | undefined;
  if (!content || typeof content !== "object") {
    return undefined;
  }

  const refId =
    (content as { referenceId?: string }).referenceId ||
    (content as { reference?: string }).reference;

  if (typeof refId !== "string") {
    return undefined;
  }

  return messageMap.get(refId);
}

/**
 * Creates a fallback original message when the reply chain cannot be traced.
 *
 * @param ctx - The XMTP message context
 * @returns A fallback XMTPOriginalMessage
 */
function fallbackOriginalMessage(ctx: XMTPMessageContext): XMTPOriginalMessage {
  return {
    id: ctx.message.id,
    content: "",
    senderInboxId: ctx.message.senderInboxId,
  };
}

/**
 * Sends a settlement failure response as a reply to the payment-payload message.
 *
 * @param ctx - The XMTP message context
 * @param errorReason - The error reason string
 * @param paymentPayload - The payment payload that failed
 */
async function sendSettlementFailure(
  ctx: XMTPMessageContext,
  errorReason: string,
  paymentPayload: PaymentPayload,
): Promise<void> {
  const failureResponse = {
    success: false as const,
    errorReason,
    payer: (paymentPayload.payload as { authorization?: { from?: string } })?.authorization?.from,
    transaction: "",
    network: paymentPayload.accepted.network,
  };

  const encoded = settlementResponseCodec.encode(failureResponse);
  await ctx.conversation.sendReply({
    content: encoded,
    reference: ctx.message.id,
    referenceInboxId: ctx.message.senderInboxId,
  });
}
