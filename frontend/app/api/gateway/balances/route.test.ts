import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from './route';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/gateway/balances', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/gateway/balances', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('forwards {token: "USDC", sources: [{depositor}]} to gateway-api-testnet.circle.com/v1/balances', async () => {
    const mockResponse = { token: 'USDC', balances: [{ domain: 6, balance: '5.0' }] };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    const res = await POST(makeRequest({ address: '0x2ec8175015Bef5ad1C0BE1587C4A377bC083A2d8' }));
    const body = await res.json();

    expect(global.fetch).toHaveBeenCalledWith(
      'https://gateway-api-testnet.circle.com/v1/balances',
      expect.objectContaining({ method: 'POST' }),
    );
    const forwardedBody = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(forwardedBody).toEqual({
      token: 'USDC',
      sources: [{ depositor: '0x2ec8175015Bef5ad1C0BE1587C4A377bC083A2d8' }],
    });
    expect(res.status).toBe(200);
    expect(body).toEqual(mockResponse);
  });

  it('rejects a request with no address before calling fetch', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('passes through an upstream error response verbatim', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Not found' }),
    });

    const res = await POST(makeRequest({ address: '0xabc' }));
    expect(res.status).toBe(404);
  });
});
