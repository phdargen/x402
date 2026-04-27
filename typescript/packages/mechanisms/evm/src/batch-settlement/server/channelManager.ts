import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";
import type { FacilitatorClient } from "@x402/core/server";
import type { BatchSettlementVoucherClaim } from "../types";
import type { BatchSettlementEvmScheme } from "./scheme";
import { computeChannelId } from "../utils";
import { BATCH_SETTLEMENT_SCHEME } from "../constants";
import { signClaimBatch, signRefund } from "../authorizerSigner";
import type { Channel } from "./storage";

export interface ChannelManagerConfig {
  scheme: BatchSettlementEvmScheme;
  facilitator: FacilitatorClient;
  receiver: `0x${string}`;
  token: `0x${string}`;
  network: Network;
}

export interface AutoSettlementConfig {
  claimIntervalSecs?: number;
  claimOnIdleSecs?: number;
  claimThreshold?: string;
  claimOnWithdrawal?: boolean;
  settleIntervalSecs?: number;
  settleThreshold?: string;
  maxClaimsPerBatch?: number;
  tickSecs?: number;
  refundOnIdleSecs?: number;
  refundOnShutdown?: boolean;
  onClaim?: (result: ClaimResult) => void;
  onSettle?: (result: SettleResult) => void;
  onRefund?: (result: RefundResult) => void;
  onError?: (error: unknown) => void;
}

export interface ClaimResult {
  vouchers: number;
  transaction: string;
}

export interface SettleResult {
  transaction: string;
}

export interface RefundResult {
  channels: string[];
  transaction: string;
}

/**
 * Formats a `Facilitator.settle()` failure into a human-readable error message.
 *
 * @param operation - Operation label (e.g. `"Claim"`, `"Settle"`, `"Refund"`).
 * @param response - The failed settle response.
 * @returns Error message including reason and (when available) facilitator-provided detail.
 */
function formatFacilitatorFailure(operation: string, response: SettleResponse): string {
  return `${operation} failed: ${response.errorReason ?? "unknown"} — ${response.errorMessage ?? ""}`;
}

/**
 * Manages the server-side channel lifecycle for the `batch-settlement` scheme:
 * batch claiming of vouchers, settlement of claimed funds, and cooperative refund.
 *
 * Provides both manual (`claim()`, `settle()`, `refund()`) and automatic
 * (`start()` / `stop()`) modes.  In automatic mode a periodic tick evaluates configurable
 * triggers (interval, idle time, threshold, pending withdrawal) and batches operations
 * accordingly.
 */
export class BatchSettlementChannelManager {
  private readonly scheme: BatchSettlementEvmScheme;
  private readonly facilitator: FacilitatorClient;
  private readonly receiver: `0x${string}`;
  private readonly token: `0x${string}`;
  private readonly network: Network;

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastClaimTime = 0;
  private lastSettleTime = 0;
  private pendingSettle = false;
  private running = false;
  private tickInProgress = false;
  private autoSettleConfig: AutoSettlementConfig = {};

  /**
   * Creates a new channel manager.
   *
   * @param config - Manager configuration: scheme, facilitator, receiver, token, network.
   */
  constructor(config: ChannelManagerConfig) {
    this.scheme = config.scheme;
    this.facilitator = config.facilitator;
    this.receiver = config.receiver;
    this.token = config.token;
    this.network = config.network;
  }

  /**
   * Collects claimable vouchers and submits them in batches to the facilitator via `claim()`.
   *
   * @param opts - Optional: `maxClaimsPerBatch` (default 50), `idleSecs` to filter idle channels.
   * @param opts.maxClaimsPerBatch - Max vouchers per facilitator `claim` batch.
   * @param opts.idleSecs - When set, only include channels idle for at least this many seconds.
   * @returns Array of claim results (one per batch).
   */
  async claim(opts?: { maxClaimsPerBatch?: number; idleSecs?: number }): Promise<ClaimResult[]> {
    const maxBatch = opts?.maxClaimsPerBatch ?? 50;
    const allClaims = await this.getClaimableVouchers(
      opts?.idleSecs !== undefined ? { idleSecs: opts.idleSecs } : undefined,
    );

    if (allClaims.length === 0) {
      return [];
    }

    const results: ClaimResult[] = [];
    for (let i = 0; i < allClaims.length; i += maxBatch) {
      const batch = allClaims.slice(i, i + maxBatch);
      const result = await this.submitClaim(batch);
      results.push(result);
      await this.updateClaimedSessions(batch);
    }

    if (results.length > 0) {
      this.pendingSettle = true;
    }

    return results;
  }

