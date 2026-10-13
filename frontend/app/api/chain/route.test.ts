import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from './[network]/route';

const ME = '0x2ec8175015Bef5ad1C0BE1587C4A377bC083A2d8';
const call = (id = 1, method = 'eth_getBalance', params: unknown[] = [ME, 'latest']) => ({ jsonrpc: '2.0', id, method, params });

function req(body: unknown, headers: Record<string, string> = {}, raw?: string): Request {
  return new Request('http://localhost:3000/api/chain/mainnet', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'localhost:3000', ...headers },
    body: raw ?? JSON.stringify(body),
  });
}
const ctx = (network: string) => ({ params: Promise.resolve({ network }) });

let fetchMock: ReturnType<typeof vi.fn>;
const okResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => {
  fetchMock = vi.fn().mockImplementation(async () => okResponse({ jsonrpc: '2.0', id: 1, result: '0x1' }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /api/chain/[network] (same-origin RPC relay)', () => {
  it('forwards a read to the right upstream and returns the answer', async () => {
    const res = await POST(req(call()), ctx('mainnet'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: '0x1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://rpc.mainnet.arc.io');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('routes testnet to the testnet RPC', async () => {
    await POST(req(call()), ctx('testnet'));
    expect(fetchMock.mock.calls[0][0]).toBe('https://rpc.testnet.arc.network');
  });

  it('forwards batches untouched', async () => {
    const batch = [call(1), call(2, 'eth_blockNumber', [])];
    fetchMock.mockResolvedValue(okResponse([{ id: 1, result: '0x1' }, { id: 2, result: '0x2' }]));
    const res = await POST(req(batch), ctx('mainnet'));
    expect(await res.json()).toHaveLength(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(batch);
  });

  it('rejects unknown networks', async () => {
    const res = await POST(req(call()), ctx('ethereum'));
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('is not an open proxy', () => {
    it.each(['eth_sendRawTransaction', 'eth_sendTransaction', 'personal_sign', 'eth_accounts', 'debug_traceTransaction', 'admin_peers'])(
      'rejects %s',
      async (method) => {
        const res = await POST(req(call(1, method, [])), ctx('mainnet'));
        expect(res.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it('rejects a batch if ANY call in it is not allowed', async () => {
      const res = await POST(req([call(1), call(2, 'eth_sendRawTransaction', ['0x00'])]), ctx('mainnet'));
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects oversized batches', async () => {
      const res = await POST(req(Array.from({ length: 26 }, (_, i) => call(i + 1))), ctx('mainnet'));
      expect(res.status).toBe(413);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects oversized bodies', async () => {
      const res = await POST(req(null, {}, JSON.stringify(call(1, 'eth_call', ['x'.repeat(70_000)]))), ctx('mainnet'));
      expect(res.status).toBe(413);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects malformed input', async () => {
      expect((await POST(req(null, {}, '{not json'), ctx('mainnet'))).status).toBe(400);
      expect((await POST(req([]), ctx('mainnet'))).status).toBe(400);
      expect((await POST(req({ method: 'eth_chainId' }), ctx('mainnet'))).status).toBe(400); // no jsonrpc
      expect((await POST(req({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: 'nope' }), ctx('mainnet'))).status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects cross-site browser callers but allows same-site and non-browser callers', async () => {
      expect((await POST(req(call(), { origin: 'https://evil.example' }), ctx('mainnet'))).status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
      expect((await POST(req(call(), { origin: 'http://localhost:3000' }), ctx('mainnet'))).status).toBe(200);
      expect((await POST(req(call()), ctx('mainnet'))).status).toBe(200); // no Origin (curl / server)
    });

    it('honours x-forwarded-host behind a proxy', async () => {
      const res = await POST(req(call(), { origin: 'https://arcpay.example', 'x-forwarded-host': 'arcpay.example' }), ctx('mainnet'));
      expect(res.status).toBe(200);
    });
  });

  describe('upstream handling', () => {
    it('fails over to the next upstream when the first errors', async () => {
      vi.stubEnv('ARC_MAINNET_RPC_URLS', 'https://keyed.example/v3/secret');
      fetchMock.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(okResponse({ jsonrpc: '2.0', id: 1, result: '0x9' }));
      const res = await POST(req(call()), ctx('mainnet'));
      expect(res.status).toBe(200);
      expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['https://keyed.example/v3/secret', 'https://rpc.mainnet.arc.io']);
    });

    it('prefers server-only keyed URLs and never reveals them in the response', async () => {
      vi.stubEnv('ARC_MAINNET_RPC_URLS', 'https://keyed.example/v3/SECRETKEY');
      const res = await POST(req(call()), ctx('mainnet'));
      expect(fetchMock.mock.calls[0][0]).toBe('https://keyed.example/v3/SECRETKEY');
      expect(await res.text()).not.toContain('SECRETKEY');
    });

    it('passes a 429 through so the client backs off and retries', async () => {
      fetchMock.mockResolvedValue(new Response('slow down', { status: 429 }));
      const res = await POST(req(call()), ctx('mainnet'));
      expect(res.status).toBe(429);
      expect((await res.json()).error.message).toMatch(/unavailable/i);
    });

    it('never leaks a keyed upstream URL in an error response', async () => {
      vi.stubEnv('ARC_MAINNET_RPC_URLS', 'https://keyed.example/v3/SECRETKEY');
      fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED https://keyed.example/v3/SECRETKEY'));
      const res = await POST(req(call()), ctx('mainnet'));
      const text = await res.text();
      expect(res.status).toBe(502);
      expect(text).not.toContain('SECRETKEY');
      expect(text).not.toContain('keyed.example');
      expect(text).not.toContain('ECONNREFUSED');
    });

    it('returns 502 when every upstream is down', async () => {
      fetchMock.mockRejectedValue(new Error('down'));
      const res = await POST(req(call()), ctx('mainnet'));
      expect(res.status).toBe(502);
    });

    it('passes JSON-RPC-level errors through unchanged', async () => {
      fetchMock.mockResolvedValue(okResponse({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limit exceeded' } }));
      const res = await POST(req(call()), ctx('mainnet'));
      expect(res.status).toBe(200);
      expect((await res.json()).error.code).toBe(-32005);
    });
  });
});
