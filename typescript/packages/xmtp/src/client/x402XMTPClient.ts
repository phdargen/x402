/**
 * Automated x402 XMTP client for agent-to-agent payment flows.
 *
 * Wraps an XMTP agent with payment handling: sends text messages, listens for
 * payment-required responses, auto-creates payment, sends payment-payload as reply,
 * waits for settlement-response, and returns the service response.
 */

import type {
  PaymentRequired,
  SettleResponse,
  Network,
  SchemeNetworkClient,
} from "@x402/core/types";
import { x402Client } from "@x402/core/client";

import type {
  x402XMTPClientOptions,
  x402XMTPClientConfig,
  x402XMTPMessageResult,
  XMTPPaymentRequestedContext,
  XMTPBeforePaymentHook,
  XMTPAfterPaymentHook,
  XMTPAgent,
  XMTPConversation,
  XMTPMessage,
} from "../types";
import { PaymentPayloadCodec } from "../codecs/paymentPayload";
import {
  isPaymentRequiredMessage,
  isSettlementResponseMessage,
  isPaymentRequiredContent,
} from "../utils";
import { createPaymentForXMTP } from "./helpers";

const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

const paymentPayloadCodec = new PaymentPayloadCodec();

/**
 * Automated x402 XMTP client that handles payment flows transparently.
 *
 * Provides a high-level `sendWithPayment` method that handles the full
 * payment flow: send text -> detect payment-required -> create payment ->
 * send payment-payload -> wait for settlement -> return service response.
 *
 * @example
 * ```typescript
 * const client = createx402XMTPClient({
 *   agent,
 *   schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(account) }],
 *   autoPayment: true,
 * });
 *
 * const result = await client.sendWithPayment(conversation, "analyze AAPL");
 * console.log(result.content); // "AAPL analysis..."
 * ```
 */
export class x402XMTPClient {
  private readonly agent: XMTPAgent;
  private readonly paymentClient: x402Client;
  private readonly options: Required<x402XMTPClientOptions>;
  private readonly beforePaymentHooks: XMTPBeforePaymentHook[] = [];
  private readonly afterPaymentHooks: XMTPAfterPaymentHook[] = [];

  /**
   * Creates a new x402XMTPClient.
   *
   * @param agent - The XMTP agent instance
   * @param paymentClient - The x402 client with registered payment schemes
   * @param options - Configuration options
   */
  constructor(agent: XMTPAgent, paymentClient: x402Client, options: x402XMTPClientOptions = {}) {
    this.agent = agent;
    this.paymentClient = paymentClient;
    this.options = {
      autoPayment: options.autoPayment ?? true,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      onPaymentRequested: options.onPaymentRequested ?? (() => true),
    };
  }

  /**
   * Register a hook to run before payment is created.
   *
   * @param hook - The hook function
   * @returns This instance for chaining
   */
  onBeforePayment(hook: XMTPBeforePaymentHook): this {
    this.beforePaymentHooks.push(hook);
    return this;
  }

  /**
   * Register a hook to run after payment is submitted.
   *
   * @param hook - The hook function
   * @returns This instance for chaining
   */
  onAfterPayment(hook: XMTPAfterPaymentHook): this {
    this.afterPaymentHooks.push(hook);
    return this;
  }

  /**
   * Sends a text message and handles the full payment flow if required.
   *
   * Flow:
   * 1. Send text message to the conversation
   * 2. Wait for a response (text or payment-required)
   * 3. If payment-required: create payment, send as reply, wait for settlement + service response
   * 4. Return the service response content
   *
   * @param conversation - The XMTP conversation to send to
   * @param content - The text message content
   * @returns The result including service response and payment info
   */
  async sendWithPayment(
    conversation: XMTPConversation,
    content: string,
  ): Promise<x402XMTPMessageResult> {
    await conversation.sendText(content);

    const response = await this.waitForResponse(conversation);

    if (!isPaymentRequiredMessage(response)) {
      return {
        content: typeof response.content === "string" ? response.content : JSON.stringify(response.content),
        paymentMade: false,
      };
    }

    if (!this.options.autoPayment) {
      throw new Error("Payment required but autoPayment is disabled");
    }

    const paymentRequired = response.content as PaymentRequired;

    if (!isPaymentRequiredContent(paymentRequired)) {
      throw new Error("Invalid payment-required message content");
    }

    const requestedContext: XMTPPaymentRequestedContext = {
      paymentRequired,
      conversationId: response.id,
    };

    const approved = await this.options.onPaymentRequested(requestedContext);
    if (!approved) {
      throw new Error("Payment request denied");
    }

    for (const hook of this.beforePaymentHooks) {
      await hook(requestedContext);
    }

    const paymentPayload = await createPaymentForXMTP(this.paymentClient, paymentRequired);

    const encoded = paymentPayloadCodec.encode(paymentPayload);
    await conversation.sendReply({
      content: encoded,
      reference: response.id,
      referenceInboxId: response.senderInboxId,
    });

    const { settlement, serviceContent } = await this.waitForSettlementAndResponse(conversation);

    for (const hook of this.afterPaymentHooks) {
      await hook({ paymentPayload, settlement });
    }

    return {
      content: serviceContent,
      paymentMade: true,
      paymentResponse: settlement ?? undefined,
    };
  }

