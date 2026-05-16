"use client";

import { useEffect, useMemo, useState } from "react";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import type { Account, WalletClient } from "viem";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import type { ChannelConfig } from "@x402/evm";
import { BATCH_SETTLEMENT_ADDRESS } from "@x402/evm";
import { BatchSettlementEvmScheme, computeChannelId } from "@x402/evm/batch-settlement/client";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import {
  JUMP_PRICE,
  MAX_PLAY_CREDITS,
  MIN_PLAY_CREDITS,
  NETWORK,
  NEXT_DEV,
  PLAY_PRICE,
  PLAY_PRICE_UNITS,
  RECEIVER_ADDRESS,
} from "@/lib/x402/config";
import { buildGameChannelConfig } from "@/lib/x402/channel";
import {
  createStoredSessionKey,
  loadStoredSessionKey,
  signerFromStoredSession,
  type StoredSessionKey,
} from "@/lib/x402/sessionKey";
import {
  availableChannelBalance,
  LocalStorageChannelStorage,
  TopUpChannelStorage,
  type BatchSettlementClientContext,
} from "@/lib/x402/browserStorage";
import type { ClientEvmSigner } from "@x402/evm";
import type { BaseAuthSession } from "./WalletConnect";

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(),
});

const channelsAbi = [
  {
    type: "function",
    name: "channels",
    stateMutability: "view",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [
      { name: "balance", type: "uint256" },
      { name: "totalClaimed", type: "uint256" },
    ],
  },
] as const;

const readContract = publicClient.readContract as (
  args: Record<string, unknown>,
) => Promise<unknown>;

function readChannelId(settleExtra: Record<string, unknown> | undefined): `0x${string}` | null {
  const channelState = settleExtra?.channelState;
  if (typeof channelState !== "object" || channelState === null) return null;

  const channelId = (channelState as { channelId?: unknown }).channelId;
  return typeof channelId === "string" && channelId.startsWith("0x")
    ? (channelId as `0x${string}`)
    : null;
}

function wagmiToClientSigner(walletClient: WalletClient): ClientEvmSigner {
  if (!walletClient.account) {
    throw new Error("Wallet client must have an account");
  }

  return {
    address: walletClient.account.address,
    signTypedData: message =>
      walletClient.signTypedData({
        account: walletClient.account as Account | `0x${string}`,
        domain: message.domain,
        types: message.types,
        primaryType: message.primaryType,
        message: message.message,
      }),
    readContract: args => readContract(args as unknown as Record<string, unknown>),
  };
}

export type SessionInfo = {
  channelSalt: `0x${string}`;
  sessionAddress: `0x${string}`;
  voucherSigner: ClientEvmSigner;
  playerAddress: `0x${string}`;
  channelId: `0x${string}` | null;
  channelConfig: ChannelConfig | null;
  channelBalance: bigint;
  chargedCumulativeAmount: bigint;
  roundBudget: bigint;
  storage: LocalStorageChannelStorage;
};

type DepositFlowProps = {
  authSession: BaseAuthSession;
  onSessionReady: (session: SessionInfo) => void;
};

type ChannelSnapshot = {
  channelId: `0x${string}` | null;
  channelConfig: ChannelConfig | null;
  balance: bigint;
  chargedCumulativeAmount: bigint;
  availableBalance: bigint;
};

