/**
 * Arc network registry — the single source of truth for every environment
 * ArcPay can run against (Arc Mainnet + Arc Testnet).
 *
 * Server-safe on purpose: no React, no `window`. It is imported by the wagmi
 * config, every hook/page, AND the PayBot API route, so a network is defined
 * exactly once and can never drift between the UI and the agent.
 *
 * Chain parameters were verified against Circle's official Arc docs and live
 * RPC calls (eth_chainId): mainnet = 5042 (0x13b2), testnet = 5042002 (0x4cef52).
 */
import { fallback, http, isAddress, type Chain, type Transport } from 'viem';

export type ArcNetworkKey = 'mainnet' | 'testnet';

export interface ArcNetwork {
  key: ArcNetworkKey;
  chain: Chain;
  id: number;
  /** Full name, e.g. "Arc Mainnet" */
  name: string;
  /** Short name, e.g. "Mainnet" */
  label: string;
  /** Badge text shown in the switcher */
  badge: 'LIVE' | 'TEST';
  isTestnet: boolean;
  /** Primary RPC endpoint */
  rpcUrl: string;
  /** Primary first, then any failover endpoints */
  rpcUrls: string[];
  explorerUrl: string;
  /** ProtectedPay contract on this network */
  contractAddress: `0x${string}`;
  /** Circle Gateway ("Fund from Any Chain") only exists on testnet for now */
  gatewaySupported: boolean;
  /** UI accent colours for the switcher */
  color: string;
  bg: string;
  border: string;
}

// ── Chain definitions ─────────────────────────────────────────────────────────
// Native currency is USDC with 18 decimals (the native view of Arc's USDC).
const NATIVE_USDC = { name: 'USDC', symbol: 'USDC', decimals: 18 } as const;

// NOTE: NEXT_PUBLIC_* vars must be referenced as literal `process.env.X`
// expressions so Next.js can inline them into the client bundle.
/**
 * Parse a comma-separated list of RPC URLs. Only well-formed http(s) URLs are
 * kept; anything else is dropped with a warning instead of breaking the app.
 */
export function parseRpcUrls(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    try {
      const u = new URL(part);
      if (u.protocol === 'https:' || u.protocol === 'http:') out.push(part);
      else console.warn(`[ArcPay] Ignoring RPC URL with unsupported protocol: "${part}"`);
    } catch {
      console.warn(`[ArcPay] Ignoring malformed RPC URL: "${part}" (include https://)`);
    }
  }
  return out;
}

/** primary (override or default) first, then de-duplicated failovers */
function buildRpcList(primaryOverride: string | undefined, fallbacksRaw: string | undefined, defaultUrl: string): string[] {
  const primary = parseRpcUrls(primaryOverride)[0] ?? defaultUrl;
  return [...new Set([primary, ...parseRpcUrls(fallbacksRaw)])];
}

// Public endpoints are the default. Add your own keyed endpoints (Infura,
// QuickNode, ...) as failovers via the *_FALLBACK_RPC_URLS env vars.
const MAINNET_RPCS = buildRpcList(
  process.env.NEXT_PUBLIC_ARC_MAINNET_RPC_URL,
  process.env.NEXT_PUBLIC_ARC_MAINNET_FALLBACK_RPC_URLS,
  'https://rpc.mainnet.arc.io',
);
const TESTNET_RPCS = buildRpcList(
  process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL,
  process.env.NEXT_PUBLIC_ARC_TESTNET_FALLBACK_RPC_URLS,
  'https://rpc.testnet.arc.network',
);

export const arcMainnet = {
  id: 5042,
  name: 'Arc Mainnet',
  nativeCurrency: NATIVE_USDC,
  rpcUrls: {
    default: { http: MAINNET_RPCS },
    public:  { http: MAINNET_RPCS },
  },
  blockExplorers: {
    default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' },
  },
  testnet: false,
} as const satisfies Chain;

export const arcTestnet = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: NATIVE_USDC,
  rpcUrls: {
    default: { http: TESTNET_RPCS },
    public:  { http: TESTNET_RPCS },
  },
  blockExplorers: {
    default: { name: 'Arcscan', url: 'https://testnet.arcscan.app' },
  },
  testnet: true,
} as const satisfies Chain;