  /**
   * Waits for the next response message from the agent in the conversation.
   *
   * @param conversation - The conversation to poll
   * @returns The response message
   */
  private async waitForResponse(conversation: XMTPConversation): Promise<XMTPMessage> {
    const startTime = Date.now();
    const existingMessages = await conversation.messages();
    const existingIds = new Set(existingMessages.map(m => m.id));

    while (Date.now() - startTime < this.options.timeoutMs) {
      await sleep(POLL_INTERVAL_MS);
      const messages = await conversation.messages();
      const newMessages = messages.filter(
        m => !existingIds.has(m.id) && m.senderInboxId !== this.agent.client.accountAddress,
      );

      if (newMessages.length > 0) {
        return newMessages[0];
      }
    }

    throw new Error(`Timed out waiting for response after ${this.options.timeoutMs}ms`);
  }

  /**
   * Waits for both the settlement-response and the service response after sending payment.
   *
   * @param conversation - The conversation to poll
   * @returns Object with settlement response and service content
   */
  private async waitForSettlementAndResponse(
    conversation: XMTPConversation,
  ): Promise<{ settlement: SettleResponse | null; serviceContent: string }> {
    const startTime = Date.now();
    const existingMessages = await conversation.messages();
    const existingIds = new Set(existingMessages.map(m => m.id));

    let settlement: SettleResponse | null = null;
    let serviceContent: string | null = null;

    while (Date.now() - startTime < this.options.timeoutMs) {
      await sleep(POLL_INTERVAL_MS);
      const messages = await conversation.messages();
      const newMessages = messages.filter(
        m => !existingIds.has(m.id) && m.senderInboxId !== this.agent.client.accountAddress,
      );

      for (const msg of newMessages) {
        existingIds.add(msg.id);

        if (isSettlementResponseMessage(msg)) {
          settlement = msg.content as SettleResponse;
          if (!settlement.success) {
            throw new Error(`Payment failed: ${settlement.errorReason || "unknown error"}`);
          }
        } else if (!isPaymentRequiredMessage(msg)) {
          serviceContent =
            typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        }
      }

      if (settlement && serviceContent !== null) {
        return { settlement, serviceContent };
      }
    }

    if (settlement && serviceContent === null) {
      return { settlement, serviceContent: "" };
    }

    throw new Error(`Timed out waiting for settlement/response after ${this.options.timeoutMs}ms`);
  }
}

/**
 * Wraps an existing XMTP agent with x402 payment handling.
 *
 * @param agent - The XMTP agent to wrap
 * @param paymentClient - The x402 client for payment handling
 * @param options - Configuration options
 * @returns An x402XMTPClient instance
 */
export function wrapAgentWithPayment(
  agent: XMTPAgent,
  paymentClient: x402Client,
  options?: x402XMTPClientOptions,
): x402XMTPClient {
  return new x402XMTPClient(agent, paymentClient, options);
}

/**
 * Creates a fully configured x402 XMTP client with sensible defaults.
 *
 * This factory handles creation of the x402Client and registration of payment schemes.
 *
 * @param config - Client configuration
 * @returns A configured x402XMTPClient instance
 *
 * @example
 * ```typescript
 * const client = createx402XMTPClient({
 *   agent,
 *   schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(account) }],
 *   autoPayment: true,
 *   onPaymentRequested: async ({ paymentRequired }) => {
 *     console.log(`Paying ${paymentRequired.accepts[0].amount}`);
 *     return true;
 *   },
 * });
 *
 * const result = await client.sendWithPayment(conversation, "analyze AAPL");
 * ```
 */
export function createx402XMTPClient(config: x402XMTPClientConfig): x402XMTPClient {
  const paymentClient = new x402Client();

  for (const scheme of config.schemes) {
    if (scheme.x402Version === 1) {
      paymentClient.registerV1(scheme.network as Network, scheme.client as SchemeNetworkClient);
    } else {
      paymentClient.register(scheme.network as Network, scheme.client as SchemeNetworkClient);
    }
  }

  return new x402XMTPClient(config.agent, paymentClient, {
    autoPayment: config.autoPayment,
    timeoutMs: config.timeoutMs,
    onPaymentRequested: config.onPaymentRequested,
  });
}

/**
 * Sleeps for the specified duration.
 *
 * @param ms - Duration in milliseconds
 * @returns Promise that resolves after the duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
