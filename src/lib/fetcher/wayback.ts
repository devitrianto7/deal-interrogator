// As-of mode: read the web as it was on a past date, from Wayback Machine captures.
//
// No-leakage rules (every page that enters an as-of report goes through here):
// 1. A page is read only from a capture whose timestamp is strictly BEFORE the as-of day
//    (CDX `to=` is the day before, and every timestamp is re-checked in code).
// 2. Captures are fetched in raw `id_` mode, so the HTML is exactly what was archived,
//    with no Wayback toolbar or rewritten links.
// 3. If Wayback answers with a redirect to a different capture (it resolves to the nearest
//    one, which can be newer), the final capture timestamp is checked again and rejected
//    when it is on or after the as-of day.
// 4. No capture before the cutoff means "page not found", never a fallback to the live site.
import { safeFetch, type FetchResult } from "./http";

const WB = "https://web.archive.org";

export interface ArchivedFetch extends FetchResult {
  snapshotUrl: string | null; // human-viewable capture URL, used as the document's source link
  capturedAt: string | null; // YYYY-MM-DD of the capture
}

/** Validates YYYYMMDD and returns the cutoff timestamp (YYYYMMDD000000). Throws on bad input. */
export function asOfCutoff(asOf: string): string {
  if (!/^\d{8}$/.test(asOf)) throw new Error("asOf must be YYYYMMDD");
  const d = Date.parse(`${asOf.slice(0, 4)}-${asOf.slice(4, 6)}-${asOf.slice(6, 8)}T00:00:00Z`);
  if (Number.isNaN(d)) throw new Error("asOf is not a valid date");
  if (d > Date.now()) throw new Error("asOf is in the future");
  return `${asOf}000000`;
}

export const asOfMs = (asOf: string) => Date.parse(`${asOf.slice(0, 4)}-${asOf.slice(4, 6)}-${asOf.slice(6, 8)}T00:00:00Z`);
const tsDay = (ts: string) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;

function dayBefore(asOf: string): string {
  const d = new Date(asOfMs(asOf) - 864e5);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

const cdxCache = new Map<string, Promise<{ ts: string; original: string } | null>>();

async function cdxQuery(qs: string): Promise<string[][] | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await safeFetch(`${WB}/cdx/search/cdx?${qs}`, "application/json");
      if (r.status === 200) return r.body.trim() ? (JSON.parse(r.body) as string[][]) : [];
      if (r.status !== 429 && r.status < 500) return null;
    } catch {
      /* timeout or reset: retry */
    }
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
  }
  return null;
}

/** Latest 2xx/3xx capture of `url` strictly before the as-of day, or null. */
export function captureBefore(url: string, asOf: string): Promise<{ ts: string; original: string } | null> {
  const key = `${url}|${asOf}`;
  if (!cdxCache.has(key)) {
    cdxCache.set(
      key,
      (async () => {
        const cutoff = asOfCutoff(asOf);
        const variants = [url];
        const u = new URL(url);
        if (u.pathname !== "/" && !u.search) variants.push(url.endsWith("/") ? url.slice(0, -1) : url + "/");
        for (const v of variants) {
          const rows = await cdxQuery(
            `url=${encodeURIComponent(v)}&to=${dayBefore(asOf)}&filter=statuscode%3A%5B23%5D..&fl=timestamp,original,statuscode&output=json&limit=-8`,
          );
          // Prefer the newest 200; fall back to the newest redirect (followed and re-checked below).
          const caps = (rows ?? []).slice(1).filter((r) => r[0] < cutoff);
          const best = [...caps].reverse().find((r) => r[2] === "200") ?? caps.at(-1);
          if (best) return { ts: best[0], original: best[1] };
        }
        return null;
      })(),
    );
  }
  return cdxCache.get(key)!;
}

/** Fetch `url` as it was before `asOf`. Returns status 404 (empty body) when no capture qualifies. */
export async function archiveFetch(url: string, asOf: string): Promise<ArchivedFetch> {
  const cutoff = asOfCutoff(asOf);
  const miss = (): ArchivedFetch => ({
    requestedUrl: url,
    finalUrl: url,
    status: 404,
    contentType: "",
    body: "",
    truncated: false,
    snapshotUrl: null,
    capturedAt: null,
  });
  const cap = await captureBefore(url, asOf);
  if (!cap) return miss();
  let r: FetchResult;
  try {
    r = await safeFetch(`${WB}/web/${cap.ts}id_/${cap.original}`);
  } catch {
    return miss();
  }
  // finalUrl looks like https://web.archive.org/web/<ts>id_/<original>; re-check the timestamp.
  const m = r.finalUrl.match(/\/web\/(\d{14})(?:id_)?\/(.+)$/);
  if (!m || m[1] >= cutoff) return miss();
  const original = m[2].replace(/^(https?):\/(?!\/)/, "$1://");
  return {
    ...r,
    requestedUrl: url,
    finalUrl: original,
    snapshotUrl: `${WB}/web/${m[1]}/${original}`,
    capturedAt: tsDay(m[1]),
  };
}

/** Earliest Wayback capture of a domain, only if it predates the cutoff (as-of mode) or at all (live). */
export async function firstCapture(domain: string, asOf?: string): Promise<{ date: string; url: string } | null> {
  const rows = await cdxQuery(`url=${encodeURIComponent(domain)}&limit=1&output=json&fl=timestamp,original`);
  if (rows == null) throw new Error("Wayback CDX unavailable");
  const row = rows[1];
  if (!row) return null;
  if (asOf && row[0] >= asOfCutoff(asOf)) return null;
  return { date: tsDay(row[0]), url: `${WB}/web/${row[0]}/${row[1]}` };
}
