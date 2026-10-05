'use client';

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  getActiveNetworkKey,
  getServerNetworkKey,
  setActiveNetworkKey,
  subscribeActiveNetwork,
} from '../lib/activeNetwork';
import { ARC_NETWORKS, type ArcNetworkKey } from '../lib/networks';

/**
 * The one hook for "which Arc network am I on". Every page, hook and the
 * PayBot chat read their chain id, contract address and explorer from here, so
 * switching the environment updates the whole app at once.
 */
export function useArcNetwork() {
  const key = useSyncExternalStore(subscribeActiveNetwork, getActiveNetworkKey, getServerNetworkKey);
  const network = ARC_NETWORKS[key];

  const setNetwork = useCallback((next: ArcNetworkKey) => setActiveNetworkKey(next), []);

  return useMemo(
    () => ({
      network,
      key,
      chainId: network.id,
      chain: network.chain,
      contractAddress: network.contractAddress,
      explorerUrl: network.explorerUrl,
      isMainnet: !network.isTestnet,
      isTestnet: network.isTestnet,
      setNetwork,
    }),
    [network, key, setNetwork],
  );
}