// ── Contract addresses ────────────────────────────────────────────────────────
// ProtectedPay is deployed at the same address on both networks today. Each
// network still has its own env override so they can diverge without code
// changes. An invalid override is ignored (falls back to the default) rather
// than silently sending funds to a malformed address.
const DEFAULT_CONTRACT = '0xCa36dD890F987EDcE1D6D7C74Fb9df627c216BF6' as const;

function pickAddress(candidate: string | undefined, fallback: `0x${string}`): `0x${string}` {
  if (candidate && isAddress(candidate, { strict: false })) return candidate as `0x${string}`;
  if (candidate) console.warn(`[ArcPay] Ignoring invalid contract address override: "${candidate}"`);
  return fallback;
}

const MAINNET_CONTRACT = pickAddress(process.env.NEXT_PUBLIC_CONTRACT_ADDRESS_MAINNET, DEFAULT_CONTRACT);
const TESTNET_CONTRACT = pickAddress(process.env.NEXT_PUBLIC_CONTRACT_ADDRESS_TESTNET, DEFAULT_CONTRACT);

// ── Registry ──────────────────────────────────────────────────────────────────
export const ARC_NETWORKS: Record<ArcNetworkKey, ArcNetwork> = {
  mainnet: {
    key: 'mainnet',
    chain: arcMainnet,
    id: arcMainnet.id,
    name: 'Arc Mainnet',
    label: 'Mainnet',
    badge: 'LIVE',
    isTestnet: false,
    rpcUrl: MAINNET_RPCS[0],
    rpcUrls: MAINNET_RPCS,
    explorerUrl: arcMainnet.blockExplorers.default.url,
    contractAddress: MAINNET_CONTRACT,
    gatewaySupported: false,
    color: '#10B981',
    bg: 'rgba(16,185,129,0.1)',
    border: 'rgba(16,185,129,0.3)',
  },
  testnet: {
    key: 'testnet',
    chain: arcTestnet,
    id: arcTestnet.id,
    name: 'Arc Testnet',
    label: 'Testnet',
    badge: 'TEST',
    isTestnet: true,
    rpcUrl: TESTNET_RPCS[0],
    rpcUrls: TESTNET_RPCS,
    explorerUrl: arcTestnet.blockExplorers.default.url,
    contractAddress: TESTNET_CONTRACT,
    gatewaySupported: true,
    color: '#F59E0B',
    bg: 'rgba(245,158,11,0.1)',
    border: 'rgba(245,158,11,0.3)',
  },
};

/** Display order for the switcher */
export const ARC_NETWORK_LIST: ArcNetwork[] = [ARC_NETWORKS.mainnet, ARC_NETWORKS.testnet];

/**
 * Which network a fresh visitor lands on. Testnet unless explicitly overridden,
 * so nobody touches real funds by accident. Returning users keep whatever they
 * last picked (persisted by activeNetwork.ts).
 */
export const DEFAULT_NETWORK_KEY: ArcNetworkKey =
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';

export const DEFAULT_NETWORK: ArcNetwork = ARC_NETWORKS[DEFAULT_NETWORK_KEY];

/**
 * viem transport for a network: a single http transport, or — when failover
 * endpoints are configured — a fallback transport that retries the next RPC
 * if the current one errors or times out.
 */
export function arcTransport(network: ArcNetwork): Transport {
  const transports = network.rpcUrls.map((url) => http(url));
  return transports.length > 1 ? fallback(transports) : transports[0];
}

// ── Lookups ───────────────────────────────────────────────────────────────────
export function isArcNetworkKey(value: unknown): value is ArcNetworkKey {
  return value === 'mainnet' || value === 'testnet';
}

export function findArcNetworkByChainId(chainId: number | undefined | null): ArcNetwork | undefined {
  if (chainId == null) return undefined;
  return ARC_NETWORK_LIST.find((n) => n.id === chainId);
}

export function isArcChainId(chainId: number | undefined | null): boolean {
  return findArcNetworkByChainId(chainId) !== undefined;
}

/** Resolve a chain id to an Arc network, falling back to the default network. */
export function resolveArcNetwork(chainId?: number | null): ArcNetwork {
  return findArcNetworkByChainId(chainId) ?? DEFAULT_NETWORK;
}
