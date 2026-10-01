# Design Document — Circle Gateway Integration for ArcPay

## Spike result (Requirement 5) — read this first

I pulled the actual verified `GatewayMinter` implementation source directly from Arcscan for the live Arc Testnet contract (proxy `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` → implementation `0x9EF4C7ad4F577be713972310e655337bFD0b84bF`, verified, name `GatewayMinter`, source module `src/modules/minter/Mints.sol`).

The public interface is exactly `gatewayMint(bytes attestationPayload, bytes signature)` — two parameters, nothing else. Tracing `_mint(bytes29 spec)` line by line, it reads exactly six fields off the `TransferSpec` (`recipient`, `value`, `token`, `sourceDomain`, `depositorBytes`, `signerBytes`), calls `IMintableToken(minter).mint(recipient, value)`, marks the transfer spec hash used, and emits `AttestationUsed`. **`hookData` is never read.** It's part of the struct that gets hashed and signed (so it affects the `transferSpecHash` / replay-protection identity of a transfer), but the deployed contract has no branch, no decoder, no external call using it.

**Decision: the atomic router-contract path is out of scope for this build.** There is no Circle-native "atomic mint + call ProtectedPay" feature today, and building one would mean shipping new, unaudited ArcPay contract code just to fund a flow that the two-step path already satisfies. Former Requirement 6 has been removed from the requirements doc. See **Future Work** at the end of this document for a description of the router contract as a possible later enhancement.

## Confirmed addresses and chain config (finalized, not illustrative)

Re-verified directly against the following live sources on the date of writing:
- https://developers.circle.com/stablecoins/usdc-contract-addresses (Circle's canonical USDC address table)
- https://developers.circle.com/gateway/references/contract-addresses (Gateway Wallet/Minter per chain)
- https://docs.arc.io/arc/references/contract-addresses.md (Arc's own contract address reference)

**Gateway Wallet and Gateway Minter use the same address across every EVM testnet, including Arc Testnet.** Arc's own docs confirm this independently (`GatewayWallet` domain 26 → `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`, `GatewayMinter` domain 26 → `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` — identical to the EVM-wide testnet addresses). This means the config schema does not need a per-chain Wallet/Minter address field — one shared constant pair covers every EVM testnet in `GATEWAY_SOURCE_CHAINS`, plus the same Minter address is reused for the Arc destination config.

**Arc Testnet is destination-only in this flow and does not need a `GatewayWallet` entry in the source-chain config.** Users are never depositing *from* Arc into Gateway as part of "fund ArcPay from any chain" — Arc only ever receives mints. The schema below reflects this asymmetry directly: `GatewaySourceChain` (used for the picker) carries no Arc entry at all; Arc's destination-only config (`ARC_TESTNET_DOMAIN`, `ARC_TESTNET_USDC`, `GATEWAY_MINTER_ADDRESS`) is a separate, smaller set of constants.

