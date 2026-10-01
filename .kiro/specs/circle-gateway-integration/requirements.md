# Requirements Document

## Introduction

This feature adds Circle Gateway support to ArcPay, letting a user fund a Protected Transfer or Batch Payment on Arc Testnet using USDC that currently sits on any Gateway-supported source chain (Ethereum, Base, Arbitrum, Optimism, Avalanche, Polygon, etc.), without manually bridging first. Arc Testnet is always the destination domain; ArcPay's existing `ProtectedPay` contract is untouched and only ever receives already-minted native/ERC-20 USDC on Arc. The integration is purely additive: no existing ArcPay contract call sites, ABI entries, hooks, or PayBot configuration are modified.

## Glossary

- **Gateway**: Circle's cross-chain unified USDC balance system, consisting of `GatewayWallet` (deposit-side, per source chain) and `GatewayMinter` (mint-side, per destination chain) contracts plus an off-chain attestation API.
- **Burn intent**: An EIP-712 typed message, signed by the depositor's wallet, authorizing Circle's Gateway system to burn a specified USDC amount from the depositor's Gateway balance on a source chain.
- **Attestation**: A signed proof issued by Circle's Gateway API in response to a valid burn intent, submitted to `GatewayMinter.gatewayMint()` on the destination chain to mint the corresponding USDC.
- **Domain**: Circle's numeric chain identifier used by both CCTP and Gateway (not the same as an EVM chain ID). Arc Testnet's domain is `26`.
- **hookData**: A field in Gateway's `TransferSpec` struct reserved for "arbitrary bytes... used for onchain composition." Confirmed via this document's Requirement 5 spike to be unused by the deployed `GatewayMinter` contract.
- **Unified balance**: The aggregated view of a depositor's available USDC across all Gateway source chains, queried via Circle's `/v1/balances` API.

## Research basis

The requirements below are grounded in official Circle documentation fetched directly on the date of writing:
- https://developers.circle.com/gateway
- https://developers.circle.com/gateway/howtos/transfer-unified-usdc-balance
- https://developers.circle.com/gateway/references/technical-guide
- https://developers.circle.com/gateway/references/contract-interfaces-and-events
- https://developers.circle.com/gateway/references/contract-addresses
- https://developers.circle.com/gateway/references/supported-blockchains
- https://developers.circle.com/gateway/references/fees
- https://developers.circle.com/gateway/references/forwarding-service
- https://developers.circle.com/api-reference/gateway/all/create-transfer-attestation
- https://developers.circle.com/api-reference/gateway/all/get-token-balances
- https://developers.circle.com/api-reference/gateway/all/estimate-transfer
- https://developers.circle.com/gateway/quickstarts/unified-balance-evm
- https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-gateway/SKILL.md

### Key confirmed facts

- **GatewayWallet** (testnet, all EVM chains incl. Arc Testnet): `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`
- **GatewayMinter** (testnet, all EVM chains incl. Arc Testnet): `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B`
- **Arc Testnet domain ID**: `26`. **Arc Testnet native USDC address**: `0x3600000000000000000000000000000000000000`
- Attestation API: `POST https://gateway-api-testnet.circle.com/v1/transfer` — body `[{burnIntent, signature}]`, response `{transferId, attestation, signature, fees, expirationBlock}`
- Balance API: `POST https://gateway-api-testnet.circle.com/v1/balances` — body `{token: "USDC", sources: [{depositor, domain?}]}`
- EIP-712 domain: `{ name: "GatewayWallet", version: "1" }`. `TransferSpec` has 14 fields (see design doc); all address fields signed as `bytes32`-padded.
- Transfer is instant (<500ms) **only after** the source-chain deposit has finalized. Finality time varies drastically: Arc/Sei/HyperEVM ≈0.5–5s, Avalanche/Polygon/Sonic ≈8s, **Ethereum/Base/Arbitrum/Optimism/Unichain/World Chain ≈13–19 minutes**.
- Fees: 0.005% transfer fee (cross-chain only) + a per-chain gas fee (e.g. Base $0.01, Ethereum $1.00) + optional Forwarding Service fee ($0.05 + destination gas) if Circle submits the mint for you.
- Deposits must use `deposit`, `depositFor`, `depositWithPermit`, or `depositWithAuthorization` on GatewayWallet. A raw ERC-20 `transfer` to GatewayWallet **permanently loses funds**.

