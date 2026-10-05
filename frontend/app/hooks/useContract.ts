'use client';

import { useCallback } from 'react';
import { useWriteContract, useReadContract, usePublicClient, useAccount } from 'wagmi';
import { parseEther } from 'viem';
import { PROTECTED_PAY_ABI } from '../lib/abi';
import { useArcNetwork } from './useArcNetwork';

export type { PROTECTED_PAY_ABI };

// ── Network-aware contract address hook ───────────────────────────────────────
// Follows the ACTIVE ArcPay environment (Arc Mainnet / Arc Testnet) rather than
// the wallet's ambient connected chain (which can be a Gateway source chain
// mid-deposit — see GatewayFundPanel).
export function useContractAddress(): `0x${string}` {
  return useArcNetwork().contractAddress;
}

// ── Write hook — submit a tx and wait for inclusion ───────────────────────────
export function useTx() {
  const { writeContractAsync } = useWriteContract();
  const { chainId, contractAddress } = useArcNetwork();
  const client = usePublicClient({ chainId });

  return useCallback(async (
    functionName: string,
    args: unknown[],
    value: bigint = 0n,
    onSuccess?: () => void,
    onError?: (err: string) => void,
  ) => {
    try {
      const hash = await writeContractAsync({
        address: contractAddress,
        abi: PROTECTED_PAY_ABI,
        functionName: functionName as never,
        args: args as never,
        value,
        chainId,
      });
      if (client) await client.waitForTransactionReceipt({ hash });
      onSuccess?.();
    } catch (e: unknown) {
      const msg = e instanceof Error
        ? (e.message.includes('revert') ? e.message.split('revert')[1]?.trim() || e.message : e.message)
        : String(e);
      onError?.(msg);
      throw e;
    }
  }, [writeContractAsync, client, contractAddress, chainId]);
}

// ── Read hook — call a view function ─────────────────────────────────────────
export function useQuery() {
  const { chainId, contractAddress } = useArcNetwork();
  const client = usePublicClient({ chainId });
  const { address } = useAccount();

  return useCallback(async (functionName: string, args: unknown[] = []) => {
    if (!client) throw new Error('No public client');
    const result = await client.readContract({
      address: contractAddress,
      abi: PROTECTED_PAY_ABI,
      functionName: functionName as never,
      args: args as never,
      account: address,
    });
    return result;
  }, [client, address, contractAddress]);
}

// ── Convenience hook for a single read contract value ─────────────────────────
export function useContractRead(functionName: string, args: unknown[] = []) {
  const { chainId, contractAddress } = useArcNetwork();
  return useReadContract({
    address: contractAddress,
    abi: PROTECTED_PAY_ABI,
    functionName: functionName as never,
    args: args as never,
    chainId,
  });
}

// ── Parse ether helper re-exported ────────────────────────────────────────────
export { parseEther };