**Confirmed per-chain testnet USDC ERC-20 addresses** (cross-checked against Circle's canonical table, not illustrative):

| Chain | Domain | USDC address |
|---|---|---|
| Ethereum Sepolia | 0 | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| Avalanche Fuji | 1 | `0x5425890298aed601595a70AB815c96711a31Bc65` |
| OP Sepolia | 2 | `0x5fd84259d66Cd46123540766Be93DFE6D43130D7` |
| Arbitrum Sepolia | 3 | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` |
| Base Sepolia | 6 | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Polygon PoS Amoy | 7 | `0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582` |
| **Arc Testnet (destination)** | 26 | `0x3600000000000000000000000000000000000000` |

**Decimals nuance — resolved via Arc's official "Stablecoin native model" doc (`docs.arc.io/arc/concepts/stablecoin-native-model`):** Arc's native gas-token USDC balance uses **18 decimals** (`msg.value`, native transfers), while the **USDC ERC-20 interface at the same address (`0x3600...0000`) uses 6 decimals** — but Arc's docs state explicitly: *"The ERC-20 and native interfaces share the same underlying balance. An ERC-20 transfer directly moves the native balance, and a native send is reflected in the ERC-20 balance. These are not two separate tokens."* I independently confirmed this on-chain: `0x3600...0000`'s `decimals()` call returns `6` live on Arc Testnet, and the deployed bytecode contains both the ERC-20 `mint(address,uint256)` and `balanceOf(address)` selectors that `GatewayMinter._mint()` calls.

**Resolved implication for Task 7's hand-off:** because the ERC-20 mint directly moves the same underlying native balance (just represented at different decimal scales), Gateway-minted USDC becomes immediately usable as native `msg.value` for `ProtectedPay.createEscrow`/`createGroupPayment`/`batchTransfer` with no separate bridging step and no need to route through `createTokenEscrow`. The only remaining engineering care is **unit conversion in display/amount-entry code**: Gateway's wire format and `useGatewayBalance`/`useGatewayTransfer` operate in 6-decimal USDC micro-units, while ArcPay's existing `parseEther`/`formatEther`-based UI (used for `createEscrow` etc.) operates in 18-decimal wei-equivalent units. Converting between the two is `microUsdc * 10n**12n` (6→18) — this conversion must happen explicitly at the Fund panel's "continue to Protected Transfer" hand-off, not be assumed away, to avoid a 10^12 display/amount bug. This is a straightforward multiply/divide, not a design risk — downgraded from "highest-risk unknown" to "a documented conversion step" now that the underlying-balance-sharing behavior is confirmed.

---

## Overview

This adds a new, additive "Fund from any chain" capability to ArcPay, letting a user move USDC they hold on any Gateway-supported chain (Ethereum, Base, Arbitrum, Optimism, etc.) into usable Arc Testnet USDC, which they then spend through ArcPay's existing, completely unmodified Protected Transfer / Group Split / Batch Payment / Payment Links flows.

Nothing in `ProtectedPay`'s ABI, `wagmi.ts`'s existing exports, `useHistory`, or PayBot's system prompt changes. Everything here is new files plus one new tab/panel in the dashboard UI.

```
┌─────────────────────────────────────────────────────────────────┐
│                         ArcPay Dashboard                         │
│  (existing, untouched: Protected Transfer / Group / Batch /     │
│   Links / History / PayBot)                                     │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  NEW: "Fund from Any Chain" panel                        │    │
│  │  1. Unified balance view  (GET via server route)          │    │
│  │  2. Select source chain + amount                         │    │
│  │  3. Sign EIP-712 burn intent (existing wallet connection) │    │
│  │  4. Server route submits to Gateway API → attestation    │    │
│  │  5. gatewayMint() on Arc via existing wallet connection   │    │
│  │  6. Redirect into existing Protected Transfer / Batch     │    │
│  │     Payment form, now funded                              │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

## Architecture

### New files (all additive)

```
frontend/app/lib/gateway.ts                    -- constants, EIP-712 types, address encoding helpers
frontend/app/hooks/useGatewayBalance.ts        -- unified balance query hook
frontend/app/hooks/useGatewayTransfer.ts       -- burn intent construction, signing, mint orchestration
frontend/app/api/gateway/balances/route.ts     -- server proxy to POST /v1/balances
frontend/app/api/gateway/transfer/route.ts     -- server proxy to POST /v1/transfer
frontend/app/app/components/GatewayFundPanel.tsx -- new UI panel (unified balance + transfer flow)
frontend/app/app/components/Sidebar.tsx        -- ADD one new nav item only (existing items untouched)
frontend/app/app/components/HomePanel.tsx      -- ADD an entry point button only (existing content untouched)
```

Nothing under `frontend/app/lib/abi.ts`, `frontend/app/lib/wagmi.ts` (existing exports), `frontend/app/api/agent/route.ts`, `frontend/app/hooks/useHistory.ts`, or any existing page (`escrow/`, `group/`, `batch/`, `links/`, `profile/`) is modified. `Sidebar.tsx` and `HomePanel.tsx` get one additive nav entry / button each, consistent with Requirement 7.

### Why a server route for balances/transfer instead of calling Gateway API directly from the browser

Two reasons, both consistent with existing ArcPay conventions:
1. **CORS/reliability**: proxying through `app/api/*` (already the pattern for the PayBot agent route) avoids browser CORS issues with `gateway-api-testnet.circle.com` and lets us centralize the testnet/mainnet base URL switch in one server-side constant, per Requirement 8.5.
2. **No secrets needed here** — this is a pure pass-through proxy. The burn intent is signed client-side by the user's wallet (Requirement 8.1); the server route just forwards the already-signed payload to Circle and returns the response. No API key or entity secret is required for this self-managed-wallet flow, since Circle's `/v1/transfer` and `/v1/balances` endpoints are public/permissionless per the docs ("no sign-up needed").

## Components and Interfaces

### 1. `app/lib/gateway.ts` — constants and pure helpers

```typescript
// Testnet-only, per Requirement 8.5 (mainnet requires explicit separate config, not default)
export const GATEWAY_API_BASE = 'https://gateway-api-testnet.circle.com';

// Confirmed identical across every EVM testnet, Arc included (cross-checked against
// developers.circle.com/gateway/references/contract-addresses AND docs.arc.io/arc/references/contract-addresses).
// One shared pair — no per-chain override needed.
export const GATEWAY_WALLET_ADDRESS = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9' as const;
export const GATEWAY_MINTER_ADDRESS = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B' as const;

// Arc Testnet destination-only config. Arc is never a source chain in this flow, so it
// intentionally has no GatewayWallet entry / no place in GATEWAY_SOURCE_CHAINS below —
// the schema reflects that asymmetry instead of forcing a Wallet+Minter shape onto Arc.
export const ARC_TESTNET_DOMAIN = 26;
// Confirmed 6-decimal USDC ERC-20 interface predeploy — see decimals note above.
// This is the address Gateway mints into; it is NOT the same decimal precision as
// Arc's native 18-decimal gas balance, even though both track the same underlying funds.
export const ARC_TESTNET_USDC = '0x3600000000000000000000000000000000000000' as const;
export const ARC_USDC_DECIMALS = 6;

// Pre-sign safety-threshold warning (Requirement 8.4), env-configurable so it can be
// raised for a mainnet pass without touching the warning logic itself.
export const GATEWAY_WARN_THRESHOLD_USDC = Number(
  process.env.NEXT_PUBLIC_GATEWAY_WARN_THRESHOLD_USDC ?? '25'
);

// Gateway-supported source chains for the "fund from any chain" picker.
// Domain IDs + USDC addresses confirmed against developers.circle.com/stablecoins/usdc-contract-addresses
// and developers.circle.com/gateway/references/supported-blockchains — finalized, not placeholder.
// NOTE: no walletAddress/minterAddress fields here — every source chain shares the
// single GATEWAY_WALLET_ADDRESS/GATEWAY_MINTER_ADDRESS constants above.
export interface GatewaySourceChain {
  key: string;
  label: string;
  chainId: number;       // EVM chainId, for wagmi network switch prompts
  domain: number;        // Circle domain id
  usdcAddress: `0x${string}`;
  gasFeeUsd: number;      // from Circle's published fee table, used for maxFee estimation UI copy
}

export const GATEWAY_SOURCE_CHAINS: GatewaySourceChain[] = [
  { key: 'ethereumSepolia', label: 'Ethereum Sepolia', chainId: 11155111, domain: 0, usdcAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', gasFeeUsd: 1.00 },
  { key: 'avalancheFuji',   label: 'Avalanche Fuji',    chainId: 43113,    domain: 1, usdcAddress: '0x5425890298aed601595a70AB815c96711a31Bc65', gasFeeUsd: 0.02 },
  { key: 'optimismSepolia', label: 'OP Sepolia',        chainId: 11155420, domain: 2, usdcAddress: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7', gasFeeUsd: 0.0015 },
  { key: 'arbitrumSepolia', label: 'Arbitrum Sepolia',  chainId: 421614,   domain: 3, usdcAddress: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', gasFeeUsd: 0.01 },
  { key: 'baseSepolia',     label: 'Base Sepolia',      chainId: 84532,    domain: 6, usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', gasFeeUsd: 0.01 },
  { key: 'polygonAmoy',     label: 'Polygon Amoy',      chainId: 80002,    domain: 7, usdcAddress: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', gasFeeUsd: 0.0015 },
];

// EIP-712 type definitions — copied verbatim from Circle's docs, DO NOT MODIFY
// (per circlefin/skills SKILL.md security rule: "NEVER modify EIP-712 type definitions...")
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

export const GATEWAY_MINTER_ABI = [
  { type: 'function', name: 'gatewayMint', stateMutability: 'nonpayable',
    inputs: [{ name: 'attestationPayload', type: 'bytes' }, { name: 'signature', type: 'bytes' }],
    outputs: [] },
] as const;

// pad any 20-byte address to 32 bytes for TransferSpec fields
export function addressToBytes32(address: string): `0x${string}` {
  return ('0x' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0')) as `0x${string}`;
}

// maxFee helper per Requirement 2.5 / Circle's documented formula:
// maxFee >= gasFee + forwardingFee(0 if not used) + (amount * 0.00005), plus buffer
export function estimateMaxFee(amountMicroUsdc: bigint, sourceGasFeeUsd: number, bufferPct = 0.5): bigint {
  const transferFee = (amountMicroUsdc * 5n) / 100000n; // 0.005%
  const gasFeeMicroUsdc = BigInt(Math.ceil(sourceGasFeeUsd * 1_000_000));
  const base = transferFee + gasFeeMicroUsdc;
  return base + (base * BigInt(Math.ceil(bufferPct * 100))) / 100n;
}
```

### 2. `app/api/gateway/balances/route.ts` — server proxy for `/v1/balances`

```typescript
import { GATEWAY_API_BASE } from '../../../lib/gateway';

export async function POST(req: Request) {
  const { address } = await req.json();
  if (!address || typeof address !== 'string') {
    return Response.json({ error: 'address is required' }, { status: 400 });
  }
  const res = await fetch(`${GATEWAY_API_BASE}/v1/balances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'USDC', sources: [{ depositor: address }] }),
  });
  const body = await res.json();
  return Response.json(body, { status: res.status });
}
```

This mirrors the shape of the existing `app/api/agent/route.ts` — a thin server-side proxy, no new architectural pattern introduced.

### 3. `app/api/gateway/transfer/route.ts` — server proxy for `/v1/transfer`

```typescript
import { GATEWAY_API_BASE } from '../../../lib/gateway';

