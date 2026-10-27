# Deal Interrogator

**Live:** https://deal.nogap.tech · **Demo video (2:41):** https://youtu.be/4P2WdAkbhfA

Paste a lifetime-deal URL (AppSumo or any deal page). Deal Interrogator puts the vendor's promises on trial: it collects their own pages, the terms and refund fine print, and buyer reviews, cross-examines every key claim in a courtroom of models, and rules **Buy / Wait / Skip** with a 0-100 risk score.

The rule that makes it trustworthy: **no receipt, no point.** Every finding carries a verbatim quote, and code checks each quote against the source text. A quote that isn't really there is dropped before it can count.

Built for the Meta Global AI Developer Hackathon (Indie track), Oct 26 - Nov 5, 2026. All code was written during the event.

## Why
Lifetime deals are cheap until they aren't: "lifetime" quietly means "lifetime of the product", caps appear after purchase, and terms let the vendor change anything at any time. Buyers find out from 1-star reviews months later. The evidence usually exists on day one, spread across five pages nobody reads. This tool reads them.

## Demo cases
| Deal | Score | Verdict | Why |
|---|---|---|---|
| TinyEmail | 29 | **Buy** | 14-year-old vendor, strong ratings, no one-sided change clause; the lifetime claim is confirmed in court. |
| SheetXAI | 53 | **Wait** | Popular, but the ToS allows no refunds and lets the vendor change credits and discontinue features at any time; hidden caps and a tier trap. |
| ChatPlayground AI | 68 | **Skip** | Recent reviews average 1.6 vs 3.72 all-time; buyers report lifetime access removed and features moved behind a subscription. The "lifetime access" claim is ruled **contradicted**. |

These three reports are pinned in `src/demo/` so the demo is stable. Any other URL runs live (about 45-60 s, roughly $0.02-0.04 per deal).

## The Docket
**https://deal.nogap.tech/docket** lists about 200 live AppSumo lifetime deals already judged by the same engine, with verdict counts, Buy/Wait/Skip filters, sorting by risk score, and each deal's top two signals with a verified quote. Every row opens the full report (`/docket/<slug>`, statically generated), where "Run fresh" re-tries the case live.

Deals were picked from AppSumo's public deals API: currently on sale, "Lifetime access" in the terms, and the most reviews. Summaries live in `src/docket/index.json` and full reports in `src/docket/<slug>.json`; they are snapshots dated in each report.

## How it works
```
URL ─► 1 Collect ─► 2 Extract ─► 3 Verify quotes ─► 4 Score (code) ─► Verdict
              │                                   ▲
              ├─► Reviews (trend + themes) ───────┤
              ├─► RDAP domain age + first Wayback ┤
              └─► 5 Courtroom: Prosecutor ∥ Defender ─► Judge
```
1. **Collect** (`src/lib/fetcher/`): for AppSumo, parses the page's embedded data (plans, per-tier terms, features, FAQs, review stats) and the public reviews API; then discovers the vendor's homepage, pricing, terms and refund pages. SSRF-guarded fetches, 24 h cache.
   Vendor discovery: AppSumo's `product_url`, else any link in the deal data whose host matches the product name, else a `<name>.com/.io/.ai/.app` domain whose homepage title names the product (flagged in the warnings). Short links are followed and reported as the real domain; a failing landing subpage falls back to the root site. Pages that refuse Node's fetch (bot-shield 403s) are retried with curl; JavaScript-only or still-blocked homepages fall back to the r.jina.ai reader, then the latest Wayback capture, and those documents are marked `via` in the sources. Terms and pricing come from homepage links, `/sitemap.xml`, then common paths; a homepage pricing section with prices counts as the pricing source. A legal notice (imprint) is never counted as terms.
