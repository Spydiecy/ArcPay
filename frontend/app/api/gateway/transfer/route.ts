import { GATEWAY_API_BASE } from '../../../lib/gateway';

/**
 * Thin server-side proxy to Circle's Gateway `/v1/transfer` endpoint.
 *
 * This exists purely to avoid browser CORS issues and to centralize the
 * testnet/mainnet base URL in one place (Requirement 7.5). It does not sign,
 * mutate, or retry anything — the burn intent is already signed client-side
 * by the user's own wallet before it reaches this route, and Circle's
 * response (success or error) is forwarded back verbatim so the caller can
 * surface the exact failure reason (Requirement 3.3 / Property 1).
 *
 * No API key or secret is required: Circle's Gateway API is public and
 * permissionless for this self-managed-wallet flow (Requirement 7.1).
 */
export async function POST(req: Request) {
  let requests: unknown;
  try {
    requests = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!Array.isArray(requests) || requests.length === 0) {
    return Response.json({ error: 'Request body must be a non-empty array of {burnIntent, signature}' }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${GATEWAY_API_BASE}/v1/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requests, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Failed to reach Gateway API' },
      { status: 502 },
    );
  }

  const body = await upstream.json().catch(() => ({}));
  return Response.json(body, { status: upstream.status });
}