### Spike resolved — hookData confirmed unused, atomic router contract out of scope

Your original plan assumed `hookData` lets `GatewayMinter.gatewayMint()` atomically call into `ProtectedPay`'s deposit function in the same transaction. The Requirement 5 spike (below) pulled the actual verified `GatewayMinter`/`Mints.sol` source deployed on Arc Testnet from Arcscan and confirmed `hookData` is never read by the mint path — it only affects the signed struct's hash. Per your decision, the atomic router-contract path is **out of scope for this build** (it would require ArcPay deploying and auditing new, unaudited contract code, which isn't justified for a feature the two-step flow already delivers). The two-step flow (Requirements 1–4) is the entire scope of this build. See the design doc's "Future Work" section for the router contract as a possible later enhancement.

---

## Requirements

### Requirement 1: Unified balance visibility

**User Story:** As an ArcPay user, I want to see how much USDC I hold across all Gateway-supported chains in one place, so that I can decide whether to fund an ArcPay action from my existing multi-chain USDC instead of bridging manually first.

#### Acceptance Criteria

1. WHEN a user connects a wallet on the ArcPay dashboard THEN the system SHALL query the Gateway `/v1/balances` API for that wallet address across all Gateway-supported source domains.
2. WHEN the balances API responds successfully THEN the system SHALL display a per-chain breakdown (chain name, available USDC amount) and a single aggregated "Unified Balance" total, without altering any existing balance displays (native Arc balance, ArcPay contract balances) already present on the dashboard.
3. IF the balances API request fails or times out THEN the system SHALL show the existing native-chain balance UI unaffected and display a non-blocking notice that the unified balance is unavailable, retryable via manual refresh.
4. WHEN a user's unified balance on a given source chain is zero THEN the system SHALL omit that chain from the visible breakdown rather than showing a zero-value row.
5. THE system SHALL cache balance responses for a short duration (no more than 30 seconds) to avoid redundant API calls on repeated renders, consistent with the retry/caching pattern already used for on-chain reads elsewhere in ArcPay.

### Requirement 2: Signing a burn intent from an existing wallet connection

**User Story:** As an ArcPay user, I want to authorize moving my USDC from a source chain to Arc using my already-connected wallet, so that I don't need a separate wallet connection step or a new signing flow to learn.

#### Acceptance Criteria

1. WHEN a user selects a source chain and an amount from their unified balance view THEN the system SHALL construct a `BurnIntent` object with `spec.sourceDomain` set to the selected chain's Gateway domain ID and `spec.destinationDomain` set to `26` (Arc Testnet), using the exact EIP-712 type definitions (`EIP712Domain`, `TransferSpec`, `BurnIntent`) and domain separator (`{name: "GatewayWallet", version: "1"}`) published by Circle, without modification to field names, types, or ordering.
2. WHEN constructing the burn intent THEN the system SHALL set `sourceContract` and `destinationContract` to the GatewayWallet and GatewayMinter addresses respectively for the relevant network (testnet addresses for Arc Testnet integration), `sourceToken`/`destinationToken` to the correct USDC address per chain, and pad all address fields to `bytes32` per the documented encoding.
3. WHEN the user confirms the intended transfer amount and destination THEN the system SHALL request the user's signature via `signTypedData` using the existing wagmi/viem wallet connection already used elsewhere in ArcPay, and SHALL NOT introduce a parallel wallet connection stack.
4. IF the user has insufficient available Gateway balance on the selected source chain for the requested amount THEN the system SHALL block intent construction and display an error before requesting a signature.
5. THE system SHALL set `maxFee` to a value that satisfies `gas fee + transfer fee (0.005% of amount) [+ forwarding fee if applicable]`, with a safety buffer, per Circle's documented fee formula, and SHALL NOT hardcode a fee value that could cause attestation rejection on fee fluctuation.
6. THE system SHALL require the user to explicitly confirm source chain, destination (always Arc Testnet), and amount before signing, and SHALL default all flows to testnet contract addresses and Arc Testnet as the only destination, consistent with ArcPay's current Arc-Testnet-only chain configuration.

### Requirement 3: Submitting the signed intent and obtaining an attestation

**User Story:** As an ArcPay user, I want my signed transfer request submitted to Circle automatically after I sign, so that I don't need to manually call any API or manage the attestation myself.

#### Acceptance Criteria

1. WHEN a user has signed a burn intent THEN the system SHALL submit `{burnIntent, signature}` (as an array per the documented request shape) to `POST https://gateway-api-testnet.circle.com/v1/transfer` from a server-side route (not directly from the browser), consistent with ArcPay's existing pattern of routing chain-sensitive logic through `app/api/*` routes.
2. WHEN the Gateway API responds with HTTP 201 and a body containing `transferId`, `attestation`, and `signature` THEN the system SHALL surface these values to the client for the subsequent mint step.
3. IF the Gateway API responds with an error (4xx/5xx) THEN the system SHALL display the specific failure reason to the user (e.g., insufficient balance, invalid signature, expired intent) and SHALL NOT retry automatically with a mutated burn intent, since burn intents are single-use and signature-bound.
4. IF the burn intent's implied balance requirement was invalidated between signing and submission (e.g., a concurrent transfer already spent the balance) THEN the system SHALL surface the resulting Gateway API error rather than silently failing.
5. THE system SHALL treat the returned attestation as valid for at most 10 minutes per Circle's documented expiration, and SHALL warn the user if they attempt to proceed with the mint step after that window and prompt re-signing instead.

### Requirement 4: Minting on Arc and funding the ArcPay action (two-step, non-atomic path)

**User Story:** As an ArcPay user, I want the minted USDC to land in my Arc wallet and then be usable to create a Protected Transfer or Batch Payment, so that I can fund ArcPay features with USDC that started on any supported chain, even if that requires two separate transactions.

#### Acceptance Criteria

1. WHEN an attestation has been obtained THEN the system SHALL call `gatewayMint(attestationPayload, signature)` on the Arc Testnet `GatewayMinter` contract (`0x0022222ABE238Cc2C7Bb1f21003F0a260052475B`) using the user's connected wallet, minting USDC to the `destinationRecipient` specified in the original burn intent (the user's own Arc address).
2. WHEN the mint transaction is confirmed on Arc THEN the system SHALL refresh the user's Arc-native USDC balance display using ArcPay's existing balance-refresh mechanism (the same `useHistory`/`useBalance` pattern already in place), without introducing a separate, inconsistent balance source.
3. WHEN the mint completes THEN the system SHALL present the user with the existing, unmodified Protected Transfer / Batch Payment creation form pre-filled with the newly available balance context, requiring the user to submit that as a normal, separate transaction using ArcPay's existing `createEscrow` / `createTokenEscrow` / `batchTransfer` contract calls.
4. THE system SHALL NOT modify, wrap, or bypass any existing ProtectedPay contract function signatures, ABI entries, or call sites as part of this integration.
5. IF the mint transaction fails or is rejected by the user's wallet THEN the system SHALL preserve the obtained attestation (within its validity window) and allow the user to retry the mint call without re-signing or re-submitting to the Gateway API, since the same attestation can be reused until it expires or is consumed.
6. THIS two-step flow (mint-to-wallet, then separate ArcPay transaction) SHALL be the default, always-available funding path, independent of whether Requirement 5/6's atomic path is ever implemented.

