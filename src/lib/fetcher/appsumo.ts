// AppSumo product pages embed the full deal in __NEXT_DATA__. We read that JSON
// (plans, terms, features, FAQs, reviews) instead of scraping the rendered DOM,
// then pull critical reviews (1-3 stars) from AppSumo's public reviews API.
import * as cheerio from "cheerio";
import { safeFetch } from "./http";
import { stripHtml } from "./extract";
import type { DealInfo, DealPlan, DealReview } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export function isAppSumoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)appsumo\.com$/.test(u.hostname) && u.pathname.startsWith("/products/");
  } catch {
    return false;
  }
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

function mapReview(c: any): DealReview {
  return {
    id: c.id,
    rating: num(c.rating),
    title: String(c.title ?? "").trim(),
    text: stripHtml(String(c.comment ?? "")),
    date: String(c.created ?? c.submit_date ?? ""),
    url: c.display_path ? `https://appsumo.com${c.display_path}` : undefined,
  };
}

async function fetchReviews(dealId: number, rating?: number): Promise<any[]> {
  const qs = rating ? `&rating=${rating}` : "";
  try {
    const r = await safeFetch(`https://appsumo.com/api/v2/deals/${dealId}/reviews/?page=1${qs}`, "application/json");
    if (r.status !== 200) return [];
    return JSON.parse(r.body).comments ?? [];
  } catch {
    return [];
  }
}

export interface AppSumoParse {
  deal: DealInfo;
  dealText: string; // the page's own words, for verbatim quote checks
}

export async function parseAppSumo(url: string, html: string): Promise<AppSumoParse> {
  const $ = cheerio.load(html);
  const raw = $("script#__NEXT_DATA__").first().text();
  if (!raw) throw new Error("AppSumo page has no __NEXT_DATA__ (layout changed or blocked)");
  const pp = JSON.parse(raw).props?.pageProps ?? {};
  const d = pp.deal ?? {};
  const story = d.products?.[0]?.story ?? {};

  const plans: DealPlan[] = (d.plans ?? [])
    .filter((p: any) => p.is_active !== false)
    .sort((a: any, b: any) => (a.tier ?? 0) - (b.tier ?? 0))
    .map((p: any) => ({
      name: p.public_name || `${p.plan_type ?? "Plan"} Tier ${p.tier ?? "?"}`,
      tier: num(p.tier),
      price: num(p.price),
      originalPrice: num(p.original_price),
      terms: (p.terms ?? []).filter((t: any) => t.is_active !== false).map((t: any) => stripHtml(t.term)),
      features: (p.plan_features ?? []).map((f: any) => stripHtml(f.feature)),
    }));

  const commonFeatures: string[] = (d.common_features ?? []).map((f: any) =>
    f.tooltip ? `${f.feature} (${f.tooltip})` : String(f.feature),
  );
  const faqs = (d.faqs ?? []).map((f: any) => ({ q: stripHtml(f.question ?? ""), a: stripHtml(f.answer ?? "") }));

  const dr = d.deal_review ?? null;
  const reviewStats = dr
    ? {
        count: Number(dr.review_count ?? 0),
        average: num(dr.average_rating),
        distribution: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [String(n), Number(dr[`review_count_${n}_tacos`] ?? 0)])),
      }
    : null;

  // Newest reviews + every critical review (1-3 stars). The rating filter can
  // return reviews from earlier campaigns of the same product (other deal ids).
  const dealId = Number(d.id);
  const [newest, r1, r2, r3] = await Promise.all([
    fetchReviews(dealId),
    fetchReviews(dealId, 1),
    fetchReviews(dealId, 2),
    fetchReviews(dealId, 3),
  ]);
  const base = newest.length ? newest : (pp.reviews?.comments ?? []);
  const seen = new Set<number>();
  const all: any[] = [];
  for (const c of [...base, ...r1, ...r2, ...r3]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    all.push(c);
  }
  const relatedDealIds = [...new Set(all.map((c) => Number(c.deal_id)).filter((x) => x && x !== dealId))];

  const deal: DealInfo = {
    platform: "appsumo",
    url,
    name: String(d.public_name ?? story.header ?? ""),
    tagline: String(story.subheader ?? story.value_prop ?? ""),
    vendorUrl: d.product_url || null,
    price: num(d.price),
    originalPrice: num(d.original_price),
    refundableDays: num(d.refundable_days),
    startDate: d.dates?.start_date ?? null,
    endDate: d.dates?.end_date ?? null,
    purchases: num(d.current_purchases),
    plans,
    commonFeatures,
    faqs,
    reviewStats,
    reviews: all.map(mapReview),
    relatedDealIds,
  };

  const lines: string[] = [];
  lines.push(`# ${deal.name}`, deal.tagline);
  if (story.value_prop) lines.push(String(story.value_prop));
  if (story.tldr_overview) lines.push(stripHtml(String(story.tldr_overview)));
  if (story.html_body) lines.push("## Overview", stripHtml(String(story.html_body)));
  lines.push("## Plans");
  for (const p of plans) {
    lines.push(`### ${p.name}: $${p.price} (was $${p.originalPrice})`);
    p.terms.forEach((t) => lines.push(`- ${t}`));
    p.features.forEach((f) => lines.push(`- ${f}`));
  }
  if (commonFeatures.length) lines.push("## Features included in all plans", ...commonFeatures.map((f) => `- ${f}`));
  if (deal.refundableDays != null) lines.push(`## Refund`, `${deal.refundableDays}-day money-back guarantee`);
  if (faqs.length) lines.push("## FAQ", ...faqs.flatMap((f: { q: string; a: string }) => [`Q: ${f.q}`, `A: ${f.a}`]));
  if (deal.reviews.length) {
    lines.push("## Reviews");
    for (const r of deal.reviews) lines.push(`[review ${r.id}, ${r.rating ?? "?"}/5] ${r.title}: ${r.text}`);
  }
  return { deal, dealText: lines.filter(Boolean).join("\n") };
}
