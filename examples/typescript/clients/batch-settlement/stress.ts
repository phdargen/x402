import { PERMIT2_ADDRESS, toClientEvmSigner } from "@x402/evm";
import { config as loadDotenv } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWalletClient, erc20Abi, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createBaseSepoliaClient, snapshotBacklog, type BacklogChannel } from "./stress/chain";
import { AtomicBudget } from "./stress/budget";
import { StressChannel, type StressServerConfig } from "./stress/channel";
import { loadConfig, tokenKeyForChannel, type StressConfig } from "./stress/config";
import { StressFailureRecorder } from "./stress/failures";
import { ChannelSampler, exponentialIntervalMs, sleep } from "./stress/random";
import { distributionReport, formatAtomic, formatTokenAtomic, StressStats } from "./stress/stats";

loadDotenv();

/**
 * Batch-settlement stress client.
 *
 * One funded payer, many channels. Channel `i` has its own unfunded voucher signer
 * (derived from the seed) and salt `i`, so a single `EVM_PRIVATE_KEY` can hold thousands of
 * distinct channels. It runs an open-loop steady phase with Poisson arrivals that gradually
 * opens channels, then takes one onchain backlog snapshot for the report.
 */

const PENDING_GRACE_MS = 120_000;
const SLEEP_SLICE_MS = 100;
const SAMPLE_PREVIEW = 5;

let stopRequested = false;
let sigintCount = 0;

/**
 * First Ctrl-C stops sending and snapshots the remaining backlog.
 * A second Ctrl-C exits immediately.
 */
function installSignalHandler(): void {
  process.on("SIGINT", () => {
    sigintCount += 1;
    if (sigintCount >= 2) {
      console.log("\nSecond interrupt: exiting immediately.");
      process.exit(130);
    }
    console.log(
      "\nInterrupt: stopping the load and reporting backlog. Press again to exit immediately.",
    );
    stopRequested = true;
  });
}

/**
 * Fetches the receiver and token set published by the stress server.
 *
 * @param baseUrl - Stress server base URL.
 * @returns The server configuration.
 */
async function fetchServerConfig(baseUrl: string): Promise<StressServerConfig> {
  const response = await fetch(`${baseUrl}/stress/config`);
  if (!response.ok) {
    throw new Error(`GET ${baseUrl}/stress/config failed with HTTP ${response.status}`);
  }
  return (await response.json()) as StressServerConfig;
}

/**
 * Sleeps until `deadline`, waking early if a stop was requested.
 *
 * @param deadline - Target time from `performance.now()`.
 */
async function sleepUntil(deadline: number): Promise<void> {
  for (;;) {
    const remaining = deadline - performance.now();
    if (remaining <= 0 || stopRequested) return;
    await sleep(Math.min(SLEEP_SLICE_MS, remaining));
  }
}

/**
 * Picks a channel that is not already in flight, retrying a few draws.
 *
 * @param channels - All channels.
 * @param sampler - Hot/cold channel sampler.
 * @param openedOnly - Whether to select only channels that already have a deposit.
 * @returns A free channel, or undefined if every draw hit a busy channel.
 */
function pickFreeChannel(
  channels: StressChannel[],
  sampler: ChannelSampler,
  openedOnly: boolean,
): StressChannel | undefined {
  for (let attempt = 0; attempt < (openedOnly ? 20 : 5); attempt++) {
    const channel = channels[sampler.next()];
    if (!channel.exhausted && !channel.busy && (!openedOnly || channel.opened)) return channel;
  }
  if (openedOnly) {
    const startIndex = Math.floor(Math.random() * channels.length);
    for (let offset = 0; offset < channels.length; offset++) {
      const channel = channels[(startIndex + offset) % channels.length];
      if (!channel.exhausted && !channel.busy && channel.opened) return channel;
    }
  }
  return undefined;
}

