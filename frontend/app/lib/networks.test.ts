import { describe, it, expect, vi } from 'vitest';
import { createPublicClient } from 'viem';
import {
  RPC_BATCH_SIZE,
  arcBrowserTransport,
  chainRelayUrl,
  arcTransport,
  parseRpcUrls,
  ARC_NETWORKS,
  ARC_NETWORK_LIST,
  DEFAULT_NETWORK,
  arcMainnet,
  arcTestnet,
  findArcNetworkByChainId,
  isArcChainId,
  isArcNetworkKey,
  resolveArcNetwork,
} from './networks';
import { CONTRACT_ADDRESSES, EXPLORER_URLS, getContractAddress, getExplorerUrl, explorerTx, explorerAddress, wagmiConfig } from './wagmi';

const CONTRACT = '0xCa36dD890F987EDcE1D6D7C74Fb9df627c216BF6';

describe('Arc network registry', () => {
  it('defines Arc Mainnet with the official chain parameters', () => {
    expect(arcMainnet.id).toBe(5042); // 0x13b2
    expect(ARC_NETWORKS.mainnet.rpcUrl).toBe('https://rpc.mainnet.arc.io');
    expect(ARC_NETWORKS.mainnet.explorerUrl).toBe('https://explorer.arc.io');
    expect(ARC_NETWORKS.mainnet.isTestnet).toBe(false);
    expect(arcMainnet.nativeCurrency).toMatchObject({ symbol: 'USDC', decimals: 18 });
  });

  it('keeps Arc Testnet unchanged', () => {
    expect(arcTestnet.id).toBe(5042002);
    expect(ARC_NETWORKS.testnet.rpcUrl).toBe('https://rpc.testnet.arc.network');
    expect(ARC_NETWORKS.testnet.explorerUrl).toBe('https://testnet.arcscan.app');
    expect(ARC_NETWORKS.testnet.isTestnet).toBe(true);
  });

  it('uses the provided contract address on both networks', () => {
    expect(ARC_NETWORKS.mainnet.contractAddress).toBe(CONTRACT);
    expect(ARC_NETWORKS.testnet.contractAddress).toBe(CONTRACT);
  });

  it('lists Mainnet first, both networks exactly once', () => {
    expect(ARC_NETWORK_LIST.map((n) => n.key)).toEqual(['mainnet', 'testnet']);
    expect(new Set(ARC_NETWORK_LIST.map((n) => n.id)).size).toBe(2);
  });

  it('only Testnet supports Circle Gateway', () => {
    expect(ARC_NETWORKS.testnet.gatewaySupported).toBe(true);
    expect(ARC_NETWORKS.mainnet.gatewaySupported).toBe(false);
  });

  it('defaults to Testnet so nobody touches real funds by accident', () => {
    expect(DEFAULT_NETWORK.key).toBe('testnet');
  });

  it('finds networks by chain id and rejects everything else', () => {
    expect(findArcNetworkByChainId(5042)?.key).toBe('mainnet');
    expect(findArcNetworkByChainId(5042002)?.key).toBe('testnet');
    expect(findArcNetworkByChainId(1)).toBeUndefined();
    expect(findArcNetworkByChainId(undefined)).toBeUndefined();
    expect(findArcNetworkByChainId(null)).toBeUndefined();
    expect(isArcChainId(5042)).toBe(true);
    expect(isArcChainId(11155111)).toBe(false); // a Gateway source chain is not an Arc chain
  });

  it('resolveArcNetwork falls back to the default for unknown chains', () => {
    expect(resolveArcNetwork(5042).key).toBe('mainnet');
    expect(resolveArcNetwork(5042002).key).toBe('testnet');
    expect(resolveArcNetwork(999999)).toBe(DEFAULT_NETWORK);
    expect(resolveArcNetwork()).toBe(DEFAULT_NETWORK);
  });

  it('validates network keys', () => {
    expect(isArcNetworkKey('mainnet')).toBe(true);
    expect(isArcNetworkKey('testnet')).toBe(true);
    expect(isArcNetworkKey('goerli')).toBe(false);
    expect(isArcNetworkKey(null)).toBe(false);
  });
});

