import type {
  FacilitatorContext,
  Network,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";
import { resolveDataSuffix, type DataSuffixContext } from "../../shared/extensions";
import type { FacilitatorEvmSigner } from "../../signer";
import { BATCH_SETTLEMENT_SCHEME } from "../constants";
import type {
  AuthorizerSigner,
  BatchSettlementSettlePayload,
  BatchSettlementVoucherClaim,
} from "../types";
import { applyClaimedTotals, selectClaimableVouchers } from "../claims";
import { computeChannelId } from "../utils";
import type { ChannelLockStorage, ChannelStorage } from "../storage/channel";
import { isChannelLockStorage } from "../storage/channel";
import { composeClaimDataSuffix, encodeChargeCountsSuffix } from "./chargeCounts";
import { submitClaim } from "./claim";
import { submitRefund } from "./refund";
import { executeSettle } from "./settle";
import { assertDirectAuthorizerSubmitter, type SubmitContext, type SubmitMode } from "./submit";
import type { FacilitatorChannel } from "./types";
import * as Errors from "../errors";

export type { FacilitatorChannel };

export type FacilitatorRetention = "until-closed" | "forever";

export interface FacilitatorChannelManagerConfig {
  storage: ChannelStorage<FacilitatorChannel>;
  lockStorage?: ChannelLockStorage;
  signer: FacilitatorEvmSigner;
  authorizerSigner: AuthorizerSigner;
  authorizerSubmitter?: FacilitatorEvmSigner;
  submitMode?: SubmitMode;
  retention?: FacilitatorRetention;
  /**
   * Optional facilitator extension context so scheduled claim, settle, and
   * refund txs can append builder-code (`w` / `serviceCode` only).
   */
  context?: FacilitatorContext;
}

export interface FacilitatorClaimOptions {
  maxClaimsPerBatch?: number;
  idleSecs?: number;
}

export interface FacilitatorAutoConfig {
  claimIntervalSecs?: number;
  settleIntervalSecs?: number;
  refundIntervalSecs?: number;
  refundIdleSecs?: number;
  maxClaimsPerBatch?: number;
  onClaim?: (result: FacilitatorClaimResult) => void;
  onSettle?: (result: FacilitatorSettleResult) => void;
  onRefund?: (result: FacilitatorRefundResult) => void;
  onError?: (error: unknown) => void;
}

export interface FacilitatorClaimResult {
  network: Network;
  vouchers: number;
  transaction: string;
}

export interface FacilitatorSettleResult {
  network: Network;
  receiver: `0x${string}`;
  token: `0x${string}`;
  transaction: string;
}

export interface FacilitatorRefundResult {
  network: Network;
  channel: string;
  transaction: string;
}

type AutoJob = "claim" | "settle" | "refund";

const AUTO_JOB_PRIORITY: AutoJob[] = ["claim", "settle", "refund"];

/**
 * Formats a settle failure into a human-readable error.
 *
 * @param operation - Operation label.
 * @param response - Failed settle response.
 * @returns Error message.
 */
function formatFailure(operation: string, response: SettleResponse): string {
  return `${operation} failed: ${response.errorReason ?? "unknown"} — ${response.errorMessage ?? ""}`;
}

/**
 * Returns whether a live admission lock is held, treating lock-store errors as not held.
 *
 * @param lock - Admission lock store.
 * @param channelId - Channel to inspect.
 * @returns Whether a live lock is present.
 */
async function channelIsHeld(lock: ChannelLockStorage, channelId: string): Promise<boolean> {
  try {
    return await lock.isHeld(channelId);
  } catch {
    return false;
  }
}

/**
 * Applies claimed totals, subtracts attested `chargeCount`, and deletes closed rows.
 *
 * Call only after a successful onchain claim. A simulation miss must leave the store alone.
 *
 * @param storage - Facilitator voucher store.
 * @param lockStorage - Optional admission lock store used for closed-row deletion.
 * @param claims - Submitted claims.
 * @param network - Network for channel-id recomputation.
 * @param attested - Charge-count snapshot encoded on the claim (do not re-read the store).
 * @param retention - Row retention policy.
 */
export async function afterClaim(
  storage: ChannelStorage<FacilitatorChannel>,
  lockStorage: ChannelLockStorage | undefined,
  claims: BatchSettlementVoucherClaim[],
  network: Network,
  attested: ReadonlyMap<string, number>,
  retention: FacilitatorRetention = "until-closed",
): Promise<void> {
  await applyClaimedTotals(storage, claims, network);

  for (const claim of claims) {
    const channelId = computeChannelId(claim.voucher.channel, network);
    const snapshot = attested.get(channelId.toLowerCase()) ?? 0;
    await storage.updateChannel(channelId, current => {
      if (!current) {
        return current;
      }
      const chargeCount = Math.max(0, current.chargeCount - snapshot);
      return { ...current, chargeCount };
    });

    if (retention === "forever") {
      continue;
    }
    const held = lockStorage ? await channelIsHeld(lockStorage, channelId) : false;
    await storage.updateChannel(channelId, current => {
      if (!current) {
        return current;
      }
      if (
        !held &&
        current.chargeCount === 0 &&
        BigInt(current.balance) <= BigInt(current.totalClaimed)
      ) {
        return undefined;
      }
      return current;
    });
  }
}

/**
 * Snapshots each claim row's unattested `chargeCount` in batch order.
 *
 * Encode this snapshot on the claim, then pass the same map to {@link afterClaim}.
 *
 * @param storage - Facilitator voucher store.
 * @param claims - Claims about to be submitted.
 * @param network - Network for channel-id recomputation.
 * @returns Counts for the calldata suffix and the map used to subtract after confirm.
 */
export async function snapshotClaimChargeCounts(
  storage: ChannelStorage<FacilitatorChannel>,
  claims: BatchSettlementVoucherClaim[],
  network: Network,
): Promise<{ counts: bigint[]; attested: Map<string, number> }> {
  const counts: bigint[] = [];
  const attested = new Map<string, number>();
  for (const claim of claims) {
    const channelId = computeChannelId(claim.voucher.channel, network);
    const stored = await storage.get(channelId);
    const count = stored?.chargeCount ?? 0;
    counts.push(BigInt(count));
    attested.set(channelId.toLowerCase(), count);
  }
  return { counts, attested };
}

/**
 * Facilitator-side claim / settle / idle-refund scheduler for the voucher store.
 */
export class FacilitatorChannelManager {
  private readonly storage: ChannelStorage<FacilitatorChannel>;
  private readonly lockStorage: ChannelLockStorage | undefined;
  private readonly signer: FacilitatorEvmSigner;
  private readonly authorizerSigner: AuthorizerSigner;
  private readonly authorizerSubmitter: FacilitatorEvmSigner | undefined;
  private readonly submitMode: SubmitMode;
  private readonly retention: FacilitatorRetention;
  private readonly context: FacilitatorContext | undefined;

  private timers: Partial<Record<AutoJob, ReturnType<typeof setInterval>>> = {};
  private running = false;
  private pendingJobs = new Set<AutoJob>();
  private drainingJobs = false;
  private autoConfig: FacilitatorAutoConfig = {};
  /** True after a successful claim batch until onchain `settle` completes or is confirmed empty. */
  private pendingSettle = false;

  /**
   * Creates a facilitator channel manager.
   *
   * @param config - Storage, signers, submit mode, and retention policy.
   */
  constructor(config: FacilitatorChannelManagerConfig) {
    assertDirectAuthorizerSubmitter(
      config.submitMode,
      config.authorizerSigner,
      config.authorizerSubmitter,
    );
    this.storage = config.storage;
    this.lockStorage =
      config.lockStorage ?? (isChannelLockStorage(config.storage) ? config.storage : undefined);
    this.signer = config.signer;
    this.authorizerSigner = config.authorizerSigner;
    this.authorizerSubmitter = config.authorizerSubmitter;
    this.submitMode = config.submitMode ?? "relay";
    this.retention = config.retention ?? "until-closed";
    this.context = config.context;
  }

  /**
   * Claims eligible vouchers, grouped by network, withdraw-pending first.
   *
   * @param opts - Optional batching and idle filter.
   * @returns One result per submitted claim batch.
   */
  async claim(opts?: FacilitatorClaimOptions): Promise<FacilitatorClaimResult[]> {
    const channels = await this.storage.list();
    const byNetwork = groupByNetwork(channels);
    const results: FacilitatorClaimResult[] = [];
    const maxClaimsPerBatch = opts?.maxClaimsPerBatch ?? 100;

    for (const [network, group] of byNetwork) {
      const ordered = [...group].sort((a, b) => {
        const aw = a.withdrawRequestedAt > 0 ? 0 : 1;
        const bw = b.withdrawRequestedAt > 0 ? 0 : 1;
        return aw - bw;
      });
      const claims = selectClaimableVouchers(ordered, {
        now: Date.now(),
        ...(opts?.idleSecs !== undefined ? { idleSecs: opts.idleSecs } : {}),
      });
      if (claims.length === 0) {
        continue;
      }

      for (let i = 0; i < claims.length; i += maxClaimsPerBatch) {
        const batch = claims.slice(i, i + maxClaimsPerBatch);
        const { result, attested } = await this.submitClaimBatch(network, batch);
        results.push(result);
        await afterClaim(this.storage, this.lockStorage, batch, network, attested, this.retention);
      }
    }

    if (results.length > 0) {
      this.pendingSettle = true;
    }

    return results;
  }

  /**
   * Settles claimed-but-unsettled funds for each distinct (receiver, token) pair
   * among stored claimed channels.
   *
   * @returns One result per settle transaction.
   */
  async settle(): Promise<FacilitatorSettleResult[]> {
    const channels = await this.storage.list();
    const pairs = new Map<
      string,
      { network: Network; receiver: `0x${string}`; token: `0x${string}` }
    >();
    for (const channel of channels) {
      if (BigInt(channel.totalClaimed) === 0n) {
        continue;
      }
      const receiver = channel.channelConfig.receiver;
      const token = channel.channelConfig.token;
      const key = `${channel.network}:${receiver.toLowerCase()}:${token.toLowerCase()}`;
      if (!pairs.has(key)) {
        pairs.set(key, { network: channel.network, receiver, token });
      }
    }

    if (pairs.size === 0) {
      this.pendingSettle = false;
      return [];
    }

    const results: FacilitatorSettleResult[] = [];
    for (const pair of pairs.values()) {
      const payload: BatchSettlementSettlePayload = {
        type: "settle",
        receiver: pair.receiver,
        token: pair.token,
      };
      const dataSuffix = await this.resolveBuilderSuffix(
        pair.network,
        payload,
        pair.token,
        pair.receiver,
      );
      const response = await executeSettle(this.signer, payload, pair.network, dataSuffix);
      if (!response.success) {
        if (response.errorReason === Errors.ErrNothingToSettle) {
          continue;
        }
        throw new Error(formatFailure("Settle", response));
      }
      results.push({
        network: pair.network,
        receiver: pair.receiver,
        token: pair.token,
        transaction: response.transaction,
      });
    }
    this.pendingSettle = false;
    return results;
  }

  /**
   * Claims eligible vouchers then settles.
   *
   * @param opts - Optional claim options.
   * @returns Combined claim and settle results.
   */
  async claimAndSettle(
    opts?: FacilitatorClaimOptions,
  ): Promise<{ claims: FacilitatorClaimResult[]; settle: FacilitatorSettleResult[] }> {
    const claims = await this.claim(opts);
    const settle = claims.length > 0 ? await this.settle() : [];
    return { claims, settle };
  }

  /**
   * Cooperatively refunds one or more stored channels.
   *
   * Skips channels with a live admission lock. Claims outstanding vouchers first,
   * then refunds `balance - chargedCumulativeAmount`.
   *
   * @param channelIds - Specific channels to refund; defaults to all stored channels.
   * @returns One result per successfully refunded or claim-only channel.
   */
  async refund(channelIds?: string[]): Promise<FacilitatorRefundResult[]> {
    const channels = await this.storage.list();
    const selected = channelIds
      ? channels.filter(channel =>
          channelIds.some(id => id.toLowerCase() === channel.channelId.toLowerCase()),
        )
      : channels;
    return this.refundChannels(selected);
  }

  /**
   * Refunds idle channels with a remaining escrow balance.
   *
   * @param opts - Idle refund options.
   * @param opts.idleSecs - Minimum seconds since the last request.
   * @returns One result per successfully refunded channel.
   */
  async refundIdleChannels(opts: { idleSecs: number }): Promise<FacilitatorRefundResult[]> {
    const channels = await this.getIdleChannelsForRefund(opts.idleSecs);
    return this.refundChannels(channels);
  }

  /**
   * Starts claim, settle, and refund interval jobs.
   *
   * @param config - Interval, idle-refund, and callback configuration.
   */
  start(config: FacilitatorAutoConfig = {}): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.autoConfig = config;
    this.startAutoTimer("claim", config.claimIntervalSecs);
    this.startAutoTimer("settle", config.settleIntervalSecs);
    this.startAutoTimer("refund", config.refundIntervalSecs);
  }

  /**
   * Stops the interval loop.
   *
   * @param opts - Stop options.
   * @param opts.flush - When true, run claimAndSettle before stopping.
   */
  async stop(opts?: { flush?: boolean }): Promise<void> {
    this.running = false;
    for (const timer of Object.values(this.timers)) {
      clearInterval(timer);
    }
    this.timers = {};
    this.pendingJobs.clear();
    if (opts?.flush) {
      await this.claimAndSettle({
        maxClaimsPerBatch: this.autoConfig.maxClaimsPerBatch,
      });
    }
  }

  /**
   * Submits one claim batch.
   *
   * @param network - Network for this batch.
   * @param claims - Voucher claims.
   * @returns Per-batch claim summary.
   */
  private async submitClaimBatch(
    network: Network,
    claims: BatchSettlementVoucherClaim[],
  ): Promise<{ result: FacilitatorClaimResult; attested: Map<string, number> }> {
    const { counts, attested } = await snapshotClaimChargeCounts(this.storage, claims, network);
    const builderSuffix = await this.resolveBuilderSuffix(
      network,
      { type: "claim", claims },
      claims[0]?.voucher.channel.token ?? "0x0000000000000000000000000000000000000000",
      claims[0]?.voucher.channel.receiver ?? "0x0000000000000000000000000000000000000000",
    );
    const response = await submitClaim(
      { network, claims, dataSuffix: composeClaimDataSuffix(counts, builderSuffix) },
      this.submitContext(),
    );
    if (!response.success) {
      throw new Error(formatFailure("Claim", response));
    }
    return {
      result: { network, vouchers: claims.length, transaction: response.transaction },
      attested,
    };
  }

  /**
   * Refunds each eligible unlocked channel independently.
   *
   * @param channels - Channels to inspect.
   * @returns Successful refund results.
   */
  private async refundChannels(channels: FacilitatorChannel[]): Promise<FacilitatorRefundResult[]> {
    const results: FacilitatorRefundResult[] = [];
    for (const channel of channels) {
      if (this.lockStorage && (await channelIsHeld(this.lockStorage, channel.channelId))) {
        continue;
      }
      const result = await this.refundChannel(channel);
      if (result) {
        results.push(result);
      }
    }
    return results;
  }

  /**
   * Claims outstanding value then refunds unearned escrow for one channel.
   *
   * @param target - Channel to refund.
   * @returns Refund result, or `undefined` when there is nothing to claim or refund.
   */
  private async refundChannel(
    target: FacilitatorChannel,
  ): Promise<FacilitatorRefundResult | undefined> {
    const claims = this.buildRefundClaims(target);
    const refundAmount = BigInt(target.balance) - BigInt(target.chargedCumulativeAmount);

    if (refundAmount <= 0n && claims.length === 0) {
      return undefined;
    }

    if (refundAmount <= 0n) {
      const { result, attested } = await this.submitClaimBatch(target.network, claims);
      await afterClaim(
        this.storage,
        this.lockStorage,
        claims,
        target.network,
        attested,
        this.retention,
      );
      return {
        network: target.network,
        channel: target.channelId,
        transaction: result.transaction,
      };
    }

    const payload = {
      type: "refund" as const,
      channelConfig: target.channelConfig,
      voucher: {
        channelId: target.channelId as `0x${string}`,
        maxClaimableAmount: target.signedMaxClaimable,
        signature: target.signature as `0x${string}`,
      },
      amount: refundAmount.toString(),
      refundNonce: String(target.refundNonce ?? 0),
      claims,
    };
    const dataSuffix = await this.resolveBuilderSuffix(
      target.network,
      payload,
      target.channelConfig.token,
      target.channelConfig.receiver,
    );
    const response = await submitRefund(
      {
        network: target.network,
        payload,
        dataSuffix,
        ...(claims.length > 0
          ? { claimDataSuffix: encodeChargeCountsSuffix([target.chargeCount]) }
          : {}),
      },
      this.submitContext(),
    );
    if (!response.success) {
      throw new Error(formatFailure("Refund", response));
    }

    await this.afterRefund(target, claims, response);
    return {
      network: target.network,
      channel: target.channelId,
      transaction: response.transaction,
    };
  }

  /**
   * Subtracts attested `chargeCount` when a claim was bundled, mirrors refunded
   * escrow, and deletes the row when closed.
   *
   * @param target - Channel that was refunded.
   * @param claims - Claims bundled into the refund transaction.
   * @param response - Successful refund settle response.
   */
  private async afterRefund(
    target: FacilitatorChannel,
    claims: BatchSettlementVoucherClaim[],
    response: SettleResponse,
  ): Promise<void> {
    if (claims.length > 0) {
      const attested = target.chargeCount;
      await applyClaimedTotals(this.storage, claims, target.network);
      await this.storage.updateChannel(target.channelId, current => {
        if (!current) {
          return current;
        }
        return { ...current, chargeCount: Math.max(0, current.chargeCount - attested) };
      });
    }

    const extra = response.extra as
      | {
          channelState?: {
            balance?: string;
            totalClaimed?: string;
            refundNonce?: string;
            withdrawRequestedAt?: number;
          };
        }
      | undefined;
    const refunded = extra?.channelState;

    await this.storage.updateChannel(target.channelId, current => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        balance: refunded?.balance ?? current.balance,
        totalClaimed: refunded?.totalClaimed ?? current.totalClaimed,
        refundNonce:
          refunded?.refundNonce !== undefined
            ? Number(refunded.refundNonce)
            : current.refundNonce + 1,
        withdrawRequestedAt: refunded?.withdrawRequestedAt ?? current.withdrawRequestedAt,
      };
    });

    if (this.retention === "forever") {
      return;
    }
    const held = this.lockStorage ? await channelIsHeld(this.lockStorage, target.channelId) : false;
    await this.storage.updateChannel(target.channelId, current => {
      if (!current) {
        return current;
      }
      if (
        !held &&
        current.chargeCount === 0 &&
        BigInt(current.balance) <= BigInt(current.totalClaimed)
      ) {
        return undefined;
      }
      return current;
    });
  }

  /**
   * Builds an outstanding voucher claim for a refund payload.
   *
   * @param channel - Channel being refunded.
   * @returns Claim payloads needed before refunding unclaimed balance.
   */
  private buildRefundClaims(channel: FacilitatorChannel): BatchSettlementVoucherClaim[] {
    if (BigInt(channel.chargedCumulativeAmount) <= BigInt(channel.totalClaimed)) {
      return [];
    }
    return [
      {
        voucher: {
          channel: channel.channelConfig,
          maxClaimableAmount: channel.signedMaxClaimable,
        },
        signature: channel.signature as `0x${string}`,
        totalClaimed: channel.chargedCumulativeAmount,
      },
    ];
  }

  /**
   * Returns idle channels that still have escrow.
   *
   * @param idleSecs - Minimum seconds since the last request.
   * @returns Idle refundable channels.
   */
  private async getIdleChannelsForRefund(idleSecs: number): Promise<FacilitatorChannel[]> {
    const now = Date.now();
    const idleMs = idleSecs * 1000;
    const channels = await this.storage.list();
    const idle: FacilitatorChannel[] = [];
    for (const channel of channels) {
      if (BigInt(channel.balance) === 0n) {
        continue;
      }
      if (this.lockStorage && (await channelIsHeld(this.lockStorage, channel.channelId))) {
        continue;
      }
      if (now - channel.lastRequestTimestamp >= idleMs) {
        idle.push(channel);
      }
    }
    return idle;
  }

  /**
   * Starts a recurring timer for one auto job.
   *
   * @param job - Job to enqueue when the interval fires.
   * @param intervalSecs - Timer interval in seconds.
   */
  private startAutoTimer(job: AutoJob, intervalSecs?: number): void {
    if (intervalSecs === undefined) {
      return;
    }
    this.timers[job] = setInterval(() => {
      this.enqueueJob(job);
    }, intervalSecs * 1000);
  }

  /**
   * Adds an auto job to the coalescing queue.
   *
   * @param job - Job to run.
   */
  private enqueueJob(job: AutoJob): void {
    if (!this.running) {
      return;
    }
    this.pendingJobs.add(job);
    if (!this.drainingJobs) {
      void this.drainJobs();
    }
  }

  /**
   * Drains queued auto jobs in priority order.
   */
  private async drainJobs(): Promise<void> {
    if (this.drainingJobs) {
      return;
    }
    this.drainingJobs = true;
    try {
      while (this.running && this.pendingJobs.size > 0) {
        const job = this.nextPendingJob();
        if (!job) {
          return;
        }
        this.pendingJobs.delete(job);
        await this.runAutoJob(job);
      }
    } finally {
      this.drainingJobs = false;
    }
  }

  /**
   * Returns the highest-priority queued auto job.
   *
   * @returns Next job to run.
   */
  private nextPendingJob(): AutoJob | undefined {
    return AUTO_JOB_PRIORITY.find(job => this.pendingJobs.has(job));
  }

  /**
   * Runs one auto job.
   *
   * @param job - Job to run.
   */
  private async runAutoJob(job: AutoJob): Promise<void> {
    switch (job) {
      case "claim":
        await this.runClaimJob();
        return;
      case "settle":
        await this.runSettleJob();
        return;
      case "refund":
        await this.runRefundJob();
        return;
      default: {
        const _exhaustive: never = job;
        throw new Error(`unhandled auto job: ${_exhaustive}`);
      }
    }
  }

  /**
   * Runs the claim auto job.
   */
  private async runClaimJob(): Promise<void> {
    const cfg = this.autoConfig;
    try {
      const results = await this.claim({
        maxClaimsPerBatch: cfg.maxClaimsPerBatch,
      });
      for (const result of results) {
        cfg.onClaim?.(result);
      }
    } catch (err) {
      cfg.onError?.(err);
    }
  }

  /**
   * Runs the settle auto job.
   */
  private async runSettleJob(): Promise<void> {
    if (!this.pendingSettle) {
      return;
    }
    const cfg = this.autoConfig;
    try {
      const results = await this.settle();
      for (const result of results) {
        cfg.onSettle?.(result);
      }
    } catch (err) {
      cfg.onError?.(err);
    }
  }

  /**
   * Runs the refund auto job.
   */
  private async runRefundJob(): Promise<void> {
    const cfg = this.autoConfig;
    try {
      const results =
        cfg.refundIdleSecs !== undefined
          ? await this.refundIdleChannels({ idleSecs: cfg.refundIdleSecs })
          : await this.refund();
      for (const result of results) {
        cfg.onRefund?.(result);
      }
    } catch (err) {
      cfg.onError?.(err);
    }
  }

  /**
   * Resolves an optional builder-code suffix for a scheduled claim, settle, or refund.
   *
   * @param network - Network of the transaction.
   * @param payload - Synthetic payload (`type` plus operation fields).
   * @param asset - Token address used as `accepted.asset`.
   * @param payTo - Receiver address used as `accepted.payTo`.
   * @returns ERC-8021 suffix, or `undefined` when no extension produces one.
   */
  private async resolveBuilderSuffix(
    network: Network,
    payload: Record<string, unknown>,
    asset: `0x${string}`,
    payTo: `0x${string}`,
  ): Promise<`0x${string}` | undefined> {
    return resolveDataSuffix(this.context, scheduledSuffixContext(network, payload, asset, payTo));
  }

  /**
   * Builds the submit context for claim and refund dispatchers.
   *
   * @returns Signers and submit mode.
   */
  private submitContext(): SubmitContext {
    return {
      submitMode: this.submitMode,
      signer: this.signer,
      authorizerSigner: this.authorizerSigner,
      authorizerSubmitter: this.authorizerSubmitter,
    };
  }
}

