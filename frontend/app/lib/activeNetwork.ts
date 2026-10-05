/**
 * Active-network store — which Arc environment (Mainnet / Testnet) the app is
 * currently pointed at. A tiny external store so it works with React's
 * useSyncExternalStore, and so non-React code (async callbacks) can read the
 * current value without stale closures.
 *
 * - SSR / first hydration render always see DEFAULT_NETWORK_KEY, so server and
 *   client markup match; the persisted choice is applied right after.
 * - Persisted in localStorage and synced across tabs.
 */
import { ARC_NETWORKS, DEFAULT_NETWORK_KEY, isArcNetworkKey, type ArcNetwork, type ArcNetworkKey } from './networks';

const STORAGE_KEY = 'arcpay:network';

let current: ArcNetworkKey = DEFAULT_NETWORK_KEY;
let initialized = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function readStored(): ArcNetworkKey | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return isArcNetworkKey(v) ? v : null;
  } catch {
    return null; // storage blocked (private mode etc.) — just use the default
  }
}

function init() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  const stored = readStored();
  if (stored) current = stored;
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    const next = readStored() ?? DEFAULT_NETWORK_KEY;
    if (next !== current) {
      current = next;
      emit();
    }
  });
}

export function getActiveNetworkKey(): ArcNetworkKey {
  init();
  return current;
}

export function getActiveNetwork(): ArcNetwork {
  return ARC_NETWORKS[getActiveNetworkKey()];
}

export function setActiveNetworkKey(key: ArcNetworkKey): void {
  init();
  if (key === current) return;
  current = key;
  try {
    window.localStorage.setItem(STORAGE_KEY, key);
  } catch {
    /* non-fatal: choice just won't persist */
  }
  emit();
}

export function subscribeActiveNetwork(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Snapshot used for server rendering + the hydration pass. */
export function getServerNetworkKey(): ArcNetworkKey {
  return DEFAULT_NETWORK_KEY;
}
