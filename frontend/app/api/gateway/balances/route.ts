import { GATEWAY_API_BASE } from '../../../lib/gateway';

/**
 * Thin server-side proxy to Circle's Gateway `/v1/balances` endpoint.
 *
 * Same rationale as the /transfer proxy: avoids browser CORS issues and
 * centralizes the testnet/mainnet base URL. No secrets required — the
 * balances endpoint is public and only takes a wallet address as input.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const address = (body as { address?: unknown })?.address;
  if (!address || typeof address !== 'string') {
    return Response.json({ error: 'address is required' }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${GATEWAY_API_BASE}/v1/balances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'USDC', sources: [{ depositor: address }] }),
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Failed to reach Gateway API' },
      { status: 502 },
    );
  }

  const json = await upstream.json().catch(() => ({}));
  return Response.json(json, { status: upstream.status });
}
