// Buyer reviews on non-AppSumo marketplaces, read from what the deal page itself
// already serves (no extra requests):
//  - schema.org Product JSON-LD (RocketHub, StackSocial, WooCommerce stores such as
//    DealMirror/Earlybird when they have reviews): aggregateRating + review[].
//  - Judge.me widget markup (Shopify stores such as Dealify): summary, histogram, reviews.
// The page shows the newest reviews first, so they are the unbiased "recent" sample.
import { normalize, stripHtml } from "./extract";
import type { DealInfo, DealReview } from "./types";

type Found = Pick<DealInfo, "reviewStats" | "reviews">;

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const clean = (s: unknown) => (typeof s === "string" ? normalize(stripHtml(s)) : "");
const byNewest = (a: DealReview, b: DealReview) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0);

/** 1-5 counts from the reviews themselves, only when they are (nearly) every review there is. */
function fullDistribution(reviews: DealReview[], count: number): Record<string, number> {
  if (!count || reviews.length < count * 0.9) return {};
  const d: Record<string, number> = {};
  for (const r of reviews) if (r.rating != null) d[String(Math.round(r.rating))] = (d[String(Math.round(r.rating))] ?? 0) + 1;
  return d;
}

function ldNodes(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      out.push(o);
      if (o["@graph"]) walk(o["@graph"]);
    }
  };
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1].trim()));
    } catch {
      /* malformed block: skip */
    }
  }
  return out;
}

function fromJsonLd(html: string, pageUrl: string): Found | null {
  const product = ldNodes(html).find((n) => (n.aggregateRating || n.review) && /Product/i.test(String(n["@type"] ?? "")));
  if (!product) return null;
  const agg = (product.aggregateRating ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(product.review) ? product.review : product.review ? [product.review] : [];
  const reviews: DealReview[] = raw
    .map((r: Record<string, unknown>, i: number): DealReview => ({
      id: String(r["@id"] ?? `ld-${i}`).replace(/^.*#/, "") || `ld-${i}`,
      rating: num((r.reviewRating as Record<string, unknown> | undefined)?.ratingValue),
      title: clean(r.name ?? r.headline),
      text: clean(r.reviewBody ?? r.description),
      date: String(r.datePublished ?? ""),
      url: pageUrl,
      sample: "recent",
      dealId: null,
    }))
    .filter((r) => r.text)
    .sort(byNewest);
  const count = num(agg.reviewCount) ?? num(agg.ratingCount) ?? reviews.length;
  if (!count && !reviews.length) return null;
  return {
    reviewStats: { count, average: num(agg.ratingValue), distribution: fullDistribution(reviews, count) },
    reviews,
  };
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}=['"]([^'"]*)['"]`));
  return m ? m[1] : null;
}

function fromJudgeMe(html: string, pageUrl: string): Found | null {
  const widget = html.match(/<div[^>]*class=['"]jdgm-rev-widg['"][^>]*>/);
  if (!widget) return null;
  const count = num(attr(widget[0], "data-number-of-reviews")) ?? 0;
  const average = num(attr(widget[0], "data-average-rating"));
  const distribution: Record<string, number> = {};
  for (const m of html.matchAll(/class=['"]jdgm-histogram__row['"][^>]*data-rating=['"](\d)['"][^>]*data-frequency=['"](\d+)['"]/g))
    distribution[m[1]] = Number(m[2]);
  const reviews: DealReview[] = [];
  const blocks = html.split(/(?=<div class=['"]jdgm-rev jdgm)/).slice(1);
  for (const b of blocks) {
    const id = b.match(/data-review-id=['"]([^'"]+)/)?.[1];
    const body = b.match(/class=['"]jdgm-rev__body['"]>([\s\S]*?)<\/div>/)?.[1];
    if (!id || !body) continue;
    reviews.push({
      id,
      rating: num(b.match(/data-score=['"](\d)/)?.[1]),
      title: clean(b.match(/class=['"]jdgm-rev__title['"]>([\s\S]*?)<\/b>/)?.[1]),
      text: clean(body),
      date: (b.match(/jdgm-rev__timestamp[^>]*data-content=['"]([^'"]+)/)?.[1] ?? "").replace(" UTC", "Z").replace(" ", "T"),
      url: pageUrl,
      sample: "recent",
      dealId: null,
    });
  }
  if (!count && !reviews.length) return null;
  reviews.sort(byNewest);
  return { reviewStats: { count: count || reviews.length, average, distribution }, reviews };
}

/** Reviews the marketplace deal page shows, or null when it shows none we can read. */
export function parseMarketplaceReviews(html: string, pageUrl: string): Found | null {
  return fromJudgeMe(html, pageUrl) ?? fromJsonLd(html, pageUrl);
}