/**
 * Builds a synthetic settle context for scheduled txs (no client `a`/`s`).
 *
 * @param network - Network of the transaction.
 * @param payload - Synthetic payload body.
 * @param asset - Token address.
 * @param payTo - Receiver address.
 * @returns Context passed to `resolveDataSuffix`.
 */
function scheduledSuffixContext(
  network: Network,
  payload: Record<string, unknown>,
  asset: `0x${string}`,
  payTo: `0x${string}`,
): DataSuffixContext {
  const accepted: PaymentRequirements = {
    scheme: BATCH_SETTLEMENT_SCHEME,
    network,
    asset,
    amount: "0",
    payTo,
    maxTimeoutSeconds: 0,
    extra: {},
  };
  return {
    paymentPayload: {
      x402Version: 2,
      accepted,
      payload,
    },
    paymentRequirements: accepted,
  };
}

/**
 * Groups channels by their stored network.
 *
 * @param channels - Facilitator channel records.
 * @returns Map of network → channels.
 */
function groupByNetwork(channels: FacilitatorChannel[]): Map<Network, FacilitatorChannel[]> {
  const groups = new Map<Network, FacilitatorChannel[]>();
  for (const channel of channels) {
    const list = groups.get(channel.network) ?? [];
    list.push(channel);
    groups.set(channel.network, list);
  }
  return groups;
}
