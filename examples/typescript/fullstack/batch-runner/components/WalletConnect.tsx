"use client";

import { useConnection, useConnect, useConnectors, useDisconnect } from "wagmi";

export function WalletConnect() {
  const { address, isConnected, isConnecting, isReconnecting } = useConnection();
  const connect = useConnect();
  const connectors = useConnectors();
  const disconnect = useDisconnect();

  if (isReconnecting) {
    return (
      <div className="text-xs text-[var(--color-text-secondary)]">Reconnecting...</div>
    );
  }

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-3">
        <span className="text-sm text-[var(--color-text-secondary)] font-mono">
          {address.slice(0, 6)}...{address.slice(-4)}
        </span>
        <button
          onClick={() => disconnect.mutate()}
          className="px-3 py-1.5 text-xs border border-[var(--color-text-secondary)] rounded-lg
                     hover:border-[var(--color-accent-red)] hover:text-[var(--color-accent-red)]
                     transition-colors cursor-pointer"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3">
      {connectors.map((connector) => (
        <button
          key={connector.uid}
          onClick={() => connect.mutate({ connector })}
          disabled={isConnecting}
          className="px-6 py-3 bg-[var(--color-base-blue)] text-white rounded-xl font-bold
                     hover:bg-[var(--color-base-blue-dark)] transition-colors
                     disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer
                     animate-pulse-blue"
        >
          {isConnecting ? "Connecting..." : `Connect ${connector.name}`}
        </button>
      ))}
    </div>
  );
}
