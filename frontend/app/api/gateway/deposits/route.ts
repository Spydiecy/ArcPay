import { GATEWAY_API_BASE } from '../../../lib/gateway';

/**
 * Thin server-side proxy to Circle's Gateway `/v1/deposits` endpoint.
 *
 * Surfaces deposits that have been submitted on-chain but haven't finalized
 * yet, so the Fund panel can show "1 USDC pending finality" instead of just
 * a confusing 0 balance right after a user deposits.
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
    upstream = await fetch(`${GATEWAY_API_BASE}/v1/deposits`, {
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
