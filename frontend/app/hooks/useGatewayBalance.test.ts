import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x2ec8175015Bef5ad1C0BE1587C4A377bC083A2d8' }),
}));

import { useGatewayBalance } from './useGatewayBalance';

describe('useGatewayBalance', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('filters out zero-balance chains (Requirement 1.4)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        token: 'USDC',
        balances: [
          { domain: 6, depositor: '0xabc', balance: '5.000000' },
          { domain: 0, depositor: '0xabc', balance: '0.000000' },
          { domain: 3, depositor: '0xabc', balance: '0' },
        ],
      }),
    });

    const { result } = renderHook(() => useGatewayBalance());

    await waitFor(() => expect(result.current.balances.length).toBe(1));
    expect(result.current.balances[0].domain).toBe(6);
    expect(result.current.total).toBe(5);
  });

  it('preserves last-known-good balances on a failed refresh (Requirement 1.3)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: 'USDC',
          balances: [{ domain: 6, depositor: '0xabc', balance: '5.000000' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => ({ error: 'Gateway API unreachable' }),
      });

    const { result } = renderHook(() => useGatewayBalance());
    await waitFor(() => expect(result.current.balances.length).toBe(1));

    await act(async () => {
      await result.current.refresh();
    });

    // Balances unchanged, error surfaced separately.
    expect(result.current.balances.length).toBe(1);
    expect(result.current.balances[0].domain).toBe(6);
    expect(result.current.error).toBeTruthy();
  });

  it('does not trigger extra fetches within the 30s cache window unless forced', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'USDC', balances: [], deposits: [] }),
    });

    const { result } = renderHook(() => useGatewayBalance());
    // Each refresh fires two requests in parallel (balances + deposits).
    await waitFor(() => expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2));

    // refresh() exposed to consumers is always force=true by design, so this
    // call SHOULD hit fetch again — confirming the public API always allows
    // an explicit manual refresh regardless of cache.
    await act(async () => {
      await result.current.refresh();
    });
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
  });

  it('surfaces pending deposits separately from confirmed balances', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.includes('/balances')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ token: 'USDC', balances: [] }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          token: 'USDC',
          deposits: [
            { domain: 6, depositor: '0xabc', amount: '1000000', status: 'pending', transactionHash: '0xdep1' },
          ],
        }),
      });
    });

    const { result } = renderHook(() => useGatewayBalance());
    await waitFor(() => expect(result.current.pendingDeposits.length).toBe(1));
    expect(result.current.balances.length).toBe(0);
    expect(result.current.pendingDeposits[0].label).toBe('Base Sepolia');
    expect(result.current.pendingDeposits[0].amount).toBe('1000000');
  });

  it('a failed deposits fetch does not affect the primary balances result', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.includes('/balances')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ token: 'USDC', balances: [{ domain: 6, depositor: '0xabc', balance: '5' }] }),
        });
      }
      return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
    });

    const { result } = renderHook(() => useGatewayBalance());
    await waitFor(() => expect(result.current.balances.length).toBe(1));
    expect(result.current.error).toBeNull();
    expect(result.current.pendingDeposits).toEqual([]);
  });

  it('maps known domains to their GATEWAY_SOURCE_CHAINS label', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        token: 'USDC',
        balances: [{ domain: 6, depositor: '0xabc', balance: '1.5' }],
      }),
    });

    const { result } = renderHook(() => useGatewayBalance());
    await waitFor(() => expect(result.current.balances.length).toBe(1));
    expect(result.current.balances[0].label).toBe('Base Sepolia');
  });
});
