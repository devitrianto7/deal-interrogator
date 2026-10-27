// S4: risk score, computed in code from verified evidence only.
// 8 signals, 100 points max (rubric in concept.md). The model never sets points:
// it only supplied labeled, quote-verified findings; these rules turn them into points.
import type { DealInfo } from "./fetcher/types";
import type { Extraction, FinePrint } from "./extract";
import type { ReviewAnalysis, ReviewTheme } from "./reviews";
import type { VendorTrace } from "./trace";

export interface Evidence {
  source: string; // deal | terms | refund | vendor_pricing | vendor_home | review | rdap | wayback
  quote: string;
  url?: string;
}

export interface SignalScore {
  key: string;
  label: string;
  max: number;
  points: number;
  finding: string;
  evidence: Evidence[];
}

export type Verdict = "Buy" | "Wait" | "Skip";

export interface RiskReport {
  score: number;
  verdict: Verdict;
  signals: SignalScore[];
}

const fp = (x: FinePrint): Evidence => ({ source: x.quote.doc, quote: x.quote.text, url: x.quote.url });
const rv = (t: ReviewTheme | undefined, n = 3): Evidence[] =>
  (t?.hits ?? []).slice(0, n).map((h) => ({ source: "review", quote: h.quote, url: h.url }));
const theme = (r: ReviewAnalysis, k: string) => r.themes.find((t) => t.theme === k);
const yearsSince = (d: string | null) => (d ? (Date.now() - Date.parse(d)) / (365.25 * 864e5) : null);

