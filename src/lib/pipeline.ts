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

export async function analyzeDeal(url: string, opts: { fresh?: boolean; vendorUrl?: string } = {}) {
  const file = reportFile(url, opts.vendorUrl);
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
  const bundle = await collectEvidence(url, opts);
  // The trial needs the extracted claims, so it chains on extraction while reviews and RDAP run alongside.
  const extracting = extract(bundle);
  const [extraction, court, reviews, trace] = await Promise.all([
    extracting,
    extracting.then((ex) => holdTrial(bundle, ex.claims)),
    analyzeReviews(bundle.deal),
    bundle.deal.vendorUrl ? vendorTrace(bundle.deal.vendorUrl) : Promise.resolve(null),
  ]);
  const risk = scoreRisk(bundle.deal, extraction, reviews, trace, bundle.docs.map((x) => x.kind), bundle.docs.find((x) => x.kind === "deal")?.text ?? "");
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
