import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from './route';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/gateway/transfer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/gateway/transfer (Property 1: no auto-retry with mutated intent)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('forwards the request body unchanged to gateway-api-testnet.circle.com/v1/transfer', async () => {
    const mockResponse = {
      transferId: 'abc-123',
      attestation: '0xattestation',
      signature: '0xopsig',
      fees: { total: '0.06', token: 'USDC', perIntent: [], forwardingFee: '0' },
      expirationBlock: '999',
    };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => mockResponse,
    });

    const payload = [{ burnIntent: { maxBlockHeight: '1', maxFee: '1', spec: {} }, signature: '0xsig' }];
    const res = await POST(makeRequest(payload));
    const body = await res.json();

    expect(global.fetch).toHaveBeenCalledWith(
      'https://gateway-api-testnet.circle.com/v1/transfer',
      expect.objectContaining({ method: 'POST' }),
    );
    const forwardedBody = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(forwardedBody).toEqual(payload);

    expect(res.status).toBe(201);
    expect(body).toEqual(mockResponse);
  });

  it('passes through a 4xx error response with its original status and body verbatim', async () => {
    const errorBody = { error: 'Insufficient balance for burn intent' };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => errorBody,
    });

    const res = await POST(makeRequest([{ burnIntent: {}, signature: '0xsig' }]));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual(errorBody);
  });

  it('passes through a 5xx error response verbatim', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'Service unavailable' }),
    });

    const res = await POST(makeRequest([{ burnIntent: {}, signature: '0xsig' }]));
    expect(res.status).toBe(503);
  });

  it('rejects an empty array with a 400 before ever calling fetch', async () => {
    const res = await POST(makeRequest([]));
    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects a non-array body with a 400 before ever calling fetch', async () => {
    const res = await POST(makeRequest({ burnIntent: {}, signature: '0xsig' }));
    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('serializes bigint values in the request body as strings', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ attestation: '0xa', signature: '0xs' }),
    });

    // bigint can't survive JSON.stringify in the test harness's own
    // makeRequest(), so build the Request directly here.
    const req = new Request('http://localhost/api/gateway/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ burnIntent: { value: '1000000' }, signature: '0xsig' }]),
    });
    await POST(req);

    const forwardedBody = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(forwardedBody[0].burnIntent.value).toBe('1000000');
  });
});
