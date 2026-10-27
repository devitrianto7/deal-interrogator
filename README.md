# Deal Interrogator

Paste a lifetime-deal URL. The engine cross-examines the vendor's claims against their own pages, terms/refund fine print, and reviews, then rules **Buy / Wait / Skip** with a 0-100 risk score. Every finding carries a verbatim quote that is checked against the source.

Built for the Meta Global AI Developer Hackathon (Indie track), Oct 26 - Nov 5, 2026. All code written during the event.

## Models (Meta Model API)
- Judge: `muse-wonder-1.0`
- Prosecutor / Defender / Extractor: `muse-spark-1.3-contributor` in dev, `muse-spark-1.3` in demo (`MODEL_MODE=demo`)

## Run
```bash
cp .env.example .env.local   # add MODEL_API_KEY
npm install
npm run dev
curl localhost:3000/api/ping
```

## Safety rails
- `BUDGET_USD` (default 140): Meta has no hard spend cap, so every model call is priced from its `usage` and calls stop once the cap is hit (HTTP 402).
- `RATE_LIMIT_PER_HOUR` (default 10) per IP on public endpoints (HTTP 429).

## Evidence collection (S1)

`POST /api/collect` with `{ "url": "<deal page>", "vendorUrl?": "...", "fresh?": true }` returns an evidence bundle:

- **deal**: for AppSumo, parsed from the page's embedded data (plans, per-tier terms and features, FAQs, review stats) plus newest and all 1-3 star reviews from AppSumo's public reviews API. Other deal pages are read as text.
- **docs**: the exact text of the deal page, vendor homepage, vendor pricing, terms of service and refund policy (found from homepage links, then common paths). Later steps quote only from these texts.
- **warnings**: what could not be read (e.g. JavaScript-only vendor sites).

Fetching is SSRF-guarded (public http(s) hosts only, re-checked on every redirect), time- and size-capped, and cached in `.data/cache/` for 24 h so demo deals replay identically. No model calls, so no budget spend.

## Extraction (S2)

`POST /api/extract` with `{ "url": "<deal page>" }` collects evidence, then makes two Spark calls in parallel:

- **claims** from the deal page (seller's promises: lifetime, unlimited, per-tier limits, features, updates, refund, regular price);
- **fine print** from the vendor's own pages (lifetime definition, usage caps, refund window, unilateral change, termination, support, regular price).

Every item carries a quote. `src/lib/quotes.ts` checks each quote verbatim against the fetched text (normalizing only case, whitespace, curly quotes and dashes; `...` splits must match in order) and drops anything that does not match, listing it under `dropped`. The model never scores anything.

## Review mining (S3)

Runs alongside extraction in `/api/extract` and returns `reviews`:

- **Numbers from code**: rating distribution, share of 1-2 star reviews, and the newest-first page's average vs the all-time average (AppSumo's public reviews API serves one page of 20 newest, plus up to 20 per star rating; it does not paginate further).
- **Themes from Spark**: support gone, limits shrunk, features paywalled, bugs, not as advertised, pricing/billing, and the positive ones. Each hit quotes the review verbatim and is checked against that review's text; hits from the product's earlier AppSumo campaigns are flagged.

## Risk score (S4)

`POST /api/analyze { url }` runs the whole pipeline and returns `risk: { score, verdict, signals[] }`. The score is computed in `src/lib/score.ts` from verified evidence only, across 8 signals (100 points): lifetime definition 20, hidden caps 15, support complaints 15, review trend 10, tier trap 10, vendor age and track record 10 (RDAP registration date, first Wayback capture, earlier AppSumo campaigns), discount size 10, one-sided change clauses 10. Verdict: 0-30 Buy, 31-60 Wait, 61-100 Skip. Every signal lists its finding and the quotes or public records behind it.
