// Fallbacks for vendor pages that refuse a plain fetch (live mode only).
//
// 1. curl: many bot shields (Cloudflare and friends) answer Node's own TLS client with a 403
//    challenge but serve the same page to curl. Same URL, same live page, re-checked per hop.
// 2. reader: https://r.jina.ai renders JavaScript-only pages and returns their text as markdown.
// 3. wayback: the latest Wayback Machine capture of the page.
// Reader and Wayback text is marked on the document (`via`) and shown with the sources;
// quotes are still verified against exactly the text that was used.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertPublicUrl, safeFetch, UA, type FetchResult } from "./http";
import type { FoundLink } from "./extract";

export const FALLBACK_TIMEOUT_MS = 12_000;
const MAX_BYTES = 3_000_000;
const MAX_REDIRECTS = 5;

function curlOnce(url: string, timeoutMs: number, jar: string): Promise<{ status: number; contentType: string; location: string; body: string }> {
  // The trailer is written after the body; a random marker keeps it unambiguous.
  const mark = `\n@@CURL${Math.random().toString(36).slice(2)}@@`;
  const args = [
    "-s",
    "--compressed",
    "--proto", "=http,https",
    "--max-time", String(Math.ceil(timeoutMs / 1000)),
    "--max-filesize", String(MAX_BYTES),
    "-A", UA,
    // Cookies carry across our manual redirect hops (some sites set a cookie, then redirect).
    "-b", jar,
    "-c", jar,
    "-H", "Accept: text/html,application/xhtml+xml,*/*;q=0.8",
    "-H", "Accept-Language: en-US,en;q=0.9",
    "-w", `${mark}%{http_code}\t%{content_type}\t%{redirect_url}`,
    "--", url,
  ];
  return new Promise((resolve, reject) => {
    execFile("curl", args, { maxBuffer: MAX_BYTES + 65_536, timeout: timeoutMs + 2_000, encoding: "utf8" }, (err, stdout) => {
      const at = stdout ? stdout.lastIndexOf(mark) : -1;
      if (at < 0) return reject(err ?? new Error("curl returned no status"));
      const [code, contentType, location] = stdout.slice(at + mark.length).split("\t");
      const status = Number(code) || 0;
      if (!status) return reject(err ?? new Error("curl could not connect"));
      resolve({ status, contentType: contentType ?? "", location: (location ?? "").trim(), body: stdout.slice(0, at) });
    });
  });
}

/** Fetch with the system curl, following redirects by hand so every hop passes the public-URL check. */
export async function curlFetch(url: string, timeoutMs = FALLBACK_TIMEOUT_MS): Promise<FetchResult> {
  const jar = path.join(tmpdir(), `di-cookies-${randomUUID()}`);
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const u = await assertPublicUrl(current);
      const r = await curlOnce(u.toString(), timeoutMs, jar);
      if (r.status >= 300 && r.status < 400 && r.location) {
        current = new URL(r.location, u).toString();
        continue;
      }
      return { requestedUrl: url, finalUrl: u.toString(), status: r.status, contentType: r.contentType, body: r.body, truncated: false };
    }
    throw new Error("Too many redirects");
  } finally {
    await rm(jar, { force: true }).catch(() => {});
  }
}

export interface ReaderPage {
  url: string; // the page's own URL as the reader resolved it
  title: string;
  text: string; // markdown with link targets and images removed (what the model reads and quotes)
  links: FoundLink[];
}

const MD_LINK = /(!?)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/** Rendered text of a JavaScript-heavy page through the r.jina.ai reader (no key needed). */
export async function readerFetch(url: string, timeoutMs = FALLBACK_TIMEOUT_MS): Promise<ReaderPage | null> {
  const r = await safeFetch(`https://r.jina.ai/${url}`, "text/plain", timeoutMs);
  // 401/402/429: the reader refuses this server (IP reputation, quota): stop asking for this analysis.
  if (r.status === 401 || r.status === 402 || r.status === 429) throw new Error(`reader refused (HTTP ${r.status})`);
  if (r.status !== 200 || !r.body) return null;
  const body = r.body;
  const title = body.match(/^Title:\s*(.*)$/m)?.[1]?.trim() ?? "";
  const source = body.match(/^URL Source:\s*(\S+)/m)?.[1] ?? url;
  const at = body.indexOf("Markdown Content:");
  const md = at >= 0 ? body.slice(at + "Markdown Content:".length) : body;
  // The reader reports the target's own error page as content; treat those as failures.
  if (/^Warning: Target URL returned error (4\d\d|5\d\d)/m.test(body.slice(0, at >= 0 ? at : 400))) return null;
  const links: FoundLink[] = [];
  const seen = new Set<string>();
  for (const m of md.matchAll(MD_LINK)) {
    if (m[1]) continue; // image
    try {
      const u = new URL(m[3], source);
      if (!/^https?:$/.test(u.protocol)) continue;
      u.hash = "";
      const href = u.toString();
      if (seen.has(href)) continue;
      seen.add(href);
      links.push({ href, text: m[2].replace(/[*_`]/g, "").replace(/\s+/g, " ").trim() });
    } catch {
      /* bad link */
    }
  }
  const text = md.replace(MD_LINK, (_m, img: string, label: string) => (img ? "" : label));
  return { url: source, title, text, links };
}

/** Latest Wayback capture of a page, read raw (`id_`), plus its human-viewable URL and capture day. */
export async function waybackLatest(
  url: string,
  timeoutMs = FALLBACK_TIMEOUT_MS,
): Promise<(FetchResult & { snapshotUrl: string; capturedAt: string }) | null> {
  const a = await safeFetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, "application/json", 6_000);
  if (a.status !== 200) return null;
  const snap = (JSON.parse(a.body) as { archived_snapshots?: { closest?: { status?: string; timestamp?: string } } }).archived_snapshots?.closest;
  if (!snap?.timestamp || !/^2\d\d$/.test(snap.status ?? "")) return null;
  const ts = snap.timestamp;
  const r = await safeFetch(`https://web.archive.org/web/${ts}id_/${url}`, "text/html,*/*;q=0.8", timeoutMs);
  if (r.status !== 200) return null;
  return {
    ...r,
    finalUrl: url,
    snapshotUrl: `https://web.archive.org/web/${ts}/${url}`,
    capturedAt: `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`,
  };
}
