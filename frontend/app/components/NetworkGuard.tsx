'use client';

import { useAccount, useSwitchChain } from 'wagmi';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useArcNetwork } from '../hooks/useArcNetwork';
import { findArcNetworkByChainId } from '../lib/networks';

/**
 * Slim banner shown when the connected wallet is on a different chain than the
 * environment ArcPay is pointed at (e.g. app on Arc Mainnet, wallet still on
 * Ethereum). Transactions would be rejected in that state, so we say so and
 * offer a one-click fix instead of letting a write fail with a cryptic error.
 */
export default function NetworkGuard({ hidden = false }: { hidden?: boolean }) {
  const { isConnected, chainId: walletChainId } = useAccount();
  const { network } = useArcNetwork();
  const { switchChain, isPending, error } = useSwitchChain();

  if (hidden || !isConnected || walletChainId === network.id) return null;

  const walletNet = findArcNetworkByChainId(walletChainId);
  const walletLabel = walletNet ? walletNet.name : `chain ${walletChainId ?? '?'}`;

  return (
    <div
      role="alert"
      style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        padding: '10px 20px',
        background: 'var(--warning-container)',
        borderBottom: '1px solid rgba(251,191,36,0.3)',
      }}
    >
      <AlertTriangle size={16} color="var(--warning)" style={{ flexShrink: 0 }} />
      <p style={{ flex: 1, minWidth: 200, fontSize: 13, color: 'var(--foreground)', lineHeight: 1.4 }}>
        <strong>Wrong network.</strong> Your wallet is on {walletLabel}, but ArcPay is set to{' '}
        <strong style={{ color: network.color }}>{network.name}</strong>.
        {error && <span style={{ color: 'var(--error)' }}> Switch was rejected — try again or change it in your wallet.</span>}
      </p>
      <button
        onClick={() => switchChain({ chainId: network.id })}
        disabled={isPending}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '7px 16px', borderRadius: 999, border: 'none',
          background: 'var(--primary)', color: 'var(--primary-fg)',
          fontSize: 12.5, fontWeight: 700, cursor: isPending ? 'not-allowed' : 'pointer',
          opacity: isPending ? 0.7 : 1,
        }}
      >
        {isPending && <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />}
        Switch to {network.name}
      </button>
    </div>
  );
}
