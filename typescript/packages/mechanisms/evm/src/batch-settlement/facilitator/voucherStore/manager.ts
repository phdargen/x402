import type { Network, PaymentRequirements } from "@x402/core/types";
import { getAddress } from "viem";
import type { FacilitatorEvmSigner } from "../../../signer";
import { BATCH_SETTLEMENT_SCHEME } from "../../constants";
import { buildClaimRow, isWithdrawUrgent, selectClaimableChannels } from "../../claims";
import { isPendingLive, type Channel } from "../../storage";
import type { AuthorizerSigner, BatchSettlementVoucherClaim } from "../../types";
import { computeChannelId } from "../../utils";
import * as Errors from "../../errors";
import { executeClaimWithSignature } from "../claim";
import { executeSettle } from "../settle";
import type { BatchSettlementVoucherStore } from "./store";

const DEFAULT_MAX_CLAIMS_PER_BATCH = 100;
const DEFAULT_URGENCY_RATIO = 0.5;

export interface BatchSettlementVoucherStoreManagerConfig {
  store: BatchSettlementVoucherStore;
  signer: FacilitatorEvmSigner;
  authorizerSigner: AuthorizerSigner;
  network: Network;
  /**
   * Fraction of a channel's withdraw delay after which its vouchers are claimed ahead of
   * everything else, so a timed withdrawal cannot finalize over unclaimed charges.
   *
   * @default 0.5
   */
  urgencyRatio?: number;
}

export interface VoucherStoreClaimOptions {
  maxClaimsPerBatch?: number;
  /** Only claim channels idle for at least this many seconds. */
  idleSecs?: number;
}

export interface VoucherStoreSettlementTarget {
  receiver: `0x${string}`;
  token: `0x${string}`;
}

export interface VoucherStoreClaimResult {
  vouchers: number;
  transaction: string;
}

export interface VoucherStoreSettleResult extends VoucherStoreSettlementTarget {
  transaction: string;
  amount: string;
}

export interface VoucherStoreScheduleConfig extends VoucherStoreClaimOptions {
  claimIntervalSecs?: number;
  settleIntervalSecs?: number;
  onClaim?: (result: VoucherStoreClaimResult) => void;
  onSettle?: (result: VoucherStoreSettleResult) => void;
  onError?: (error: unknown) => void;
}

type ScheduledJob = "claim" | "settle";

const JOB_PRIORITY: ScheduledJob[] = ["claim", "settle"];

/**
 * Redeems the vouchers the facilitator holds in facilitator-managed custody.
 *
 * The resource server runs no claim schedule in this mode, so the facilitator does:
 * `claimWithSignature` batches vouchers whose charges are ahead of onchain accounting,
 * then `settle(receiver, token)` moves the claimed funds. Unlike the server-side channel
 * manager it calls the scheme handlers in-process instead of going back out through a
 * facilitator client, and it groups settlement per `(receiver, token)` because one
 * facilitator serves many receivers.
 */
export class BatchSettlementVoucherStoreManager {
  private readonly store: BatchSettlementVoucherStore;
  private readonly signer: FacilitatorEvmSigner;
  private readonly authorizerSigner: AuthorizerSigner;
  private readonly network: Network;
  private readonly urgencyRatio: number;

  private timers: Partial<Record<ScheduledJob, ReturnType<typeof setInterval>>> = {};
  private schedule: VoucherStoreScheduleConfig = {};
  private pendingJobs = new Set<ScheduledJob>();
  private draining = false;
  private running = false;
  private pendingSettle = false;

  /**
   * Creates a voucher-store manager.
   *
   * @param config - Store, signers, network, and claim-urgency policy.
   */
  constructor(config: BatchSettlementVoucherStoreManagerConfig) {
    this.store = config.store;
    this.signer = config.signer;
    this.authorizerSigner = config.authorizerSigner;
    this.network = config.network;
    this.urgencyRatio = config.urgencyRatio ?? DEFAULT_URGENCY_RATIO;
  }