  /**
   * Transfers claimed (but unsettled) funds to the receiver by calling `settle(receiver, token)`.
   *
   * @returns Settle result with the transaction hash.
   */
  async settle(): Promise<SettleResult> {
    const paymentPayload = this.buildSettlePaymentPayload();
    const requirements = this.buildPaymentRequirements();

    const response = await this.facilitator.settle(paymentPayload, requirements);
    if (!response.success) {
      throw new Error(formatFacilitatorFailure("Settle", response));
    }

    this.pendingSettle = false;
    return { transaction: response.transaction };
  }

  /**
   * Convenience: claims all eligible vouchers then settles in one call.
   *
   * @param opts - Optional: `maxClaimsPerBatch`.
   * @param opts.maxClaimsPerBatch - Max vouchers per claim batch before settling.
   * @returns Combined claim and settle results.
   */
  async claimAndSettle(opts?: {
    maxClaimsPerBatch?: number;
  }): Promise<{ claims: ClaimResult[]; settle?: SettleResult }> {
    const claims = await this.claim(opts);
    let settleResult: SettleResult | undefined;
    if (claims.length > 0) {
      settleResult = await this.settle();
    }
    return { claims, settle: settleResult };
  }

  /**
   * Initiates a cooperative refund for one or more channels, optionally claiming
   * outstanding vouchers first.
   *
   * @param channelIds - Specific channels to refund; defaults to all sessions.
   * @returns Result with the list of refunded channels and the transaction hash.
   */
  async refund(channelIds?: string[]): Promise<RefundResult> {
    const storage = this.scheme.getStorage();
    const channels = await storage.list();

    const targets = channelIds
      ? channels.filter(s => channelIds.some(id => id.toLowerCase() === s.channelId.toLowerCase()))
      : channels;

    if (targets.length === 0) {
      return { channels: [], transaction: "" };
    }

    const claims: BatchSettlementVoucherClaim[] = [];
    for (const c of targets) {
      if (BigInt(c.chargedCumulativeAmount) > BigInt(c.totalClaimed)) {
        claims.push({
          voucher: {
            channel: c.channelConfig,
            maxClaimableAmount: c.signedMaxClaimable,
          },
          signature: c.signature as `0x${string}`,
          totalClaimed: c.chargedCumulativeAmount,
        });
      }
    }

    const firstTarget = targets[0];
    const config = firstTarget.channelConfig;
    const authorizerSigner = this.scheme.getReceiverAuthorizerSigner();

    const refundAmount = (
      BigInt(firstTarget.balance) - BigInt(firstTarget.chargedCumulativeAmount)
    ).toString();

    const nonce = String(firstTarget.refundNonce ?? 0);

    const refundAuthorizerSignature = authorizerSigner
      ? await signRefund(
          authorizerSigner,
          firstTarget.channelId as `0x${string}`,
          refundAmount,
          nonce,
          this.network,
        )
      : undefined;

    const claimAuthorizerSignature =
      authorizerSigner && claims.length > 0
        ? await signClaimBatch(authorizerSigner, claims, this.network)
        : undefined;

    const paymentPayload: PaymentPayload = {
      x402Version: 2,
      accepted: this.buildPaymentRequirements(),
      payload: {
        type: "refund",
        channelConfig: config,
        voucher: {
          channelId: firstTarget.channelId as `0x${string}`,
          maxClaimableAmount: firstTarget.signedMaxClaimable,
          signature: firstTarget.signature as `0x${string}`,
        },
        amount: refundAmount,
        refundNonce: nonce,
        claims,
        ...(refundAuthorizerSignature ? { refundAuthorizerSignature } : {}),
        ...(claimAuthorizerSignature ? { claimAuthorizerSignature } : {}),
      },
    };

    const response = await this.facilitator.settle(paymentPayload, this.buildPaymentRequirements());
    if (!response.success) {
      throw new Error(formatFacilitatorFailure("Refund", response));
    }

    for (const c of targets) {
      await storage.delete(c.channelId);
    }

    return {
      channels: targets.map(c => c.channelId),
      transaction: response.transaction,
    };
  }

