# ArcPay: The Trust Layer for Crypto Payments

**Trustless payment infrastructure on Arc Testnet. No middlemen. No broken promises.**

📊 [Pitch Deck](https://canva.link/h8tqd13woyj1ycp) · 🐦 [Follow on X](https://x.com/arcpay_)

---

## The Problem

Sending crypto to someone you don't fully trust is still a broken experience.

You send funds — and then what? You hope they deliver. You hope they don't disappear. You hope the address was right. There's no recourse, no protection, no way to coordinate a group payment without someone holding the bag.

ArcPay puts the smart contract in charge instead of people.

---

## What We Built

ArcPay is a payment infrastructure layer built as an EVM smart contract deployed on Arc Testnet, plus a cross-chain funding layer on top. Eight payment primitives that give users real protection:

### 🔒 Protected Transfer (Native + ERC-20)
Lock funds in a smart contract. The recipient claims when ready. If they don't — you get it back. Works for USDC (Arc's native gas and settlement currency) and any ERC-20 token. No escrow service, no third party. The contract is the escrow.

### 👥 Group Split
Need to pool money from multiple people before paying someone? Set a total, set a participant count, and let contributors join. The moment the last person pays in, the full amount auto-releases. Creator can cancel anytime and everyone gets refunded. Contributors can withdraw their share individually too.

### ⚡ Batch Payment
One transaction. Multiple recipients. Different amounts. All atomic — either every transfer succeeds, or none do. Built for payroll, airdrops, and bulk payouts.

### 🔗 Payment Links
Create a shareable link or QR code for any payment — fixed amount or open amount. Anyone with the link can pay directly from a browser. Once paid, both parties can download a PDF invoice with full receipt details including transaction hash.

### 🌐 Username Registry
Addresses are 42 characters of anxiety. Register a human-readable username on-chain. Anyone can resolve @yourname to your address instantly. Works across all features.

### 🔀 Fund from Any Chain (Circle Gateway)
Already holding USDC on Ethereum, Base, Arbitrum, Optimism, Avalanche, or Polygon? No need to bridge manually first. Deposit into Circle's Gateway from the source chain, then sign a transfer request — Circle relays an attestation and you mint the USDC directly into your Arc Testnet balance, ready to fund a protected transfer, group split, or batch payment. Testnet-only for now, with a built-in safety-threshold warning before signing large transfers.

### 🤖 PayBot — AI Payment Assistant
Ask PayBot anything in plain English. It reads your on-chain history, resolves usernames, checks your Gateway balance across chains, explains features, and — most importantly — executes real transactions directly from the chat. Say "send 1 USDC to @alice as escrow" and a wallet confirmation popup appears instantly. Powered by Mistral AI via Vercel AI SDK.

### 📜 Transaction History
Full on-chain history across all features — protected transfers, token escrows, group splits, batch payments, and payment links — with expandable details, copyable addresses, username resolution, and timestamps.

---

## Deployed on Arc Testnet

| Property | Value |
|---|---|
| Contract Address | `0xCa36dD890F987EDcE1D6D7C74Fb9df627c216BF6` |
| Network | Arc Testnet |
| Chain ID | `5042002` |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | [testnet.arcscan.app](https://testnet.arcscan.app) |
| Gas Token | USDC |

Arc is currently testnet-only — there is no mainnet yet. The app ships with a network switcher in the sidebar so additional networks (like an eventual Arc Mainnet) can be added without reworking the UI.

---

## Why Arc Testnet

Arc is an EVM-compatible Layer-1 blockchain purpose-built for stablecoin finance, using USDC as its native gas and settlement currency instead of a volatile token. ArcPay runs natively on Arc because:

- **USDC as gas** — every transaction uses USDC, so transaction costs are denominated in dollars, not a volatile native asset.
- **EVM-compatible** — full Ethereum tooling. Same Solidity contract, same wallet experience.
- **On-chain identity** — the username registry is fully on-chain, queryable directly from the contract.
- **Non-custodial** — no admin key, no upgrade mechanism, no pause function.

---

## Network Selector

The dashboard includes a network selector in the sidebar. Right now Arc Testnet is the only live network, but the switcher UI is kept in place for when more networks (e.g. Arc Mainnet) come online — the contract address updates automatically based on the selected network.

---

## What Makes This Different

Most "escrow" tools are custodial. A company holds your funds. ArcPay has no company in the loop — the contract code is the only authority. Open source. Verifiable on-chain.

Most "batch payment" tools send multiple transactions. ArcPay's batch is a single atomic transaction — if one transfer fails, the entire batch reverts. No partial payouts.

Most "group payment" flows require someone to collect money and then pay out. ArcPay's group split holds funds in the contract until the threshold is met, then releases automatically. Nobody can run with the money.

Most payment apps that support "multiple chains" mean you have to manually bridge first, on a separate site, before you can use your funds. ArcPay's Gateway integration does the bridging step for you — deposit once, sign a transfer, and the USDC is usable on Arc immediately.

---

## Security

- **CEI pattern** on every state-changing function — reentrancy structurally impossible
- **Checked arithmetic** throughout — no overflow risks
- **Access control** on every sensitive operation — only sender can refund, only recipient can claim
- **Atomic batch execution** — entire batch reverts if any single transfer fails
- **Non-custodial by design** — no admin key, no upgrade mechanism, no pause function

---

## The Stack

| Layer | Technology |
|---|---|
| Smart Contract | Solidity 0.8.24 (EVM) |
| Blockchain | Arc Testnet (Chain ID: 5042002) |
| Gas Token | USDC |
| Frontend | Next.js 16, TypeScript |
| Wallet | RainbowKit v2 (MetaMask, Rainbow, WalletConnect, Coinbase, Trust) |
| Chain SDK | wagmi v2 + viem v2 |
| AI Assistant | PayBot — Mistral Large via Vercel AI SDK with tool-calling |
| Cross-Chain Funding | Circle Gateway (testnet) — EIP-712 burn intents, attestation relay, on-chain mint |
| Invoice | Canvas API — PDF receipts, zero dependencies |
| Styling | CSS custom properties, dark/light theme |

---

## Features

- ✅ Protected transfers — native USDC with claim and refund
- ✅ ERC-20 token escrow — approve once, create, claim or refund
- ✅ Group split payments — auto-release, contributor tracking, individual withdrawals
- ✅ Atomic batch transfers — one tx, multiple recipients
- ✅ Payment links with QR codes and downloadable PDF invoices
- ✅ On-chain username registry with @mention resolution
- ✅ Fund from Any Chain — Circle Gateway cross-chain USDC funding (6+ source chains)
- ✅ PayBot AI — natural language interface, executes real transactions from chat, checks Gateway balances
- ✅ Full transaction history across all feature types
- ✅ Live USDC balance display
- ✅ Network selector — ready for additional networks beyond Arc Testnet
- ✅ Multi-wallet support via RainbowKit
- ✅ Light and dark mode
- ✅ Mobile responsive

---

**[Follow on X](https://x.com/arcpay_) · [View on GitHub](https://github.com/Spydiecy/ArcPay) · [Pitch Deck](https://canva.link/h8tqd13woyj1ycp)**