2. **Extract** (`src/lib/extract.ts`): two parallel Muse Spark calls return JSON: the seller's claims from the deal page, and fine print (lifetime definition, caps, refund, change/discontinue clauses) from the official docs.
3. **Verify** (`src/lib/quotes.ts`): every quote must appear verbatim (whitespace and punctuation normalised) in the document it cites, or it is dropped.
4. **Score** (`src/lib/score.ts`): the model never sets points. Code maps verified evidence to an 8-signal rubric (100 points):

   | Signal | Max |
   |---|---|
   | Lifetime definition | 20 |
   | Hidden caps | 15 |
   | Support complaints | 15 |
   | Review trend (newest vs all-time) | 10 |
   | Tier trap | 10 |
   | Vendor age & track record (RDAP + Wayback + repeat LTDs) | 10 |
   | Discount size | 10 |
   | One-sided change clauses | 10 |

   0-30 Buy, 31-60 Wait, 61+ Skip. A **coverage guard** blocks a Buy when the terms couldn't be read: a missing ToS is not proof of safety.
5. **Courtroom** (`src/lib/courtroom.ts`): up to 6 key claims go to trial. Prosecutor and Defender (Muse Spark) each file exhibits in parallel; exhibits are verified verbatim. The Judge (Muse Wonder) rules each claim *confirmed / contradicted / unverifiable*. Code downgrades any ruling that doesn't cite a verified exhibit from the winning side.

## Backtest
**Live:** https://deal.nogap.tech/backtest

Would the engine have seen it coming? `POST /api/analyze` accepts `asOf: "YYYYMMDD"`: every page (deal, vendor home, pricing, terms, refund) is read from the newest Wayback Machine capture strictly before that day (raw `id_` mode; a redirect to a newer capture is rejected; no capture means missing, never a live fallback). Review stats come from the archived deal page; review texts from AppSumo's API only if written before the date and not edited after it. Domain age is measured at the as-of date. Code: `src/lib/fetcher/wayback.ts`.

We ran 14 AppSumo deals that later shut down, revoked lifetime access or cut limits (dated AppSumo notices or buyer reports), 90 days before each event, plus 8 controls still healthy in Oct 2026, as of 1 Aug 2024. Production thresholds, no recalibration. Results (`src/backtest/results.json`): 6 of 13 scored failures scored above 30 (Wait on the evidence), 12 of 13 were not rated Buy (6 of those were set by evidence guards: unreadable terms, zero reviews, or unreachable vendor site, not by the score), 1 was rated Buy (Notice). Controls: 1 of 6 rated Buy, 3 of 6 scored above 30. At this sample size the score does not separate failures from survivors; the engine is cautious for both. 3 cases could not be scored because the Internet Archive rate-limited us mid-run. Total model spend for the backtest: about $1.

## Models (Meta Model API)
- Judge: `muse-wonder-1.0`
- Prosecutor / Defender / Extractor: `muse-spark-1.3-contributor`, or `muse-spark-1.3` with `MODEL_MODE=demo`

## API
- `POST /api/analyze` `{ "url": "...", "vendorUrl?": "...", "fresh?": true, "asOf?": "YYYYMMDD" }` → full report (risk, signals with receipts, claims, fine print, courtroom, reviews, trace, sources, cost)
- `POST /api/collect` → evidence bundle only
- `POST /api/extract` → claims + fine print + reviews
- `GET /api/ping` → model health check

## Safety rails
- `BUDGET_USD` (default 140): Meta's spend limit is an alert, not a cap, so every call is priced from its `usage` and calls stop past the budget (HTTP 402).
- `RATE_LIMIT_PER_HOUR` (default 10) per IP (HTTP 429).
- Finished reports cached 24 h; `fresh: true` bypasses.

## Run locally
```bash
cp .env.example .env.local   # add MODEL_API_KEY
npm ci
npm run dev
```

## Deploy
Production runs on an AWS Lightsail server (Singapore) managed by CloudStick: Node 22, `npm ci` → `npm run build` → `npm run start -- -p 8282` under PM2, nginx reverse proxy with Let's Encrypt, auto-deploy on push to `main`.

## Stack
Next.js 16, React 19, Tailwind 4, cheerio, OpenAI-compatible SDK pointed at `https://api.meta.ai/v1`.

## Limits
- Model output varies slightly between runs even at temperature 0, so borderline scores can move a few points.
- Vendor sites that render only with JavaScript yield no official pages; the coverage guard flags this instead of guessing.
- The courtroom explains claims; it doesn't change the score.
