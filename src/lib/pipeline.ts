// Full pipeline: collect -> (extract | reviews | vendor trace) in parallel -> score.
import { collectEvidence } from "./fetcher";
import { extract } from "./extract";
import { analyzeReviews } from "./reviews";
import { vendorTrace } from "./trace";
import { scoreRisk } from "./score";

export async function analyzeDeal(url: string, opts: { fresh?: boolean; vendorUrl?: string } = {}) {
  const started = Date.now();
  const bundle = await collectEvidence(url, opts);
  const [extraction, reviews, trace] = await Promise.all([
    extract(bundle),
    analyzeReviews(bundle.deal),
    bundle.deal.vendorUrl ? vendorTrace(bundle.deal.vendorUrl) : Promise.resolve(null),
  ]);
  const risk = scoreRisk(bundle.deal, extraction, reviews, trace);
  const d = bundle.deal;
  return {
    deal: {
      name: d.name,
      tagline: d.tagline,
      url: d.url,
      vendorUrl: d.vendorUrl,
      platform: d.platform,
      price: d.price,
      originalPrice: d.originalPrice,
      refundableDays: d.refundableDays,
      plans: d.plans,
      relatedDealIds: d.relatedDealIds,
    },
    risk,
    claims: extraction.claims,
    finePrint: extraction.finePrint,
    reviews,
    trace,
    sources: bundle.docs.map((x) => ({ kind: x.kind, url: x.url, title: x.title, chars: x.chars })),
    warnings: [...bundle.warnings, ...(trace?.errors ?? [])],
    dropped: extraction.dropped,
    costUsd: Math.round((extraction.costUsd + reviews.costUsd) * 1e6) / 1e6,
    models: extraction.models,
    ms: Date.now() - started,
  };
}

export type DealReport = Awaited<ReturnType<typeof analyzeDeal>>;
