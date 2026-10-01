import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ARC_TESTNET_DOMAIN } from '../lib/gateway';

// ── Mock wagmi hooks so this test exercises pure burn-intent logic without a
// real wallet/provider. ─────────────────────────────────────────────────────
const signTypedDataAsync = vi.fn();
const writeContractAsync = vi.fn();
const switchChainAsync = vi.fn();
const waitForTransactionReceipt = vi.fn().mockResolvedValue({});

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x2ec8175015Bef5ad1C0BE1587C4A377bC083A2d8' }),
  useChainId: () => 5042002, // already on Arc Testnet by default in these tests
  useSwitchChain: () => ({ switchChainAsync }),
  useSignTypedData: () => ({ signTypedDataAsync }),
  useWriteContract: () => ({ writeContractAsync }),
  useWaitForTransactionReceipt: () => ({ isSuccess: false }),
}));

// The mint step now waits for confirmation via `@wagmi/core`'s
// `waitForTransactionReceipt` (called directly against `wagmiConfig`,
// bypassing React's reactive client) rather than `useWaitForTransactionReceipt`.
vi.mock('@wagmi/core', () => ({
  waitForTransactionReceipt: (...args: unknown[]) => waitForTransactionReceipt(...args),
}));

// `../lib/wagmi` calls the real `createConfig` at module load time — mock it
// to a minimal stand-in so this test only exercises useGatewayTransfer's own
// logic, consistent with useGatewayDeposit.test.ts.
vi.mock('../lib/wagmi', () => ({
  arcTestnet: { id: 5042002, name: 'Arc Testnet' },
  wagmiConfig: {},
}));

import { useGatewayTransfer } from './useGatewayTransfer';

describe('useGatewayTransfer — signBurnIntent (Property 1, Property 2)', () => {
  beforeEach(() => {
    signTypedDataAsync.mockReset();
    writeContractAsync.mockReset();
    switchChainAsync.mockReset();
  });

  it('always sets destinationDomain to Arc Testnet regardless of source domain', async () => {
    signTypedDataAsync.mockResolvedValue('0xsig1');
    const { result } = renderHook(() => useGatewayTransfer());

    await act(async () => {
      await result.current.signBurnIntent({
        sourceDomain: 6, // Base Sepolia
        sourceUsdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        amountMicroUsdc: 1_000_000n,
        sourceGasFeeUsd: 0.01,
        availableMicroUsdc: 10_000_000n,
      });
    });

    const [{ message }] = signTypedDataAsync.mock.calls[0];
    expect(message.spec.destinationDomain).toBe(ARC_TESTNET_DOMAIN);
    expect(message.spec.sourceDomain).toBe(6);
  });

  it('generates a fresh salt on every call — never reused', async () => {
    signTypedDataAsync.mockResolvedValue('0xsig1');
    const { result } = renderHook(() => useGatewayTransfer());

    const params = {
      sourceDomain: 6,
      sourceUsdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const,
      amountMicroUsdc: 1_000_000n,
      sourceGasFeeUsd: 0.01,
      availableMicroUsdc: 10_000_000n,
    };

    await act(async () => { await result.current.signBurnIntent(params); });
    await act(async () => { await result.current.signBurnIntent(params); });

    const salt1 = signTypedDataAsync.mock.calls[0][0].message.spec.salt;
    const salt2 = signTypedDataAsync.mock.calls[1][0].message.spec.salt;
    expect(salt1).not.toBe(salt2);
  });

  it('always sends hookData as empty 0x (confirmed unused by GatewayMinter)', async () => {
    signTypedDataAsync.mockResolvedValue('0xsig1');
    const { result } = renderHook(() => useGatewayTransfer());

    await act(async () => {
      await result.current.signBurnIntent({
        sourceDomain: 0,
        sourceUsdcAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        amountMicroUsdc: 5_000_000n,
        sourceGasFeeUsd: 1.0,
        availableMicroUsdc: 10_000_000n,
      });
    });

    const [{ message }] = signTypedDataAsync.mock.calls[0];
    expect(message.spec.hookData).toBe('0x');
  });

  it('blocks signing when amount exceeds available balance, without calling signTypedDataAsync', async () => {
    const { result } = renderHook(() => useGatewayTransfer());

    await expect(
      act(async () => {
        await result.current.signBurnIntent({
          sourceDomain: 6,
          sourceUsdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          amountMicroUsdc: 10_000_000n, // 10 USDC requested
          sourceGasFeeUsd: 0.01,
          availableMicroUsdc: 1_000_000n, // only 1 USDC available
        });
      }),
    ).rejects.toThrow(/Insufficient Gateway balance/);

    expect(signTypedDataAsync).not.toHaveBeenCalled();
  });

  it('surfaces a rejected signature as an error without throwing unhandled', async () => {
    signTypedDataAsync.mockRejectedValue(new Error('User rejected the request'));
    const { result } = renderHook(() => useGatewayTransfer());

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.signBurnIntent({
          sourceDomain: 6,
          sourceUsdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          amountMicroUsdc: 1_000_000n,
          sourceGasFeeUsd: 0.01,
          availableMicroUsdc: 10_000_000n,
        });
      } catch (e) {
        caught = e;
      }
    });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('User rejected the request');
    expect(result.current.phase).toBe('error');
    // formatGatewayError() rewrites raw wallet errors into a friendlier
    // message rather than surfacing the raw string verbatim.
    expect(result.current.errorMsg).toBe('Request was rejected in your wallet.');
  });
});

