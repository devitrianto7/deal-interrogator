import { collectEvidence, DealUnavailableError } from "@/lib/fetcher";
import { FetchBlockedError } from "@/lib/fetcher/http";
import { extract } from "@/lib/extract";
import { BudgetExceededError } from "@/lib/budget";
import { clientIp, rateLimit } from "@/lib/ratelimit";

// POST /api/extract { url, vendorUrl?, fresh? }
// Collects evidence, then extracts claims + fine print with verbatim-checked quotes.
export async function POST(req: Request) {
  const rl = rateLimit(clientIp(req));
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
    const extraction = await extract(bundle);
    return Response.json({
      deal: { name: bundle.deal.name, url: bundle.deal.url, vendorUrl: bundle.deal.vendorUrl },
      sources: bundle.docs.map((d) => ({ kind: d.kind, url: d.url, chars: d.chars })),
      warnings: bundle.warnings,
      ...extraction,
    });
  } catch (e) {
    if (e instanceof BudgetExceededError) return Response.json({ error: e.message }, { status: 402 });
    const status = e instanceof FetchBlockedError ? 400 : e instanceof DealUnavailableError ? 422 : 502;
    return Response.json({ error: (e as Error).message }, { status });
  }
}
