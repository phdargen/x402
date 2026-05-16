"use client";

import { useEffect, useState } from "react";

type LeaderboardEntry = {
  address: string;
  distance: number;
  voucherCount: number;
};

export function Leaderboard() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/leaderboard")
      .then((r) => r.json())
      .then((data) => {
        setEntries(data.entries ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div className="w-full max-w-md mx-auto">
      <h3 className="text-sm font-bold text-[var(--color-text-secondary)] mb-3 uppercase tracking-wider">
        Top Runners
      </h3>

      {loading ? (
        <div className="text-center text-xs text-[var(--color-text-secondary)] py-4">
          Loading...
        </div>
      ) : entries.length === 0 ? (
        <div className="text-center text-xs text-[var(--color-text-secondary)] py-4">
          No scores yet. Be the first!
        </div>
      ) : (
        <div className="rounded-xl border border-[var(--color-surface-lighter)] overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[var(--color-surface-light)] text-[var(--color-text-secondary)]">
                <th className="py-2 px-3 text-left">#</th>
                <th className="py-2 px-3 text-left">Runner</th>
                <th className="py-2 px-3 text-right">Distance</th>
                <th className="py-2 px-3 text-right">Vouchers</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => (
                <tr
                  key={`${entry.address}-${i}`}
                  className="border-t border-[var(--color-surface-lighter)]
                             hover:bg-[var(--color-surface-light)] transition-colors"
                >
                  <td className="py-2 px-3 font-bold text-[var(--color-base-blue)]">{i + 1}</td>
                  <td className="py-2 px-3 font-mono">
                    {entry.address.slice(0, 6)}...{entry.address.slice(-4)}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {Math.floor(entry.distance).toLocaleString()}m
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {entry.voucherCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
