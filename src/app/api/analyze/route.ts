import { DealUnavailableError } from "@/lib/fetcher";
import { FetchBlockedError } from "@/lib/fetcher/http";
import { analyzeDeal } from "@/lib/pipeline";
import { BudgetExceededError } from "@/lib/budget";
import { clientIp, rateLimit } from "@/lib/ratelimit";

// POST /api/analyze { url, vendorUrl?, fresh? } -> full report with risk score and verdict.
export async function POST(req: Request) {
  const rl = rateLimit(clientIp(req));
  if (!rl.ok) return Response.json({ error: "rate_limited" }, { status: 429 });

  let body: { url?: string; vendorUrl?: string; fresh?: boolean; asOf?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON: { url }" }, { status: 400 });
  }
  if (!body.url || typeof body.url !== "string") return Response.json({ error: "Missing url" }, { status: 400 });
  // asOf (YYYYMMDD): backtest mode, evidence rebuilt from Wayback captures before that day.
  if (body.asOf != null && (typeof body.asOf !== "string" || !/^\d{8}$/.test(body.asOf)))
    return Response.json({ error: "asOf must be YYYYMMDD" }, { status: 400 });

  try {
    return Response.json(await analyzeDeal(body.url, { fresh: !!body.fresh, vendorUrl: body.vendorUrl, asOf: body.asOf }));
  } catch (e) {
    if (e instanceof BudgetExceededError) return Response.json({ error: e.message }, { status: 402 });
    const status = e instanceof FetchBlockedError ? 400 : e instanceof DealUnavailableError ? 422 : 502;
    return Response.json({ error: (e as Error).message }, { status });
  }
}