  /**
   * Collects vouchers that are eligible for on-chain claiming.
   *
   * A voucher is claimable when its `chargedCumulativeAmount` exceeds what has already
   * been claimed on-chain.  An optional idle filter skips sessions that received a
   * request within the last `idleSecs` seconds.
   *
   * @param opts - Optional filtering: `idleSecs` to only return idle channels.
   * @param opts.idleSecs - Minimum seconds since last request for a channel to be included.
   * @returns Array of {@link BatchSettlementVoucherClaim} entries for batch submission.
   */
  async getClaimableVouchers(opts?: { idleSecs?: number }): Promise<BatchSettlementVoucherClaim[]> {
    const channels = await this.scheme.getStorage().list();
    const now = Date.now();
    const claims: BatchSettlementVoucherClaim[] = [];

    for (const c of channels) {
      if (BigInt(c.chargedCumulativeAmount) <= BigInt(c.totalClaimed)) {
        continue;
      }
      if (opts?.idleSecs !== undefined) {
        const idleMs = now - c.lastRequestTimestamp;
        if (idleMs < opts.idleSecs * 1000) {
          continue;
        }
      }
      claims.push({
        voucher: {
          channel: c.channelConfig,
          maxClaimableAmount: c.signedMaxClaimable,
        },
        signature: c.signature as `0x${string}`,
        totalClaimed: c.chargedCumulativeAmount,
      });
    }

    return claims;
  }

  /**
   * Returns channels that have a pending payer-initiated withdrawal.
   *
   * @returns All stored channel records with `withdrawRequestedAt` set.
   */
  async getWithdrawalPendingSessions(): Promise<Channel[]> {
    const channels = await this.scheme.getStorage().list();
    return channels.filter(s => s.withdrawRequestedAt > 0);
  }

  /**
   * Starts the auto-settlement loop that periodically evaluates claim/settle/refund
   * triggers and executes them.
   *
   * @param config - Auto-settlement policy configuration (intervals, thresholds, callbacks).
   */
  start(config: AutoSettlementConfig = {}): void {
    if (this.tickTimer) {
      return;
    }

    const tickMs = (config.tickSecs ?? 10) * 1000;
    const claimIntervalMs = (config.claimIntervalSecs ?? 60) * 1000;
    const settleIntervalMs = (config.settleIntervalSecs ?? 300) * 1000;
    const claimOnWithdrawal = config.claimOnWithdrawal ?? true;
    const maxClaimsPerBatch = config.maxClaimsPerBatch ?? 50;

    this.lastClaimTime = Date.now();
    this.lastSettleTime = Date.now();
    this.running = true;

    this.autoSettleConfig = config;

    this.tickTimer = setInterval(() => {
      void this.tick({
        claimIntervalMs,
        settleIntervalMs,
        claimOnIdleSecs: config.claimOnIdleSecs,
        claimThreshold: config.claimThreshold,
        claimOnWithdrawal,
        settleThreshold: config.settleThreshold,
        maxClaimsPerBatch,
        refundOnIdleSecs: config.refundOnIdleSecs,
        onClaim: config.onClaim,
        onSettle: config.onSettle,
        onRefund: config.onRefund,
        onError: config.onError,
      });
    }, tickMs);
  }

  /**
   * Stops the auto-settlement loop.
   *
   * @param opts - Stop options.
   * @param opts.flush - When true, run `claimAndSettle` and optional shutdown cooperative refund first.
   * @returns Resolves when the loop is stopped (and flush work completes, if requested).
   */
  async stop(opts?: { flush?: boolean }): Promise<void> {
    this.running = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (opts?.flush) {
      await this.claimAndSettle();
      if (this.autoSettleConfig.refundOnShutdown) {
        try {
          const result = await this.refund();
          if (result.channels.length > 0) {
            this.autoSettleConfig.onRefund?.(result);
          }
        } catch (err) {
          this.autoSettleConfig.onError?.(err);
        }
      }
    }
  }

