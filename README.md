# Deal Interrogator

**Live:** https://deal.nogap.tech

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

## How it works
```
URL ─► 1 Collect ─► 2 Extract ─► 3 Verify quotes ─► 4 Score (code) ─► Verdict
              │                                   ▲
              ├─► Reviews (trend + themes) ───────┤
              ├─► RDAP domain age + first Wayback ┤
              └─► 5 Courtroom: Prosecutor ∥ Defender ─► Judge
```
1. **Collect** (`src/lib/fetcher/`): for AppSumo, parses the page's embedded data (plans, per-tier terms, features, FAQs, review stats) and the public reviews API; then discovers the vendor's homepage, pricing, terms and refund pages. SSRF-guarded fetches, 24 h cache.
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

## Models (Meta Model API)
- Judge: `muse-wonder-1.0`
- Prosecutor / Defender / Extractor: `muse-spark-1.3-contributor`, or `muse-spark-1.3` with `MODEL_MODE=demo`

## API
- `POST /api/analyze` `{ "url": "...", "vendorUrl?": "...", "fresh?": true }` → full report (risk, signals with receipts, claims, fine print, courtroom, reviews, trace, sources, cost)
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