export function DepositFlow({ authSession, onSessionReady }: DepositFlowProps) {
  const [storedSession, setStoredSession] = useState<StoredSessionKey | null>(null);
  const [snapshot, setSnapshot] = useState<ChannelSnapshot | null>(null);
  const [selectedCredits, setSelectedCredits] = useState(MIN_PLAY_CREDITS);
  const [status, setStatus] = useState<"loading" | "idle" | "depositing" | "refunding">("loading");
  const [error, setError] = useState<string | null>(null);

  const storage = useMemo(() => new LocalStorageChannelStorage(), []);
  const topUpStorage = useMemo(() => new TopUpChannelStorage(), []);

  const selectedDeposit = BigInt(selectedCredits) * PLAY_PRICE_UNITS;
  const hasChannel = Boolean(snapshot?.channelId && snapshot.channelConfig);
  const canStart = hasChannel && (NEXT_DEV || (snapshot?.availableBalance ?? 0n) >= PLAY_PRICE_UNITS);
  const { voucherSigner } = storedSession
    ? signerFromStoredSession(storedSession)
    : { voucherSigner: null };

  useEffect(() => {
    const existing = loadStoredSessionKey(authSession.address);
    const next = existing ?? createStoredSessionKey(authSession.address, authSession.signature);
    setStoredSession(next);
  }, [authSession.address, authSession.signature]);

  useEffect(() => {
    if (!storedSession) return;

    refreshChannel(storedSession)
      .catch(err => setError(err instanceof Error ? err.message : "Failed to load channel"))
      .finally(() => setStatus("idle"));
  }, [storedSession]);

  const startSession = () => {
    if (!storedSession || !voucherSigner) return;

    onSessionReady({
      channelSalt: storedSession.channelSalt,
      sessionAddress: storedSession.sessionAddress,
      voucherSigner,
      playerAddress: authSession.address,
      channelId: snapshot?.channelId ?? null,
      channelConfig: snapshot?.channelConfig ?? null,
      channelBalance: snapshot?.balance ?? PLAY_PRICE_UNITS,
      chargedCumulativeAmount: snapshot?.chargedCumulativeAmount ?? 0n,
      roundBudget: PLAY_PRICE_UNITS,
      storage,
    });
  };

  const fundChannel = async () => {
    if (!storedSession || !voucherSigner) return;

    setStatus("depositing");
    setError(null);

    try {
      const currentAvailable = snapshot?.availableBalance ?? 0n;
      const fundingStorage = currentAvailable > 0n ? topUpStorage : storage;
      const batchedScheme = createBatchedScheme(storedSession, fundingStorage, selectedDeposit);
      const client = new x402Client();
      client.register(NETWORK, batchedScheme);

      const fetchWithPayment = wrapFetchWithPayment(fetch, client);

      const response = await fetchWithPayment(`${window.location.origin}/api/game/start`, {
        method: "GET",
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Deposit failed (${response.status}): ${text}`);
      }

      await refreshChannel(storedSession, readSettledChannelId(response));
    } catch (err) {
      console.error("[batch-runner] Deposit error:", err);
      setError(err instanceof Error ? err.message : "Failed to deposit");
    } finally {
      setStatus("idle");
    }
  };

  const requestRefund = async () => {
    if (!storedSession) return;

    setStatus("refunding");
    setError(null);

    try {
      const batchedScheme = createBatchedScheme(storedSession, storage, selectedDeposit);
      await batchedScheme.refund(`${window.location.origin}/api/game/start`);
      await refreshChannel(storedSession);
    } catch (err) {
      console.error("[batch-runner] Refund error:", err);
      setError(err instanceof Error ? err.message : "Failed to request refund");
    } finally {
      setStatus("idle");
    }
  };

  async function refreshChannel(
    session: StoredSessionKey,
    knownChannelId?: `0x${string}` | null,
  ): Promise<void> {
    if (NEXT_DEV) {
      const debugChannel = getDebugChannel(session);
      setSnapshot({
        channelId: debugChannel?.channelId ?? null,
        channelConfig: debugChannel?.config ?? null,
        balance: PLAY_PRICE_UNITS,
        chargedCumulativeAmount: 0n,
        availableBalance: PLAY_PRICE_UNITS,
      });
      return;
    }

    const derivedChannel = await getChannelInfo(session);
    const channel = {
      channelId: knownChannelId ?? derivedChannel.channelId,
      channelConfig: derivedChannel.channelConfig,
    };
    if (!channel.channelId) {
      setSnapshot({
        channelId: null,
        channelConfig: null,
        balance: 0n,
        chargedCumulativeAmount: 0n,
        availableBalance: 0n,
      });
      return;
    }

    let context = await storage.get(channel.channelId);
    context = await recoverChannelContext(channel.channelId, context);

    setSnapshot({
      channelId: channel.channelId,
      channelConfig: channel.channelConfig,
      balance: BigInt(context?.balance ?? "0"),
      chargedCumulativeAmount: BigInt(context?.chargedCumulativeAmount ?? "0"),
      availableBalance: availableChannelBalance(context),
    });
  }

  async function getChannelInfo(
    session: StoredSessionKey,
  ): Promise<{ channelId: `0x${string}` | null; channelConfig: ChannelConfig | null }> {
    const requirements = await getGamePaymentRequirements();
    if (!requirements) return { channelId: null, channelConfig: null };

    const batchedScheme = createBatchedScheme(session, storage, selectedDeposit);
    const channelConfig = batchedScheme.buildChannelConfig(requirements);
    return { channelId: computeChannelId(channelConfig, requirements.network), channelConfig };
  }

  async function recoverChannelContext(
    channelId: `0x${string}`,
    context: BatchSettlementClientContext | undefined,
  ): Promise<BatchSettlementClientContext | undefined> {
    const [balance, totalClaimed] = (await readContract({
      address: BATCH_SETTLEMENT_ADDRESS,
      abi: channelsAbi,
      functionName: "channels",
      args: [channelId],
    })) as [bigint, bigint];

    if (balance === 0n && totalClaimed === 0n) return context;

    const recoveredCharged =
      BigInt(context?.chargedCumulativeAmount ?? "0") > totalClaimed
        ? context?.chargedCumulativeAmount
        : totalClaimed.toString();
    const next = {
      ...(context ?? {}),
      balance: balance.toString(),
      chargedCumulativeAmount: recoveredCharged,
      totalClaimed: totalClaimed.toString(),
    };
    await storage.set(channelId, next);
    return next;
  }

  function createBatchedScheme(
    session: StoredSessionKey,
    channelStorage: LocalStorageChannelStorage,
    depositAmount: bigint,
  ): BatchSettlementEvmScheme {
    const walletSigner = wagmiToClientSigner(authSession.walletClient);
    const { voucherSigner: sessionVoucherSigner } = signerFromStoredSession(session);

    return new BatchSettlementEvmScheme(walletSigner, {
      voucherSigner: sessionVoucherSigner,
      salt: session.channelSalt,
      storage: channelStorage,
      depositStrategy: () => depositAmount.toString(),
    });
  }

  const balanceFormatted = formatUsdc(snapshot?.availableBalance ?? 0n);
  const spentFormatted = formatUsdc(snapshot?.chargedCumulativeAmount ?? 0n);
  const selectedDepositFormatted = formatUsdc(selectedDeposit);

  return (
    <div
      className="animate-slide-up flex flex-col items-center gap-6 p-8 rounded-2xl
                    bg-[var(--color-surface-light)] border border-[var(--color-surface-lighter)]"
    >
      <div className="text-center">
        <h2 className="text-xl font-bold mb-2">Start a Game Session</h2>
        <p className="text-sm text-[var(--color-text-secondary)] max-w-xs leading-relaxed">
          {NEXT_DEV
            ? "Dev mode: deposit skipped. Base Account sign-in creates your session key."
            : `Deposit ${PLAY_PRICE} per play into your game channel. Each jump costs ${JUMP_PRICE} via a signed voucher.`}
        </p>
      </div>

      <div className="grid grid-cols-3 gap-4 text-center text-xs">
        <div className="p-3 rounded-lg bg-[var(--color-surface)]">
          <div className="text-[var(--color-base-blue)] font-bold text-lg">${balanceFormatted}</div>
          <div className="text-[var(--color-text-secondary)] mt-1">Remaining</div>
        </div>
        <div className="p-3 rounded-lg bg-[var(--color-surface)]">
          <div className="text-[var(--color-accent-green)] font-bold text-lg">${spentFormatted}</div>
          <div className="text-[var(--color-text-secondary)] mt-1">Spent</div>
        </div>
        <div className="p-3 rounded-lg bg-[var(--color-surface)]">
          <div className="text-[var(--color-accent-orange)] font-bold text-lg">{JUMP_PRICE}</div>
          <div className="text-[var(--color-text-secondary)] mt-1">Per jump</div>
        </div>
      </div>

      <label className="w-full max-w-xs text-xs text-[var(--color-text-secondary)]">
        Plays to deposit:{" "}
        <span className="font-bold text-white">
          {selectedCredits} (${selectedDepositFormatted})
        </span>
        <input
          type="range"
          min={MIN_PLAY_CREDITS}
          max={MAX_PLAY_CREDITS}
          value={selectedCredits}
          onChange={event => setSelectedCredits(Number(event.target.value))}
          className="mt-3 w-full accent-[var(--color-base-blue)]"
        />
      </label>

      <div className="flex flex-col sm:flex-row gap-3">
        <button
          onClick={fundChannel}
          disabled={
            NEXT_DEV ||
            status === "loading" ||
            status === "depositing" ||
            status === "refunding"
          }
          className="px-6 py-3 border border-[var(--color-base-blue)] text-[var(--color-base-blue)]
                     rounded-xl font-bold text-sm hover:bg-[var(--color-base-blue)]/10 transition-colors
                     disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {status === "depositing"
            ? "Depositing..."
            : `Deposit ${selectedCredits} Play${selectedCredits === 1 ? "" : "s"}`}
        </button>

        <button
          onClick={startSession}
          disabled={!canStart || status !== "idle"}
          className="px-6 py-3 bg-[var(--color-base-blue)] text-white rounded-xl font-bold text-sm
                     hover:bg-[var(--color-base-blue-dark)] transition-colors
                     disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          Start Game
        </button>
      </div>

      <button
        onClick={requestRefund}
        disabled={(snapshot?.availableBalance ?? 0n) === 0n || status !== "idle"}
        className="px-4 py-2 text-xs border border-[var(--color-text-secondary)] rounded-lg
                   hover:border-[var(--color-accent-red)] hover:text-[var(--color-accent-red)]
                   transition-colors
                   disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
      >
        {status === "refunding" ? "Requesting refund..." : "Request Refund"}
      </button>

      <p className="text-xs text-[var(--color-text-secondary)] text-center max-w-xs">
        {NEXT_DEV
          ? "NEXT_DEV=true — no login or on-chain deposit needed for gameplay testing."
          : "Deposits use one ERC-3009 authorization. Gameplay signs vouchers with a browser-only session key."}
      </p>

      {error && <p className="text-xs text-[var(--color-accent-red)]">{error}</p>}
    </div>
  );
}

async function getGamePaymentRequirements(): Promise<PaymentRequirements | null> {
  const response = await fetch(`${window.location.origin}/api/game/start`, { method: "GET" });
  const header = response.headers.get("PAYMENT-REQUIRED");
  if (!header) return null;

  const paymentRequired = decodePaymentRequiredHeader(header);
  return paymentRequired.accepts.find(accept => accept.scheme === "batch-settlement") ?? null;
}

function readSettledChannelId(response: Response): `0x${string}` | null {
  const header =
    response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE");
  if (!header) return null;

  return readChannelId(decodePaymentResponseHeader(header).extra);
}

function getDebugChannel(
  session: StoredSessionKey,
): { config: ChannelConfig; channelId: `0x${string}` } | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(RECEIVER_ADDRESS)) return null;
  return buildGameChannelConfig(
    session.playerAddress,
    session.sessionAddress,
    RECEIVER_ADDRESS,
    RECEIVER_ADDRESS,
    session.channelSalt,
  );
}

function formatUsdc(amount: bigint): string {
  return (Number(amount) / 1e6).toFixed(3);
}
