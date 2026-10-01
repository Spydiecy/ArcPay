'use client';

import { useState, useCallback, useEffect } from 'react';
import { useAccount } from 'wagmi';

/**
 * Local history of cross-chain USDC movements made through ArcPay's Gateway
 * integration (deposits into a source-chain GatewayWallet, and transfers
 * minted onto Arc Testnet).
 *
 * Circle's Gateway API doesn't expose a "list all past transfers for this
 * address" endpoint (only a snapshot of currently-pending deposits via
 * `/v1/deposits`) — so this is tracked client-side, per-address, in
 * localStorage. It's best-effort UX (a fresh browser/device won't show past
 * history) rather than an authoritative record; the authoritative record is
 * always the chain itself (see the tx hash / explorer link on each entry).
 */
export interface GatewayHistoryEntry {
  type: 'deposit' | 'transfer';
  chainLabel: string;
  /** Decimal USDC amount as entered by the user, e.g. "1.5". */
  amount: string;
  txHash: string;
  timestamp: number;
}

const STORAGE_PREFIX = 'arcpay:gatewayHistory:';
const MAX_ENTRIES = 50;

function storageKey(address: string): string {
  return `${STORAGE_PREFIX}${address.toLowerCase()}`;
}

function loadHistory(address: string): GatewayHistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(storageKey(address));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHistory(address: string, entries: GatewayHistoryEntry[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(address), JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // Storage full or disabled (private browsing) — history just won't
    // persist across reloads; never let this throw into the caller.
  }
}

export function useGatewayHistory() {
  const { address } = useAccount();
  const [entries, setEntries] = useState<GatewayHistoryEntry[]>([]);

  useEffect(() => {
    setEntries(address ? loadHistory(address) : []);
  }, [address]);

  const addEntry = useCallback((entry: GatewayHistoryEntry) => {
    if (!address) return;
    setEntries((prev) => {
      const next = [entry, ...prev].slice(0, MAX_ENTRIES);
      saveHistory(address, next);
      return next;
    });
  }, [address]);

  return { entries, addEntry };
}
