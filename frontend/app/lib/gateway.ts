/**
 * Circle Gateway integration constants and pure helpers.
 *
 * This module is purely additive to ArcPay — it does not modify anything in
 * `wagmi.ts` or `abi.ts`. It powers the "Fund from Any Chain" flow: a user
 * signs an EIP-712 burn intent for USDC they hold on any Gateway-supported
 * source chain, ArcPay relays that intent to Circle's Gateway API for an
 * attestation, and the user mints the resulting USDC on Arc Testnet via
 * `GatewayMinter.gatewayMint()`. From there they fund a Protected Transfer /
 * Batch Payment through ArcPay's existing, completely unmodified flows.
 *
 * All contract addresses below were verified directly against:
 * - https://developers.circle.com/gateway/references/contract-addresses
 * - https://developers.circle.com/stablecoins/usdc-contract-addresses
 * - https://docs.arc.io/arc/references/contract-addresses.md
 * as of the date this integration was designed. See the design doc
 * (.kiro/specs/circle-gateway-integration/design.md) for the full research
 * trail, including the spike that confirmed `hookData` is unused by the
 * deployed `GatewayMinter` contract (so it is always sent as `0x` here).
 */

// ── Gateway API (testnet only) ────────────────────────────────────────────────
// Requirement 7.5: testnet is the default; mainnet requires an explicit,
// separate config change, never a silent default flip.
export const GATEWAY_API_BASE = 'https://gateway-api-testnet.circle.com';

// ── Shared Gateway contract addresses ─────────────────────────────────────────
// Confirmed identical across every EVM testnet, Arc Testnet included — no
// per-chain override is needed. (Cross-checked against Circle's Gateway docs
// AND Arc's own contract-addresses reference, which lists the same values for
// domain 26.)
export const GATEWAY_WALLET_ADDRESS = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9' as const;
export const GATEWAY_MINTER_ADDRESS = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B' as const;

// ── Arc Testnet — destination-only config ─────────────────────────────────────
// Arc is never a source chain in this flow (users don't deposit FROM Arc into
// Gateway here), so it intentionally has no GatewayWallet entry and no place
// in GATEWAY_SOURCE_CHAINS below. This constant set is deliberately smaller
// than GatewaySourceChain to reflect that asymmetry in the schema itself.
export const ARC_TESTNET_DOMAIN = 26;

// Confirmed predeploy address for Arc's USDC ERC-20 interface (6 decimals).
// This is NOT the same decimal precision as Arc's native 18-decimal gas
// balance at the same underlying funds — see ARC_USDC_DECIMALS note below and
// the design doc's "Critical decimals nuance" section. Gateway mints into
// this 6-decimal interface, matching every other EVM chain's USDC.
export const ARC_TESTNET_USDC = '0x3600000000000000000000000000000000000000' as const;
export const ARC_USDC_DECIMALS = 6;

// ── Pre-sign safety threshold (Requirement 7.4) ───────────────────────────────
// Env-configurable so it can be raised for a mainnet pass without touching
// the warning logic itself. Defaults to 25 USDC.
export const GATEWAY_WARN_THRESHOLD_USDC = Number(
  process.env.NEXT_PUBLIC_GATEWAY_WARN_THRESHOLD_USDC ?? '25'
);

// ── Gateway-supported source chains for the "fund from any chain" picker ─────
// Domain IDs + USDC addresses confirmed against Circle's canonical USDC
// address table and Gateway's supported-blockchains reference — finalized,
// not placeholder values. No walletAddress/minterAddress fields here: every
// source chain shares the single GATEWAY_WALLET_ADDRESS/GATEWAY_MINTER_ADDRESS
// constants above.
export interface GatewaySourceChain {
  key: string;
  label: string;
  chainId: number;        // EVM chainId, for wagmi network switch prompts
  domain: number;         // Circle Gateway/CCTP domain id
  usdcAddress: `0x${string}`;
  gasFeeUsd: number;       // from Circle's published Gateway fee table, used for maxFee estimation
  explorerUrl: string;     // block explorer base URL, for linking deposit tx hashes in history
}