  /**
   * Single tick of the auto-settlement loop: evaluates claim, settle, and cooperative
   * refund triggers and executes any that fire.
   *
   * @param cfg - Resolved auto-settlement options for this tick.
   * @param cfg.claimIntervalMs - Minimum milliseconds between automatic claim rounds.
   * @param cfg.settleIntervalMs - Minimum milliseconds between automatic settle rounds.
   * @param cfg.claimOnIdleSecs - Optional idle threshold to trigger claims (see {@link BatchSettlementChannelManager.getClaimableVouchers}).
   * @param cfg.claimThreshold - Optional min cumulative claimable amount to trigger a claim.
   * @param cfg.claimOnWithdrawal - Whether pending withdrawals can trigger a claim.
   * @param cfg.settleThreshold - Optional min claimed-not-settled amount to trigger settle.
   * @param cfg.maxClaimsPerBatch - Voucher batch size passed to {@link BatchSettlementChannelManager.claim}.
   * @param cfg.refundOnIdleSecs - Optional idle seconds before cooperative refund for non-zero balances.
   * @param cfg.onClaim - Callback after each successful claim batch.
   * @param cfg.onSettle - Callback after a successful settle.
   * @param cfg.onRefund - Callback after a cooperative refund with channels.
   * @param cfg.onError - Callback on errors inside the tick.
   * @returns Resolves when this tick's work finishes (no return value).
   */
  private async tick(cfg: {
    claimIntervalMs: number;
    settleIntervalMs: number;
    claimOnIdleSecs?: number;
    claimThreshold?: string;
    claimOnWithdrawal: boolean;
    settleThreshold?: string;
    maxClaimsPerBatch: number;
    refundOnIdleSecs?: number;
    onClaim?: (result: ClaimResult) => void;
    onSettle?: (result: SettleResult) => void;
    onRefund?: (result: RefundResult) => void;
    onError?: (error: unknown) => void;
  }): Promise<void> {
    if (!this.running || this.tickInProgress) {
      return;
    }

    this.tickInProgress = true;
    try {
      await this.runClaimPhase(cfg);
      await this.runSettlePhase(cfg);
      await this.runRefundPhase(cfg);
    } finally {
      this.tickInProgress = false;
    }
  }

  /**
   * Runs the claim portion of {@link tick}: evaluates triggers and claims if needed.
   * Errors are reported via `cfg.onError` and do not propagate.
   *
   * @param cfg - Tick configuration with claim triggers and callbacks.
   * @param cfg.claimIntervalMs - Time since last claim after which a claim should run.
   * @param cfg.claimOnIdleSecs - If set, claim when any idle-eligible vouchers exist.
   * @param cfg.claimThreshold - If set, claim when total claimable exceeds this amount.
   * @param cfg.claimOnWithdrawal - If true, claim when any channel has a pending withdrawal.
   * @param cfg.maxClaimsPerBatch - Voucher batch size passed to {@link BatchSettlementChannelManager.claim}.
   * @param cfg.onClaim - Callback invoked after each successful claim batch.
   * @param cfg.onError - Callback invoked when an error is caught during the phase.
   */
  private async runClaimPhase(cfg: {
    claimIntervalMs: number;
    claimOnIdleSecs?: number;
    claimThreshold?: string;
    claimOnWithdrawal: boolean;
    maxClaimsPerBatch: number;
    onClaim?: (result: ClaimResult) => void;
    onError?: (error: unknown) => void;
  }): Promise<void> {
    try {
      const shouldClaim = await this.evaluateClaimTriggers(cfg);
      if (!shouldClaim) return;

      const results = await this.claim({ maxClaimsPerBatch: cfg.maxClaimsPerBatch });
      this.lastClaimTime = Date.now();
      for (const r of results) {
        cfg.onClaim?.(r);
      }
    } catch (err) {
      cfg.onError?.(err);
    }
  }

