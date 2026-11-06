import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { toClientEvmSigner, type ClientEvmSigner } from "@x402/evm";
import {
  BatchSettlementEvmScheme,
  type BatchSettlementDepositStrategyContext,
} from "@x402/evm/batch-settlement/client";
import {
  InMemoryClientChannelStorage,
  type BatchSettlementClientContext,
} from "@x402/evm/batch-settlement/client";
import { deriveVoucherSigner, NETWORK } from "./config";
import { AtomicBudget, BudgetExhaustedError } from "./budget";
import { StressFailureRecorder, type FailureRecord } from "./failures";
import { partialRefundAmount } from "./refund";
import type { FailureKind, RequestKind, StressStats, TokenKey } from "./stats";

const MAX_REASON_LENGTH = 120;

export type StressToken = {
  key: TokenKey;
  symbol: string;
  asset: `0x${string}`;
  name: string;
  version: string;
  decimals: number;
};

/** Shape of `GET /stress/config` on the stress server. */
export type StressServerConfig = {
  network: string;
  /** Facilitator target the server runs against; absent on servers that predate targets. */
  target?: string;
  facilitatorHost?: string;
  /** Facilitator EVM signer addresses from `/supported`; absent on older servers. */
  facilitatorSigners?: `0x${string}`[];
  maxAmountAtomic: string;
  maxAmountAtomicByToken: Record<TokenKey, string>;
  receivers: `0x${string}`[];
  tokens: StressToken[];
};

export type PayOutcome =
  | { ok: true; charged: bigint; kind: RequestKind }
  | { ok: false; skippedBudget: true }
  | { ok: false; reason: string };

export type RefundOutcome =
  | { ok: true; amount: bigint }
  | { ok: false; skipped: true }
  | { ok: false; skipped: false; reason: string };

/**
 * Channel storage that remembers the channel id the scheme computed for this client.
 */
class CapturingStorage extends InMemoryClientChannelStorage {
  channelId: `0x${string}` | undefined;

  /**
   * Stores the channel record and remembers its key.
   *
   * @param key - Channel id.
   * @param context - Channel fields to persist.
   */
  async set(key: string, context: BatchSettlementClientContext): Promise<void> {
    this.channelId = key as `0x${string}`;
    await super.set(key, context);
  }
}

/**
 * Decodes a base64 JSON x402 header (PAYMENT-SIGNATURE or PAYMENT-RESPONSE).
 *
 * @param header - Base64-encoded JSON header value.
 * @returns The decoded object.
 */
function decodeHeader<T>(header: string): T {
  return JSON.parse(Buffer.from(header, "base64").toString("utf-8")) as T;
}

type PaymentAttempt = {
  kind: FailureKind;
  maxClaimableSent?: string;
  httpStatus?: number;
  channelState?: Record<string, unknown>;
};

type FailureResponse = {
  reason: string;
  channelState?: Record<string, unknown>;
};

const CHANNEL_STATE_FIELDS = [
  "balance",
  "chargedCumulativeAmount",
  "totalClaimed",
  "withdrawRequestedAt",
  "refundNonce",
] as const;

/**
 * Reads the cumulative claim ceiling from a payment payload.
 *
 * @param payload - Decoded payment payload.
 * @returns The sent ceiling when present.
 */
function extractMaxClaimable(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const raw = payload as {
    voucher?: { maxClaimableAmount?: unknown };
  };
  const value = raw.voucher?.maxClaimableAmount;
  return typeof value === "string" && /^\d+$/.test(value) ? value : undefined;
}

/**
 * Keeps only numeric channel state fields safe for failure diagnostics.
 *
 * @param value - Candidate channel state.
 * @returns Sanitized state or undefined.
 */
function sanitizeChannelState(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const state: Record<string, unknown> = {};
  for (const field of CHANNEL_STATE_FIELDS) {
    const fieldValue = input[field];
    if (
      (typeof fieldValue === "string" && /^\d+$/.test(fieldValue)) ||
      (typeof fieldValue === "number" && Number.isFinite(fieldValue))
    ) {
      state[field] = fieldValue;
    }
  }
  return Object.keys(state).length > 0 ? state : undefined;
}

/**
 * Finds a corrective channel state in a response body.
 *
 * @param value - Decoded response body.
 * @returns Sanitized channel state or undefined.
 */
function extractChannelState(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as {
    channelState?: unknown;
    extra?: { channelState?: unknown };
    accepts?: Array<{ extra?: { channelState?: unknown } }>;
  };
  return (
    sanitizeChannelState(raw.channelState) ??
    sanitizeChannelState(raw.extra?.channelState) ??
    sanitizeChannelState(raw.accepts?.[0]?.extra?.channelState)
  );
}

