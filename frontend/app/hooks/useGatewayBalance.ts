'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useAccount } from 'wagmi';
import { GATEWAY_SOURCE_CHAINS } from '../lib/gateway';

// ── Types ─────────────────────────────────────────────────────────────────────
export interface GatewayChainBalance {
  domain: number;
  label: string;
  /** Human-readable decimal string, e.g. "5.000000" — as returned by Circle's API. */
  balance: string;
}

export interface GatewayPendingDeposit {
  domain: number;
  label: string;
  /** Amount in micro-USDC units, as returned by Circle's API (6 decimals). */
  amount: string;
  transactionHash: string;
}

interface RawGatewayBalance {
  domain?: number;
  depositor: string;
  balance: string;
}

interface RawGatewayDeposit {
  domain?: number;
  depositor: string;
  amount: string;
  status: string;
  transactionHash: string;
}

// 30-second cache window (Requirement 1.5) — avoids redundant API calls on
// repeated renders, consistent with the retry/caching pattern already used
// for on-chain reads elsewhere in ArcPay (see useHistory.ts).
const CACHE_WINDOW_MS = 30_000;

export function useGatewayBalance() {
  const { address } = useAccount();
  const [balances, setBalances] = useState<GatewayChainBalance[]>([]);
  const [pendingDeposits, setPendingDeposits] = useState<GatewayPendingDeposit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastFetchRef = useRef(0);

  const refresh = useCallback(async (force = false) => {
    if (!address) return;
    if (!force && Date.now() - lastFetchRef.current < CACHE_WINDOW_MS) return;

    setLoading(true);
    try {
      const [balRes, depRes] = await Promise.allSettled([
        fetch('/api/gateway/balances', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address }),
        }),
        fetch('/api/gateway/deposits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address }),
        }),
      ]);

      // Balances — the primary signal. A failure here surfaces as `error`
      // and preserves last-known-good data (Requirement 1.3).
      if (balRes.status === 'fulfilled') {
        if (!balRes.value.ok) {
          const body = await balRes.value.json().catch(() => ({}));
          throw new Error(body?.error ?? `Gateway balances request failed (${balRes.value.status})`);
        }
        const json = await balRes.value.json();
        const raw: RawGatewayBalance[] = json.balances ?? [];
        // Requirement 1.4: omit zero-value chains rather than showing a zero row.
        const nonZero: GatewayChainBalance[] = raw
          .filter((b) => parseFloat(b.balance) > 0)
          .map((b) => ({
            domain: b.domain ?? -1,
            label: GATEWAY_SOURCE_CHAINS.find((c) => c.domain === b.domain)?.label ?? `Domain ${b.domain ?? '?'}`,
            balance: b.balance,
          }));
        setBalances(nonZero);
      } else {
        throw balRes.reason;
      }

      // Pending deposits — a secondary, best-effort signal purely for UX
      // ("your deposit is on its way, not lost"). A failure here must never
      // block the primary balance display.
      if (depRes.status === 'fulfilled' && depRes.value.ok) {
        const json = await depRes.value.json().catch(() => ({}));
        const raw: RawGatewayDeposit[] = json.deposits ?? [];
        setPendingDeposits(
          raw
            .filter((d) => d.status === 'pending')
            .map((d) => ({
              domain: d.domain ?? -1,
              label: GATEWAY_SOURCE_CHAINS.find((c) => c.domain === d.domain)?.label ?? `Domain ${d.domain ?? '?'}`,
              amount: d.amount,
              transactionHash: d.transactionHash,
            })),
        );
      }

      setError(null);
      lastFetchRef.current = Date.now();
    } catch (e) {
      // Requirement 1.3: a failed refresh must not clear previously-successful
      // balances — surface the error separately and keep showing last-known-good data.
      setError(e instanceof Error ? e.message : 'Failed to load unified balance');
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    setBalances([]);
    setPendingDeposits([]);
    setError(null);
    lastFetchRef.current = 0;
    if (address) refresh(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  const total = balances.reduce((sum, b) => sum + parseFloat(b.balance), 0);

  return {
    balances,
    pendingDeposits,
    total,
    loading,
    error,
    refresh: () => refresh(true),
  };
}