describe('RPC configuration + failover', () => {
  it('parseRpcUrls keeps valid http(s) URLs and drops junk', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseRpcUrls(undefined)).toEqual([]);
    expect(parseRpcUrls('')).toEqual([]);
    expect(
      parseRpcUrls(' https://a.example/v3/key , https://b.example ,, http://localhost:8545 '),
    ).toEqual(['https://a.example/v3/key', 'https://b.example', 'http://localhost:8545']);
    // Hostnames without a scheme (like the bare "arc-mainnet.infura.io") and non-http protocols are rejected.
    expect(parseRpcUrls('arc-mainnet.infura.io, ws://x.example, ftp://y.example')).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('defaults to a single public RPC per network', () => {
    expect(ARC_NETWORKS.mainnet.rpcUrls).toEqual(['https://rpc.mainnet.arc.io']);
    expect(ARC_NETWORKS.testnet.rpcUrls).toEqual(['https://rpc.testnet.arc.network']);
    expect(ARC_NETWORKS.mainnet.rpcUrl).toBe(ARC_NETWORKS.mainnet.rpcUrls[0]);
  });

  it('uses a plain http transport with no failover, and a fallback transport with failovers', () => {
    expect(arcTransport(ARC_NETWORKS.mainnet)({ chain: arcMainnet }).config.type).toBe('http');

    const withFailover = { ...ARC_NETWORKS.mainnet, rpcUrls: ['https://one.example', 'https://two.example'] };
    expect(arcTransport(withFailover)({ chain: arcMainnet }).config.type).toBe('fallback');
  });

  it('reads the failover list from the environment, primary first and de-duplicated', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_ARC_MAINNET_FALLBACK_RPC_URLS', 'https://rpc.mainnet.arc.io, https://backup.example/key');
    const fresh = await import('./networks');
    expect(fresh.ARC_NETWORKS.mainnet.rpcUrls).toEqual(['https://rpc.mainnet.arc.io', 'https://backup.example/key']);
    expect(fresh.arcMainnet.rpcUrls.default.http).toEqual(['https://rpc.mainnet.arc.io', 'https://backup.example/key']);
    vi.unstubAllEnvs();
  });

  it('an env primary override replaces the default primary', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_ARC_MAINNET_RPC_URL', 'https://my-own.example/key');
    const fresh = await import('./networks');
    expect(fresh.ARC_NETWORKS.mainnet.rpcUrl).toBe('https://my-own.example/key');
    vi.unstubAllEnvs();
  });
});

describe('RPC request batching (public RPCs rate-limit bursts)', () => {
  // Fake JSON-RPC server: answers every call in a request (single or batch).
  function mockRpc() {
    const requests: unknown[] = [];
    const spy = vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      requests.push(body);
      const answer = (c: { id: number }) => ({ jsonrpc: '2.0', id: c.id, result: '0x1' });
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    return { requests, spy };
  }

  it('folds a burst of concurrent reads into ONE http request', async () => {
    const { requests, spy } = mockRpc();
    const client = createPublicClient({ chain: arcMainnet, transport: arcTransport(ARC_NETWORKS.mainnet) });
    const addr = '0x2ec8175015Bef5ad1C0BE1587C4A377bC083A2d8';

    const results = await Promise.all(Array.from({ length: 10 }, () => client.getBalance({ address: addr })));

    expect(results).toHaveLength(10);
    expect(results.every((r) => r === 1n)).toBe(true);
    expect(requests).toHaveLength(1);              // one HTTP request...
    expect(Array.isArray(requests[0])).toBe(true); // ...carrying a JSON-RPC batch
    expect((requests[0] as unknown[]).length).toBe(10);
    spy.mockRestore();
  });

  it('never sends more than the endpoint allows per batch (it drops calls above 30)', async () => {
    const { requests, spy } = mockRpc();
    const client = createPublicClient({ chain: arcMainnet, transport: arcTransport(ARC_NETWORKS.mainnet) });
    const addr = '0x2ec8175015Bef5ad1C0BE1587C4A377bC083A2d8';

    const results = await Promise.all(Array.from({ length: 70 }, () => client.getBalance({ address: addr })));

    expect(results).toHaveLength(70); // every single call still gets an answer
    const sizes = requests.map((r) => (Array.isArray(r) ? r.length : 1));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(RPC_BATCH_SIZE);
    expect(RPC_BATCH_SIZE).toBeLessThanOrEqual(30);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(70);
    spy.mockRestore();
  });
});

