import { describe, it, expect, vi, beforeEach } from 'vitest';

// The store keeps module-level state (current value + "initialized" flag), so
// each test loads a fresh copy of the module after preparing localStorage.
async function freshStore() {
  vi.resetModules();
  return import('./activeNetwork');
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('active network store', () => {
  it('starts on the default (Testnet) when nothing is stored', async () => {
    const store = await freshStore();
    expect(store.getActiveNetworkKey()).toBe('testnet');
    expect(store.getActiveNetwork().id).toBe(5042002);
  });

  it('server snapshot is always the default so SSR and hydration match', async () => {
    window.localStorage.setItem('arcpay:network', 'mainnet');
    const store = await freshStore();
    expect(store.getServerNetworkKey()).toBe('testnet');
    // ...while the client snapshot reflects the stored choice.
    expect(store.getActiveNetworkKey()).toBe('mainnet');
  });

  it('restores a previously chosen network', async () => {
    window.localStorage.setItem('arcpay:network', 'mainnet');
    const store = await freshStore();
    expect(store.getActiveNetwork().id).toBe(5042);
  });

  it('ignores garbage in storage instead of crashing or trusting it', async () => {
    window.localStorage.setItem('arcpay:network', 'ethereum');
    const store = await freshStore();
    expect(store.getActiveNetworkKey()).toBe('testnet');
  });

  it('persists a new choice and notifies subscribers exactly once', async () => {
    const store = await freshStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribeActiveNetwork(listener);

    store.setActiveNetworkKey('mainnet');
    expect(store.getActiveNetworkKey()).toBe('mainnet');
    expect(window.localStorage.getItem('arcpay:network')).toBe('mainnet');
    expect(listener).toHaveBeenCalledTimes(1);

    // Re-selecting the same network is a no-op (no spurious re-renders).
    store.setActiveNetworkKey('mainnet');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.setActiveNetworkKey('testnet');
    expect(listener).toHaveBeenCalledTimes(1); // unsubscribed
  });

  it('syncs when another tab changes the network', async () => {
    const store = await freshStore();
    store.getActiveNetworkKey(); // initialize + attach the storage listener
    const listener = vi.fn();
    store.subscribeActiveNetwork(listener);

    window.localStorage.setItem('arcpay:network', 'mainnet');
    window.dispatchEvent(new StorageEvent('storage', { key: 'arcpay:network', newValue: 'mainnet' }));

    expect(store.getActiveNetworkKey()).toBe('mainnet');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