  /**
   * Runs the settle portion of {@link tick}: evaluates triggers and settles if needed.
   * Errors are reported via `cfg.onError` and do not propagate.
   *
   * @param cfg - Tick configuration with settle triggers and callbacks.
   * @param cfg.settleIntervalMs - Time since last settle after which a settle should run.
   * @param cfg.settleThreshold - If set, settle when claimed-not-settled exceeds this amount.
   * @param cfg.onSettle - Callback invoked after a successful settle.
   * @param cfg.onError - Callback invoked when an error is caught during the phase.
   */
  private async runSettlePhase(cfg: {
    settleIntervalMs: number;
    settleThreshold?: string;
    onSettle?: (result: SettleResult) => void;
    onError?: (error: unknown) => void;
  }): Promise<void> {
    try {
      const shouldSettle = await this.evaluateSettleTriggers(cfg);
      if (!shouldSettle) return;

      const result = await this.settle();
      this.lastSettleTime = Date.now();
      cfg.onSettle?.(result);
    } catch (err) {
      cfg.onError?.(err);
    }
  }

  /**
   * Runs the refund portion of {@link tick}: cooperatively refunds idle channels.
   * No-op when `refundOnIdleSecs` is undefined. Errors are reported via `cfg.onError`.
   *
   * @param cfg - Tick configuration with refund settings and callbacks.
   * @param cfg.refundOnIdleSecs - Idle threshold (seconds) before triggering cooperative refund.
   * @param cfg.onRefund - Callback invoked after a refund that touched at least one channel.
   * @param cfg.onError - Callback invoked when an error is caught during the phase.
   */
  private async runRefundPhase(cfg: {
    refundOnIdleSecs?: number;
    onRefund?: (result: RefundResult) => void;
    onError?: (error: unknown) => void;
  }): Promise<void> {
    if (cfg.refundOnIdleSecs === undefined) return;

    try {
      const idleChannels = await this.getIdleChannelsForRefund(cfg.refundOnIdleSecs);
      if (idleChannels.length === 0) return;

      const result = await this.refund(idleChannels);
      if (result.channels.length > 0) {
        cfg.onRefund?.(result);
      }
    } catch (err) {
      cfg.onError?.(err);
    }
  }

