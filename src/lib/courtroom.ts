// S10: the courtroom. For the deal's most important claims:
//   Prosecutor (Spark) looks for evidence AGAINST each claim,
//   Defender (Spark) looks for evidence FOR it, in parallel,
//   code verifies every quoted exhibit verbatim against its source and drops the rest,
//   Judge (Wonder) rules confirmed / contradicted / unverifiable from the surviving exhibits only.
// Code then enforces the rule of evidence: a ruling that cites no valid exhibit from the
// right side is downgraded to "unverifiable". No verdict without a verified quote.
import { callModel } from "./meta";
import { normQ, verifyQuote } from "./quotes";
import type { Claim, ClaimCategory } from "./extract";
import type { DealReview, EvidenceBundle } from "./fetcher/types";

export type Side = "prosecution" | "defense";
export type Ruling = "confirmed" | "contradicted" | "unverifiable";

export interface Exhibit {
  id: string; // E1, E2, ...
  claimId: string;
  side: Side;
  source: string; // terms | refund | vendor_pricing | vendor_home | review
  quote: string;
  argument: string;
  url: string;
  reviewRating?: number | null;
}

export interface ClaimTrial {
  claimId: string;
  claim: string;
  claimQuote: string;
  category: ClaimCategory;
  ruling: Ruling;
  reasoning: string;
  cited: string[]; // exhibit ids the judge relied on (validated)
  exhibits: Exhibit[];
  overruled?: string; // why code downgraded the judge's ruling
}

export interface Courtroom {
  trials: ClaimTrial[];
  droppedExhibits: { side: Side; claimId: string; source: string; quote: string; reason: string }[];
  costUsd: number;
  models: { prosecutor: string; defender: string; judge: string } | null;
}

const MAX_CLAIMS = 6;
const PRIORITY: ClaimCategory[] = ["lifetime", "unlimited", "limit", "updates", "refund", "support", "pricing", "feature", "other"];
const DOC_BUDGET = 30_000;
const REVIEW_LIMIT = 40;

function parseJson(text: string): Record<string, unknown> {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : {};
  }
}

// Marketplace boilerplate (activation windows, new-user rules, plan-name mapping) is the same on
// every deal and has no evidence to argue over; keep the trial on the product's own promises.
const BOILERPLATE = /activat|redeem|within \d+ days|new .*(users?|customers?)|previous account|plan name|stack|upgrade (or|and|between)|downgrade/i;

export function pickClaims(claims: Claim[]): Claim[] {
  const sorted = claims
    .filter((c) => !BOILERPLATE.test(c.text)).sort((a, b) => PRIORITY.indexOf(a.category) - PRIORITY.indexOf(b.category));
  const out: Claim[] = [];
  const perCat = new Map<string, number>();
  for (const c of sorted) {
    const n = perCat.get(c.category) ?? 0;
    if (n >= (c.category === "feature" ? 3 : 2)) continue; // spread the trial across kinds of promises
    perCat.set(c.category, n + 1);
    out.push(c);
    if (out.length === MAX_CLAIMS) break;
  }
  return out;
}

const ADVOCATE_RULES = `Sources are given as <doc source="..."> (the vendor's own official pages) and <review source="review:ID" rating=".."> (buyer reviews).
Return JSON only: {"cases":[{"claim_id":string,"exhibits":[{"source":string,"quote":string,"argument":string}]}]}
Rules:
- "source" is exactly the source attribute of the doc or review you quote, e.g. "terms" or "review:12345".
- "quote" is copied EXACTLY, character for character, from that source (8-50 words). Never paraphrase or stitch. A quote that is not verbatim will be thrown out.
- "argument" is one plain sentence on why the quote matters for this claim.
- At most 2 exhibits per claim, the strongest only. If you find nothing real, return an empty exhibits list. Do not stretch.
- Include every claim_id you were given.`;

const PROSECUTOR = `You are the prosecutor in a due-diligence trial of a software lifetime deal. For each seller claim, find evidence that CONTRADICTS or UNDERMINES it: fine print that limits or voids it, terms that let the vendor take it back, prices that make it misleading, or buyer reviews reporting it is not true.
${ADVOCATE_RULES}`;

const DEFENDER = `You are the defense in a due-diligence trial of a software lifetime deal. For each seller claim, find evidence that SUPPORTS it: the vendor's own official pages stating the same thing, or buyer reviews confirming it works as promised.
${ADVOCATE_RULES}`;

const JUDGE = `You are the judge in a due-diligence trial of a software lifetime deal. For each claim you get exhibits from the prosecution (against) and defense (for). Every exhibit quote was already checked verbatim against its source.
Return JSON only: {"rulings":[{"claim_id":string,"ruling":"confirmed"|"contradicted"|"unverifiable","cited":[exhibit ids],"reasoning":string}]}
Rules of evidence:
- Rule ONLY on the exhibits shown. Ignore anything you know about the product from elsewhere.
- "contradicted": a prosecution exhibit directly conflicts with or materially limits the claim. Cite it.
- "confirmed": a defense exhibit directly supports the claim and no prosecution exhibit materially undercuts it. Cite it.
- "unverifiable": the exhibits are missing, off-topic, or too weak either way.
- Binding terms (terms, refund) outweigh marketing pages; several consistent reviews outweigh one.
- The vendor's regular subscription prices for ordinary customers are NOT evidence against a deal-specific promise (a lifetime deal exists precisely because others pay monthly). Only count them if they show deal buyers are being charged or moved to them.
- "reasoning" is one or two plain sentences a buyer understands, naming what the exhibits show.
- Rule on every claim_id.`;

interface SourceText {
  text: string;
  norm: string;
  url: string;
  rating?: number | null;
}

