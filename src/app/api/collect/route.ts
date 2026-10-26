import { collectEvidence, DealUnavailableError } from "@/lib/fetcher";
import { FetchBlockedError } from "@/lib/fetcher/http";
import { clientIp, rateLimit } from "@/lib/ratelimit";

// POST /api/collect { url, vendorUrl?, fresh? }
// Gathers the evidence bundle (deal page, vendor home/pricing, ToS, refund).
// No model calls, so no budget spend; its own, looser rate limit.
export async function POST(req: Request) {
  const rl = rateLimit(`collect:${clientIp(req)}`, Number(process.env.COLLECT_LIMIT_PER_HOUR ?? 30));
  if (!rl.ok) return Response.json({ error: "rate_limited" }, { status: 429 });

  let body: { url?: string; vendorUrl?: string; fresh?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON: { url }" }, { status: 400 });
  }
  if (!body.url || typeof body.url !== "string") return Response.json({ error: "Missing url" }, { status: 400 });

  try {
    const bundle = await collectEvidence(body.url, { fresh: !!body.fresh, vendorUrl: body.vendorUrl });
    return Response.json(bundle);
  } catch (e) {
    const status = e instanceof FetchBlockedError ? 400 : e instanceof DealUnavailableError ? 422 : 502;
    return Response.json({ error: (e as Error).message }, { status });
  }
}
