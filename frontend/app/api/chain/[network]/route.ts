/**
 * Same-origin JSON-RPC relay for Arc Mainnet / Arc Testnet reads.
 *
 * Why this exists: browser extensions (ad blockers, Brave Shields, privacy
 * tools) can block requests to third-party RPC hosts with
 * `net::ERR_BLOCKED_BY_CLIENT`, which leaves balances and history empty for
 * those visitors. Requests to our own origin aren't blocked, so the browser
 * sends reads here and we forward them to the real RPC from the server.
 *
 * It also lets keyed providers (Infura, QuickNode, ...) live in SERVER-ONLY env
 * (`ARC_MAINNET_RPC_URLS` / `ARC_TESTNET_RPC_URLS`) instead of being shipped to
 * every browser as NEXT_PUBLIC_* values.
 *
 * This is deliberately NOT an open proxy. It is read-only and defensive:
 *  - only Arc Mainnet / Arc Testnet;
 *  - only an allowlist of read methods (no signing, no sending, no debug/trace);
 *  - batch size and body size are capped;
 *  - cross-site browser callers are rejected (Origin must match this host).
 * There is no authentication: it exposes nothing that the public RPCs don't
 * already serve to anyone, but it does spend this server's outbound RPC quota.
 */
import { ARC_NETWORKS, RPC_BATCH_SIZE, isArcNetworkKey, parseRpcUrls } from '../../../lib/networks';

const ALLOWED_METHODS = new Set([
  'eth_chainId',
  'net_version',
  'eth_blockNumber',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getLogs',
]);

const MAX_BODY_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 15_000;

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

function rpcError(status: number, code: number, message: string, id: unknown = null): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), { status, headers: JSON_HEADERS });
}

/** Server-only URLs first (keyed providers), then the public defaults. */
function upstreamsFor(networkKey: 'mainnet' | 'testnet'): string[] {
  const serverOnly = parseRpcUrls(networkKey === 'mainnet' ? process.env.ARC_MAINNET_RPC_URLS : process.env.ARC_TESTNET_RPC_URLS);
  return [...new Set([...serverOnly, ...ARC_NETWORKS[networkKey].rpcUrls])];
}

/** Browsers always send Origin on cross-origin POSTs; reject ones that aren't us. */
function isSameSite(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true; // non-browser caller (curl, server-side) — nothing to protect against here
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

type RpcCall = { jsonrpc?: unknown; method?: unknown; params?: unknown; id?: unknown };

function validateCall(call: unknown): { ok: true } | { ok: false; id: unknown; message: string } {
  if (typeof call !== 'object' || call === null || Array.isArray(call)) return { ok: false, id: null, message: 'Invalid request' };
  const c = call as RpcCall;
  const id = typeof c.id === 'number' || typeof c.id === 'string' ? c.id : null;
  if (c.jsonrpc !== '2.0') return { ok: false, id, message: 'jsonrpc must be "2.0"' };
  if (typeof c.method !== 'string' || !ALLOWED_METHODS.has(c.method)) {
    return { ok: false, id, message: `Method not allowed: ${String(c.method).slice(0, 40)}` };
  }
  if (c.params !== undefined && !Array.isArray(c.params)) return { ok: false, id, message: 'params must be an array' };
  return { ok: true };
}

export async function POST(req: Request, ctx: { params: Promise<{ network: string }> }): Promise<Response> {
  const { network } = await ctx.params;
  if (!isArcNetworkKey(network)) return rpcError(404, -32601, 'Unknown network');

  if (!isSameSite(req)) return rpcError(403, -32600, 'Cross-site requests are not allowed');

  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return rpcError(413, -32600, 'Request too large');
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return rpcError(413, -32600, 'Request too large');

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return rpcError(400, -32700, 'Parse error');
  }

  const calls = Array.isArray(payload) ? payload : [payload];
  if (calls.length === 0) return rpcError(400, -32600, 'Empty batch');
  if (calls.length > RPC_BATCH_SIZE) return rpcError(413, -32600, `Batch too large (max ${RPC_BATCH_SIZE})`);
  for (const call of calls) {
    const v = validateCall(call);
    if (!v.ok) return rpcError(400, -32601, v.message, v.id);
  }

  // Forward to the first upstream that answers; fall through on network errors / 5xx / 429.
  let lastStatus = 502;
  for (const url of upstreamsFor(network)) {
    try {
      const upstream = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw,
        cache: 'no-store',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (upstream.ok) {
        return new Response(await upstream.text(), { status: 200, headers: JSON_HEADERS });
      }
      lastStatus = upstream.status;
    } catch {
      lastStatus = 502;
    }
  }

  // Pass 429 through so the client's retry/backoff kicks in; everything else is a bad gateway.
  return rpcError(lastStatus === 429 ? 429 : 502, -32603, 'Upstream RPC unavailable');
}
