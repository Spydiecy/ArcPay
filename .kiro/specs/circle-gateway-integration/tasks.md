# Implementation Plan

## Overview

This plan implements the two-step Circle Gateway funding flow for ArcPay (Requirements 1–4, 6, 7 in `requirements.md`; the atomic router-contract path is out of scope per the resolved Requirement 5 spike). Work proceeds config-first, since every later task depends on the constants and chain definitions established in Task 1: burn-intent signing next, then the attestation relay, then the Arc-side mint-into-ProtectedPay hand-off, then the unified-balance/warning-modal frontend UI, finishing with a full non-regression pass and a manual end-to-end testnet walkthrough.

## Task Dependency Graph

Tasks are grouped into waves; every task in a wave depends only on tasks in earlier waves and can be worked in parallel within its own wave.

```json
{
  "waves": [
    { "wave": 1, "tasks": [1], "description": "Config layer — everything else depends on this" },
    { "wave": 2, "tasks": [2, 3, 5, 9], "description": "Config unit tests; burn-intent signing; attestation relay route; balances route — all depend only on Task 1" },
    { "wave": 3, "tasks": [4, 6, 7, 10], "description": "Signing unit tests; relay integration tests; mint+hand-off (depends on 5); balance hook (depends on 9)" },
    { "wave": 4, "tasks": [8, 11], "description": "Mint/hand-off tests (depends on 7); balance hook tests (depends on 10)" },
    { "wave": 5, "tasks": [12], "description": "Fund panel UI — depends on 3, 5, 7, 10 all being complete" },
    { "wave": 6, "tasks": [13], "description": "Dashboard wiring — depends on 12" },
    { "wave": 7, "tasks": [14], "description": "Full regression pass — depends on 13" },
    { "wave": 8, "tasks": [15], "description": "Manual end-to-end testnet walkthrough — depends on 14" }
  ]
}
```

## Tasks