/**
 * Parses a failed HTTP response into a bounded reason and channel state.
 *
 * @param status - HTTP status code.
 * @param text - Response body text.
 * @param headers - Optional response headers containing a corrective payment challenge.
 * @returns Parsed failure details.
 */
function parseFailureResponse(status: number, text: string, headers?: Headers): FailureResponse {
  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    // Keep the raw response text as the detail.
  }
  let detail = "";
  if (typeof body === "object" && body !== null) {
    const raw = body as { error?: unknown; errorReason?: unknown; errorMessage?: unknown };
    detail = String(raw.error ?? raw.errorReason ?? raw.errorMessage ?? "");
  }
  if (!detail && typeof body === "string") detail = body;
  let channelState = extractChannelState(body);
  if (!channelState && status === 402) {
    const paymentRequiredHeader = headers?.get("payment-required");
    if (paymentRequiredHeader) {
      try {
        channelState = extractChannelState(
          decodeHeader<{ accepts?: Array<{ extra?: { channelState?: unknown } }> }>(
            paymentRequiredHeader,
          ),
        );
      } catch {
        // Ignore malformed diagnostic headers; the response reason is still useful.
      }
    }
  }
  return {
    reason: normalizeReason(`http_${status}${detail ? `: ${detail}` : ""}`),
    ...(channelState ? { channelState } : {}),
  };
}

/**
 * Normalizes an error string so error buckets stay low-cardinality: hex blobs and long digit
 * runs collapse to placeholders and the text is truncated.
 *
 * @param text - Raw error text.
 * @returns A bounded, normalized reason.
 */
export function normalizeReason(text: string): string {
  return text
    .replace(/0x[0-9a-fA-F]{8,}/g, "0x…")
    .replace(/\d{6,}/g, "N")
    .replace(/\s+/g, " ")
    .slice(0, MAX_REASON_LENGTH);
}

/**
 * Reads a failure reason from an error response without relying on its exact shape.
 *
 * @param response - The non-2xx response.
 * @returns A normalized reason prefixed with the HTTP status.
 */
async function reasonFromResponse(response: Response): Promise<FailureResponse> {
  const text = await response.text().catch(() => "");
  return parseFailureResponse(response.status, text, response.headers);
}

/**
 * One payment channel: its own scheme, derived voucher signer and salt, and serialized requests.
 */
export class StressChannel {
  readonly url: string;
  readonly token: StressToken;
  readonly receiverIndex: number;
  readonly receiver: `0x${string}`;
  /** True while a request is in flight. A real client serializes requests per channel. */
  busy = false;
  /** True once a deposit succeeded in this process. */
  opened = false;
  /** True after this channel's token budget can no longer fund its next deposit. */
  exhausted = false;
  successes = 0;

  private readonly stats: StressStats;
  private readonly failureRecorder: StressFailureRecorder;
  private readonly storage = new CapturingStorage();
  private readonly scheme: BatchSettlementEvmScheme;
  private readonly fetchPaid: typeof fetch;
  private lastLeg: { kind: RequestKind; latencyMs: number } | undefined;
  private lastAttempt: PaymentAttempt | undefined;
  private lastRefundLatencyMs: number | undefined;