describe('browser transport: survives ad-blockers (ERR_BLOCKED_BY_CLIENT)', () => {
  const ADDR = '0x2ec8175015Bef5ad1C0BE1587C4A377bC083A2d8';
  const rpcAnswer = (body: { id: number }) => ({ jsonrpc: '2.0', id: body.id, result: '0x10' });

  // A fake network: direct RPC hosts are "blocked" (fetch throws like the browser does),
  // while same-origin requests to /api/chain/* work.
  function blockDirectRpc() {
    const seen: string[] = [];
    const spy = vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push(url);
      if (!url.includes('/api/chain/')) throw new TypeError('Failed to fetch'); // net::ERR_BLOCKED_BY_CLIENT
      const body = JSON.parse(String((init as RequestInit).body));
      const answer = Array.isArray(body) ? body.map(rpcAnswer) : rpcAnswer(body);
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    return { seen, spy };
  }

  it('in the browser, uses the same-origin relay first', () => {
    const relay = chainRelayUrl(ARC_NETWORKS.mainnet);
    expect(relay).toBe(`${window.location.origin}/api/chain/mainnet`);
    expect(arcBrowserTransport(ARC_NETWORKS.mainnet)({ chain: arcMainnet }).config.type).toBe('fallback');
  });

  it('still returns a balance when the direct RPC host is blocked by the browser', async () => {
    const { seen, spy } = blockDirectRpc();
    const client = createPublicClient({ chain: arcMainnet, transport: arcBrowserTransport(ARC_NETWORKS.mainnet) });

    const balance = await client.getBalance({ address: ADDR });

    expect(balance).toBe(16n);
    expect(seen.every((u) => u.includes('/api/chain/mainnet'))).toBe(true); // never even tried the blocked host
    spy.mockRestore();
  });

  it('the plain direct transport fails in the same scenario (proves the test is meaningful)', async () => {
    const { spy } = blockDirectRpc();
    const client = createPublicClient({ chain: arcMainnet, transport: arcTransport(ARC_NETWORKS.mainnet) });
    await expect(client.getBalance({ address: ADDR })).rejects.toThrow();
    spy.mockRestore();
  }, 20000);

  it('falls back to the direct RPC if the relay itself is unavailable', async () => {
    const seen: string[] = [];
    const spy = vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push(url);
      if (url.includes('/api/chain/')) return new Response('bad gateway', { status: 502 });
      const body = JSON.parse(String((init as RequestInit).body));
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(rpcAnswer) : rpcAnswer(body)), { status: 200 });
    });
    const client = createPublicClient({ chain: arcMainnet, transport: arcBrowserTransport(ARC_NETWORKS.mainnet) });
    expect(await client.getBalance({ address: ADDR })).toBe(16n);
    expect(seen.some((u) => u.startsWith('https://rpc.mainnet.arc.io'))).toBe(true);
    spy.mockRestore();
  }, 20000);
});

describe('wagmi.ts network wiring', () => {
  it('derives contract + explorer maps from the registry for both chains', () => {
    expect(CONTRACT_ADDRESSES[5042]).toBe(CONTRACT);
    expect(CONTRACT_ADDRESSES[5042002]).toBe(CONTRACT);
    expect(EXPLORER_URLS[5042]).toBe('https://explorer.arc.io');
    expect(EXPLORER_URLS[5042002]).toBe('https://testnet.arcscan.app');
    expect(getContractAddress(5042)).toBe(CONTRACT);
    expect(getExplorerUrl(5042)).toBe('https://explorer.arc.io');
  });

  it('builds the right explorer links per network', () => {
    const hash = '0xabc';
    expect(explorerTx(hash, 5042)).toBe('https://explorer.arc.io/tx/0xabc');
    expect(explorerTx(hash, 5042002)).toBe('https://testnet.arcscan.app/tx/0xabc');
    expect(explorerAddress(CONTRACT, 5042)).toBe(`https://explorer.arc.io/address/${CONTRACT}`);
  });

  it('registers both Arc chains (plus Gateway source chains) in the wagmi config', () => {
    const ids = wagmiConfig.chains.map((c) => c.id);
    expect(ids).toContain(5042);
    expect(ids).toContain(5042002);
    expect(ids).toContain(11155111);
  });
});
