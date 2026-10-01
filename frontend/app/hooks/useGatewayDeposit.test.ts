import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { GATEWAY_WALLET_ADDRESS } from '../lib/gateway';

const switchChainAsync = vi.fn();
const writeContractAsync = vi.fn();
const readContract = vi.fn();
const waitForTransactionReceipt = vi.fn().mockResolvedValue({});

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x2ec8175015Bef5ad1C0BE1587C4A377bC083A2d8' }),
  useChainId: () => 5042002, // currently on Arc Testnet
  useSwitchChain: () => ({ switchChainAsync }),
  useWriteContract: () => ({ writeContractAsync }),
}));

// The hook now uses imperative `@wagmi/core` actions (readContract,
// waitForTransactionReceipt) called directly against `wagmiConfig`, rather
// than the reactive `usePublicClient()` snapshot — mock those directly.
vi.mock('@wagmi/core', () => ({
  readContract: (...args: unknown[]) => readContract(...args),
  waitForTransactionReceipt: (...args: unknown[]) => waitForTransactionReceipt(...args),
}));

// `../lib/wagmi` calls the real `createConfig` (and pulls in RainbowKit/
// wagmi/chains) at module load time — mock it to a minimal stand-in so this
// test only exercises useGatewayDeposit's own logic.
vi.mock('../lib/wagmi', () => ({
  arcTestnet: { id: 5042002, name: 'Arc Testnet' },
  wagmiConfig: {},
}));

import { useGatewayDeposit } from './useGatewayDeposit';

describe('useGatewayDeposit', () => {
  beforeEach(() => {
    switchChainAsync.mockReset();
    writeContractAsync.mockReset();
    readContract.mockReset();
    waitForTransactionReceipt.mockClear();
  });

  it('switches network before depositing when on a different chain', async () => {
    // Two readContract calls per deposit now: balanceOf (must cover the
    // amount), then allowance.
    readContract
      .mockResolvedValueOnce(100_000_000n) // balanceOf: plenty of USDC
      .mockResolvedValueOnce(0n); // allowance: none yet
    writeContractAsync.mockResolvedValue('0xtxhash');
    const { result } = renderHook(() => useGatewayDeposit());

    await act(async () => {
      await result.current.deposit({
        chainId: 84532, // Base Sepolia
        usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        amountMicroUsdc: 20_000_000n,
      });
    });

    expect(switchChainAsync).toHaveBeenCalledWith({ chainId: 84532 });
  });

  it('switches back to Arc Testnet after a successful deposit', async () => {
    readContract
      .mockResolvedValueOnce(100_000_000n) // balanceOf
      .mockResolvedValueOnce(50_000_000n); // allowance: skip approve for simplicity
    writeContractAsync.mockResolvedValue('0xdeposithash');
    const { result } = renderHook(() => useGatewayDeposit());

    await act(async () => {
      await result.current.deposit({
        chainId: 84532,
        usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        amountMicroUsdc: 20_000_000n,
      });
    });

    // First switch: to the source chain. Second switch: back to Arc.
    expect(switchChainAsync).toHaveBeenCalledTimes(2);
    expect(switchChainAsync).toHaveBeenNthCalledWith(1, { chainId: 84532 });
    expect(switchChainAsync).toHaveBeenNthCalledWith(2, { chainId: 5042002 });
    expect(result.current.phase).toBe('done');
  });

  it('still reports success even if switching back to Arc fails', async () => {
    readContract
      .mockResolvedValueOnce(100_000_000n)
      .mockResolvedValueOnce(50_000_000n);
    writeContractAsync.mockResolvedValue('0xdeposithash');
    switchChainAsync
      .mockResolvedValueOnce(undefined) // switch to source chain succeeds
      .mockRejectedValueOnce(new Error('user dismissed switch prompt')); // switch back fails

    const { result } = renderHook(() => useGatewayDeposit());

    await act(async () => {
      await result.current.deposit({
        chainId: 84532,
        usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        amountMicroUsdc: 20_000_000n,
      });
    });

    // The deposit itself succeeded — a failed switch-back must not turn this
    // into an error state, since the funds already moved.
    expect(result.current.phase).toBe('done');
  });

  it('approves then deposits when allowance is insufficient', async () => {
    readContract
      .mockResolvedValueOnce(100_000_000n) // balanceOf
      .mockResolvedValueOnce(0n); // allowance
    writeContractAsync
      .mockResolvedValueOnce('0xapprovehash')
      .mockResolvedValueOnce('0xdeposithash');

    const { result } = renderHook(() => useGatewayDeposit());

    await act(async () => {
      await result.current.deposit({
        chainId: 84532,
        usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        amountMicroUsdc: 20_000_000n,
      });
    });

    expect(writeContractAsync).toHaveBeenCalledTimes(2);
    const [approveCall, depositCall] = writeContractAsync.mock.calls;
    expect(approveCall[0].functionName).toBe('approve');
    expect(approveCall[0].args).toEqual([GATEWAY_WALLET_ADDRESS, 20_000_000n]);
    expect(depositCall[0].functionName).toBe('deposit');
    expect(depositCall[0].args).toEqual(['0x036CbD53842c5426634e7929541eC2318f3dCF7e', 20_000_000n]);
    expect(result.current.phase).toBe('done');
  });

  it('skips approve when allowance is already sufficient', async () => {
    readContract
      .mockResolvedValueOnce(100_000_000n) // balanceOf
      .mockResolvedValueOnce(50_000_000n); // allowance: already approved for 50 USDC
    writeContractAsync.mockResolvedValue('0xdeposithash');

    const { result } = renderHook(() => useGatewayDeposit());

    await act(async () => {
      await result.current.deposit({
        chainId: 84532,
        usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        amountMicroUsdc: 20_000_000n,
      });
    });

    expect(writeContractAsync).toHaveBeenCalledTimes(1);
    expect(writeContractAsync.mock.calls[0][0].functionName).toBe('deposit');
    expect(result.current.phase).toBe('done');
  });

  it('leaves phase in error state if the deposit transaction is rejected', async () => {
    readContract
      .mockResolvedValueOnce(100_000_000n) // balanceOf
      .mockResolvedValueOnce(50_000_000n); // allowance
    writeContractAsync.mockRejectedValueOnce(new Error('user rejected'));

    const { result } = renderHook(() => useGatewayDeposit());

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.deposit({
          chainId: 84532,
          usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          amountMicroUsdc: 20_000_000n,
        });
      } catch (e) {
        caught = e;
      }
    });

    expect((caught as Error).message).toBe('user rejected');
    expect(result.current.phase).toBe('error');
  });

  it('blocks the deposit with a clear message when the on-chain balance is insufficient (precision/insufficient-funds bug)', async () => {
    // Wallet only holds 0.999998 USDC on-chain but the user requested 1.0
    // USDC — this is the exact class of "clean decimal amount, insufficient
    // real balance" bug reported (1.0 USDC failing while 0.98 succeeded).
    readContract.mockResolvedValueOnce(999_998n); // balanceOf
    const { result } = renderHook(() => useGatewayDeposit());

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.deposit({
          chainId: 84532,
          usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          amountMicroUsdc: 1_000_000n, // 1.0 USDC requested
        });
      } catch (e) {
        caught = e;
      }
    });

    expect((caught as Error).message).toContain('Insufficient USDC balance');
    expect(result.current.phase).toBe('error');
    expect(result.current.errorMsg).toContain('Insufficient USDC balance');
    // Never even attempts approve/deposit once the balance check fails.
    expect(writeContractAsync).not.toHaveBeenCalled();
  });
});