  /**
   * Builds the channel client.
   *
   * @param index - Channel index, used for the voucher key and the salt.
   * @param options - Channel construction options.
   * @param options.seed - Stress seed.
   * @param options.baseUrl - Stress server base URL.
   * @param options.receiverIndex - Index of the receiver this channel pays.
   * @param options.receiver - Receiver address.
   * @param options.token - Token this channel pays in.
   * @param options.payer - Shared funded payer signer.
   * @param options.maxAmountAtomic - Server maximum request amount in atomic units.
   * @param options.depositMultiplier - Deposit size as a multiple of the request amount.
   * @param options.depositBudget - Optional monotonic deposit budget for this token.
   * @param options.failureRecorder - Persistent failure recorder.
   * @param options.stats - Shared stats collector.
   */
  constructor(
    readonly index: number,
    options: {
      seed: string;
      baseUrl: string;
      receiverIndex: number;
      receiver: `0x${string}`;
      token: StressToken;
      payer: ClientEvmSigner;
      maxAmountAtomic: string;
      depositMultiplier: number;
      depositBudget?: AtomicBudget;
      failureRecorder: StressFailureRecorder;
      stats: StressStats;
    },
  ) {
    this.token = options.token;
    this.receiverIndex = options.receiverIndex;
    this.receiver = options.receiver;
    this.url = `${options.baseUrl}/stress/${options.receiverIndex}/${options.token.key}`;
    this.stats = options.stats;

    const voucherSigner = toClientEvmSigner(deriveVoucherSigner(options.seed, index));
    const depositBudget = options.depositBudget;
    const depositStrategy = depositBudget
      ? (context: BatchSettlementDepositStrategyContext): string | false => {
          const depositAmount = BigInt(context.depositAmount);
          if (!depositBudget.tryReserve(depositAmount)) {
            throw new BudgetExhaustedError(
              depositAmount,
              depositBudget.reserved,
              depositBudget.limit,
            );
          }
          return context.depositAmount;
        }
      : undefined;
    const scheme = new BatchSettlementEvmScheme(options.payer, {
      depositPolicy: { depositMultiplier: options.depositMultiplier },
      depositStrategy,
      salt: BigInt(index),
      voucherSigner,
      storage: this.storage,
    });
    this.scheme = scheme;
    this.failureRecorder = options.failureRecorder;
    const client = new x402Client();
    client.register("eip155:*", scheme);
    client.setSpendControls({
      maxAmountPerPayment: "$1",
      allowedAssets: [
        {
          network: NETWORK,
          asset: options.token.asset,
          maxAmountPerPayment: options.maxAmountAtomic,
        },
      ],
    });
    this.fetchPaid = wrapFetchWithPayment(this.instrumentedFetch, client);
  }