export async function holdTrial(bundle: EvidenceBundle, claims: Claim[]): Promise<Courtroom> {
  const picked = pickClaims(claims);
  const empty: Courtroom = { trials: [], droppedExhibits: [], costUsd: 0, models: null };
  if (!picked.length) return empty;

  // Evidence locker: official docs + a slice of reviews (newest first, then critical).
  const sources = new Map<string, SourceText>();
  const officialDocs = bundle.docs.filter((d) => d.kind !== "deal" && !d.error && d.text.length > 0);
  for (const d of officialDocs) sources.set(d.kind, { text: d.text, norm: normQ(d.text), url: d.url });
  const reviews: DealReview[] = bundle.deal.reviews.slice(0, REVIEW_LIMIT);
  for (const r of reviews) {
    const text = `${r.title}. ${r.text}`;
    sources.set(`review:${r.id}`, { text, norm: normQ(text), url: r.url ?? bundle.deal.url, rating: r.rating });
  }
  if (!sources.size) return empty;

  const locker = [
    ...officialDocs.map((d) => `<doc source="${d.kind}" url="${d.url}">\n${d.text.slice(0, DOC_BUDGET)}\n</doc>`),
    ...reviews.map((r) => `<review source="review:${r.id}" rating="${r.rating ?? "?"}">${r.title ? r.title + ". " : ""}${r.text.slice(0, 1200)}</review>`),
  ].join("\n\n");
  const docket = picked.map((c) => `- ${c.id}: ${c.text} (seller's words: "${c.quote.text}")`).join("\n");
  const brief = `Claims on trial:\n${docket}\n\nEvidence:\n${locker}`;

  const [pRes, dRes] = await Promise.all([
    callModel("prosecutor", [{ role: "system", content: PROSECUTOR }, { role: "user", content: brief }], { json: true, reasoningEffort: "low", maxTokens: 8000 }),
    callModel("defender", [{ role: "system", content: DEFENDER }, { role: "user", content: brief }], { json: true, reasoningEffort: "low", maxTokens: 8000 }),
  ]);

  const exhibits: Exhibit[] = [];
  const droppedExhibits: Courtroom["droppedExhibits"] = [];
  const validIds = new Set(picked.map((c) => c.id));
  const admit = (side: Side, text: string) => {
    const cases = (parseJson(text).cases ?? []) as { claim_id?: string; exhibits?: { source?: string; quote?: string; argument?: string }[] }[];
    for (const c of cases) {
      const claimId = String(c.claim_id ?? "");
      if (!validIds.has(claimId)) continue;
      for (const e of (c.exhibits ?? []).slice(0, 2)) {
        const source = String(e.source ?? "");
        const quote = String(e.quote ?? "").trim();
        const src = sources.get(source);
        const check = src ? verifyQuote(quote, src.text, src.norm) : { verified: false, reason: "unknown source" };
        if (!src || !check.verified) {
          droppedExhibits.push({ side, claimId, source, quote, reason: check.reason ?? "not verbatim" });
          continue;
        }
        exhibits.push({
          id: `E${exhibits.length + 1}`,
          claimId,
          side,
          source: source.startsWith("review:") ? "review" : source,
          quote,
          argument: String(e.argument ?? "").trim(),
          url: src.url,
          ...(source.startsWith("review:") ? { reviewRating: src.rating ?? null } : {}),
        });
      }
    }
  };
  admit("prosecution", pRes.text);
  admit("defense", dRes.text);

  // Judge sees only admitted exhibits.
  const record = picked
    .map((c) => {
      const ex = exhibits.filter((e) => e.claimId === c.id);
      const lines = ex.length
        ? ex.map((e) => `  ${e.id} [${e.side}, ${e.source}${e.reviewRating ? `, ${e.reviewRating}-star` : ""}] "${e.quote}" (argument: ${e.argument})`).join("\n")
        : "  (no admitted exhibits)";
      return `${c.id}: ${c.text}\n  Seller's words: "${c.quote.text}"\n${lines}`;
    })
    .join("\n\n");
  const jRes = await callModel("judge", [{ role: "system", content: JUDGE }, { role: "user", content: record }], {
    json: true,
    reasoningEffort: "low",
    maxTokens: 6000,
  });
  const rulings = (parseJson(jRes.text).rulings ?? []) as { claim_id?: string; ruling?: string; cited?: unknown[]; reasoning?: string }[];

  const trials: ClaimTrial[] = picked.map((c) => {
    const ex = exhibits.filter((e) => e.claimId === c.id);
    const r = rulings.find((x) => String(x.claim_id) === c.id);
    let ruling: Ruling = (["confirmed", "contradicted", "unverifiable"] as const).find((v) => v === r?.ruling) ?? "unverifiable";
    const cited = (r?.cited ?? []).map(String).filter((id) => ex.some((e) => e.id === id));
    let overruled: string | undefined;
    // Rule of evidence, enforced in code.
    const need: Side | null = ruling === "confirmed" ? "defense" : ruling === "contradicted" ? "prosecution" : null;
    if (need && !cited.some((id) => ex.find((e) => e.id === id)?.side === need)) {
      overruled = `Judge ruled "${ruling}" without citing a verified ${need} exhibit.`;
      ruling = "unverifiable";
    }
    return {
      claimId: c.id,
      claim: c.text,
      claimQuote: c.quote.text,
      category: c.category,
      ruling,
      reasoning: r?.reasoning ? String(r.reasoning).trim() : "No ruling returned.",
      cited,
      exhibits: ex,
      ...(overruled ? { overruled } : {}),
    };
  });

  return {
    trials,
    droppedExhibits,
    costUsd: pRes.costUsd + dRes.costUsd + jRes.costUsd,
    models: { prosecutor: pRes.model, defender: dRes.model, judge: jRes.model },
  };
}
