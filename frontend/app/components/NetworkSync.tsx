'use client';

import { useEffect } from 'react';
import { useAccount } from 'wagmi';
import { findArcNetworkByChainId } from '../lib/networks';
import { setActiveNetworkKey } from '../lib/activeNetwork';

/**
 * Keeps the app's active Arc environment aligned with the connected wallet.
 *
 * If the wallet connects on (or the user switches it to) an Arc network, the app
 * follows it — so switching networks in MetaMask flips ArcPay too, and the two
 * can never silently disagree after a wallet-side change.
 *
 * Deliberately keyed on the WALLET's chain only, never on the app environment:
 *  - picking a network in the sidebar sets the environment first and then asks
 *    the wallet to switch; this effect doesn't fire on that environment change,
 *    so it can't fight the switch (no ping-pong), and a rejected wallet switch
 *    simply leaves the mismatch banner visible.
 *  - non-Arc chains (e.g. a Gateway source chain mid-deposit) are ignored.
 */
export default function NetworkSync() {
  const { isConnected, chainId: walletChainId } = useAccount();

  useEffect(() => {
    if (!isConnected) return;
    const arc = findArcNetworkByChainId(walletChainId);
    if (arc) setActiveNetworkKey(arc.key);
  }, [isConnected, walletChainId]);

  return null;
}
