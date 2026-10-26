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