  /**
   * Sends one paid request and records its outcome. Never throws.
   *
   * @returns The outcome.
   */
  async pay(): Promise<PayOutcome> {
    this.lastLeg = undefined;
    this.lastAttempt = undefined;
    try {
      const response = await this.fetchPaid(this.url, { method: "GET" });
      if (!response.ok) {
        const failure = await reasonFromResponse(response);
        const attempt = this.lastAttempt as PaymentAttempt | undefined;
        const channelState = failure.channelState ?? attempt?.channelState;
        const failureAttempt: PaymentAttempt = {
          kind: attempt?.kind ?? "voucher",
          ...(attempt ?? {}),
          ...(channelState ? { channelState } : {}),
        };
        await this.recordFailure(failureAttempt.kind, failure.reason, failureAttempt);
        return { ok: false, reason: failure.reason };
      }
      await response.arrayBuffer();
      const charged = this.chargedFrom(response);
      const leg = this.lastLeg ?? { kind: "voucher" as RequestKind, latencyMs: 0 };
      if (leg.kind === "deposit" || leg.kind === "topup") {
        this.opened = true;
      }
      this.successes += 1;
      this.stats.recordSuccess(leg.kind, leg.latencyMs, this.token.key, charged);
      return { ok: true, charged, kind: leg.kind };
    } catch (error) {
      const reason = normalizeReason(
        `exception: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (error instanceof BudgetExhaustedError) {
        this.exhausted = true;
        this.stats.recordSkippedBudget();
        return { ok: false, skippedBudget: true };
      }
      const attempt = this.lastAttempt as PaymentAttempt | undefined;
      await this.recordFailure(attempt?.kind ?? "voucher", reason, attempt);
      return { ok: false, reason };
    }
  }

  /**
   * Requests a partial cooperative refund from the channel's uncharged balance.
   *
   * @param fraction - Fraction of the refundable balance to request.
   * @param minimum - Smallest refund amount in token atomic units.
   * @returns The refund outcome.
   */
  async requestPartialRefund(fraction: number, minimum: bigint): Promise<RefundOutcome> {
    const channelId = this.storage.channelId;
    if (!channelId) {
      this.stats.recordRefundSkipped();
      return { ok: false, skipped: true };
    }

    try {
      const context = await this.storage.get(channelId);
      const amount = partialRefundAmount(
        BigInt(context?.balance ?? "0"),
        BigInt(context?.chargedCumulativeAmount ?? "0"),
        fraction,
        minimum,
      );
      if (amount === undefined) {
        this.stats.recordRefundSkipped();
        return { ok: false, skipped: true };
      }

      this.lastAttempt = undefined;
      this.lastRefundLatencyMs = undefined;
      const startedAt = performance.now();
      const result = await this.scheme.refund(this.url, {
        amount: amount.toString(),
        fetch: this.instrumentedFetch,
      });
      const latencyMs = this.lastRefundLatencyMs ?? performance.now() - startedAt;
      if (!result.success) {
        const reason = normalizeReason(
          `settlement: ${result.errorReason ?? result.errorMessage ?? "unknown"}`,
        );
        await this.recordFailure("refund", reason, this.lastAttempt);
        return { ok: false, skipped: false, reason };
      }
      this.stats.recordRefundSuccess(latencyMs);
      return { ok: true, amount };
    } catch (error) {
      const reason = normalizeReason(
        `exception: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.recordFailure("refund", reason, this.lastAttempt);
      return { ok: false, skipped: false, reason };
    }
  }

  /**
   * Returns the channel id and the server's cumulative charge as recorded locally.
   *
   * @returns The channel state, or undefined if no request completed.
   */
  async chargedState(): Promise<{ channelId: `0x${string}`; charged: bigint } | undefined> {
    const channelId = this.storage.channelId;
    if (!channelId) return undefined;
    const context = await this.storage.get(channelId);
    return { channelId, charged: BigInt(context?.chargedCumulativeAmount ?? "0") };
  }

  /**
   * Records a failure in memory and in the persistent NDJSON report.
   *
   * @param kind - Failed operation kind.
   * @param reason - Normalized failure reason.
   * @param attempt - Details captured from the payment request.
   */
  private async recordFailure(
    kind: FailureKind,
    reason: string,
    attempt: PaymentAttempt | undefined,
  ): Promise<void> {
    const channelId = this.storage.channelId;
    const context = channelId ? await this.storage.get(channelId) : undefined;
    const event = {
      ts: Date.now(),
      token: this.token.key,
      kind,
      channelIndex: this.index,
      reason,
    } as const;
    this.stats.recordFailure(event);

    const record: FailureRecord = {
      ts: new Date(event.ts).toISOString(),
      channelIndex: event.channelIndex,
      token: event.token,
      kind: event.kind,
      reason: event.reason,
      receiverIndex: this.receiverIndex,
      localBalance: context?.balance ?? "0",
      charged: context?.chargedCumulativeAmount ?? "0",
      ...(channelId ? { channelId } : {}),
      ...(attempt?.httpStatus !== undefined ? { httpStatus: attempt.httpStatus } : {}),
      ...(attempt?.maxClaimableSent ? { maxClaimableSent: attempt.maxClaimableSent } : {}),
      ...(attempt?.channelState ? { channelState: attempt.channelState } : {}),
    };
    this.failureRecorder.write(record);
  }

  /**
   * Fetch wrapper that classifies and times each paid HTTP leg. The paid leg is the one that
   * carries a PAYMENT-SIGNATURE, so its latency covers the server's verify and settle.
   *
   * @param input - Request target.
   * @param init - Request options.
   * @returns The upstream response.
   */
  private readonly instrumentedFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const header = request.headers.get("payment-signature") ?? request.headers.get("x-payment");
    if (!header) {
      return fetch(request);
    }
    const { payload } = decodeHeader<{ payload: { type?: string } }>(header);
    const requestKind: RequestKind =
      payload.type === "deposit" ? (this.opened ? "topup" : "deposit") : "voucher";
    const attempt: PaymentAttempt = {
      kind: payload.type === "refund" ? "refund" : requestKind,
      maxClaimableSent: extractMaxClaimable(payload),
    };
    this.lastAttempt = attempt;

    if (payload.type === "refund") {
      const startedAt = performance.now();
      const response = await fetch(request);
      this.lastRefundLatencyMs = performance.now() - startedAt;
      attempt.httpStatus = response.status;
      if (!response.ok) {
        const failure = parseFailureResponse(
          response.status,
          await response.clone().text(),
          response.headers,
        );
        attempt.channelState = failure.channelState;
      }
      if (response.status === 402) {
        this.stats.recordCorrective402();
      }
      return response;
    }
    const startedAt = performance.now();
    const response = await fetch(request);
    this.lastLeg = { kind: requestKind, latencyMs: performance.now() - startedAt };
    attempt.httpStatus = response.status;
    if (!response.ok) {
      const failure = parseFailureResponse(
        response.status,
        await response.clone().text(),
        response.headers,
      );
      attempt.channelState = failure.channelState;
    }
    if (response.status === 402) {
      this.stats.recordCorrective402();
    }
    return response;
  };

  /**
   * Reads the amount the server charged for the request from PAYMENT-RESPONSE.
   *
   * @param response - The successful paid response.
   * @returns The charged atomic amount, or 0 when the header is absent.
   */
  private chargedFrom(response: Response): bigint {
    const header = response.headers.get("PAYMENT-RESPONSE");
    if (!header) return 0n;
    const settle = decodeHeader<{ extra?: { chargedAmount?: unknown } }>(header);
    const charged = settle.extra?.chargedAmount;
    return typeof charged === "string" && /^\d+$/.test(charged) ? BigInt(charged) : 0n;
  }
}