### Requirement 5: Verification spike for atomic hookData-based composition (resolved)

**User Story:** As the ArcPay team, we want to definitively confirm whether Circle's Gateway contracts support atomic mint-plus-call execution via `hookData` before designing around it, so that we don't build a design that depends on an unsupported or undocumented feature.

#### Acceptance Criteria

1. THE system SHALL NOT proceed to design or implement an atomic hookData-based funding path until a verification spike confirms, via the actual verified `GatewayMinter` contract source/ABI on Arc Testnet (`0x0022222ABE238Cc2C7Bb1f21003F0a260052475B`), that `hookData` is decoded and executed as a callback by the minter contract itself.
2. THE spike SHALL check the block explorer (Arcscan) verified source for `GatewayMinter` for any function that parses `hookData` into a target address/call payload and executes it, and SHALL check the `circlefin/evm-gateway-contracts` GitHub repository directly for the `Attestations.sol` / minter implementation to confirm or refute hookData execution semantics.
3. **RESOLVED:** The spike traced the deployed `Mints.sol`/`_mint()` implementation and confirmed `hookData` is never read by the mint path. Only six `TransferSpec` fields (`recipient`, `value`, `token`, `sourceDomain`, `sourceDepositor`, `sourceSigner`) are used; `IMintableToken(minter).mint(recipient, value)` is called with no reference to `hookData`.
4. **DECISION:** Given the confirmed absence of native hookData execution, and per explicit direction, the atomic composition path (a custom ArcPay-owned router/multicall contract) is **out of scope** for this build. It is documented as a possible future enhancement only, not a requirement of this integration.
5. THE spike's findings ARE documented in the design doc's spike-result section.

