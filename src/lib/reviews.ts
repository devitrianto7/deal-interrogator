// S3: review mining. Numbers come from code (rating distribution, recent vs
// all-time average, review age). Spark only groups reviews into complaint and
// praise themes, quoting each review; quotes are verified against that review.
import { callModel } from "./meta";
import { verifyQuote } from "./quotes";
import type { DealInfo, DealReview } from "./fetcher/types";

export const THEMES = [
  "support_gone", // slow / no support, founder disappeared
  "limits_shrunk", // limits or credits reduced, plan remapped
  "features_paywalled", // features moved to paid plans / not in the deal
  "bugs_reliability", // broken, buggy, downtime
  "not_as_advertised", // promised features missing / misleading listing
  "pricing_billing", // extra costs, BYOK, credits burn, refund problems
  "great_support",
  "works_well",
  "good_value",
  "other",
] as const;
export type Theme = (typeof THEMES)[number];
const NEGATIVE: Theme[] = ["support_gone", "limits_shrunk", "features_paywalled", "bugs_reliability", "not_as_advertised", "pricing_billing"];

export interface ThemeHit {
  reviewId: string;
  rating: number | null;
  date: string;
  quote: string;
  url?: string;
  earlierCampaign: boolean;
}

export interface ReviewTheme {
  theme: Theme;
  polarity: "negative" | "positive" | "neutral";
  summary: string;
  hits: ThemeHit[];
}

export interface ReviewAnalysis {
  stats: { count: number; average: number | null; distribution: Record<string, number>; lowShare: number | null } | null;
  recent: { n: number; average: number | null; newest: string | null; oldest: string | null };
  trend: { delta: number | null; note: string };
  analyzed: number;
  themes: ReviewTheme[];
  droppedQuotes: number;
  costUsd: number;
  basetenUsd?: number;
  fallback?: string;
}

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
const day = (s: string) => (Number.isNaN(Date.parse(s)) ? null : new Date(s).toISOString().slice(0, 10));

const SYSTEM = `You group software-deal customer reviews into themes for a due-diligence tool.
Return JSON only: {"themes":[{"theme":one of ${JSON.stringify(THEMES)},"summary":string,"hits":[{"review_id":string,"quote":string}]}]}
Rules:
- A hit means that review clearly says this. "quote" is copied EXACTLY from that review's text (5-30 words). No quote, no hit.
- One review may appear in several themes. Do not invent themes for single vague remarks.
- "summary" is one plain-English sentence describing the pattern (e.g. "Several buyers say support stopped replying after the refund window").
- Cover complaints carefully, including in 4-5 star reviews ("great tool but support is slow").`;

export async function analyzeReviews(deal: DealInfo): Promise<ReviewAnalysis> {
  const reviews = deal.reviews;
  const stats = deal.reviewStats
    ? {
        ...deal.reviewStats,
        lowShare: deal.reviewStats.count
          ? Math.round((((deal.reviewStats.distribution["1"] ?? 0) + (deal.reviewStats.distribution["2"] ?? 0)) / deal.reviewStats.count) * 1000) / 1000
          : null,
      }
    : null;

  // Recent = AppSumo's newest-first page (an unbiased slice). Compare to the all-time average.
  const recentList = reviews.filter((r) => r.sample === "recent" && r.rating != null);
  const recentDates = recentList.map((r) => day(r.date)).filter(Boolean).sort() as string[];
  const recentAvg = avg(recentList.map((r) => r.rating!));
  const delta = recentAvg != null && stats?.average != null && recentList.length >= 5 ? Math.round((recentAvg - stats.average) * 100) / 100 : null;
  const trend = {
    delta,
    note:
      delta == null
        ? "Not enough recent reviews to compare."
        : `Newest ${recentList.length} reviews average ${recentAvg}/5 vs ${stats!.average}/5 all-time (${delta >= 0 ? "+" : ""}${delta}).`,
  };

  const base: ReviewAnalysis = {
    stats,
    recent: { n: recentList.length, average: recentAvg, newest: recentDates.at(-1) ?? null, oldest: recentDates[0] ?? null },
    trend,
    analyzed: reviews.length,
    themes: [],
    droppedQuotes: 0,
    costUsd: 0,
  };
  if (!reviews.length) return base;

  const byId = new Map<string, DealReview>(reviews.map((r) => [String(r.id), r]));
  const payload = reviews
    .map((r) => `<review id="${r.id}" rating="${r.rating ?? "?"}" date="${day(r.date) ?? r.date}">${r.title ? r.title + ". " : ""}${r.text.slice(0, 1500)}</review>`)
    .join("\n");
  const res = await callModel(
    "extractor",
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: payload },
    ],
    { json: true, reasoningEffort: "low", maxTokens: 8000 },
  );

  let parsed: { themes?: { theme?: string; summary?: string; hits?: { review_id?: unknown; quote?: string }[] }[] } = {};
  try {
    parsed = JSON.parse(res.text.replace(/^```(?:json)?\s*|```\s*$/g, ""));
  } catch {
    const m = res.text.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : {};
  }

  let dropped = 0;
  const themes: ReviewTheme[] = [];
  for (const t of parsed.themes ?? []) {
    const theme = (THEMES as readonly string[]).includes(String(t.theme)) ? (t.theme as Theme) : "other";
    const hits: ThemeHit[] = [];
    const seen = new Set<string>();
    for (const h of t.hits ?? []) {
      const r = byId.get(String(h.review_id));
      const quote = String(h.quote ?? "");
      if (!r || seen.has(String(r.id)) || !verifyQuote(quote, `${r.title}. ${r.text}`).verified) {
        dropped++;
        continue;
      }
      seen.add(String(r.id));
      hits.push({
        reviewId: String(r.id),
        rating: r.rating,
        date: day(r.date) ?? r.date,
        quote: quote.trim(),
        url: r.url,
        earlierCampaign: r.dealId != null && deal.relatedDealIds.includes(r.dealId),
      });
    }
    if (!hits.length) continue;
    themes.push({
      theme,
      polarity: NEGATIVE.includes(theme) ? "negative" : theme === "other" ? "neutral" : "positive",
      summary: String(t.summary ?? "").trim(),
      hits,
    });
  }
  themes.sort((a, b) => b.hits.length - a.hits.length);
  return { ...base, themes, droppedQuotes: dropped, costUsd: res.costUsd, basetenUsd: res.basetenUsd, ...(res.fallback ? { fallback: res.fallback } : {}) };
}