export const GATEWAY_SOURCE_CHAINS: GatewaySourceChain[] = [
  { key: 'ethereumSepolia', label: 'Ethereum Sepolia', chainId: 11155111, domain: 0, usdcAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', gasFeeUsd: 1.00, explorerUrl: 'https://sepolia.etherscan.io' },
  { key: 'avalancheFuji',   label: 'Avalanche Fuji',    chainId: 43113,    domain: 1, usdcAddress: '0x5425890298aed601595a70AB815c96711a31Bc65', gasFeeUsd: 0.02, explorerUrl: 'https://testnet.snowtrace.io' },
  { key: 'optimismSepolia', label: 'OP Sepolia',        chainId: 11155420, domain: 2, usdcAddress: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7', gasFeeUsd: 0.0015, explorerUrl: 'https://sepolia-optimism.etherscan.io' },
  { key: 'arbitrumSepolia', label: 'Arbitrum Sepolia',  chainId: 421614,   domain: 3, usdcAddress: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', gasFeeUsd: 0.01, explorerUrl: 'https://sepolia.arbiscan.io' },
  { key: 'baseSepolia',     label: 'Base Sepolia',      chainId: 84532,    domain: 6, usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', gasFeeUsd: 0.01, explorerUrl: 'https://sepolia.basescan.org' },
  { key: 'polygonAmoy',     label: 'Polygon Amoy',      chainId: 80002,    domain: 7, usdcAddress: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', gasFeeUsd: 0.0015, explorerUrl: 'https://amoy.polygonscan.com' },
];

// ── EIP-712 type definitions ───────────────────────────────────────────────────
// Copied verbatim from Circle's Gateway documentation. DO NOT MODIFY field
// names, types, or ordering — doing so produces invalid signatures.
export const GATEWAY_EIP712_DOMAIN = { name: 'GatewayWallet', version: '1' } as const;

export const EIP712Domain = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
] as const;

export const TransferSpecType = [
  { name: 'version', type: 'uint32' },
  { name: 'sourceDomain', type: 'uint32' },
  { name: 'destinationDomain', type: 'uint32' },
  { name: 'sourceContract', type: 'bytes32' },
  { name: 'destinationContract', type: 'bytes32' },
  { name: 'sourceToken', type: 'bytes32' },
  { name: 'destinationToken', type: 'bytes32' },
  { name: 'sourceDepositor', type: 'bytes32' },
  { name: 'destinationRecipient', type: 'bytes32' },
  { name: 'sourceSigner', type: 'bytes32' },
  { name: 'destinationCaller', type: 'bytes32' },
  { name: 'value', type: 'uint256' },
  { name: 'salt', type: 'bytes32' },
  { name: 'hookData', type: 'bytes' },
] as const;

export const BurnIntentType = [
  { name: 'maxBlockHeight', type: 'uint256' },
  { name: 'maxFee', type: 'uint256' },
  { name: 'spec', type: 'TransferSpec' },
] as const;

// ── GatewayMinter ABI (minimal — only what ArcPay calls) ──────────────────────
export const GATEWAY_MINTER_ABI = [
  {
    type: 'function',
    name: 'gatewayMint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'attestationPayload', type: 'bytes' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

// ── GatewayWallet ABI (minimal — deposit + balance reads) ─────────────────────
// Per Circle's docs: only deposit/depositFor/depositWithPermit/
// depositWithAuthorization credit a Gateway balance. A raw ERC-20 transfer to
// this contract permanently loses funds — ArcPay's deposit flow always goes
// through `deposit()` below, never a plain transfer.
export const GATEWAY_WALLET_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'availableBalance',
    stateMutability: 'view',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'depositor', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// ── Minimal ERC-20 ABI for the approve-then-deposit flow ──────────────────────
export const ERC20_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Pads a 20-byte EVM address to a 32-byte hex string for TransferSpec fields. */
export function addressToBytes32(address: string): `0x${string}` {
  return ('0x' +
    address
      .toLowerCase()
      .replace(/^0x/, '')
      .padStart(64, '0')) as `0x${string}`;
}

/**
 * Estimates a safe `maxFee` (in USDC micro-units, 6 decimals) for a burn
 * intent, per Circle's documented formula:
 *   maxFee >= gasFee + forwardingFee(0 if unused) + (amount * 0.00005)
 * A buffer is added on top to absorb gas fee fluctuation, per Circle's own
 * recommendation ("Add a buffer to your maxFee calculation").
 */
export function estimateMaxFee(
  amountMicroUsdc: bigint,
  sourceGasFeeUsd: number,
  bufferPct = 0.5,
): bigint {
  const transferFee = (amountMicroUsdc * 5n) / 100000n; // 0.005% = 5 / 100,000
  const gasFeeMicroUsdc = BigInt(Math.ceil(sourceGasFeeUsd * 1_000_000));
  const base = transferFee + gasFeeMicroUsdc;
  const bufferBps = BigInt(Math.ceil(bufferPct * 100));
  return base + (base * bufferBps) / 100n;
}

/**
 * Converts a USDC amount from Gateway's 6-decimal micro-unit wire format to
 * Arc's native 18-decimal wei-equivalent unit (used by ArcPay's existing
 * `parseEther`/`formatEther`-based amount handling for `createEscrow` etc.).
 *
 * Confirmed safe per Arc's official "Stablecoin native model" docs: the
 * native (18-decimal) and ERC-20 (6-decimal) USDC interfaces at
 * `0x3600...0000` share the exact same underlying balance — this is a pure
 * decimal-scale conversion, not a bridge or wrap operation.
 */
export function microUsdcToNativeWei(amountMicroUsdc: bigint): bigint {
  return amountMicroUsdc * 10n ** 12n; // 6 -> 18 decimals
}

/** Inverse of `microUsdcToNativeWei` — native 18-decimal wei-equivalent to
 *  Gateway's 6-decimal micro-USDC units. Truncates any sub-micro-USDC dust. */
export function nativeWeiToMicroUsdc(amountWei: bigint): bigint {
  return amountWei / 10n ** 12n; // 18 -> 6 decimals
}

/**
 * Converts a decimal USDC amount string (e.g. "1", "0.98", "1.234567") to
 * exact micro-USDC (6-decimal) units without floating point rounding.
 *
 * `Math.round(parseFloat(amount) * 1_000_000)` is NOT used here on purpose:
 * for most values it's fine, but it computes a *desired* amount independent
 * of what the wallet actually holds on-chain, so a value that looks clean in
 * decimal (like "1") can still get rejected on-chain if the wallet's real
 * balance is a few micro-USDC short (e.g. 0.999998 USDC) — the amount itself
 * isn't imprecise, the on-chain balance just doesn't cover it. Callers
 * should pair this with an explicit balance check (see `useGatewayDeposit`)
 * rather than relying on the revert to communicate that.
 */
export function decimalUsdcToMicro(amount: string): bigint {
  const trimmed = amount.trim();
  if (!trimmed) return 0n;
  const [whole, frac = ''] = trimmed.split('.');
  const fracPadded = frac.padEnd(6, '0').slice(0, 6);
  const wholePart = BigInt(whole || '0');
  const fracPart = BigInt(fracPadded || '0');
  return wholePart * 1_000_000n + fracPart;
}

/**
 * Turns a raw wallet/contract error (viem/wagmi error objects, plain
 * Errors, or unknown thrown values) into a short, human-readable message.
 * Raw viem errors are often multi-paragraph dumps with ABI details — never
 * fit for direct display in the UI.
 */
export function formatGatewayError(e: unknown): string {
  if (!e) return 'Something went wrong. Please try again.';

  // viem errors expose a `shortMessage` (single sentence, human-written) as
  // the top layer, and often nest the *actual* root cause under `.cause`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyErr = e as any;
  const raw: string =
    anyErr?.shortMessage ??
    anyErr?.cause?.shortMessage ??
    anyErr?.message ??
    String(e);

  const lower = raw.toLowerCase();

  if (lower.includes('user rejected') || lower.includes('user denied') || lower.includes('rejected the request')) {
    return 'Request was rejected in your wallet.';
  }
  if (lower.includes('insufficient funds') && lower.includes('gas')) {
    return 'Not enough native gas token in your wallet to pay for this transaction.';
  }
  if (lower.includes('exceeds balance') || lower.includes('transfer amount exceeds balance') || lower.includes('insufficient balance')) {
    return 'This amount exceeds your USDC balance on that chain.';
  }
  if (lower.includes('exceeds allowance') || lower.includes('insufficient allowance')) {
    return 'Approval amount was insufficient — please try again.';
  }
  if (lower.includes('gas estimation failed') || lower.includes('cannot estimate gas')) {
    return 'Unable to estimate gas for this transaction — the amount or chain state may be invalid.';
  }
  if (lower.includes('nonce')) {
    return 'Transaction nonce conflict — please try again.';
  }
  if (lower.includes('network changed') || lower.includes('chain mismatch')) {
    return 'Wallet network changed unexpectedly — please try again.';
  }

  // Fall back to the shortest available message, truncated so a raw ABI
  // encoding error never floods the UI.
  const firstLine = raw.split('\n')[0];
  return firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
}