/**
 * Picks an unopened channel in round-robin order.
 *
 * @param channels - All channels.
 * @param startIndex - Index at which to begin scanning.
 * @returns A free unopened channel and the next scan index.
 */
function pickFreeUnopenedChannel(
  channels: StressChannel[],
  startIndex: number,
): { channel: StressChannel; nextIndex: number } | undefined {
  for (let offset = 0; offset < channels.length; offset++) {
    const index = (startIndex + offset) % channels.length;
    const channel = channels[index];
    if (!channel.exhausted && !channel.busy && !channel.opened) {
      return { channel, nextIndex: (index + 1) % channels.length };
    }
  }
  return undefined;
}

/**
 * Returns how many channels are either open or currently opening.
 *
 * @param channels - All channels.
 * @returns Number of started channels.
 */
function startedChannelCount(channels: StressChannel[]): number {
  return channels.filter(channel => channel.opened || channel.busy).length;
}

/**
 * Returns how many initial deposits are currently in flight.
 *
 * @param channels - All channels.
 * @returns Number of opening requests in flight.
 */
function openingChannelCount(channels: StressChannel[]): number {
  return channels.filter(channel => !channel.exhausted && !channel.opened && channel.busy).length;
}

/**
 * Computes the number of channels that should have been started by this point in the ramp.
 *
 * @param elapsedMs - Milliseconds since the steady phase started.
 * @param durationMs - Duration of the steady phase.
 * @param totalChannels - Total configured channels.
 * @returns Target number of started channels.
 */
function openingTargetCount(elapsedMs: number, durationMs: number, totalChannels: number): number {
  if (durationMs <= 0) return totalChannels;
  return Math.min(totalChannels, Math.max(1, Math.ceil((elapsedMs / durationMs) * totalChannels)));
}

/**
 * Open-loop Poisson arrivals. New channels are opened progressively over the steady
 * phase, while arrivals otherwise use already-open channels. The schedule never waits for
 * responses, so a slow facilitator shows up as dropped or late arrivals instead of a silently
 * reduced rate.
 *
 * @param channels - All channels.
 * @param cfg - Stress configuration.
 * @param stats - Shared stats.
 * @returns The promises of requests still in flight when the phase ended.
 */
async function steadyPhase(
  channels: StressChannel[],
  cfg: StressConfig,
  stats: StressStats,
): Promise<Set<Promise<void>>> {
  console.log(
    `Steady phase: interleaved load at ${cfg.rps}/s for ${Math.round(cfg.durationMs / 1000)}s ` +
      `(ramping ${channels.length} channels, max initial-deposit concurrency ${cfg.openConcurrency}; ` +
      `hot ${Math.round(cfg.hotShare * 100)}%, zipf s=${cfg.zipfS}, max inflight ${cfg.maxInflight}, ` +
      `refund probability ${cfg.refundProbability}, fraction ${cfg.refundFraction})`,
  );
  const sampler = new ChannelSampler(channels.length, cfg.hotShare, cfg.zipfS);
  const pending = new Set<Promise<void>>();
  let nextUnopenedIndex = 0;
  const startedAt = performance.now();
  const endAt = performance.now() + cfg.durationMs;
  let nextAt = performance.now();

  while (!stopRequested) {
    nextAt += exponentialIntervalMs(cfg.rps);
    if (nextAt >= endAt) break;
    await sleepUntil(nextAt);
    if (stopRequested) break;
    // When the loop is behind schedule, still yield so responses and timers can run.
    if (nextAt <= performance.now()) await sleep(0);

    stats.recordOffered();
    if (stats.inflightCount >= cfg.maxInflight) {
      stats.recordSkippedInflight();
      continue;
    }

    const elapsedMs = performance.now() - startedAt;
    const targetStarted = openingTargetCount(elapsedMs, cfg.durationMs, channels.length);
    const canStartOpening = openingChannelCount(channels) < cfg.openConcurrency;
    let channel: StressChannel | undefined;

    if (startedChannelCount(channels) < targetStarted && canStartOpening) {
      const candidate = pickFreeUnopenedChannel(channels, nextUnopenedIndex);
      if (candidate) {
        channel = candidate.channel;
        nextUnopenedIndex = candidate.nextIndex;
      }
    }
    if (!channel) {
      channel = pickFreeChannel(channels, sampler, true);
    }
    // Keep arrivals flowing while the first deposits are still confirming. This is also a
    // fallback when all currently-open channels are busy.
    if (!channel && canStartOpening) {
      const candidate = pickFreeUnopenedChannel(channels, nextUnopenedIndex);
      if (candidate) {
        channel = candidate.channel;
        nextUnopenedIndex = candidate.nextIndex;
      }
    }
    if (!channel) {
      if (channels.every(candidate => candidate.exhausted)) {
        stats.recordSkippedBudget();
      } else {
        stats.recordSkippedBusy();
      }
      continue;
    }
    channel.busy = true;
    stats.adjustInflight(1);
    const request: Promise<void> = channel
      .pay()
      .then(async outcome => {
        if (outcome.ok && outcome.kind === "voucher" && Math.random() < cfg.refundProbability) {
          await channel.requestPartialRefund(cfg.refundFraction, cfg.refundMinAtomic);
        }
      })
      .then(() => undefined)
      .finally(() => {
        channel.busy = false;
        stats.adjustInflight(-1);
        pending.delete(request);
      });
    pending.add(request);
  }
  const opened = channels.filter(channel => channel.opened).length;
  console.log(`Steady phase ended with ${opened}/${channels.length} channels opened`);
  return pending;
}

