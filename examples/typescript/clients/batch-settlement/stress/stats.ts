export type PhaseName = "steady";
export type RequestKind = "deposit" | "topup" | "voucher";
export type FailureKind = RequestKind | "refund";
export type TokenKey = "usdc" | "cbbtc";

const KINDS: RequestKind[] = ["deposit", "topup", "voucher"];
const TOKENS: TokenKey[] = ["usdc", "cbbtc"];
const TOKEN_DECIMALS: Record<TokenKey, number> = { usdc: 6, cbbtc: 8 };
const PERCENTILES = [50, 95, 99] as const;

type PhaseStats = {
  startedAt: number;
  endedAt: number | undefined;
  offered: number;
  skippedBusy: number;
  skippedInflight: number;
  skippedBudget: number;
  ok: Record<RequestKind, number>;
  failed: number;
  corrective402: number;
  errors: Map<string, number>;
  refunds: number;
  refundFailures: number;
  refundSkipped: number;
  refundErrors: Map<string, number>;
  charged: Record<TokenKey, bigint>;
  latencyMs: Record<RequestKind, number[]>;
  refundLatencyMs: number[];
};

export type FailureEvent = {
  ts: number;
  token: TokenKey;
  kind: FailureKind;
  channelIndex: number;
  reason: string;
};

export type ProgressSnapshot = {
  offered: number;
  ok: number;
  deposits: number;
  topups: number;
  vouchers: number;
  refunds: number;
  refundFailures: number;
  failed: number;
};

type ChannelFailureSummary = {
  channelIndex: number;
  token: TokenKey;
  count: number;
  reasons: Record<string, number>;
};

/**
 * Computes a percentile with the nearest-rank method.
 *
 * @param sorted - Ascending sorted samples.
 * @param percentile - Percentile in [0, 100].
 * @returns The percentile value, or 0 for no samples.
 */