  /**
   * Claims outstanding vouchers, submitting withdraw-urgent channels first.
   *
   * @param opts - Batch size and optional idle filter.
   * @returns One result per submitted claim batch.
   */
  async claim(opts: VoucherStoreClaimOptions = {}): Promise<VoucherStoreClaimResult[]> {
    const maxClaimsPerBatch = opts.maxClaimsPerBatch ?? DEFAULT_MAX_CLAIMS_PER_BATCH;
    const targets = await this.selectClaimTargets(opts);
    const rows = targets.map(buildClaimRow);

    const results: VoucherStoreClaimResult[] = [];
    for (let i = 0; i < rows.length; i += maxClaimsPerBatch) {
      const batch = rows.slice(i, i + maxClaimsPerBatch);
      results.push(await this.submitClaim(batch));
      await this.recordClaimed(batch);
    }

    if (results.length > 0) {
      this.pendingSettle = true;
    }
    return results;
  }

  /**
   * Transfers claimed funds to their receivers.
   *
   * @param target - Single receiver/token pair; defaults to every pair in the store.
   * @returns One result per pair that had funds to settle.
   */
  async settle(target?: VoucherStoreSettlementTarget): Promise<VoucherStoreSettleResult[]> {
    const targets = target ? [target] : await this.settlementTargets();

    const results: VoucherStoreSettleResult[] = [];
    for (const { receiver, token } of targets) {
      const response = await executeSettle(
        this.signer,
        { type: "settle", receiver, token },
        this.buildPaymentRequirements(token, receiver),
      );

      if (!response.success) {
        if (response.errorReason === Errors.ErrNothingToSettle) {
          continue;
        }
        throw new Error(
          `Settle failed: ${response.errorReason ?? "unknown"} — ${response.errorMessage ?? ""}`,
        );
      }

      results.push({
        receiver,
        token,
        transaction: response.transaction,
        amount: response.amount ?? "",
      });
    }

    this.pendingSettle = false;
    return results;
  }

  /**
   * Claims outstanding vouchers then settles the receivers they belong to.
   *
   * @param opts - Batch size and optional idle filter.
   * @returns Claim results and, when anything was claimed, settle results.
   */
  async claimAndSettle(
    opts: VoucherStoreClaimOptions = {},
  ): Promise<{ claims: VoucherStoreClaimResult[]; settles: VoucherStoreSettleResult[] }> {
    const claims = await this.claim(opts);
    const settles = claims.length > 0 ? await this.settle() : [];
    return { claims, settles };
  }