/**
 * Waits for in-flight requests, bounded so a stuck request cannot hang the run.
 *
 * @param pending - In-flight request promises.
 */
async function settlePending(pending: Set<Promise<void>>): Promise<void> {
  if (pending.size === 0) return;
  console.log(`Waiting for ${pending.size} in-flight requests...`);
  await Promise.race([Promise.allSettled([...pending]), sleep(PENDING_GRACE_MS)]);
}

/**
 * Collects channels with locally charged payments for one final onchain backlog read.
 *
 * @param channels - All stress channels.
 * @returns Charged channels suitable for an onchain snapshot.
 */
async function collectBacklogChannels(channels: StressChannel[]): Promise<BacklogChannel[]> {
  const backlogChannels: BacklogChannel[] = [];
  for (const channel of channels) {
    const state = await channel.chargedState();
    if (state && state.charged > 0n) {
      backlogChannels.push({
        channelId: state.channelId,
        receiver: channel.receiver,
        tokenKey: channel.token.key,
        tokenAsset: channel.token.asset,
        charged: state.charged,
      });
    }
  }
  return backlogChannels;
}

/**
 * Reads the server-side verify/settle failure reasons.
 *
 * @param baseUrl - Stress server base URL.
 * @returns The server stats, or an error note.
 */
async function fetchServerStats(baseUrl: string): Promise<unknown> {
  try {
    const response = await fetch(`${baseUrl}/stress/stats`);
    return response.ok ? await response.json() : { error: `HTTP ${response.status}` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Prints a compact version of the final report.
 *
 * @param report - The full report object.
 */
function printReport(report: Record<string, Record<string, unknown>>): void {
  const line = "=".repeat(80);
  console.log(`\n${line}\nSTRESS CLIENT REPORT\n${line}`);
  for (const name of ["steady", "overall"]) {
    const phase = (name === "overall" ? report.overall : report.phases[name]) as Record<
      string,
      unknown
    >;
    console.log(
      `${name.padEnd(8)} ${String(phase.durationSecs)}s offered=${String(phase.offeredPerSec)}/s ` +
        `achieved=${String(phase.achievedPerSec)}/s deposits=${String(phase.depositsPerSec)}/s ` +
        `topups=${String(phase.topupsPerSec)}/s vouchers=${String(phase.vouchersPerSec)}/s ` +
        `refunds=${String(phase.refundsPerSec)}/s refundFailures=${String(phase.refundFailuresPerSec)}/s ` +
        `failures=${String(phase.failuresPerSec)}/s skippedBusy=${String(phase.skippedBusy)} ` +
        `skippedInflight=${String(phase.skippedInflight)} skippedBudget=${String(phase.skippedBudget)} ` +
        `corrective402=${String(phase.corrective402)}`,
    );
    console.log(
      `         charged ${JSON.stringify(phase.charged)} (${JSON.stringify(phase.chargedPerSec)} per s)`,
    );
    console.log(`         latency ${JSON.stringify(phase.latency)}`);
    const errors = phase.errors as Record<string, number>;
    for (const [reason, count] of Object.entries(errors).slice(0, SAMPLE_PREVIEW)) {
      console.log(`         error x${count}: ${reason}`);
    }
  }
  console.log(`endBacklog ${JSON.stringify(report.endBacklog)}`);
  console.log(`errors    ${JSON.stringify(report.errors)}`);
  console.log(`channels ${JSON.stringify(report.distribution)}`);
  console.log(line);
}

/**
 * Runs the steady phase, takes one end-of-run backlog snapshot, and writes the report.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  installSignalHandler();

  const serverConfig = await fetchServerConfig(cfg.baseUrl);
  const tokens = new Map(serverConfig.tokens.map(token => [token.key, token]));

  const account = privateKeyToAccount(cfg.evmPrivateKey);
  const publicClient = createBaseSepoliaClient(cfg.rpcUrl);
  const payer = toClientEvmSigner(account, publicClient);
  const stats = new StressStats();
  const failureRecorder = new StressFailureRecorder(cfg.reportDir);
  const maxAmountsAtomic = serverConfig.maxAmountAtomicByToken ?? {
    usdc: serverConfig.maxAmountAtomic,
    cbbtc: serverConfig.maxAmountAtomic,
  };
  const usdcDepositAtomic = BigInt(maxAmountsAtomic.usdc) * BigInt(cfg.depositMultiplier);
  const cbbtcDepositAtomic = BigInt(maxAmountsAtomic.cbbtc) * BigInt(cfg.depositMultiplier);
  const cbbtcChannelCount = Array.from({ length: cfg.channels }, (_, index) =>
    tokenKeyForChannel(index, cfg.cbbtcShare),
  ).filter(token => token === "cbbtc").length;
  const maximumCbbtcDeposits = cbbtcDepositAtomic * BigInt(cbbtcChannelCount);
  if (maximumCbbtcDeposits > cfg.cbbtcBudgetAtomic) {
    throw new Error(
      `cbBTC deposit budget exceeded: worst-case initial deposits are ` +
        `${maximumCbbtcDeposits} atomic units, budget is ${cfg.cbbtcBudgetAtomic}`,
    );
  }
  const cbbtcBudget = new AtomicBudget(cfg.cbbtcBudgetAtomic);
  const cbbtcToken = tokens.get("cbbtc");
  if (cbbtcChannelCount > 0 && cbbtcToken) {
    const allowance = await publicClient.readContract({
      address: cbbtcToken.asset,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, PERMIT2_ADDRESS],
    });
    if (allowance < cfg.cbbtcBudgetAtomic) {
      const walletClient = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http(cfg.rpcUrl),
      });
      console.log(
        `Approving ${formatTokenAtomic("cbbtc", cfg.cbbtcBudgetAtomic)} cbBTC for Permit2...`,
      );
      const approvalHash = await walletClient.writeContract({
        account,
        address: cbbtcToken.asset,
        abi: erc20Abi,
        functionName: "approve",
        args: [PERMIT2_ADDRESS, cfg.cbbtcBudgetAtomic],
      });
      await publicClient.waitForTransactionReceipt({ hash: approvalHash });
    }
  }

  const channels = Array.from({ length: cfg.channels }, (_, index) => {
    const receiverIndex = index % serverConfig.receivers.length;
    const token = tokens.get(tokenKeyForChannel(index, cfg.cbbtcShare));
    if (!token) throw new Error("server config is missing a stress token");
    return new StressChannel(index, {
      seed: cfg.seed,
      baseUrl: cfg.baseUrl,
      receiverIndex,
      receiver: serverConfig.receivers[receiverIndex],
      token,
      payer,
      maxAmountAtomic: maxAmountsAtomic[token.key],
      depositMultiplier: cfg.depositMultiplier,
      depositBudget: token.key === "cbbtc" ? cbbtcBudget : undefined,
      failureRecorder,
      stats,
    });
  });

  const cbbtcChannels = channels.filter(channel => channel.token.key === "cbbtc").length;
  console.log(`Stress server: ${cfg.baseUrl} (${serverConfig.receivers.length} receivers)`);
  console.log(`Payer: ${account.address}`);
  console.log(
    `Channels: ${cfg.channels} (${cbbtcChannels} cbBTC), worst-case deposit per channel ` +
      `${formatAtomic(usdcDepositAtomic, tokens.get("usdc")?.decimals ?? 6)} USDC or ` +
      `${formatTokenAtomic("cbbtc", cbbtcDepositAtomic)} cbBTC; max cbBTC budget ` +
      `${formatTokenAtomic("cbbtc", cfg.cbbtcBudgetAtomic)} cbBTC`,
  );
  for (const token of serverConfig.tokens) {
    const balance = await publicClient.readContract({
      address: token.asset,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    console.log(`  ${token.symbol} balance: ${formatAtomic(balance, token.decimals)}`);
  }

  const startedAt = new Date();
  const progress = setInterval(() => console.log(stats.progressLine()), cfg.progressIntervalMs);

  let endBacklog: Record<string, unknown> = { error: "not sampled" };
  try {
    const pending = stopRequested
      ? new Set<Promise<void>>()
      : await steadyPhase(channels, cfg, stats);
    await settlePending(pending);
    stats.endPhase();
    try {
      const backlogChannels = await collectBacklogChannels(channels);
      endBacklog = await snapshotBacklog(publicClient, backlogChannels);
    } catch (error) {
      endBacklog = { error: error instanceof Error ? error.message : String(error) };
    }
  } finally {
    clearInterval(progress);
  }

  const report = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    config: {
      baseUrl: cfg.baseUrl,
      channels: cfg.channels,
      rps: cfg.rps,
      durationMs: cfg.durationMs,
      openConcurrency: cfg.openConcurrency,
      maxInflight: cfg.maxInflight,
      cbbtcShare: cfg.cbbtcShare,
      cbbtcBudgetAtomic: cfg.cbbtcBudgetAtomic.toString(),
      cbbtcReservedAtomic: cbbtcBudget.reserved.toString(),
      hotShare: cfg.hotShare,
      zipfS: cfg.zipfS,
      depositMultiplier: cfg.depositMultiplier,
      refundProbability: cfg.refundProbability,
      refundFraction: cfg.refundFraction,
      refundMinAtomic: cfg.refundMinAtomic.toString(),
      maxAmountAtomicByToken: maxAmountsAtomic,
      receivers: serverConfig.receivers.length,
      payer: account.address,
    },
    phases: stats.phaseReports(),
    overall: stats.overallReport(),
    distribution: distributionReport(channels.map(channel => channel.successes)),
    endBacklog,
    errors: stats.failureReport(),
    failureLog: failureRecorder.path,
    server: await fetchServerStats(cfg.baseUrl),
  };
  printReport(report as unknown as Record<string, Record<string, unknown>>);

  mkdirSync(cfg.reportDir, { recursive: true });
  const path = join(cfg.reportDir, `batch-settlement-stress-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(`JSON report written to ${path}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