const PRODUCT_LIFETIME = /lifetime of (the )?(product|service|company|business|platform|plan|software|app)|as long as (the )?(product|service|company)|product('s)? lifetime/i;
const BUYER_LIFETIME = /lifetime of (the )?(user|buyer|customer|account holder|purchaser)|for as long as you/i;
const DISCONTINUE = /discontinu|cease|shut ?down|terminate (the )?(service|product)|end of life|sunset/i;
const NO_NOTICE = /without (prior )?notice|at any time|sole discretion/i;

export function scoreRisk(deal: DealInfo, ex: Extraction, rev: ReviewAnalysis, trace: VendorTrace | null): RiskReport {
  const by = (s: FinePrint["signal"]) => ex.finePrint.filter((f) => f.signal === s);
  const signals: SignalScore[] = [];

  // 1. Lifetime definition (20)
  {
    const defs = by("lifetime_definition");
    const term = by("termination");
    const productLife = defs.find((d) => PRODUCT_LIFETIME.test(d.quote.text));
    const buyerLife = defs.find((d) => BUYER_LIFETIME.test(d.quote.text));
    const discontinue = [...term, ...by("unilateral_change")].find((d) => DISCONTINUE.test(d.quote.text));
    const revoked = theme(rev, "features_paywalled");
    const revokedN = revoked?.hits.filter((h) => (h.rating ?? 5) <= 2).length ?? 0;
    let points = 0;
    let finding = "No clause limits what \"lifetime\" means.";
    let evidence: Evidence[] = [];
    if (revokedN >= 3) {
      points = 20;
      finding = `${revokedN} low-star reviews say lifetime access was cut back or moved behind a subscription.`;
      evidence = rv(revoked);
    } else if (productLife) {
      points = 20;
      finding = "\"Lifetime\" means the product's lifetime, not yours.";
      evidence = [fp(productLife)];
    } else if (discontinue) {
      points = 10;
      finding = "The vendor may discontinue the product, which ends a lifetime deal.";
      evidence = [fp(discontinue)];
    } else if (buyerLife) {
      finding = "\"Lifetime\" is tied to the buyer, not the product.";
      evidence = [fp(buyerLife)];
    }
    signals.push({ key: "lifetime", label: "Lifetime definition", max: 20, points, finding, evidence });
  }

  // 2. Hidden caps (15): "unlimited" promised, but caps/credits in fine print or shrinking limits in reviews
  {
    const unlimited = ex.claims.filter((c) => c.category === "unlimited" || /unlimited/i.test(c.quote.text));
    const caps = by("usage_cap");
    const shrunk = theme(rev, "limits_shrunk");
    let points = 0;
    let finding = "No usage caps found behind the deal's promises.";
    let evidence: Evidence[] = [];
    if (unlimited.length && caps.length) {
      points = 15;
      finding = `The deal says "unlimited", but the vendor's own pages meter usage.`;
      evidence = [{ source: "deal", quote: unlimited[0].quote.text, url: unlimited[0].quote.url }, ...caps.slice(0, 2).map(fp)];
    } else if (caps.length) {
      points = 5;
      finding = "Usage is metered (credits or quotas) on the vendor's pages.";
      evidence = caps.slice(0, 2).map(fp);
    }
    if (shrunk && shrunk.hits.length >= 2) {
      points = Math.min(15, points + 8);
      const r = `${shrunk.hits.length} reviews say limits were reduced.`;
      finding = points > 8 ? `${finding} ${r}` : r;
      evidence.push(...rv(shrunk, 2));
    }
    signals.push({ key: "caps", label: "Hidden caps", max: 15, points, finding: finding.trim(), evidence });
  }

  // 3. Support complaints (15)
  {
    const t = theme(rev, "support_gone");
    const n = t?.hits.length ?? 0;
    const points = n >= 3 ? 15 : n === 2 ? 8 : n === 1 ? 4 : 0;
    signals.push({
      key: "support",
      label: "Support complaints",
      max: 15,
      points,
      finding: n ? `${n} review${n > 1 ? "s" : ""} say support is slow or gone.` : "No reviews complain about support.",
      evidence: rv(t),
    });
  }

  // 4. Sentiment trend (10)
  {
    const d = rev.trend.delta;
    const low = rev.stats?.lowShare ?? 0;
    let points = d == null ? 0 : d <= -1 ? 10 : d <= -0.5 ? 6 : d <= -0.25 ? 3 : 0;
    if (low >= 0.25) points = Math.max(points, 6);
    const finding =
      rev.trend.note + (low >= 0.1 ? ` ${Math.round(low * 100)}% of all reviews are 1-2 stars.` : "");
    signals.push({
      key: "trend",
      label: "Review trend",
      max: 10,
      points,
      finding,
      evidence: rev.stats ? [{ source: "review", quote: `${rev.stats.count} reviews, average ${rev.stats.average}/5`, url: deal.url }] : [],
    });
  }

  // 5. Tier trap (10): cheapest tier missing most of what the next tier has, or zero allowances
  {
    const plans = [...deal.plans].sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
    let points = 0;
    let finding = plans.length < 2 ? "Single tier, nothing to compare." : "The cheapest tier is a usable slice of the product.";
    const evidence: Evidence[] = [];
    if (plans.length >= 2) {
      const key = (s: string) => s.toLowerCase().replace(/[\d,.]+|unlimited/g, "").replace(/\s+/g, " ").trim();
      const t1 = new Set(plans[0].features.map(key));
      const t2 = plans[1].features.map(key);
      const missing = t2.filter((f) => !t1.has(f));
      const share = t2.length ? missing.length / t2.length : 0;
      const zero = plans[0].features.find((f) => /(^|\s)0\s/.test(f));
      if (share >= 0.5) {
        points += 6;
        evidence.push({ source: "deal", quote: `${plans[0].name} ($${plans[0].price}): ${plans[0].features.join("; ")}`, url: deal.url });
      }
      if (zero) {
        points += 4;
        if (!evidence.length) evidence.push({ source: "deal", quote: zero, url: deal.url });
      }
      if (points)
        finding = `The $${plans[0].price} tier lacks ${missing.length} of ${t2.length} features in the $${plans[1].price} tier${zero ? " and includes a zero allowance" : ""}.`;
    }
    signals.push({ key: "tiers", label: "Tier trap", max: 10, points, finding, evidence });
  }

  // 6. Vendor age & track record (10)
  {
    const regY = yearsSince(trace?.registered ?? null);
    const snapY = yearsSince(trace?.firstSnapshot ?? null);
    const age = Math.max(regY ?? 0, snapY ?? 0);
    let points = 0;
    const evidence: Evidence[] = [];
    if (trace?.registered) evidence.push({ source: "rdap", quote: `${trace.domain} registered ${trace.registered}`, url: trace.rdapUrl });
    if (trace?.firstSnapshot) evidence.push({ source: "wayback", quote: `First archived ${trace.firstSnapshot}`, url: trace.firstSnapshotUrl ?? undefined });
    let finding: string;
    if (!trace || (regY == null && snapY == null)) finding = "Domain age could not be checked.";
    else {
      points = age < 1 ? 10 : age < 2 ? 5 : 0;
      finding = `Domain is about ${age.toFixed(1)} years old.`;
    }
    const repeats = deal.relatedDealIds.length;
    if (repeats >= 2) {
      points = Math.min(10, points + 3);
      finding += ` Sold on AppSumo ${repeats} times before.`;
    } else if (repeats === 1) finding += " Sold on AppSumo once before.";
    signals.push({ key: "vendor", label: "Vendor age & track record", max: 10, points, finding, evidence });
  }

  // 7. Unreasonable discount (10): entry tier price vs the stated regular price
  {
    const p = [...deal.plans].sort((a, b) => (a.price ?? 0) - (b.price ?? 0))[0];
    const price = p?.price ?? deal.price;
    const orig = p?.originalPrice ?? deal.originalPrice;
    let points = 0;
    let finding = "No regular price to compare against.";
    const evidence: Evidence[] = [];
    if (price != null && orig) {
      const off = 1 - price / orig;
      points = off > 0.9 ? 10 : off > 0.8 ? 5 : 0;
      finding = `$${price} vs a stated $${orig} regular price (${Math.round(off * 100)}% off).`;
      evidence.push({ source: "deal", quote: `$${price} (was $${orig})`, url: deal.url });
    }
    signals.push({ key: "discount", label: "Discount size", max: 10, points, finding, evidence });
  }

  // 8. Unilateral change clauses (10)
  {
    const u = by("unilateral_change");
    const strong = u.find((x) => NO_NOTICE.test(x.quote.text));
    const points = strong ? 10 : u.length ? 6 : 0;
    signals.push({
      key: "unilateral",
      label: "One-sided change clauses",
      max: 10,
      points,
      finding: strong
        ? "The terms let the vendor change features or pricing at any time."
        : u.length
          ? "The terms let the vendor change the service."
          : "No one-sided change clause found.",
      evidence: (strong ? [strong, ...u.filter((x) => x !== strong)] : u).slice(0, 2).map(fp),
    });
  }

  const score = signals.reduce((a, s) => a + s.points, 0);
  const verdict: Verdict = score <= 30 ? "Buy" : score <= 60 ? "Wait" : "Skip";
  return { score, verdict, signals };
}
