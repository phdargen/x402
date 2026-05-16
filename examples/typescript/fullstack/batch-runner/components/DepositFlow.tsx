"use client";

import { useState } from "react";
import { useConnection, useWalletClient } from "wagmi";
import type { Account, WalletClient } from "viem";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/client";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import {
  DEPOSIT_AMOUNT,
  DEPOSIT_AMOUNT_UNITS,
  DEPOSIT_MULTIPLIER,
  JUMP_PRICE,
  NETWORK,
  SKIP_DEPOSIT,
} from "@/lib/x402/config";
import {
  generateChannelSalt,
  deriveSessionKey,
  buildDelegationMessage,
} from "@/lib/x402/sessionKey";
import { LocalStorageChannelStorage } from "@/lib/x402/browserStorage";
import type { ClientEvmSigner } from "@x402/evm";

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
        account: walletClient.account as Account,
        domain: message.domain,
        types: message.types,
        primaryType: message.primaryType,
        message: message.message,
      }),
  };
}

export type SessionInfo = {
  channelSalt: `0x${string}`;
  sessionAddress: `0x${string}`;
  voucherSigner: ClientEvmSigner;
  playerAddress: `0x${string}`;
  channelId: `0x${string}` | null;
  depositedBalance: bigint;
};

type DepositFlowProps = {
  onSessionReady: (session: SessionInfo) => void;
};

export function DepositFlow({ onSessionReady }: DepositFlowProps) {
  const { address } = useConnection();
  const { data: walletClient } = useWalletClient();
  const [status, setStatus] = useState<"idle" | "signing" | "depositing" | "ready">("idle");
  const [error, setError] = useState<string | null>(null);

  const startSession = async () => {
    if (!walletClient || !address) return;

    setStatus("signing");
    setError(null);

    try {
      // 1. Derive session key from wallet delegation signature (one popup)
      const channelSalt = generateChannelSalt();
      const message = buildDelegationMessage(channelSalt);

      const delegationSig = await walletClient.signMessage({
        account: address,
        message,
      });

      const { sessionAccount, voucherSigner } = deriveSessionKey(
        delegationSig as `0x${string}`,
        channelSalt,
      );

      // Skip-deposit mode: fake balance, no on-chain interaction
      if (SKIP_DEPOSIT) {
        console.log("[batch-runner] SKIP_DEPOSIT=true — skipping on-chain deposit");
        onSessionReady({
          channelSalt,
          sessionAddress: sessionAccount.address,
          voucherSigner,
          playerAddress: address,
          channelId: null,
          depositedBalance: DEPOSIT_AMOUNT_UNITS,
        });
        setStatus("ready");
        return;
      }

      // 2. Create the wallet signer for the BatchSettlementEvmScheme
      setStatus("depositing");

      const walletSigner = wagmiToClientSigner(walletClient);

      // 3. Create BatchSettlementEvmScheme with session-key voucherSigner
      const storage = new LocalStorageChannelStorage();
      const batchedScheme = new BatchSettlementEvmScheme(walletSigner, {
        voucherSigner,
        salt: channelSalt,
        depositPolicy: { depositMultiplier: DEPOSIT_MULTIPLIER },
        storage,
      });

      // 4. Register the scheme and create payment-enabled fetch
      const client = new x402Client();
      client.register(NETWORK, batchedScheme);

      const fetchWithPayment = wrapFetchWithPayment(fetch, client);
      const httpClient = new x402HTTPClient(client);

      // 5. Hit the game start endpoint — triggers 402 → deposit flow
      const response = await fetchWithPayment(`${window.location.origin}/api/game/start`, {
        method: "GET",
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Deposit failed (${response.status}): ${text}`);
      }

      // 6. Process the payment response to update local channel state
      const paymentResult = await httpClient.processResponse(response);
      const channelId =
        paymentResult.kind === "success"
          ? readChannelId(paymentResult.settleResponse.extra)
          : null;

      onSessionReady({
        channelSalt,
        sessionAddress: sessionAccount.address,
        voucherSigner,
        playerAddress: address,
        channelId,
        depositedBalance: DEPOSIT_AMOUNT_UNITS,
      });

      setStatus("ready");
    } catch (err) {
      console.error("[batch-runner] Deposit error:", err);
      setError(err instanceof Error ? err.message : "Failed to deposit");
      setStatus("idle");
    }
  };

  return (
    <div
      className="animate-slide-up flex flex-col items-center gap-6 p-8 rounded-2xl
                    bg-[var(--color-surface-light)] border border-[var(--color-surface-lighter)]"
    >
      <div className="text-center">
        <h2 className="text-xl font-bold mb-2">Start a Game Session</h2>
        <p className="text-sm text-[var(--color-text-secondary)] max-w-xs leading-relaxed">
          {SKIP_DEPOSIT
            ? "Debug mode: deposit skipped. Sign to derive your session key."
            : `Sign a delegation message, then deposit ${DEPOSIT_AMOUNT} USDC into your game channel. Each jump costs ${JUMP_PRICE} via a signed voucher.`}
        </p>
      </div>

      <div className="grid grid-cols-3 gap-4 text-center text-xs">
        <div className="p-3 rounded-lg bg-[var(--color-surface)]">
          <div className="text-[var(--color-base-blue)] font-bold text-lg">{DEPOSIT_AMOUNT}</div>
          <div className="text-[var(--color-text-secondary)] mt-1">Budget</div>
        </div>
        <div className="p-3 rounded-lg bg-[var(--color-surface)]">
          <div className="text-[var(--color-accent-green)] font-bold text-lg">{JUMP_PRICE}</div>
          <div className="text-[var(--color-text-secondary)] mt-1">Per jump</div>
        </div>
        <div className="p-3 rounded-lg bg-[var(--color-surface)]">
          <div className="text-[var(--color-accent-orange)] font-bold text-lg">0</div>
          <div className="text-[var(--color-text-secondary)] mt-1">Gas fees</div>
        </div>
      </div>

      <button
        onClick={startSession}
        disabled={status === "signing" || status === "depositing"}
        className="px-8 py-3 bg-[var(--color-base-blue)] text-white rounded-xl font-bold text-sm
                   hover:bg-[var(--color-base-blue-dark)] transition-colors
                   disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
      >
        {status === "signing"
          ? "Sign with wallet..."
          : status === "depositing"
            ? `Depositing ${DEPOSIT_AMOUNT} USDC...`
            : SKIP_DEPOSIT
              ? "Sign & Start (debug)"
              : `Sign & Deposit ${DEPOSIT_AMOUNT} USDC`}
      </button>

      <p className="text-xs text-[var(--color-text-secondary)] text-center max-w-xs">
        {SKIP_DEPOSIT
          ? "NEXT_PUBLIC_SKIP_DEPOSIT=true — no on-chain deposit."
          : "One wallet popup for delegation + one for the ERC-3009 deposit authorization. No more popups during gameplay."}
      </p>

      {error && <p className="text-xs text-[var(--color-accent-red)]">{error}</p>}
    </div>
  );
}
