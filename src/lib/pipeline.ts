// Full pipeline: collect -> (extract | reviews | vendor trace) in parallel -> score.
import { collectEvidence } from "./fetcher";
import { extract } from "./extract";
import { analyzeReviews } from "./reviews";
import { vendorTrace } from "./trace";
import { scoreRisk } from "./score";
import { holdTrial } from "./courtroom";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Finished reports are cached for 24h so the same deal returns the same verdict
// (and costs nothing) until someone asks for a fresh run.
const REPORT_DIR = path.join(process.cwd(), ".data", "reports-cache");
const REPORT_TTL_MS = 24 * 3_600_000;
const reportFile = (url: string, vendorUrl?: string) =>
  path.join(REPORT_DIR, createHash("sha256").update(`${url}|${vendorUrl ?? ""}`).digest("hex").slice(0, 24) + ".json");

// Demo cases ship with the repo (src/demo/*.json) so judges get an instant, stable report.
// "Run fresh" still re-runs the whole pipeline live.
const DEMO_DIR = path.join(process.cwd(), "src", "demo");
const demoSlug = (url: string) => url.match(/appsumo\.com\/products\/([a-z0-9-]+)/i)?.[1]?.toLowerCase();

export async function analyzeDeal(url: string, opts: { fresh?: boolean; vendorUrl?: string } = {}) {
  const file = reportFile(url, opts.vendorUrl);
  const slug = demoSlug(url);
  if (!opts.fresh && slug && !opts.vendorUrl) {
    try {
      const pinned = JSON.parse(await readFile(path.join(DEMO_DIR, `${slug}.json`), "utf8")) as Report & { generatedAt: string };
      return { ...pinned, cached: true, pinned: true };
    } catch {}
  }
  if (!opts.fresh) {
    try {
      const cached = JSON.parse(await readFile(file, "utf8")) as Report & { generatedAt: string };
      if (Date.now() - Date.parse(cached.generatedAt) < REPORT_TTL_MS) return { ...cached, cached: true };
    } catch {}
  }
  const report = { ...(await runPipeline(url, opts)), generatedAt: new Date().toISOString(), cached: false };
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(report));
  return report;
}

type Report = Awaited<ReturnType<typeof runPipeline>>;

async function runPipeline(url: string, opts: { fresh?: boolean; vendorUrl?: string }) {
  const started = Date.now();
  // Phase timings go to the server log so slow deals can be diagnosed ([timing] lines).
  const timings: Record<string, number> = {};
  const timed = <T,>(k: string, p: Promise<T>) => p.finally(() => (timings[k] = Date.now() - started));
  const bundle = await timed("collect", collectEvidence(url, opts));
  // The trial needs the extracted claims, so it chains on extraction while reviews and RDAP run alongside.
  const extracting = timed("extract", extract(bundle));
  const [extraction, court, reviews, trace] = await Promise.all([
    extracting,
    timed("court", extracting.then((ex) => holdTrial(bundle, ex.claims))),
    timed("reviews", analyzeReviews(bundle.deal)),
    timed("trace", bundle.deal.vendorUrl ? vendorTrace(bundle.deal.vendorUrl) : Promise.resolve(null)),
  ]);
  console.log(`[timing] ${url} ${JSON.stringify(timings)} (ms since start)`);
  const risk = scoreRisk(bundle.deal, extraction, reviews, trace, bundle.docs.map((x) => x.kind), bundle.docs.find((x) => x.kind === "deal")?.text ?? "", bundle.vendorReached !== false);
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
    courtroom: court,
    reviews,
    trace,
    sources: bundle.docs.map((x) => ({ kind: x.kind, url: x.url, title: x.title, chars: x.chars })),
    warnings: [...bundle.warnings, ...(trace?.errors ?? [])],
    dropped: extraction.dropped,
    costUsd: Math.round((extraction.costUsd + reviews.costUsd + court.costUsd) * 1e6) / 1e6,
    models: extraction.models,
    ms: Date.now() - started,
  };
}

export type DealReport = Awaited<ReturnType<typeof analyzeDeal>>;
