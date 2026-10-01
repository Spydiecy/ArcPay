'use client';

import { useState, useCallback } from 'react';
import { useAccount, useChainId, useSwitchChain, useWriteContract } from 'wagmi';
import { readContract, waitForTransactionReceipt } from '@wagmi/core';
import {
  GATEWAY_WALLET_ADDRESS,
  GATEWAY_WALLET_ABI,
  ERC20_ABI,
  formatGatewayError,
} from '../lib/gateway';
import { arcTestnet, wagmiConfig } from '../lib/wagmi';

// ── Types ─────────────────────────────────────────────────────────────────────
export type GatewayDepositPhase =
  | 'idle' | 'switching' | 'checking' | 'approving' | 'depositing' | 'restoring' | 'done' | 'error';

export interface DepositParams {
  chainId: number;
  usdcAddress: `0x${string}`;
  amountMicroUsdc: bigint;
}

/**
 * Handles the "deposit USDC into a GatewayWallet contract on a source chain"
 * step — this is the step Circle's own docs describe as happening outside
 * any dApp UI (approve + deposit), now brought into ArcPay directly so users
 * don't have to leave the app or use a block explorer's "Write Contract" tab.
 *
 * This is entirely separate from useGatewayTransfer.ts (which handles the
 * burn-intent-sign -> attest -> mint flow on the OUT side of Gateway). This
 * hook only ever touches the source chain's USDC token contract and
 * GatewayWallet contract — it never touches Arc or ProtectedPay.
 *
 * IMPORTANT: every read/write/wait below is called with an explicit
 * `chainId` against `wagmiConfig` directly (via `@wagmi/core` actions)
 * rather than through the reactive `usePublicClient()`/`useWriteContract()`
 * client objects. Those reactive clients are snapshotted at render time and
 * go stale the instant `switchChainAsync` resolves mid-callback — waiting
 * on a receipt with a stale, wrong-chain client hangs forever (the bug that
 * required a page refresh + resubmission to "fix" previously).
 */
export function useGatewayDeposit() {
  const { address } = useAccount();
  const currentChainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const [phase, setPhase] = useState<GatewayDepositPhase>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [approveTxHash, setApproveTxHash] = useState<`0x${string}` | undefined>();
  const [depositTxHash, setDepositTxHash] = useState<`0x${string}` | undefined>();

  const deposit = useCallback(async (params: DepositParams) => {
    if (!address) throw new Error('Wallet not connected');
    setErrorMsg('');
    setApproveTxHash(undefined);
    setDepositTxHash(undefined);

    try {
      // ── Step 1: ensure the wallet is on the source chain ──────────────────
      if (currentChainId !== params.chainId) {
        setPhase('switching');
        await switchChainAsync({ chainId: params.chainId });
      }

      // ── Step 2: check the wallet's actual on-chain USDC balance ───────────
      // This is what actually catches the "1.0 USDC fails, 0.98 works" class
      // of bug: the requested amount can look perfectly clean in decimal but
      // still exceed what the wallet holds on that specific chain by a few
      // micro-USDC (dust from a prior transfer, a slightly-off cached UI
      // balance, etc). Checking this BEFORE prompting for approve/deposit
      // means the user gets one clear message instead of a raw contract
      // revert after already signing a transaction.
      setPhase('checking');
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const onChainBalance = await readContract(wagmiConfig as any, {
          address: params.usdcAddress,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [address],
          chainId: params.chainId,
        }) as bigint;
        if (onChainBalance < params.amountMicroUsdc) {
          throw new Error(
            `Insufficient USDC balance on this chain — you have ${(Number(onChainBalance) / 1_000_000).toFixed(6)} USDC available.`,
          );
        }
      } catch (e) {
        // Re-throw balance-check failures (the message above); swallow only
        // genuine RPC read failures so a transient hiccup doesn't block a
        // deposit that would otherwise succeed.
        if (e instanceof Error && e.message.startsWith('Insufficient USDC balance')) throw e;
      }

      // ── Step 3: check current allowance — skip approve if already enough ─
      let currentAllowance = 0n;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        currentAllowance = await readContract(wagmiConfig as any, {
          address: params.usdcAddress,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [address, GATEWAY_WALLET_ADDRESS],
          chainId: params.chainId,
        }) as bigint;
      } catch {
        // If the read fails, fall through and approve unconditionally
        // rather than blocking the deposit on a transient RPC hiccup.
        currentAllowance = 0n;
      }

      // ── Step 4: approve if needed ─────────────────────────────────────────
      if (currentAllowance < params.amountMicroUsdc) {
        setPhase('approving');
        const approveHash = await writeContractAsync({
          address: params.usdcAddress,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [GATEWAY_WALLET_ADDRESS, params.amountMicroUsdc],
          chainId: params.chainId as never,
        });
        setApproveTxHash(approveHash);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await waitForTransactionReceipt(wagmiConfig as any, {
          hash: approveHash,
          chainId: params.chainId,
        });
      }

      // ── Step 5: deposit into GatewayWallet ────────────────────────────────
      setPhase('depositing');
      const depositHash = await writeContractAsync({
        address: GATEWAY_WALLET_ADDRESS,
        abi: GATEWAY_WALLET_ABI,
        functionName: 'deposit',
        args: [params.usdcAddress, params.amountMicroUsdc],
        chainId: params.chainId as never,
      });
      setDepositTxHash(depositHash);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await waitForTransactionReceipt(wagmiConfig as any, {
        hash: depositHash,
        chainId: params.chainId,
      });

      // ── Step 6: switch back to Arc Testnet ────────────────────────────────
      // The deposit only ever needed the wallet on the source chain — once
      // it's confirmed, restore Arc as the active network so the rest of
      // ArcPay (sidebar balance, history, other tabs) goes back to normal
      // without the user having to switch back manually.
      try {
        setPhase('restoring');
        await switchChainAsync({ chainId: arcTestnet.id });
      } catch {
        // Non-fatal — the deposit itself already succeeded. Surface nothing
        // blocking; the user can switch back manually via the wallet if this
        // particular switch-back is rejected.
      }

      setPhase('done');
      return depositHash;
    } catch (e) {
      setPhase('error');
      setErrorMsg(formatGatewayError(e));
      throw e;
    }
  }, [address, currentChainId, switchChainAsync, writeContractAsync]);

  const reset = useCallback(() => {
    setPhase('idle');
    setErrorMsg('');
    setApproveTxHash(undefined);
    setDepositTxHash(undefined);
  }, []);

  return { phase, errorMsg, approveTxHash, depositTxHash, deposit, reset };
}
