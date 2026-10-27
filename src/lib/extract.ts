// S2: extraction. Spark reads the fetched texts and returns claims (from the
// deal page) and fine-print findings (from ToS / refund / pricing pages), each
// with a verbatim quote. Code then checks every quote against the source text
// and drops anything that does not match. Scoring happens later, in code.
import { callModel } from "./meta";
import { normQ, verifyQuote } from "./quotes";
import type { DocKind, EvidenceBundle, SourceDoc } from "./fetcher/types";

export const CLAIM_CATEGORIES = ["lifetime", "unlimited", "limit", "feature", "updates", "support", "refund", "pricing", "other"] as const;
export const FINE_PRINT_SIGNALS = [
  "lifetime_definition",
  "usage_cap",
  "refund_window",
  "unilateral_change",
  "termination",
  "support_terms",
  "regular_price",
  "other",
] as const;

export type ClaimCategory = (typeof CLAIM_CATEGORIES)[number];
export type FinePrintSignal = (typeof FINE_PRINT_SIGNALS)[number];

export interface Quote {
  doc: DocKind;
  url: string;
  text: string;
}

export interface Claim {
  id: string;
  text: string;
  category: ClaimCategory;
  tier: string | null;
  quote: Quote;
}

export interface FinePrint {
  id: string;
  signal: FinePrintSignal;
  summary: string;
  quote: Quote;
}

export interface Dropped {
  kind: "claim" | "fine_print";
  text: string;
  quote: string;
  doc: string;
  reason: string;
}

export interface Extraction {
  claims: Claim[];
  finePrint: FinePrint[];
  dropped: Dropped[];
  costUsd: number;
  basetenUsd?: number;
  models: string[];
  fallbacks?: string[];
}

const DOC_BUDGET = 45_000; // chars per doc sent to the model

function parseJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("Model did not return JSON");
  }
}

const block = (d: SourceDoc) => `<doc kind="${d.kind}" url="${d.url}">\n${d.text.slice(0, DOC_BUDGET)}\n</doc>`;

const CLAIMS_SYSTEM = `You extract checkable claims from a software deal page for a due-diligence tool.
Return JSON only: {"claims":[{"text":string,"category":one of ${JSON.stringify(CLAIM_CATEGORIES)},"tier":string|null,"quote":string}]}
Rules:
- A claim is something the seller promises that could be true or false: "lifetime access", "unlimited X", a numeric limit per tier, included features, "all future updates", support promises, refund promises, the stated regular price.
- "quote" must be copied EXACTLY, character for character, from the doc text (8-40 words). Never paraphrase, never merge two places. If you cannot quote it, leave the claim out.
- Ignore user reviews and FAQ answers written by users; only the seller's own words.
- Prefer claims that matter for value or risk. 8 to 20 claims. No duplicates.`;

const FINE_PRINT_SYSTEM = `You read a software vendor's official pages (terms of service, refund policy, pricing, homepage) for a due-diligence tool that checks lifetime deals.
Return JSON only: {"findings":[{"signal":one of ${JSON.stringify(FINE_PRINT_SIGNALS)},"doc":"terms"|"refund"|"vendor_pricing"|"vendor_home","summary":string,"quote":string}]}
Signals:
- lifetime_definition: what "lifetime" means (lifetime of the product/company/plan vs the buyer), or how long access lasts.
- usage_cap: fair-use limits, throttling, quotas, credits, "unlimited" caveats.
- refund_window: refund period and conditions.
- unilateral_change: vendor may change, remove features, change pricing or terms at any time / without notice.
- termination: vendor may suspend or terminate accounts or the service, discontinue the product.
- support_terms: what support is promised or disclaimed.
- regular_price: the normal (non-deal) price of comparable plans, with limits.
Rules:
- "quote" must be copied EXACTLY from the doc text (8-50 words). Never paraphrase. No quote, no finding.
- "summary" is one plain-English sentence on what it means for a lifetime-deal buyer.
- Report what is there, including reassuring clauses. If a signal is absent, omit it. At most 3 findings per signal.`;