export function percentile(sorted: number[], percentile: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * Creates empty stats for one phase.
 *
 * @param now - Phase start time in milliseconds.
 * @returns Zeroed phase stats.
 */
function emptyPhase(now: number): PhaseStats {
  return {
    startedAt: now,
    endedAt: undefined,
    offered: 0,
    skippedBusy: 0,
    skippedInflight: 0,
    skippedBudget: 0,
    ok: { deposit: 0, topup: 0, voucher: 0 },
    failed: 0,
    corrective402: 0,
    errors: new Map(),
    refunds: 0,
    refundFailures: 0,
    refundSkipped: 0,
    refundErrors: new Map(),
    charged: { usdc: 0n, cbbtc: 0n },
    latencyMs: { deposit: [], topup: [], voucher: [] },
    refundLatencyMs: [],
  };
}

/**
 * Formats an atomic amount as a decimal string.
 *
 * @param atomic - Atomic amount.
 * @param decimals - Number of fractional digits.
 * @returns Decimal string with the requested fractional digits.
 */
export function formatAtomic(atomic: bigint, decimals = 6): string {
  const scale = 10n ** BigInt(decimals);
  const whole = atomic / scale;
  const fraction = (atomic % scale).toString().padStart(decimals, "0");
  return `${whole}.${fraction}`;
}

/**
 * Formats an atomic amount using the decimals of a stress token.
 *
 * @param token - Stress token key.
 * @param atomic - Atomic amount.
 * @returns Decimal string.
 */
export function formatTokenAtomic(token: TokenKey, atomic: bigint): string {
  return formatAtomic(atomic, TOKEN_DECIMALS[token]);
}

/**
 * Collects request outcomes, rates and latencies across the steady phase.
 */
export class StressStats {
  private current: PhaseName = "steady";
  private readonly phases: Record<PhaseName, PhaseStats>;
  private readonly errorsByToken: Record<TokenKey, number> = { usdc: 0, cbbtc: 0 };
  private readonly errorsByKind: Record<FailureKind, number> = {
    deposit: 0,
    topup: 0,
    voucher: 0,
    refund: 0,
  };
  private readonly errorsByChannel = new Map<number, ChannelFailureSummary>();
  private readonly errorTimeline = new Map<
    number,
    { errors: number; byToken: Record<TokenKey, number>; byKind: Record<FailureKind, number> }
  >();
  private inflight = 0;
  private lastProgress: ProgressSnapshot = {
    offered: 0,
    ok: 0,
    deposits: 0,
    topups: 0,
    vouchers: 0,
    refunds: 0,
    refundFailures: 0,
    failed: 0,
  };
  private lastProgressAt = Date.now();

  /**
   * Starts the clock on the steady phase.
   */
  constructor() {
    const now = Date.now();
    this.phases = { steady: emptyPhase(now) };
  }

  /**
   * Returns the number of requests currently in flight.
   *
   * @returns In-flight count.
   */
  get inflightCount(): number {
    return this.inflight;
  }

  /**
   * Switches the active phase.
   *
   * @param phase - Phase that begins now.
   */
  startPhase(phase: PhaseName): void {
    const now = Date.now();
    this.phases[this.current].endedAt ??= now;
    this.current = phase;
    this.phases[phase] = emptyPhase(now);
  }

  /**
   * Stamps the end of the active phase.
   */
  endPhase(): void {
    this.phases[this.current].endedAt ??= Date.now();
  }

  /**
   * Tracks the number of requests currently in flight.
   *
   * @param delta - +1 when a request starts, -1 when it ends.
   */
  adjustInflight(delta: number): void {
    this.inflight += delta;
  }

  /**
   * Records an arrival the load generator tried to send.
   */
  recordOffered(): void {
    this.phases[this.current].offered += 1;
  }

  /**
   * Records an arrival dropped because its channel was busy.
   */
  recordSkippedBusy(): void {
    this.phases[this.current].skippedBusy += 1;
  }

  /**
   * Records an arrival dropped because the in-flight cap was reached.
   */
  recordSkippedInflight(): void {
    this.phases[this.current].skippedInflight += 1;
  }

  /**
   * Records an arrival skipped because its token budget was exhausted.
   */
  recordSkippedBudget(): void {
    this.phases[this.current].skippedBudget += 1;
  }

  /**
   * Records a corrective 402, where the server answered a paid request with fresh channel state.
   */
  recordCorrective402(): void {
    this.phases[this.current].corrective402 += 1;
  }

  /**
   * Records a paid request that completed successfully.
   *
   * @param kind - Deposit, top-up or voucher.
   * @param latencyMs - Latency of the paid HTTP leg (server verify + settle).
   * @param token - Token charged.
   * @param charged - Amount charged by the server for this request.
   */
  recordSuccess(kind: RequestKind, latencyMs: number, token: TokenKey, charged: bigint): void {
    const phase = this.phases[this.current];
    phase.ok[kind] += 1;
    phase.latencyMs[kind].push(latencyMs);
    phase.charged[token] += charged;
  }

  /**
   * Records a failed paid request.
   *
   * @param event - Failure details, including token, kind and channel.
   */
  recordFailure(event: FailureEvent): void {
    const phase = this.phases[this.current];
    if (event.kind === "refund") {
      phase.refundFailures += 1;
      phase.refundErrors.set(event.reason, (phase.refundErrors.get(event.reason) ?? 0) + 1);
    } else {
      phase.failed += 1;
      phase.errors.set(event.reason, (phase.errors.get(event.reason) ?? 0) + 1);
    }
    this.errorsByToken[event.token] += 1;
    this.errorsByKind[event.kind] += 1;
    const channel = this.errorsByChannel.get(event.channelIndex) ?? {
      channelIndex: event.channelIndex,
      token: event.token,
      count: 0,
      reasons: {},
    };
    channel.count += 1;
    channel.reasons[event.reason] = (channel.reasons[event.reason] ?? 0) + 1;
    this.errorsByChannel.set(event.channelIndex, channel);

    const minute = Math.floor(event.ts / 60_000) * 60_000;
    const timeline = this.errorTimeline.get(minute) ?? {
      errors: 0,
      byToken: { usdc: 0, cbbtc: 0 },
      byKind: { deposit: 0, topup: 0, voucher: 0, refund: 0 },
    };
    timeline.errors += 1;
    timeline.byToken[event.token] += 1;
    timeline.byKind[event.kind] += 1;
    this.errorTimeline.set(minute, timeline);
  }

  /**
   * Records a successful cooperative refund.
   *
   * @param latencyMs - Paid refund HTTP-leg latency.
   */
  recordRefundSuccess(latencyMs: number): void {
    const phase = this.phases[this.current];
    phase.refunds += 1;
    phase.refundLatencyMs.push(latencyMs);
  }

  /**
   * Records a failed cooperative refund.
   *
   * @param reason - Normalized, bounded failure reason.
   */
  recordRefundFailure(reason: string): void {
    const phase = this.phases[this.current];
    phase.refundFailures += 1;
    phase.refundErrors.set(reason, (phase.refundErrors.get(reason) ?? 0) + 1);
  }

  /**
   * Records a refund skipped because the channel had no usable refundable balance.
   */
  recordRefundSkipped(): void {
    this.phases[this.current].refundSkipped += 1;
  }

  /**
   * Builds the periodic progress line with rolling rates since the previous line.
   *
   * @returns A one-line progress summary.
   */
  progressLine(): string {
    const now = Date.now();
    const seconds = Math.max((now - this.lastProgressAt) / 1000, 0.001);
    const totals = this.totals();
    const last = this.lastProgress;
    const rate = (current: number, previous: number): string =>
      ((current - previous) / seconds).toFixed(2);
    this.lastProgress = totals;
    this.lastProgressAt = now;
    const phase = this.phases[this.current];
    return (
      `[${this.current}] offered=${rate(totals.offered, last.offered)}/s ` +
      `achieved=${rate(totals.ok, last.ok)}/s deposits=${rate(totals.deposits, last.deposits)}/s ` +
      `topups=${rate(totals.topups, last.topups)}/s vouchers=${rate(totals.vouchers, last.vouchers)}/s ` +
      `refunds=${rate(totals.refunds, last.refunds)}/s ` +
      `refundFailures=${rate(totals.refundFailures, last.refundFailures)}/s ` +
      `failures=${rate(totals.failed, last.failed)}/s inflight=${this.inflight} ` +
      `(total ok=${totals.ok} failed=${totals.failed} skippedBusy=${phase.skippedBusy} ` +
      `skippedInflight=${phase.skippedInflight} skippedBudget=${phase.skippedBudget})`
    );
  }

  /**
   * Builds the per-phase report with rates, latencies and errors.
   *
   * @returns A JSON-serializable phase report keyed by phase name.
   */
  phaseReports(): Record<PhaseName, Record<string, unknown>> {
    const report = {} as Record<PhaseName, Record<string, unknown>>;
    for (const name of ["steady"] as PhaseName[]) {
      report[name] = this.phaseReport(this.phases[name]);
    }
    return report;
  }

  /**
   * Builds a report that merges all recorded phases.
   *
   * @returns A JSON-serializable overall report.
   */
  overallReport(): Record<string, unknown> {
    const merged = emptyPhase(Math.min(...Object.values(this.phases).map(p => p.startedAt)));
    merged.endedAt = Math.max(...Object.values(this.phases).map(p => p.endedAt ?? Date.now()));
    for (const phase of Object.values(this.phases)) {
      merged.offered += phase.offered;
      merged.skippedBusy += phase.skippedBusy;
      merged.skippedInflight += phase.skippedInflight;
      merged.skippedBudget += phase.skippedBudget;
      merged.failed += phase.failed;
      merged.corrective402 += phase.corrective402;
      merged.refunds += phase.refunds;
      merged.refundFailures += phase.refundFailures;
      merged.refundSkipped += phase.refundSkipped;
      for (const kind of KINDS) {
        merged.ok[kind] += phase.ok[kind];
        merged.latencyMs[kind].push(...phase.latencyMs[kind]);
      }
      for (const token of TOKENS) {
        merged.charged[token] += phase.charged[token];
      }
      for (const [reason, count] of phase.errors) {
        merged.errors.set(reason, (merged.errors.get(reason) ?? 0) + count);
      }
      merged.refundLatencyMs.push(...phase.refundLatencyMs);
      for (const [reason, count] of phase.refundErrors) {
        merged.refundErrors.set(reason, (merged.refundErrors.get(reason) ?? 0) + count);
      }
    }
    return this.phaseReport(merged);
  }

  /**
   * Returns bounded failure aggregates suitable for the JSON report.
   *
   * @returns Failure totals grouped by token, kind, channel and minute.
   */
  failureReport(): Record<string, unknown> {
    const topChannels = [...this.errorsByChannel.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    const timeline = [...this.errorTimeline.entries()]
      .sort(([a], [b]) => a - b)
      .map(([minute, value]) => ({
        minute: new Date(minute).toISOString(),
        ...value,
      }));
    return {
      byToken: { ...this.errorsByToken },
      byKind: { ...this.errorsByKind },
      topChannels,
      timeline,
    };
  }

  /**
   * Returns the cumulative counters for the active phase.
   *
   * @returns Current totals.
   */
  private totals(): ProgressSnapshot {
    const phase = this.phases[this.current];
    return {
      offered: phase.offered,
      ok: phase.ok.deposit + phase.ok.topup + phase.ok.voucher,
      deposits: phase.ok.deposit,
      topups: phase.ok.topup,
      vouchers: phase.ok.voucher,
      refunds: phase.refunds,
      refundFailures: phase.refundFailures,
      failed: phase.failed,
    };
  }

  /**
   * Builds the report for one phase.
   *
   * @param phase - Phase stats.
   * @returns A JSON-serializable report.
   */
  private phaseReport(phase: PhaseStats): Record<string, unknown> {
    const seconds = Math.max(((phase.endedAt ?? Date.now()) - phase.startedAt) / 1000, 0.001);
    const okTotal = phase.ok.deposit + phase.ok.topup + phase.ok.voucher;
    const latency: Record<string, Record<string, number>> = {};
    for (const kind of KINDS) {
      const sorted = [...phase.latencyMs[kind]].sort((a, b) => a - b);
      latency[kind] = { count: sorted.length };
      for (const p of PERCENTILES) {
        latency[kind][`p${p}Ms`] = Math.round(percentile(sorted, p));
      }
    }
    const sortedRefundLatency = [...phase.refundLatencyMs].sort((a, b) => a - b);
    const refundLatency: Record<string, number> = { count: sortedRefundLatency.length };
    for (const p of PERCENTILES) {
      refundLatency[`p${p}Ms`] = Math.round(percentile(sortedRefundLatency, p));
    }
    const chargedPerSecond: Record<string, string> = {};
    const charged: Record<string, string> = {};
    for (const token of TOKENS) {
      charged[token] = formatTokenAtomic(token, phase.charged[token]);
      chargedPerSecond[token] = formatTokenAtomic(
        token,
        BigInt(Math.round(Number(phase.charged[token]) / seconds)),
      );
    }
    return {
      durationSecs: Number(seconds.toFixed(1)),
      offered: phase.offered,
      offeredPerSec: Number((phase.offered / seconds).toFixed(3)),
      achieved: okTotal,
      achievedPerSec: Number((okTotal / seconds).toFixed(3)),
      depositsPerSec: Number((phase.ok.deposit / seconds).toFixed(3)),
      topupsPerSec: Number((phase.ok.topup / seconds).toFixed(3)),
      vouchersPerSec: Number((phase.ok.voucher / seconds).toFixed(3)),
      failuresPerSec: Number((phase.failed / seconds).toFixed(3)),
      refundsPerSec: Number((phase.refunds / seconds).toFixed(3)),
      refundFailuresPerSec: Number((phase.refundFailures / seconds).toFixed(3)),
      requests: { ...phase.ok },
      failed: phase.failed,
      skippedBusy: phase.skippedBusy,
      skippedInflight: phase.skippedInflight,
      corrective402: phase.corrective402,
      refunds: phase.refunds,
      refundFailures: phase.refundFailures,
      refundSkipped: phase.refundSkipped,
      skippedBudget: phase.skippedBudget,
      latency,
      refundLatency,
      charged,
      chargedPerSec: chargedPerSecond,
      errors: Object.fromEntries([...phase.errors.entries()].sort((a, b) => b[1] - a[1])) as Record<
        string,
        number
      >,
      refundErrors: Object.fromEntries(
        [...phase.refundErrors.entries()].sort((a, b) => b[1] - a[1]),
      ) as Record<string, number>,
    };
  }
}

/**
 * Summarizes how requests spread across channels.
 *
 * @param counts - Successful request count per channel.
 * @returns Distribution statistics.
 */
export function distributionReport(counts: number[]): Record<string, unknown> {
  const sorted = [...counts].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const topShare = (fraction: number): number => {
    const take = Math.max(1, Math.ceil(sorted.length * fraction));
    const top = sorted.slice(sorted.length - take).reduce((sum, value) => sum + value, 0);
    return total === 0 ? 0 : Number((top / total).toFixed(3));
  };
  return {
    channels: sorted.length,
    totalRequests: total,
    averagePaymentsPerChannel: sorted.length === 0 ? 0 : Number((total / sorted.length).toFixed(3)),
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    max: sorted[sorted.length - 1] ?? 0,
    zeroRequestChannels: sorted.filter(value => value === 0).length,
    top1PercentShare: topShare(0.01),
    top10PercentShare: topShare(0.1),
  };
}