  /**
   * Starts the claim and settle intervals.
   *
   * @param config - Interval lengths, batch size, and result callbacks.
   */
  start(config: VoucherStoreScheduleConfig = {}): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.schedule = config;
    this.startTimer("claim", config.claimIntervalSecs);
    this.startTimer("settle", config.settleIntervalSecs);
  }

  /**
   * Stops the claim and settle intervals. Work already in flight runs to completion.
   */
  stop(): void {
    this.running = false;
    for (const timer of Object.values(this.timers)) {
      clearInterval(timer);
    }
    this.timers = {};
    this.pendingJobs.clear();
  }

  /**
   * Starts one recurring job timer.
   *
   * @param job - Job to enqueue when the interval fires.
   * @param intervalSecs - Interval in seconds; the job is disabled when omitted.
   */
  private startTimer(job: ScheduledJob, intervalSecs?: number): void {
    if (intervalSecs === undefined) {
      return;
    }
    this.timers[job] = setInterval(() => {
      if (!this.running) {
        return;
      }
      this.pendingJobs.add(job);
      if (!this.draining) {
        void this.drainJobs();
      }
    }, intervalSecs * 1000);
  }

  /**
   * Runs queued jobs one at a time, claims before settles, so a slow claim batch cannot
   * overlap with the settlement that depends on it.
   */
  private async drainJobs(): Promise<void> {
    this.draining = true;
    try {
      while (this.running && this.pendingJobs.size > 0) {
        const job = JOB_PRIORITY.find(candidate => this.pendingJobs.has(candidate));
        if (!job) {
          return;
        }
        this.pendingJobs.delete(job);
        await this.runJob(job);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Runs one scheduled job and reports its outcome through the configured callbacks.
   *
   * @param job - Job to run.
   */
  private async runJob(job: ScheduledJob): Promise<void> {
    const config = this.schedule;
    try {
      if (job === "claim") {
        const results = await this.claim({
          maxClaimsPerBatch: config.maxClaimsPerBatch,
          idleSecs: config.idleSecs,
        });
        results.forEach(result => config.onClaim?.(result));
        return;
      }

      if (!this.pendingSettle) {
        return;
      }
      const results = await this.settle();
      results.forEach(result => config.onSettle?.(result));
    } catch (error) {
      config.onError?.(error);
    }
  }

  /**
   * Selects the channels to claim, urgent withdrawals first.
   *
   * Two kinds of channel are left out: those whose `receiverAuthorizer` is not this
   * facilitator's authorizer, because only the holder of that key can authorize their
   * claims, and those with a live reservation, because their charge is still being decided
   * and the next pass will pick them up.
   *
   * @param opts - Optional idle filter.
   * @returns Channels to build claim rows from, in submission order.
   */
  private async selectClaimTargets(opts: VoucherStoreClaimOptions): Promise<Channel[]> {
    const now = Date.now();
    const stored = await this.store.getStorage().list();
    const authorizer = getAddress(this.authorizerSigner.address);

    const claimable = selectClaimableChannels(stored, { idleSecs: opts.idleSecs, now }).filter(
      channel =>
        getAddress(channel.channelConfig.receiverAuthorizer) === authorizer &&
        !isPendingLive(channel.pendingRequest, now),
    );

    return claimable.sort(
      (a, b) =>
        Number(isWithdrawUrgent(b, this.urgencyRatio, now)) -
        Number(isWithdrawUrgent(a, this.urgencyRatio, now)),
    );
  }

  /**
   * Submits one claim batch onchain.
   *
   * @param claims - Claim rows to submit together.
   * @returns Batch size and transaction hash.
   */
  private async submitClaim(
    claims: BatchSettlementVoucherClaim[],
  ): Promise<VoucherStoreClaimResult> {
    const first = claims[0].voucher.channel;
    const response = await executeClaimWithSignature(
      this.signer,
      { type: "claim", claims },
      this.buildPaymentRequirements(first.token, first.receiver),
      this.authorizerSigner,
    );

    if (!response.success) {
      throw new Error(
        `Claim failed: ${response.errorReason ?? "unknown"} — ${response.errorMessage ?? ""}`,
      );
    }

    return { vouchers: claims.length, transaction: response.transaction };
  }

  /**
   * Mirrors the new onchain `totalClaimed` into the store so claimed vouchers are not
   * submitted again on the next pass.
   *
   * @param claims - Claim rows that were submitted successfully.
   */
  private async recordClaimed(claims: BatchSettlementVoucherClaim[]): Promise<void> {
    const storage = this.store.getStorage();
    for (const claim of claims) {
      const channelId = computeChannelId(claim.voucher.channel, this.network);
      const claimed = BigInt(claim.totalClaimed);
      await storage.updateChannel(channelId, current => {
        if (!current || claimed <= BigInt(current.totalClaimed)) {
          return current;
        }
        return { ...current, totalClaimed: claimed.toString() };
      });
    }
  }

  /**
   * Lists the distinct receiver/token pairs the store holds channels for.
   *
   * @returns Settlement targets.
   */
  private async settlementTargets(): Promise<VoucherStoreSettlementTarget[]> {
    const groups = new Map<string, VoucherStoreSettlementTarget>();
    for (const channel of await this.store.getStorage().list()) {
      const receiver = getAddress(channel.channelConfig.receiver);
      const token = getAddress(channel.channelConfig.token);
      groups.set(`${receiver}:${token}`, { receiver, token });
    }
    return [...groups.values()];
  }

  /**
   * Builds the minimal requirements the claim and settle handlers read.
   *
   * @param token - Token being claimed or settled.
   * @param receiver - Receiver being claimed or settled for.
   * @returns Requirements describing this manager's onchain operations.
   */
  private buildPaymentRequirements(
    token: `0x${string}`,
    receiver: `0x${string}`,
  ): PaymentRequirements {
    return {
      scheme: BATCH_SETTLEMENT_SCHEME,
      network: this.network,
      asset: token,
      amount: "0",
      payTo: receiver,
      maxTimeoutSeconds: 0,
      extra: {},
    };
  }
}