describe('useGatewayTransfer — mint retry (Property 5, Property 6)', () => {
  beforeEach(() => {
    signTypedDataAsync.mockReset();
    writeContractAsync.mockReset();
    switchChainAsync.mockReset();
    waitForTransactionReceipt.mockClear();
    waitForTransactionReceipt.mockResolvedValue({});
  });

  it('mint() can be called directly with an attestation/signature pair without prior signing', async () => {
    writeContractAsync.mockResolvedValue('0xminttxhash');
    const { result } = renderHook(() => useGatewayTransfer());

    await act(async () => {
      await result.current.mint('0xattestation', '0xoperatorsig');
    });

    expect(writeContractAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'gatewayMint',
        args: ['0xattestation', '0xoperatorsig'],
      }),
    );
    expect(result.current.phase).toBe('done');
    // Already on Arc Testnet in this test's mock — no switch needed.
    expect(switchChainAsync).not.toHaveBeenCalled();
  });

  it('throws a clear error when no attestation is available', async () => {
    const { result } = renderHook(() => useGatewayTransfer());
    await expect(act(async () => { await result.current.mint(); })).rejects.toThrow(
      /No attestation available/,
    );
  });

  it('leaves phase in error state on a failed mint, retryable without re-signing', async () => {
    writeContractAsync.mockRejectedValueOnce(new Error('user rejected transaction'));
    const { result } = renderHook(() => useGatewayTransfer());

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mint('0xattestation', '0xoperatorsig');
      } catch (e) {
        caught = e;
      }
    });
    expect((caught as Error).message).toBe('user rejected transaction');
    expect(result.current.phase).toBe('error');

    // Retry with the same attestation/signature — no re-signing needed.
    writeContractAsync.mockResolvedValueOnce('0xminttxhash2');
    await act(async () => { await result.current.mint('0xattestation', '0xoperatorsig'); });
    expect(result.current.phase).toBe('done');
  });
});

describe('useGatewayTransfer — mint switches to Arc first when on a different chain', () => {
  // This suite needs its own module registry since useChainId is mocked at
  // module scope above to always return Arc's chain id — reset modules and
  // re-mock with a source-chain id to test the switch-before-mint path.
  beforeEach(() => {
    vi.resetModules();
  });

  it('calls switchChainAsync to Arc before submitting gatewayMint if not already there', async () => {
    const localSwitchChainAsync = vi.fn().mockResolvedValue(undefined);
    const localWriteContractAsync = vi.fn().mockResolvedValue('0xminttxhash');

    vi.doMock('wagmi', () => ({
      useAccount: () => ({ address: '0x2ec8175015Bef5ad1C0BE1587C4A377bC083A2d8' }),
      useChainId: () => 84532, // still on Base Sepolia right after a deposit
      useSwitchChain: () => ({ switchChainAsync: localSwitchChainAsync }),
      useSignTypedData: () => ({ signTypedDataAsync: vi.fn() }),
      useWriteContract: () => ({ writeContractAsync: localWriteContractAsync }),
      useWaitForTransactionReceipt: () => ({ isSuccess: false }),
    }));
    vi.doMock('@wagmi/core', () => ({
      waitForTransactionReceipt: vi.fn().mockResolvedValue({}),
    }));
    vi.doMock('../lib/wagmi', () => ({
      arcTestnet: { id: 5042002, name: 'Arc Testnet' },
      wagmiConfig: {},
    }));

    const { useGatewayTransfer: freshUseGatewayTransfer } = await import('./useGatewayTransfer');
    const { result } = renderHook(() => freshUseGatewayTransfer());

    await act(async () => {
      await result.current.mint('0xattestation', '0xoperatorsig');
    });

    expect(localSwitchChainAsync).toHaveBeenCalledWith({ chainId: 5042002 });
    expect(localWriteContractAsync).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'gatewayMint', chainId: 5042002 }),
    );
  });
});