  /**
   * Evaluates whether a claim should be triggered based on interval, idle, threshold,
   * and withdrawal policies.
   *
   * @param cfg - Claim trigger configuration for this evaluation.
   * @param cfg.claimIntervalMs - Time since last claim after which a claim should run.
   * @param cfg.claimOnIdleSecs - If set, claim when any idle-eligible vouchers exist.
   * @param cfg.claimThreshold - If set, claim when total claimable exceeds this amount.
   * @param cfg.claimOnWithdrawal - If true, claim when withdrawals are pending and vouchers are claimable.
   * @returns `true` when a claim should be submitted this tick.
   */
  private async evaluateClaimTriggers(cfg: {
    claimIntervalMs: number;
    claimOnIdleSecs?: number;
    claimThreshold?: string;
    claimOnWithdrawal: boolean;
  }): Promise<boolean> {
    const now = Date.now();

    if (now - this.lastClaimTime >= cfg.claimIntervalMs) {
      return true;
    }

    if (cfg.claimOnIdleSecs !== undefined) {
      const idleClaims = await this.getClaimableVouchers({
        idleSecs: cfg.claimOnIdleSecs,
      });
      if (idleClaims.length > 0) {
        return true;
      }
    }

    if (cfg.claimThreshold !== undefined) {
      const allClaims = await this.getClaimableVouchers();
      const total = allClaims.reduce((sum, c) => sum + BigInt(c.totalClaimed), 0n);
      if (total > BigInt(cfg.claimThreshold)) {
        return true;
      }
    }

    if (cfg.claimOnWithdrawal) {
      const withdrawals = await this.getWithdrawalPendingSessions();
      if (withdrawals.length > 0) {
        const claimableWithdrawals = await this.getClaimableVouchers();
        const withdrawalChannels = new Set(withdrawals.map(w => w.channelId.toLowerCase()));
        const hasClaimableForWithdrawal = claimableWithdrawals.some(c =>
          withdrawalChannels.has(computeChannelId(c.voucher.channel).toLowerCase()),
        );
        if (hasClaimableForWithdrawal) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Evaluates whether a settle should be triggered based on interval and threshold policies.
   *
   * @param cfg - Settle trigger configuration for this evaluation.
   * @param cfg.settleIntervalMs - Time since last settle after which settle should run (if pending).
   * @param cfg.settleThreshold - If set, settle when total claimed-on-chain exceeds this amount.
   * @returns `true` when a settle should run this tick.
   */
  private async evaluateSettleTriggers(cfg: {
    settleIntervalMs: number;
    settleThreshold?: string;
  }): Promise<boolean> {
    if (!this.pendingSettle) {
      return false;
    }

    const now = Date.now();

    if (now - this.lastSettleTime >= cfg.settleIntervalMs) {
      return true;
    }

    if (cfg.settleThreshold !== undefined) {
      const channels = await this.scheme.getStorage().list();
      const unsettled = channels.reduce((sum, s) => sum + BigInt(s.totalClaimed), 0n);
      if (unsettled > BigInt(cfg.settleThreshold)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Returns channel ids that have been idle longer than `idleSecs` and still have
   * a non-zero balance (candidates for cooperative refund).
   *
   * @param idleSecs - Minimum seconds since last request for a session to count as idle.
   * @returns Channel ids meeting the idle and balance criteria.
   */
  private async getIdleChannelsForRefund(idleSecs: number): Promise<string[]> {
    const storage = this.scheme.getStorage();
    const channels = await storage.list();
    const now = Date.now();
    const idleMs = idleSecs * 1000;
    const result: string[] = [];

    for (const c of channels) {
      if (BigInt(c.balance) === 0n) {
        continue;
      }
      if (now - c.lastRequestTimestamp >= idleMs) {
        result.push(c.channelId);
      }
    }

    return result;
  }

  /**
   * Submits a batch of voucher claims to the facilitator.
   *
   * @param claims - Voucher claims to send in one `type: "claim"` payload.
   * @returns Per-batch claim summary (count and transaction hash).
   */
  private async submitClaim(claims: BatchSettlementVoucherClaim[]): Promise<ClaimResult> {
    const authorizerSigner = this.scheme.getReceiverAuthorizerSigner();

    const claimAuthorizerSignature = authorizerSigner
      ? await signClaimBatch(authorizerSigner, claims, this.network)
      : undefined;

    const paymentPayload: PaymentPayload = {
      x402Version: 2,
      accepted: this.buildPaymentRequirements(),
      payload: {
        type: "claim",
        claims,
        ...(claimAuthorizerSignature ? { claimAuthorizerSignature } : {}),
      },
    };

    const response: SettleResponse = await this.facilitator.settle(
      paymentPayload,
      this.buildPaymentRequirements(),
    );

    if (!response.success) {
      throw new Error(formatFacilitatorFailure("Claim", response));
    }

    return { vouchers: claims.length, transaction: response.transaction };
  }

  /**
   * Builds a settlement payment payload for `settle(receiver, token)`.
   *
   * @returns Payload with `type: "settle"` and receiver/token fields.
   */
  private buildSettlePaymentPayload(): PaymentPayload {
    return {
      x402Version: 2,
      accepted: this.buildPaymentRequirements(),
      payload: {
        type: "settle",
        receiver: this.receiver,
        token: this.token,
      },
    };
  }

  /**
   * Builds a minimal {@link PaymentRequirements} for channel manager operations.
   *
   * @returns Requirements describing batched operations for this manager.
   */
  private buildPaymentRequirements(): PaymentRequirements {
    return {
      scheme: BATCH_SETTLEMENT_SCHEME,
      network: this.network,
      asset: this.token,
      amount: "0",
      payTo: this.receiver,
      maxTimeoutSeconds: 0,
      extra: {},
    };
  }

  /**
   * Updates session records after a successful claim submission so that
   * `getClaimableVouchers` no longer returns already-claimed vouchers.
   *
   * @param claims - Voucher claims that were included in the submitted settlement transaction.
   */
  private async updateClaimedSessions(claims: BatchSettlementVoucherClaim[]): Promise<void> {
    const storage = this.scheme.getStorage();
    for (const claim of claims) {
      const channelId = computeChannelId(claim.voucher.channel);
      const channel = await storage.get(channelId);
      if (!channel) {
        continue;
      }
      const claimedAmount = BigInt(claim.totalClaimed);
      if (claimedAmount <= BigInt(channel.totalClaimed)) {
        continue;
      }
      await storage.set(channelId, {
        ...channel,
        totalClaimed: claimedAmount.toString(),
      });
    }
  }
}