export async function POST(req: Request) {
  const requests = await req.json(); // [{ burnIntent, signature }]
  if (!Array.isArray(requests) || requests.length === 0) {
    return Response.json({ error: 'requests array required' }, { status: 400 });
  }
  const res = await fetch(`${GATEWAY_API_BASE}/v1/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requests, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  });
  const body = await res.json();
  return Response.json(body, { status: res.status });
}
```

Per Requirement 3.3, this route does not retry or mutate the request — it forwards Circle's response (including error bodies) verbatim so the client can surface the exact failure reason.

### 4. `app/hooks/useGatewayBalance.ts`

```typescript
'use client';
import { useState, useCallback, useEffect, useRef } from 'react';
import { useAccount } from 'wagmi';
import { GATEWAY_SOURCE_CHAINS } from '../lib/gateway';

export interface GatewayChainBalance { domain: number; label: string; balance: string; }

export function useGatewayBalance() {
  const { address } = useAccount();
  const [balances, setBalances] = useState<GatewayChainBalance[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastFetchRef = useRef(0);

  const refresh = useCallback(async (force = false) => {
    if (!address) return;
    // simple 30s cache per Requirement 1.5
    if (!force && Date.now() - lastFetchRef.current < 30_000) return;
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/gateway/balances', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      if (!res.ok) throw new Error(`Gateway balances failed (${res.status})`);
      const json = await res.json();
      const nonZero = (json.balances ?? [])
        .filter((b: { balance: string }) => parseFloat(b.balance) > 0)
        .map((b: { domain: number; balance: string }) => ({
          domain: b.domain,
          label: GATEWAY_SOURCE_CHAINS.find(c => c.domain === b.domain)?.label ?? `Domain ${b.domain}`,
          balance: b.balance,
        }));
      setBalances(nonZero);
      lastFetchRef.current = Date.now();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load unified balance');
      // Requirement 1.3: do not clear previously-successful balances on a transient failure
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => { refresh(); }, [address]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = balances.reduce((sum, b) => sum + parseFloat(b.balance), 0);
  return { balances, total, loading, error, refresh: () => refresh(true) };
}
```

Note the same "don't wipe good data on a transient failure" pattern already fixed in `useHistory.ts` is applied here from the start (Requirement 1.3), rather than needing a follow-up fix.

### 5. `app/hooks/useGatewayTransfer.ts` — burn intent → attestation → mint orchestration

```typescript
'use client';
import { useState, useCallback } from 'react';
import { useAccount, useSignTypedData, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import {
  GATEWAY_API_BASE, GATEWAY_WALLET_ADDRESS, GATEWAY_MINTER_ADDRESS, GATEWAY_MINTER_ABI,
  ARC_TESTNET_DOMAIN, ARC_TESTNET_USDC, GATEWAY_EIP712_DOMAIN,
  EIP712Domain, TransferSpecType, BurnIntentType, addressToBytes32, estimateMaxFee,
} from '../lib/gateway';

export type GatewayTransferPhase =
  | 'idle' | 'signing' | 'submitting' | 'minting' | 'done' | 'error';

export function useGatewayTransfer() {
  const { address } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();
  const [phase, setPhase] = useState<GatewayTransferPhase>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [mintTxHash, setMintTxHash] = useState<`0x${string}` | undefined>();
  const { isSuccess: mintConfirmed } = useWaitForTransactionReceipt({ hash: mintTxHash });

  // Requirement 2 + 3 + 4.1: sign, submit, mint — three explicit phases,
  // each independently retryable per Requirement 4.5.
  const transfer = useCallback(async (params: {
    sourceDomain: number;
    sourceUsdcAddress: `0x${string}`;
    amountMicroUsdc: bigint;
    sourceGasFeeUsd: number;
  }) => {
    if (!address) throw new Error('Wallet not connected');
    setErrorMsg('');

    // ── Requirement 2: construct + sign burn intent ──────────────────────
    setPhase('signing');
    const maxFee = estimateMaxFee(params.amountMicroUsdc, params.sourceGasFeeUsd);
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const saltHex = ('0x' + Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;

    const specRaw = {
      version: 1,
      sourceDomain: params.sourceDomain,
      destinationDomain: ARC_TESTNET_DOMAIN, // Requirement 8.3: always Arc Testnet
      sourceContract: GATEWAY_WALLET_ADDRESS,
      destinationContract: GATEWAY_MINTER_ADDRESS,
      sourceToken: params.sourceUsdcAddress,
      destinationToken: ARC_TESTNET_USDC,
      sourceDepositor: address,
      destinationRecipient: address, // mint to the user's own Arc wallet (Requirement 4.1)
      sourceSigner: address,
      destinationCaller: '0x0000000000000000000000000000000000000000' as const,
      value: params.amountMicroUsdc,
      salt: saltHex,
      hookData: '0x' as const, // confirmed unused by the deployed minter — see design spike note
    };

    const message = {
      maxBlockHeight: (2n ** 256n - 1n).toString(),
      maxFee: maxFee.toString(),
      spec: {
        ...specRaw,
        sourceContract: addressToBytes32(specRaw.sourceContract),
        destinationContract: addressToBytes32(specRaw.destinationContract),
        sourceToken: addressToBytes32(specRaw.sourceToken),
        destinationToken: addressToBytes32(specRaw.destinationToken),
        sourceDepositor: addressToBytes32(specRaw.sourceDepositor),
        destinationRecipient: addressToBytes32(specRaw.destinationRecipient),
        sourceSigner: addressToBytes32(specRaw.sourceSigner),
        destinationCaller: addressToBytes32(specRaw.destinationCaller),
        value: params.amountMicroUsdc.toString(),
      },
    };

    let signature: `0x${string}`;
    try {
      signature = await signTypedDataAsync({
        domain: GATEWAY_EIP712_DOMAIN,
        types: { EIP712Domain, TransferSpec: TransferSpecType, BurnIntent: BurnIntentType },
        primaryType: 'BurnIntent',
        message: message as never,
      });
    } catch (e) {
      setPhase('error');
      setErrorMsg(e instanceof Error ? e.message : 'Signature rejected');
      throw e;
    }

    // ── Requirement 3: submit to Gateway API for attestation ─────────────
    setPhase('submitting');
    let attestation: string, operatorSig: string;
    try {
      const res = await fetch('/api/gateway/transfer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ burnIntent: message, signature }]),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? `Gateway transfer request failed (${res.status})`);
      attestation = json.attestation;
      operatorSig = json.signature;
      if (!attestation || !operatorSig) throw new Error('Gateway API returned no attestation');
    } catch (e) {
      setPhase('error');
      setErrorMsg(e instanceof Error ? e.message : 'Attestation request failed');
      throw e; // Requirement 3.3: no auto-retry with a mutated intent
    }

    // ── Requirement 4.1: mint on Arc using the existing wallet connection ─
    setPhase('minting');
    try {
      const hash = await writeContractAsync({
        address: GATEWAY_MINTER_ADDRESS,
        abi: GATEWAY_MINTER_ABI,
        functionName: 'gatewayMint',
        args: [attestation as `0x${string}`, operatorSig as `0x${string}`],
      });
      setMintTxHash(hash);
      setPhase('done');
      return hash;
    } catch (e) {
      // Requirement 4.5: attestation preserved (still in `attestation`/`operatorSig` scope via closure
      // if the caller retries `mintOnly` below) — caller should offer a "retry mint" action.
      setPhase('error');
      setErrorMsg(e instanceof Error ? e.message : 'Mint transaction failed');
      throw e;
    }
  }, [address, signTypedDataAsync, writeContractAsync]);

  return { transfer, phase, errorMsg, mintTxHash, mintConfirmed };
}
```

Design note on Requirement 4.5 (attestation reuse on mint failure): the hook as sketched above re-derives everything per call. The actual implementation should split `transfer()` into `signAndAttest()` and `mint(attestation, signature)` as two separately callable functions, with the component (`GatewayFundPanel.tsx`) holding the attestation in state between them, so a failed/rejected wallet mint can be retried by re-invoking only `mint(...)` — without re-signing or re-hitting `/v1/transfer`. This will be reflected in the task breakdown as two hook functions, not one combined `transfer()`.

### 6. `app/app/components/GatewayFundPanel.tsx` — new UI panel

Structure (matching existing ArcPay panel conventions seen in `escrow/page.tsx`, `group/page.tsx`):
- Left column: source chain picker (from `GATEWAY_SOURCE_CHAINS`) + amount input + unified balance summary (via `useGatewayBalance`) + a `UsdcBadge` (existing component, reused) next to the amount, consistent with the rest of ArcPay's USDC labeling.
- Right column / step indicator: Sign → Attest → Mint, each showing phase from `useGatewayTransfer`.
- On `phase === 'done'`: a CTA button "Continue to Protected Transfer" / "Continue to Batch Payment" that navigates to the existing, unmodified tabs (`onTabChange('protected')` / `onTabChange('batch')`), satisfying Requirement 4.3 without touching those components.
- Error states surface `errorMsg` inline with a "Retry mint" button when `phase === 'error'` and an attestation was already obtained (Requirement 4.5), vs. a full restart button if signing/attestation itself failed.
- A safety-threshold confirmation dialog before signing if `amount > threshold` (configurable constant, e.g. 100 USDC), per Requirement 8.4.

### 7. Sidebar / HomePanel integration (minimal additive changes)

- `Sidebar.tsx`: add one entry to the existing `NAV_ITEMS` array — `{ tab: 'fund', icon: Globe, label: 'Fund from Any Chain' }` — and one line in `AppTab` type union. This is the only edit to this file; the `NETWORKS` array and everything else stays untouched.
- `app/app/page.tsx`: add one `dynamic()` import for `GatewayFundPanel` and one conditional render line (`{activeTab === 'fund' && <GatewayFundPanel onTabChange={setActiveTab} />}`), following the exact existing pattern for `EscrowContent`/`GroupContent`/etc.
- `HomePanel.tsx`: add one QUICK_ACTIONS entry pointing at the new tab. No existing entries change.

## Data Models

```typescript
// Gateway balance API response shape (per developers.circle.com/api-reference/gateway/all/get-token-balances)
interface GatewayBalancesResponse {
  token: 'USDC';
  balances: { depositor: string; domain?: number; balance: string }[];
}

// Gateway transfer API response shape (per create-transfer-attestation)
interface GatewayTransferResponse {
  transferId: string;
  attestation: string;   // hex bytes, passed to gatewayMint
  signature: string;     // operator signature, passed to gatewayMint
  fees: {
    total: string; token: 'USDC';
    perIntent: { transferSpecHash: string; baseFee: string; transferFee: string }[];
    forwardingFee: string;
  };
  expirationBlock: string;
}

// Burn intent (client-constructed, EIP-712 signed) — field types exactly as Circle's docs
interface BurnIntent {
  maxBlockHeight: string;  // uint256 as decimal string
  maxFee: string;          // uint256 as decimal string, USDC micro-units
  spec: TransferSpec;
}

interface TransferSpec {
  version: 1;
  sourceDomain: number;
  destinationDomain: number;     // always 26 (Arc Testnet) for this integration
  sourceContract: `0x${string}`; // bytes32-padded
  destinationContract: `0x${string}`;
  sourceToken: `0x${string}`;
  destinationToken: `0x${string}`;
  sourceDepositor: `0x${string}`;
  destinationRecipient: `0x${string}`;
  sourceSigner: `0x${string}`;
  destinationCaller: `0x${string}`;
  value: string;    // uint256 as decimal string, USDC micro-units (6 decimals)
  salt: `0x${string}`; // bytes32
  hookData: '0x';      // always empty — confirmed unused by deployed GatewayMinter
}
```

No changes to ArcPay's existing on-chain data models (`EscrowRecord`, `GroupRecord`, `BatchRecord`, `PaymentLinkRecord` in `useHistory.ts`) — Gateway state is entirely separate and not persisted into ArcPay's contract-derived history.

## Correctness Properties

These invariants must hold across the implementation; tests in the Testing Strategy section should target them directly.

### Property 1: No double-spend of a burn intent

Each signed burn intent carries a fresh random `salt`, making its `TransferSpec` hash unique; the same signed intent must never be submitted to `/v1/transfer` twice by ArcPay's client code. The hook must not offer a "resubmit" action that reuses an already-consumed `{burnIntent, signature}` pair — only "retry mint" with the already-issued attestation, or a full restart that generates a new salt.

**Validates: Requirements 2.1, 3.3**

### Property 2: `destinationDomain` is always 26 (Arc Testnet)

No code path in `useGatewayTransfer` or the server routes may construct or forward a burn intent with any other destination domain. This is a hardcoded constant (`ARC_TESTNET_DOMAIN`), not a parameter threaded from user input.

**Validates: Requirements 2.1, 7.3**

### Property 3: Decimal precision is never silently mixed

Any amount displayed, entered, or transmitted in this integration is unambiguously either (a) USDC micro-units (6 decimals, matching Gateway's wire format and Arc's ERC-20 USDC interface) or (b) a human-readable decimal string for display. No code path may treat Arc's native 18-decimal gas balance and the 6-decimal Gateway-minted ERC-20 balance as interchangeable without an explicit, tested conversion.

**Validates: Requirements 4.2, 4.3**

### Property 4: Existing ArcPay contract call sites are never mutated by this feature

No task in this integration edits `app/lib/abi.ts`'s existing entries, removes/renames any existing export from `app/lib/wagmi.ts`, or changes the function signature ArcPay uses to call `createEscrow`/`createTokenEscrow`/`createGroupPayment`/`batchTransfer`/`createPaymentLink`. This is directly verifiable via `git diff` on those files after implementation — the diff should show additions only.

**Validates: Requirements 4.4, 6.1, 6.2, 6.3, 6.4**

### Property 5: An attestation is never used after its validity window

The 10-minute attestation expiry and the mint's own `maxBlockHeight` check (enforced on-chain by `GatewayMinter` per the spike's traced source) together guarantee a stale attestation cannot mint; the UI must not present a "retry mint" action once the client-tracked expiry has passed, even though the contract itself is the final backstop.

**Validates: Requirements 3.5, 4.5**

### Property 6: A failed or partial Gateway flow never leaves ArcPay's existing contract state inconsistent

Because minting (`gatewayMint`) and funding a ProtectedPay action are two separate transactions in this design (no atomic composition), a failure at any step leaves the user with, at worst, USDC sitting in their Arc wallet unspent — never a partially-created escrow/group/batch on the ProtectedPay contract. This is a direct consequence of not modifying ProtectedPay's existing all-or-nothing transaction boundaries.

**Validates: Requirements 4.5, 4.6, 6.5**

## Error Handling

| Failure point | Handling |
|---|---|
| `/v1/balances` request fails | Non-blocking; keep last-known-good balances displayed (Requirement 1.3); show retry affordance |
| Insufficient Gateway balance for requested amount | Blocked client-side before signing (Requirement 2.4); no wasted signature |
| User rejects `signTypedData` | `phase = 'error'`, no API call made, no partial state to clean up |
| `/v1/transfer` returns 4xx (invalid signature, insufficient balance, expired intent) | Surface Circle's exact error message; no auto-retry with mutated intent (Requirement 3.3) |
| Attestation obtained but `gatewayMint` tx rejected/fails | Preserve attestation + signature in component state; offer "retry mint" without re-signing (Requirement 4.5), as long as within the 10-minute attestation expiry (Requirement 3.5) |
| Attestation expires before mint attempted | Detect via `expirationBlock` vs current block, or just catch the mint revert; prompt full restart (re-sign) |
| Mint succeeds but user navigates away before funding ArcPay action | No data loss — USDC is now a normal Arc-native balance in the user's wallet, visible via existing `useHistory`/`useBalance`; they can fund an escrow anytime later through the normal flow |

## Testing Strategy

1. **Unit tests** for `app/lib/gateway.ts` helpers: `addressToBytes32` padding correctness, `estimateMaxFee` formula against Circle's worked example (1,000 USDC from Base, no forwarding → $0.06 min fee) to catch regressions against the documented formula.
2. **Unit tests** for `useGatewayBalance`: mock `/api/gateway/balances`, verify zero-balance chains are filtered (Requirement 1.4), verify balances aren't cleared on a failed refresh (Requirement 1.3).
3. **Integration test** for the two server routes (`/api/gateway/balances`, `/api/gateway/transfer`): mock `fetch` to the real Circle testnet base URL shape, verify request/response pass-through and status code forwarding.
4. **Manual/E2E testnet walkthrough** (since this depends on real testnet USDC and real finality wait times): deposit testnet USDC into GatewayWallet on Base Sepolia via Circle's faucet + deposit flow (outside ArcPay, per Circle's own quickstart), wait for finality, then run the full ArcPay UI flow end-to-end: balance shows up → sign → attest → mint on Arc → confirm balance updates via existing `useHistory` → fund a Protected Transfer via the existing unmodified form.
5. **Regression check**: run ArcPay's existing `npm run build` and manually smoke-test Protected Transfer, Group Split, Batch Payment, Payment Links, and PayBot after the integration lands, confirming zero behavior change (Requirement 7).
6. **Router contract (if Requirement 6 is pursued)**: full Foundry/Hardhat test suite for the new router contract in isolation (mint-then-call atomicity, revert-on-partial-failure per Requirement 6.3) — out of scope for this design doc's core deliverable; would get its own design addendum if greenlit.

## Future Work (not in this build)

**Atomic router contract.** Confirmed via the Requirement 5 spike that Circle's `GatewayMinter` does not execute `hookData` — atomic "mint + fund ProtectedPay" in one transaction would require ArcPay deploying and auditing its own thin router/multicall contract that calls `gatewayMint()` and then `ProtectedPay.createEscrow`/`createTokenEscrow`/`batchTransfer` in the same transaction, per Circle's own guidance ("use a multi-call contract" for composition). This is meaningfully larger scope than the two-step flow (new Solidity contract, its own test suite, its own security review) and is not needed for the core "fund ProtectedPay from any chain" use case, since the two-step flow (sign → relay attestation → mint into the user's Arc wallet → fund ProtectedPay normally) already fully satisfies it. Revisit only if user research shows the extra confirmation step in the two-step flow is a real adoption blocker.
