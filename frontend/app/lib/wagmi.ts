import { createConfig, http } from 'wagmi';
import {
  sepolia, avalancheFuji, optimismSepolia, arbitrumSepolia, baseSepolia, polygonAmoy,
} from 'wagmi/chains';
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
import {
  arcMainnet,
  arcTestnet,
  arcTransport,
  ARC_NETWORKS,
  ARC_NETWORK_LIST,
  DEFAULT_NETWORK,
  resolveArcNetwork,
} from './networks';

// ── Arc networks ──────────────────────────────────────────────────────────────
// Arc Mainnet + Arc Testnet are both defined once in ./networks (shared with the
// PayBot API route). Re-exported here so existing imports keep working.
export { arcMainnet, arcTestnet };

// ── Contract addresses per network ───────────────────────────────────────────
export const CONTRACT_ADDRESSES: Record<number, `0x${string}`> = Object.fromEntries(
  ARC_NETWORK_LIST.map((n) => [n.id, n.contractAddress]),
);

// Contract address of the default network (legacy export)
export const CONTRACT_ADDRESS: `0x${string}` = DEFAULT_NETWORK.contractAddress;

export function getContractAddress(chainId: number): `0x${string}` {
  return resolveArcNetwork(chainId).contractAddress;
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

// ── Gateway source-chain testnets ─────────────────────────────────────────────
// Added so the wallet can switch to a Gateway source chain to run the
// approve()+deposit() flow in GatewayFundPanel.tsx (depositing USDC into a
// GatewayWallet contract before it can be transferred to Arc). Arc Testnet
// remains the default/primary chain everywhere else in the app — these are
// additive, not a replacement for the single-chain-by-default UX.
export const gatewaySourceWagmiChains = [
  sepolia, avalancheFuji, optimismSepolia, arbitrumSepolia, baseSepolia, polygonAmoy,
] as const;

// ── Wagmi config ──────────────────────────────────────────────────────────────
// Both Arc networks are registered so the sidebar switcher (and the wallet) can
// move between them. Every read/write in the app passes an explicit chainId
// from the active network (see useArcNetwork), so chain ORDER here only decides
// the disconnected default and has no effect on which network a tx targets.
export const wagmiConfig = createConfig({
  chains: [arcTestnet, arcMainnet, ...gatewaySourceWagmiChains],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connectors: connectors as any,
  transports: {
    [arcTestnet.id]: arcTransport(ARC_NETWORKS.testnet),
    [arcMainnet.id]: arcTransport(ARC_NETWORKS.mainnet),
    [sepolia.id]: http(),
    [avalancheFuji.id]: http(),
    [optimismSepolia.id]: http(),
    [arbitrumSepolia.id]: http(),
    [baseSepolia.id]: http(),
    [polygonAmoy.id]: http(),
  },
  ssr: true,
});

// ── Explorer URLs per chain ───────────────────────────────────────────────────
export const EXPLORER_URLS: Record<number, string> = Object.fromEntries(
  ARC_NETWORK_LIST.map((n) => [n.id, n.explorerUrl]),
);

// Explorer of the default network (legacy export)
export const EXPLORER_URL = DEFAULT_NETWORK.explorerUrl;

export function getExplorerUrl(chainId: number): string {
  return resolveArcNetwork(chainId).explorerUrl;
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
