// Safe HTTP fetch for untrusted URLs: http(s) only, no private/internal hosts,
// timeout, size cap, limited redirects (each hop re-checked).
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

export class FetchBlockedError extends Error {}

export interface FetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
}

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateIp(mapped[1]) : false;
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchBlockedError(`Invalid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new FetchBlockedError("Only http(s) URLs are allowed");
  if (u.username || u.password) throw new FetchBlockedError("Credentials in URL are not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal"))
    throw new FetchBlockedError("Internal hosts are not allowed");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new FetchBlockedError("Private network addresses are not allowed");
  return u;
}

export async function safeFetch(
  url: string,
  accept = "text/html,application/xhtml+xml,*/*;q=0.8",
  timeoutMs = TIMEOUT_MS,
): Promise<FetchResult> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = await assertPublicUrl(current);
    const res = await fetch(u, {
      redirect: "manual",
      headers: { "user-agent": UA, accept, "accept-language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, u).toString();
      continue;
    }
    const { text, truncated } = await readCapped(res);
    return {
      requestedUrl: url,
      finalUrl: u.toString(),
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      body: text,
      truncated,
    };
  }
  throw new FetchBlockedError("Too many redirects");
}

async function readCapped(res: Response): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}
