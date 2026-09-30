import { createConfig, http } from 'wagmi';
import { injected, metaMask, coinbaseWallet } from 'wagmi/connectors';
import { connectorsForWallets } from '@rainbow-me/rainbowkit';
import {
  metaMaskWallet,
  coinbaseWallet as coinbaseWalletRK,
  walletConnectWallet,
  injectedWallet,
  rainbowWallet,
  trustWallet,
} from '@rainbow-me/rainbowkit/wallets';
import type { Chain } from 'wagmi/chains';

// ── Arc Testnet ────────────────────────────────────────────────────────────────
// Currently the only live network for ArcPay. The chain switcher UI is kept in
// place (see Sidebar.tsx `NETWORKS`) so additional networks (e.g. Arc Mainnet)
// can be dropped in later without reworking the UI.
export const arcTestnet = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: {
    name: 'USDC',
    symbol: 'USDC',
    decimals: 18,
  },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.arc.network'] },
    public:  { http: ['https://rpc.testnet.arc.network'] },
  },
  blockExplorers: {
    default: {
      name: 'Arcscan',
      url: 'https://testnet.arcscan.app',
    },
  },
  testnet: true,
} as const satisfies Chain;

// ── Contract addresses per network ───────────────────────────────────────────
export const CONTRACT_ADDRESSES: Record<number, `0x${string}`> = {
  [arcTestnet.id]: (
    process.env.NEXT_PUBLIC_CONTRACT_ADDRESS_TESTNET || '0xCa36dD890F987EDcE1D6D7C74Fb9df627c216BF6'
  ) as `0x${string}`,
};

// Default contract address (falls back to Arc Testnet)
export const CONTRACT_ADDRESS = (
  process.env.NEXT_PUBLIC_CONTRACT_ADDRESS || CONTRACT_ADDRESSES[arcTestnet.id]
) as `0x${string}`;

export function getContractAddress(chainId: number): `0x${string}` {
  return CONTRACT_ADDRESSES[chainId] ?? CONTRACT_ADDRESSES[arcTestnet.id];
}

// ── WalletConnect project ID ──────────────────────────────────────────────────
const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WC_PROJECT_ID || '';

// ── RainbowKit connectors ─────────────────────────────────────────────────────
const connectors = WC_PROJECT_ID
  ? connectorsForWallets(
      [
        {
          groupName: 'Popular',
          wallets: [
            metaMaskWallet,
            rainbowWallet,
            coinbaseWalletRK,
            walletConnectWallet,
            trustWallet,
          ],
        },
        {
          groupName: 'More',
          wallets: [injectedWallet],
        },
      ],
      {
        appName: 'ArcPay',
        projectId: WC_PROJECT_ID,
      }
    )
  : [injected(), metaMask(), coinbaseWallet({ appName: 'ArcPay' })];

// ── Wagmi config ──────────────────────────────────────────────────────────────
// `chains` is an array on purpose (not a single chain) so the network switcher
// keeps working as-is once more networks are added here in the future.
export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connectors: connectors as any,
  transports: {
    [arcTestnet.id]: http('https://rpc.testnet.arc.network'),
  },
  ssr: true,
});

// ── Explorer URLs per chain ───────────────────────────────────────────────────
export const EXPLORER_URLS: Record<number, string> = {
  [arcTestnet.id]: 'https://testnet.arcscan.app',
};

export const EXPLORER_URL = EXPLORER_URLS[arcTestnet.id];

export function getExplorerUrl(chainId: number): string {
  return EXPLORER_URLS[chainId] ?? EXPLORER_URLS[arcTestnet.id];
}

export function explorerTx(hash: string, chainId?: number): string {
  const base = chainId ? getExplorerUrl(chainId) : EXPLORER_URL;
  return `${base}/tx/${hash}`;
}

export function explorerAddress(addr: string, chainId?: number): string {
  const base = chainId ? getExplorerUrl(chainId) : EXPLORER_URL;
  return `${base}/address/${addr}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
export function formatNative(wei: bigint, decimals = 4): string {
  if (wei === 0n) return '0';
  const val = Number(wei) / 1e18;
  return val.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

export function toWei(amount: string): bigint {
  if (!amount || amount === '0') return 0n;
  const [whole, frac = ''] = amount.split('.');
  const fracPadded = frac.padEnd(18, '0').slice(0, 18);
  return BigInt(whole || '0') * BigInt(10 ** 18) + BigInt(fracPadded);
}

export function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}