### Requirement 6: Non-regression of existing ArcPay functionality

**User Story:** As an existing ArcPay user, I want all currently working features to continue working exactly as before, so that this new integration doesn't introduce risk to Protected Transfer, Group Split, Batch Payment, Payment Links, PayBot, Username Registry, or transaction history.

#### Acceptance Criteria

1. THE system SHALL implement all Gateway integration code as new, additive files/routes/components, and SHALL NOT modify `app/lib/abi.ts`, `app/lib/wagmi.ts`'s existing exports, or any existing ProtectedPay contract call site, except to add new exports alongside existing ones.
2. THE system SHALL NOT change the existing same-chain funding path for Protected Transfer, Group Split, Batch Payment, or Payment Links; the Gateway-based funding option SHALL be presented as an additional, clearly labeled alternative entry point only.
3. THE system SHALL NOT alter PayBot's existing system prompt, tool definitions, or chain configuration in `app/api/agent/route.ts` as part of this integration, unless a future, separately scoped task explicitly adds Gateway-awareness to PayBot.
4. THE system SHALL NOT alter the Username Registry, transaction history (`useHistory`), or any existing on-chain read/write hooks except to add new, independent hooks for Gateway balance/transfer state.
5. WHEN the Gateway integration encounters an error at any step THEN the system SHALL fail gracefully without affecting the rest of the ArcPay dashboard's rendering or state.

### Requirement 7: Security and secret handling

**User Story:** As the ArcPay team, we want the Gateway integration to follow the same security posture as the rest of ArcPay, so that no new class of vulnerability or key exposure is introduced.

#### Acceptance Criteria

1. THE system SHALL NOT require or store any private key, entity secret, or Circle API key for the core self-managed-wallet flow described in Requirements 1–4, since the burn intent is signed client-side by the user's own connected wallet.
2. IF a server-side relayer/forwarding component is introduced for the destination mint (as an optional convenience, not required by Requirements 1–4) THEN any credentials it uses SHALL be stored as environment variables consistent with ArcPay's existing `.env.local` pattern, and SHALL NEVER be logged or exposed to the client.
3. THE system SHALL validate that `destinationDomain` is always `26` (Arc Testnet) before submitting any burn intent, to prevent misdirected transfers to unintended chains.
4. THE system SHALL warn the user before signing if the requested transfer amount exceeds a configurable safety threshold (default 25 USDC, exposed as the `NEXT_PUBLIC_GATEWAY_WARN_THRESHOLD_USDC` environment variable so it can be raised for a mainnet pass without touching the warning logic itself), consistent with the general caution Circle's own tooling documentation recommends for high-value transfers.
5. THE system SHALL default to and validate testnet contract addresses and the testnet Gateway API base URL (`gateway-api-testnet.circle.com`) throughout, and SHALL require an explicit, separate configuration change (not a default) to target mainnet addresses or the mainnet API base URL (`gateway-api.circle.com`).
