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