export async function extract(bundle: EvidenceBundle): Promise<Extraction> {
  const byKind = new Map(bundle.docs.map((d) => [d.kind, d] as const));
  const norm = new Map(bundle.docs.map((d) => [d.kind, normQ(d.text)] as const));
  const dealDoc = byKind.get("deal");
  if (!dealDoc) throw new Error("Bundle has no deal page");
  const officialDocs = bundle.docs.filter((d) => d.kind !== "deal" && !d.error && d.text.length > 0);

  const claimsCall = callModel(
    "extractor",
    [
      { role: "system", content: CLAIMS_SYSTEM },
      { role: "user", content: block(dealDoc) },
    ],
    { json: true, reasoningEffort: "low", maxTokens: 8000 },
  );
  const fineCall = officialDocs.length
    ? callModel(
        "extractor",
        [
          { role: "system", content: FINE_PRINT_SYSTEM },
          { role: "user", content: officialDocs.map(block).join("\n\n") },
        ],
        { json: true, reasoningEffort: "low", maxTokens: 8000 },
      )
    : null;
  const [cRes, fRes] = await Promise.all([claimsCall, fineCall]);

  const dropped: Dropped[] = [];
  const claims: Claim[] = [];
  const rawClaims = ((parseJson(cRes.text) as { claims?: unknown[] }).claims ?? []) as Record<string, unknown>[];
  for (const c of rawClaims) {
    const text = String(c.text ?? "").trim();
    const quote = String(c.quote ?? "");
    const check = verifyQuote(quote, dealDoc.text, norm.get("deal"));
    if (!text || !check.verified) {
      dropped.push({ kind: "claim", text, quote, doc: "deal", reason: check.reason ?? "empty claim" });
      continue;
    }
    const category = (CLAIM_CATEGORIES as readonly string[]).includes(String(c.category)) ? (c.category as ClaimCategory) : "other";
    claims.push({
      id: `C${claims.length + 1}`,
      text,
      category,
      tier: c.tier ? String(c.tier) : null,
      quote: { doc: "deal", url: dealDoc.url, text: quote.trim() },
    });
  }

  const finePrint: FinePrint[] = [];
  if (fRes) {
    const raw = ((parseJson(fRes.text) as { findings?: unknown[] }).findings ?? []) as Record<string, unknown>[];
    for (const f of raw) {
      const quote = String(f.quote ?? "");
      // Trust the quote, not the label: find which official doc actually contains it.
      const claimed = String(f.doc ?? "") as DocKind;
      const order = [claimed, ...officialDocs.map((d) => d.kind).filter((k) => k !== claimed)];
      let hit: SourceDoc | undefined;
      let reason = "doc not found";
      for (const k of order) {
        const d = byKind.get(k);
        if (!d || d.kind === "deal") continue;
        const chk = verifyQuote(quote, d.text, norm.get(k));
        if (chk.verified) {
          hit = d;
          break;
        }
        reason = chk.reason ?? reason;
      }
      if (!hit) {
        dropped.push({ kind: "fine_print", text: String(f.summary ?? ""), quote, doc: claimed, reason });
        continue;
      }
      const signal = (FINE_PRINT_SIGNALS as readonly string[]).includes(String(f.signal)) ? (f.signal as FinePrintSignal) : "other";
      finePrint.push({
        id: `F${finePrint.length + 1}`,
        signal,
        summary: String(f.summary ?? "").trim(),
        quote: { doc: hit.kind, url: hit.url, text: quote.trim() },
      });
    }
  }

  return {
    claims,
    finePrint,
    dropped,
    costUsd: cRes.costUsd + (fRes?.costUsd ?? 0),
    basetenUsd: cRes.basetenUsd + (fRes?.basetenUsd ?? 0),
    models: [...new Set([cRes.label, fRes?.label].filter(Boolean) as string[])],
    fallbacks: [cRes.fallback, fRes?.fallback].filter(Boolean) as string[],
  };
}
