import { describe, it, expect, vi } from 'vitest';
import {
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