- [x] 1. Config layer: Gateway constants, chain definitions, and safety threshold
  - Create `frontend/app/lib/gateway.ts` with all confirmed, finalized constants: `GATEWAY_API_BASE` (testnet base URL), shared `GATEWAY_WALLET_ADDRESS`/`GATEWAY_MINTER_ADDRESS` (identical across all EVM testnets including Arc, per design doc), Arc destination-only config (`ARC_TESTNET_DOMAIN = 26`, `ARC_TESTNET_USDC`, `ARC_USDC_DECIMALS = 6`), and `GATEWAY_SOURCE_CHAINS` array (Ethereum Sepolia, Avalanche Fuji, OP Sepolia, Arbitrum Sepolia, Base Sepolia, Polygon Amoy — domain IDs and USDC addresses exactly as confirmed in the design doc's address table, no Arc entry in this array since Arc is destination-only)
  - Add `GATEWAY_WARN_THRESHOLD_USDC` constant reading from `process.env.NEXT_PUBLIC_GATEWAY_WARN_THRESHOLD_USDC`, defaulting to `25`
  - Add the EIP-712 type definitions (`EIP712Domain`, `TransferSpecType`, `BurnIntentType`) and `GATEWAY_EIP712_DOMAIN` copied verbatim from Circle's documentation — do not modify field names, types, or ordering
  - Add `GATEWAY_MINTER_ABI` (just `gatewayMint(bytes,bytes)`)
  - Implement `addressToBytes32(address: string): \`0x\${string}\`` helper (pads 20-byte address to 32 bytes)
  - Implement `estimateMaxFee(amountMicroUsdc: bigint, sourceGasFeeUsd: number, bufferPct?: number): bigint` per Circle's documented fee formula (`maxFee >= gasFee + (amount * 0.00005)`, plus buffer)
  - Add `NEXT_PUBLIC_GATEWAY_WARN_THRESHOLD_USDC=25` to `frontend/.env.local`
  - _Requirements: 2.1, 2.2, 2.5, 7.3, 7.4, 7.5_

- [x] 2. Unit tests for the config/helper layer
  - Test `addressToBytes32` against known input/output pairs (e.g. a 20-byte address correctly left-padded to 32 bytes)
  - Test `estimateMaxFee` against Circle's worked example from the fee docs (1,000 USDC from Base, no forwarding → minimum maxFee of 60,000 micro-USDC before buffer)
  - Test that `GATEWAY_SOURCE_CHAINS` contains no entry with `domain === ARC_TESTNET_DOMAIN` (enforces Property 2's "Arc is destination-only" invariant at the config level)
  - _Requirements: 2.1, 2.5, 7.3_
  - _Properties: 2_

- [x] 3. Burn intent construction and EIP-712 signing hook (client-side, existing wallet connection)
  - Create `frontend/app/hooks/useGatewayTransfer.ts`
  - Implement `signBurnIntent(params: { sourceDomain, sourceUsdcAddress, amountMicroUsdc, sourceGasFeeUsd })` that: constructs the `TransferSpec` with `destinationDomain` hardcoded to `ARC_TESTNET_DOMAIN`, `destinationContract`/`destinationToken` hardcoded to the Arc Minter/USDC constants, `hookData` hardcoded to `'0x'`, a fresh random 32-byte `salt` per call, and `destinationRecipient`/`sourceDepositor`/`sourceSigner` all set to the connected wallet's own address
  - Pad all address fields to bytes32 via `addressToBytes32` before constructing the typed-data message
  - Call `signTypedDataAsync` (wagmi) with the exact domain/types from `gateway.ts` — this uses the existing wallet connection already used elsewhere in ArcPay, no new wallet stack
  - Return the signed `{burnIntent, signature}` pair plus a `phase` state (`idle | signing | signed | error`) and `errorMsg`
  - Add a pre-signature balance check: block signing and show an error if the requested amount exceeds the available unified balance for the selected source chain (do not request a signature for an intent that will fail)
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6_
  - _Properties: 1, 2_

- [x] 4. Unit tests for burn intent construction
  - Verify `destinationDomain` in every constructed spec is always `26`, regardless of input source domain (Property 2)
  - Verify a fresh `salt` is generated on every call (no salt reuse across two calls with identical params) (Property 1)
  - Verify the pre-signature balance check blocks signing when amount exceeds available balance, without calling `signTypedDataAsync`
  - _Requirements: 2.1, 2.4_
  - _Properties: 1, 2_

- [x] 5. Server-side attestation relay route
  - Create `frontend/app/api/gateway/transfer/route.ts` as a thin POST proxy to `${GATEWAY_API_BASE}/v1/transfer`, forwarding the `[{burnIntent, signature}]` body verbatim (with bigint-safe JSON serialization) and returning Circle's response status and body unmodified — no retry logic, no request mutation
  - Wire `useGatewayTransfer`'s next phase (`submitting`) to call this route after a successful signature, parse `{transferId, attestation, signature, fees, expirationBlock}` from the response, and surface Circle's exact error message on non-2xx responses
  - Track the attestation's issuance time client-side and treat it as expired after 10 minutes (per Circle's documented attestation expiry), disabling any "retry mint" action past that window
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_
  - _Properties: 1, 5_

- [x] 6. Integration tests for the attestation relay route
  - Mock `fetch` to `gateway-api-testnet.circle.com/v1/transfer`; verify the route forwards the request body unchanged and passes through both success (201) and error (4xx/5xx) responses with their original status codes and bodies
  - Verify the hook does not auto-retry with a mutated burn intent on a 4xx response (Property 1)
  - Verify the client-side 10-minute expiry check correctly disables retry-mint after the window elapses (using a fake clock)
  - _Requirements: 3.3, 3.5_
  - _Properties: 1, 5_

- [x] 7. Arc-side mint execution and funding hand-off into ProtectedPay
  - `useGatewayTransfer.ts` already has a separately callable `mint(attestation, signature)` function (decoupled from signing/attestation so a failed/rejected mint can be retried without re-signing, per Property 5/6) — this task wires its output into the existing dashboard, no further hook changes expected
  - **Decimals boundary resolved via Arc's official docs + live on-chain confirmation** (see design doc): the native (18-decimal) and ERC-20 (6-decimal) USDC interfaces at `0x3600...0000` share the exact same underlying balance — an ERC-20 mint (what `GatewayMinter._mint()` performs) directly increases the recipient's native `msg.value` balance too, just at a different decimal scale. Gateway-minted USDC is immediately usable as native balance for `createEscrow`/`createGroupPayment`/`batchTransfer` — no `createTokenEscrow` routing needed
  - Use the new `microUsdcToNativeWei`/`nativeWeiToMicroUsdc` helpers in `gateway.ts` at any point this integration converts between Gateway's 6-decimal wire format and ArcPay's existing 18-decimal `parseEther`/`formatEther` amount handling — never assume the two are interchangeable without going through these helpers
  - On mint confirmation, trigger ArcPay's existing balance-refresh mechanism (reuse the existing `useHistory`/`useBalance` refresh call — do not introduce a parallel balance source)
  - Do not modify `app/lib/abi.ts`, `app/lib/wagmi.ts`'s existing exports, or any existing ProtectedPay call site to accomplish this — the hand-off is: mint completes → existing unmodified Protected Transfer/Batch Payment form opens, pre-aware of the new balance, user submits it as a normal, separate transaction
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_
  - _Properties: 3, 4, 6_

- [x] 8. Unit/integration tests for mint execution and hand-off
  - Verify `mint()` can be called independently of `signBurnIntent()` given a pre-existing `{attestation, signature}` pair (Property 5's "retry mint without re-signing" requirement)
  - Verify a failed `writeContractAsync` call leaves `phase` in a retryable error state without clearing the held attestation/signature (until the 10-minute expiry check trips)
  - Verify the balance-refresh call after mint confirmation reuses the existing `useHistory`/`useBalance` refresh function (via mock/spy) rather than a new parallel implementation
  - Run `git diff` against `app/lib/abi.ts` and `app/lib/wagmi.ts` after this task and confirm zero modifications to pre-existing lines (Property 4) — add this check as a documented manual verification step, since it isn't expressible as a runtime unit test
  - _Requirements: 4.4, 4.5, 6.1, 6.4_
  - _Properties: 4, 5, 6_

- [x] 9. Server-side unified balance route
  - Create `frontend/app/api/gateway/balances/route.ts` as a thin POST proxy to `${GATEWAY_API_BASE}/v1/balances`, accepting `{address}` and forwarding `{token: 'USDC', sources: [{depositor: address}]}` to Circle, returning the response verbatim
  - _Requirements: 1.1_

- [x] 10. Unified balance hook
  - Create `frontend/app/hooks/useGatewayBalance.ts`
  - On wallet connection, call `/api/gateway/balances`, filter out zero-balance chains from the result (Requirement 1.4), map each `domain` to its `GATEWAY_SOURCE_CHAINS` label, and compute an aggregate total
  - Cache successful responses for 30 seconds (`lastFetchRef` timestamp check) before allowing another automatic fetch; expose a `refresh(force: true)` for manual refresh that bypasses the cache
  - On a failed fetch, preserve the last-known-good `balances` state rather than clearing it, and surface a non-blocking `error` string separately (Requirement 1.3)
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 11. Unit tests for the unified balance hook
  - Mock `/api/gateway/balances` returning a mix of zero and non-zero balances; verify zero-balance chains are excluded from the returned array (Requirement 1.4)
  - Mock a failing fetch after a prior successful fetch; verify `balances` remains the prior successful value and `error` is set (Requirement 1.3)
  - Verify a second `refresh()` call within 30 seconds of the first does not trigger a new fetch, while `refresh(force: true)` (or the equivalent forced path) does
  - _Requirements: 1.2, 1.3, 1.4, 1.5_

- [x] 12. Fund panel UI: unified balance view, chain/amount picker, and safety-threshold warning modal
  - Create `frontend/app/app/components/GatewayFundPanel.tsx`
  - Render the unified balance breakdown (per-chain rows + aggregate total) from `useGatewayBalance`, with a manual refresh control and a non-blocking inline notice on `error` (balance view must never block or hide on a transient failure)
  - Render a source-chain picker (from `GATEWAY_SOURCE_CHAINS`) and an amount input; reuse the existing `UsdcBadge` component next to the amount for visual consistency with the rest of ArcPay
  - Before invoking `signBurnIntent`, compare the entered amount against `GATEWAY_WARN_THRESHOLD_USDC`; if exceeded, show a confirmation modal requiring explicit user confirmation before proceeding to signing (Requirement 7.4) — this must not block amounts at or below the threshold
  - Wire the three-phase flow (sign → relay/attest → mint) to `useGatewayTransfer`'s state, rendering each phase's status and any `errorMsg`
  - On `phase === 'error'` after a successful attestation, show a "Retry mint" action calling `mint()` again with the held attestation; on a signing/attestation failure, show a full-restart action instead
  - On successful mint, show a "Continue to Protected Transfer" / "Continue to Batch Payment" CTA that calls the existing `onTabChange('protected' | 'batch')` — do not alter those target components
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.3, 2.6, 4.3, 4.5, 7.4_
  - _Properties: 5, 6_

- [x] 13. Wire the new panel into the dashboard navigation (minimal additive edits only)
  - In `frontend/app/app/components/Sidebar.tsx`: add exactly one new entry to the existing `NAV_ITEMS` array (e.g. `{ tab: 'fund', icon: Globe, label: 'Fund from Any Chain' }`) and extend the `AppTab` union type with `'fund'` — do not reorder, rename, or remove any existing entry
  - In `frontend/app/app/page.tsx`: add one `dynamic()` import for `GatewayFundPanel` and one conditional render line (`{activeTab === 'fund' && <GatewayFundPanel onTabChange={setActiveTab} />}`), following the exact existing pattern used for `EscrowContent`/`GroupContent`/etc. — do not modify any existing conditional render line
  - In `frontend/app/app/components/HomePanel.tsx`: add one entry to `QUICK_ACTIONS` pointing at the new `'fund'` tab — do not modify any existing entry
  - _Requirements: 6.1, 6.2, 6.4_
  - _Properties: 4_

- [x] 14. Full regression pass against existing ArcPay functionality
  - `npm run build` passes clean (zero type errors); full `npm run test` suite passes (33/33)
  - `git diff --stat` against `app/lib/abi.ts`, `app/lib/wagmi.ts`, `app/api/agent/route.ts`, `app/hooks/useHistory.ts` confirmed **zero changes** to all four (Property 4 holds); `git diff` on the three files Task 13 was allowed to touch (`Sidebar.tsx`, `HomePanel.tsx`, `app/page.tsx`) confirmed every change is additive-only (one import + one array entry + one conditional render line each)
  - Smoke-tested via a live dev server: `/`, `/app`, `/escrow`, `/group`, `/batch`, `/links`, `/profile` all return 200 with no compile or runtime errors in the server log; `/api/agent` (PayBot) responds 200
  - Note: this confirms pages load and render without error, but full interactive smoke-testing (actually submitting a Protected Transfer, registering a username, etc.) still requires a connected wallet with testnet funds, which is out of scope for automated verification — deferred to Task 15's manual walkthrough
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  - _Properties: 4_

- [ ] 15. End-to-end testnet walkthrough (manual, requires real testnet USDC)
  - Using Circle's faucet and deposit flow (outside ArcPay, per Circle's own quickstart), deposit testnet USDC into `GatewayWallet` on at least one source chain (e.g. Base Sepolia) and wait for finality
  - In the running ArcPay app: confirm the unified balance panel shows the deposited amount, sign a burn intent for a portion of it, confirm the attestation is obtained, confirm the mint transaction succeeds on Arc Testnet, confirm ArcPay's existing balance display updates, then continue into the existing Protected Transfer form and successfully fund a real escrow using the newly minted USDC
  - Confirm the observed decimal behavior at the mint hand-off matches the documented expectation (native/ERC-20 shared balance, per Arc's docs) — this is a confirmation step, not open discovery, since the behavior is already documented and independently verified on-chain during design
  - _Requirements: 1.1, 2.1, 3.1, 4.1, 4.2, 4.3_
  - _Properties: 3, 6_

## Notes

- **No task in this plan touches `app/lib/abi.ts`'s existing entries, `app/lib/wagmi.ts`'s existing exports, `app/api/agent/route.ts`, or `app/hooks/useHistory.ts`.** Every file created is new; every edit to an existing file (Task 13 only) is additive-only, verified explicitly in Task 14.
- **Task 7's decimals question is resolved, not open.** Arc's official "Stablecoin native model" docs plus a live on-chain check (`decimals()` call against `0x3600...0000` on Arc Testnet, returning `6`, and confirming the `mint`/`balanceOf` selectors exist in the deployed bytecode) confirm the native and ERC-20 USDC interfaces share the same underlying balance. Gateway-minted USDC lands as native-spendable balance immediately — funding `createEscrow` directly works, no `createTokenEscrow` detour needed. Use `microUsdcToNativeWei`/`nativeWeiToMicroUsdc` from `gateway.ts` for the unit conversion.
- **The router/atomic-composition path (former Requirement 6) has zero tasks in this plan by design.** If it's revisited later, it needs its own requirements/design/tasks pass, including a Solidity test suite and security review, per the design doc's Future Work section.
- **Testnet-only throughout.** No task in this plan targets mainnet contract addresses or the mainnet Gateway API base URL; that would require a separate, explicitly-scoped follow-up per Requirement 7.5.
