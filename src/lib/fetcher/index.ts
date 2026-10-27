// collectEvidence(dealUrl): deal page -> vendor homepage -> pricing, terms,
// refund pages. Returns an EvidenceBundle and caches it on disk so demo deals
// replay instantly (and identically) without refetching.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeFetch, type FetchResult } from "./http";
import { curlFetch, FALLBACK_TIMEOUT_MS, readerFetch, waybackLatest } from "./fallback";
import { archiveFetch, asOfCutoff } from "./wayback";
import { cap, extractLinks, htmlToText, normalize, type FoundLink } from "./extract";
import { isAppSumoUrl, parseAppSumo } from "./appsumo";
import { findCandidates } from "./discover";
import {
  guessVendorDomain,
  isMarketplaceUrl,
  marketplaceTerms,
  plausibleDoc,
  productName,
  rankVendorLinks,
  sameSiteUrl,
  scopeOf,
} from "./marketplace";
import type { DealInfo, DocKind, EvidenceBundle, SourceDoc } from "./types";

export type { EvidenceBundle, SourceDoc, DealInfo } from "./types";

export class DealUnavailableError extends Error {}

const CACHE_DIR = path.join(process.cwd(), ".data", "cache");
const CACHE_TTL_MS = 24 * 3_600_000;
const MIN_TEXT = 300;

const now = () => new Date().toISOString();

function makeDoc(
  kind: DocKind,
  url: string,
  status: number,
  title: string,
  text: string,
  error?: string,
  capturedAt?: string | null,
  via?: SourceDoc["via"],
): SourceDoc {
  return {
    kind,
    url,
    status,
    title,
    text: cap(text),
    chars: text.length,
    fetchedAt: now(),
    ...(error ? { error } : {}),
    ...(capturedAt ? { capturedAt } : {}),
    ...(via ? { via } : {}),
  };
}

// Live mode reads the page now; as-of mode reads the latest Wayback capture before the as-of day.
// `base` is the page's own URL (for resolving links); the doc URL is what the report cites
// (the live URL, or the Wayback snapshot URL in as-of mode).
type Getter = (url: string) => Promise<FetchResult & { snapshotUrl?: string | null; capturedAt?: string | null }>;
const getterFor = (asOf?: string): Getter => (asOf ? (u) => archiveFetch(u, asOf) : (u) => safeFetch(u, undefined, FALLBACK_TIMEOUT_MS));

// Per-analysis fetch state. Fallbacks run only in live mode; the slow ones (reader, Wayback)
// have a deadline and a use budget so one analysis stays well under a minute.
interface Ctx {
  get: Getter;
  live: boolean;
  heavyUntil: number;
  heavyLeft: number;
  curlHosts: Set<string>; // hosts whose shield blocks Node but serves curl: go straight to curl
  readerDown: boolean;
  waybackDown: boolean;
}

const HEAVY_WINDOW_MS = 35_000;
const HEAVY_USES = 4;

function newCtx(asOf?: string): Ctx {
  return {
    get: getterFor(asOf),
    live: !asOf,
    heavyUntil: Date.now() + HEAVY_WINDOW_MS,
    heavyLeft: HEAVY_USES,
    curlHosts: new Set(),
    readerDown: false,
    waybackDown: false,
  };
}

interface Fetched {
  doc: SourceDoc;
  html: string;
  base: string;
  links?: FoundLink[]; // reader output carries its links (markdown), since it has no HTML
}

const BLOCKED = (s: number) => s === 0 || s === 202 || s === 401 || s === 403 || s === 429 || s === 503 || (s >= 520 && s <= 530);
const readable = (d: SourceDoc) => d.status === 200 && d.text.length >= MIN_TEXT;
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
};

async function plainDoc(kind: DocKind, url: string, fetcher: Getter, label: string): Promise<Fetched> {
  const t0 = Date.now();
  try {
    const r = await fetcher(url);
    console.log(`[fetch] ${kind}${label} ${url} ${r.status} ${Date.now() - t0}ms`);
    const isHtml = /html|xml/i.test(r.contentType) || r.body.trimStart().startsWith("<");
    const { title, text } = isHtml ? htmlToText(r.body) : { title: "", text: normalize(r.body) };
    return { doc: makeDoc(kind, r.snapshotUrl ?? r.finalUrl, r.status, title, text, undefined, r.capturedAt), html: isHtml ? r.body : "", base: r.finalUrl };
  } catch (e) {
    console.log(`[fetch] ${kind}${label} ${url} ERR ${(e as Error).message} ${Date.now() - t0}ms`);
    return { doc: makeDoc(kind, url, 0, "", "", (e as Error).message), html: "", base: url };
  }
}

/**
 * Fetch one page. Live mode falls back when a page refuses the plain fetch:
 * blocked (403/202/0...) -> curl; still blocked or JavaScript-only, and `heavy` allowed ->
 * the r.jina.ai reader, then the latest Wayback capture (both marked on the doc as `via`).
 */
async function fetchDoc(kind: DocKind, url: string, ctx: Ctx, heavy = false): Promise<Fetched> {
  const host = hostOf(url);
  const curlFirst = ctx.live && ctx.curlHosts.has(host);
  let best = await plainDoc(kind, url, curlFirst ? curlFetch : ctx.get, curlFirst ? " (curl)" : "");
  if (!ctx.live || readable(best.doc)) return best;
  if (!curlFirst && BLOCKED(best.doc.status)) {
    const c = await plainDoc(kind, url, curlFetch, " (curl)");
    if (readable(c.doc)) {
      ctx.curlHosts.add(host);
      return c;
    }
    if (c.doc.status === 200 || c.doc.status === 404) best = c;
  }
  const jsOnly = best.doc.status === 200 && best.doc.text.length < MIN_TEXT;
  if (!heavy || !(BLOCKED(best.doc.status) || jsOnly) || ctx.heavyLeft <= 0 || Date.now() > ctx.heavyUntil) return best;
  ctx.heavyLeft--;
  if (!ctx.readerDown) {
    const t0 = Date.now();
    try {
      const page = await readerFetch(url);
      console.log(`[fetch] ${kind} (reader) ${url} ${page ? page.text.length + " chars" : "no page"} ${Date.now() - t0}ms`);
      if (page && normalize(page.text).length >= MIN_TEXT)
        return { doc: makeDoc(kind, page.url, 200, page.title, normalize(page.text), undefined, null, "reader"), html: "", base: page.url, links: page.links };
    } catch (e) {
      console.log(`[fetch] ${kind} (reader) ${url} ERR ${(e as Error).message} ${Date.now() - t0}ms`);
      ctx.readerDown = true;
    }
  }
  if (!ctx.waybackDown && Date.now() < ctx.heavyUntil) {
    const t0 = Date.now();
    try {
      const r = await waybackLatest(url);
      console.log(`[fetch] ${kind} (wayback) ${url} ${r ? r.capturedAt : "no capture"} ${Date.now() - t0}ms`);
      if (r) {
        const { title, text } = htmlToText(r.body);
        const doc = makeDoc(kind, r.snapshotUrl, 200, title, text, undefined, r.capturedAt, "wayback");
        if (readable(doc)) return { doc, html: r.body, base: url };
      }
    } catch (e) {
      console.log(`[fetch] ${kind} (wayback) ${url} ERR ${(e as Error).message} ${Date.now() - t0}ms`);
      ctx.waybackDown = true;
    }
  }
  return best;
}

const linksOf = (f: Fetched) => f.links ?? (f.html ? extractLinks(f.html, f.base) : []);

const looksLikeRealPage = (d: SourceDoc) =>
  d.status === 200 && d.text.length >= MIN_TEXT && !/\b(404|not found|page not found)\b/i.test(d.title);

async function firstGood(
  kind: DocKind,
  candidates: string[],
  exclude: Set<string>,
  ctx: Ctx,
  heavyFor: Set<string> = new Set(),
  max = 7,
): Promise<SourceDoc | null> {
  for (const url of candidates.slice(0, max)) {
    if (exclude.has(url)) continue;
    const { doc, base } = await fetchDoc(kind, url, ctx, heavyFor.has(url));
    if (looksLikeRealPage(doc) && !exclude.has(base) && plausibleDoc(kind, base, doc.title)) return doc;
  }
  return null;
}

// Short-link and click-tracking hosts: the vendor is wherever they redirect.
const SHORTENERS = /^(hubs\.ly|hubs\.la|bit\.ly|tinyurl\.com|t\.co|ow\.ly|buff\.ly|rebrand\.ly|cutt\.ly|short\.io|lnkd\.in|go\.aws|shorturl\.at|rb\.gy|is\.gd|tiny\.cc|bl\.ink|dub\.sh|l\.linklyhq\.com|trk\.[a-z0-9.-]+)$/i;

/** Drops tracking parameters (utm_*, ref, campaign...) from a vendor URL. */
function stripTracking(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()])
      if (/^(utm_|ref$|via$|campaign$|source$|fbclid$|gclid$|mc_|_hs|hs_|affiliate|aff)/i.test(k)) u.searchParams.delete(k);
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

/** The vendor's root site for a landing URL: info.yourethos.io/get-started-now/ -> https://yourethos.io/
 *  (a creator subdomain on a hosting platform keeps its own host: see scopeOf). */
function rootOf(url: string): string | null {
  try {
    return `https://${scopeOf(new URL(url).hostname.toLowerCase())}/`;
  } catch {
    return null;
  }
}

const isRootPage = (url: string) => {
  try {
    const u = new URL(url);
    return (u.pathname === "/" || u.pathname === "") && u.hostname.replace(/^www\./, "").toLowerCase() === scopeOf(u.hostname.toLowerCase());
  } catch {
    return false;
  }
};

/** URLs listed in /sitemap.xml (and up to two child sitemaps of a sitemap index). */
async function sitemapUrls(origin: string, ctx: Ctx): Promise<string[]> {
  const read = async (u: string) => {
    const f = await (ctx.curlHosts.has(hostOf(u)) ? curlFetch(u) : ctx.get(u)).catch(() => null);
    return f && f.status === 200 && /<(urlset|sitemapindex)/i.test(f.body.slice(0, 2000)) ? f.body : "";
  };
  const locs = (xml: string) => [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
  const t0 = Date.now();
  const top = await read(`${origin}/sitemap.xml`);
  if (!top) return [];
  let urls = locs(top);
  if (/<sitemapindex/i.test(top)) {
    const children = urls.filter((u) => /page|main|static|sitemap-0|sitemap1/i.test(u)).concat(urls).slice(0, 2);
    urls = (await Promise.all([...new Set(children)].map(async (c) => locs(await read(c))))).flat();
  }
  console.log(`[fetch] sitemap ${origin} ${urls.length} urls ${Date.now() - t0}ms`);
  return urls;
}

/** The homepage itself as the pricing source, when it has a pricing section with prices in it. */
function homePricing(home: SourceDoc, links: FoundLink[]): SourceDoc | null {
  const text = home.text;
  const anchor = links.some((l) => /#(pricing|plans|price)$/i.test(l.href)) || /^#+\s.*\b(pricing|plans)\b/im.test(text);
  if (!anchor) return null;
  const at = text.search(/^(#+\s*)?.*\b(pricing|plans|choose (your|a) plan)\b.*$/im);
  if (at < 0) return null;
  const section = text.slice(Math.max(0, at), at + 8_000);
  if (!/(\$|€|£|₹|USD|EUR|INR)\s?\d|\d\s?(\$|€|£|₹|USD|EUR|INR)(?![a-z])/i.test(section) || !/\/\s?(mo|month|yr|year)\b|per (month|year|user)|monthly|yearly|annual|lifetime|one[- ]time/i.test(section))
    return null;
  return { ...home, kind: "vendor_pricing", url: `${home.url.replace(/#.*$/, "")}#pricing`, text: section, chars: section.length };
}

function genericDeal(url: string, title: string, links: FoundLink[]): DealInfo {
  const host = new URL(url).hostname;
  const external = links.find((l) => {
    const h = new URL(l.href).hostname;
    return h !== host && /visit|website|official|homepage/i.test(l.text);
  });
  return {
    platform: "generic",
    url,
    name: title,
    tagline: "",
    // No outbound "visit website" link: treat the page as the vendor's own site.
    vendorUrl: external ? new URL(external.href).origin + "/" : new URL(url).origin + "/",
    price: null,
    originalPrice: null,
    refundableDays: null,
    startDate: null,
    endDate: null,
    purchases: null,
    plans: [],
    commonFeatures: [],
    faqs: [],
    reviewStats: null,
    reviews: [],
    relatedDealIds: [],
  };
}

export async function collectEvidence(
  inputUrl: string,
  opts: { fresh?: boolean; vendorUrl?: string; asOf?: string } = {},
): Promise<EvidenceBundle> {
  if (opts.asOf) asOfCutoff(opts.asOf); // validate early
  const ctx = newCtx(opts.asOf);
  const get = ctx.get;
  const key = createHash("sha256")
    .update(inputUrl.trim() + "|" + (opts.vendorUrl ?? "") + (opts.asOf ? `|asof:${opts.asOf}` : ""))
    .digest("hex")
    .slice(0, 16);
  const file = path.join(CACHE_DIR, `${key}.json`);
  if (!opts.fresh) {
    try {
      const cached = JSON.parse(await readFile(file, "utf8")) as EvidenceBundle;
      if (Date.now() - Date.parse(cached.collectedAt) < CACHE_TTL_MS) return cached;
    } catch {
      /* no cache */
    }
  }

  const warnings: string[] = [];
  const docs: SourceDoc[] = [];

  // 1. Deal page
  const dealRes = await get(inputUrl);
  if (opts.asOf && dealRes.status === 404 && !dealRes.body)
    throw new DealUnavailableError(`No Wayback capture of the deal page before ${opts.asOf}.`);
  if (dealRes.status !== 200) throw new DealUnavailableError(`Deal page returned HTTP ${dealRes.status}`);
  const dealView = dealRes.snapshotUrl ?? dealRes.finalUrl;
  let deal: DealInfo;
  if (isAppSumoUrl(inputUrl) && !isAppSumoUrl(dealRes.finalUrl))
    throw new DealUnavailableError("AppSumo redirected away from this product page: the deal has likely ended or the URL is wrong.");
  // Captures from before AppSumo's current site (roughly pre-2023) have no embedded deal JSON;
  // in as-of mode those are read as a generic deal page instead of failing.
  const legacyAppSumo = !!opts.asOf && isAppSumoUrl(dealRes.finalUrl) && !dealRes.body.includes('id="__NEXT_DATA__"');
  if (isAppSumoUrl(dealRes.finalUrl) && !legacyAppSumo) {
    const { deal: d, dealText, reviewNote } = await parseAppSumo(dealRes.finalUrl, dealRes.body, { asOf: opts.asOf });
    deal = d;
    if (reviewNote) warnings.push(reviewNote);
    docs.push(makeDoc("deal", dealView, 200, `${d.name} | AppSumo`, dealText, undefined, dealRes.capturedAt));
  } else if (isMarketplaceUrl(dealRes.finalUrl)) {
    // Third-party marketplace: the vendor is whoever the page links out to, never the marketplace itself.
    const { title, text } = htmlToText(dealRes.body);
    const name = productName(dealRes.body, dealRes.finalUrl);
    deal = { ...genericDeal(dealRes.finalUrl, name, []), ...marketplaceTerms(text), vendorUrl: null };
    if (!opts.vendorUrl) {
      const ranked = rankVendorLinks(extractLinks(dealRes.body, dealRes.finalUrl), dealRes.finalUrl, name);
      // Guessing a domain probes the live web, so as-of mode skips it.
      deal.vendorUrl = ranked[0] ?? (opts.asOf ? null : await guessVendorDomain(name, dealRes.finalUrl));
    }
    docs.push(makeDoc("deal", dealView, 200, title, text, undefined, dealRes.capturedAt));
  } else {
    if (legacyAppSumo) warnings.push("Archived AppSumo page predates its current layout: plans and reviews could not be parsed, so the page is read as plain text.");
    const { title, text } = htmlToText(dealRes.body);
    deal = genericDeal(dealRes.finalUrl, title, extractLinks(dealRes.body, dealRes.finalUrl));
    docs.push(makeDoc("deal", dealView, 200, title, text, undefined, dealRes.capturedAt));
  }
  if (opts.vendorUrl) deal.vendorUrl = opts.vendorUrl;
  // A vendor "site" on the marketplace's own domain is the marketplace's pages, not the vendor's.
  if (deal.vendorUrl && isMarketplaceUrl(dealRes.finalUrl) && (sameSiteUrl(deal.vendorUrl, dealRes.finalUrl) || isMarketplaceUrl(deal.vendorUrl)))
    deal.vendorUrl = null;

  // AppSumo deal with no vendor link anywhere in its data: last resort, a <name>.com/.io/.ai/.app
  // domain whose homepage title names the product (live only: it probes today's web).
  if (!deal.vendorUrl && !opts.vendorUrl && ctx.live && deal.platform === "appsumo" && deal.name) {
    const guessed = await guessVendorDomain(deal.name, inputUrl, (u) => fetchForGuess(u));
    if (guessed) {
      deal.vendorUrl = guessed;
      warnings.push(`The deal page links no vendor website; ${guessed} was used because its homepage title names "${deal.name}".`);
    }
  }

  // 2. Vendor homepage
  if (!deal.vendorUrl) {
    warnings.push("Could not reach the vendor's own site: no vendor website found on the deal page (pass vendorUrl to compare against official pages).");
    return save(file, { inputUrl, collectedAt: now(), deal, docs, warnings, vendorReached: false, ...(opts.asOf ? { asOf: opts.asOf } : {}) });
  }
  const given = ctx.live ? stripTracking(deal.vendorUrl) : deal.vendorUrl;
  let home = await fetchDoc("vendor_home", given, ctx);
  let fellBack = false;
  if (ctx.live) {
    // A landing subpage or subdomain (info.vendor.io/get-started/) that fails: try the root site.
    const root = rootOf(home.base);
    const tryRoot = root && !isRootPage(home.base) ? root : null;
    if (!looksLikeRealPage(home.doc) && tryRoot) {
      const r = await fetchDoc("vendor_home", tryRoot, ctx);
      if (looksLikeRealPage(r.doc)) [home, fellBack] = [r, true];
    }
    // Still unreadable: rendered text (reader) or the latest Wayback capture.
    if (!looksLikeRealPage(home.doc)) {
      const r = await fetchDoc("vendor_home", given, ctx, true);
      if (looksLikeRealPage(r.doc)) home = r;
      else if (tryRoot) {
        const rr = await fetchDoc("vendor_home", tryRoot, ctx, true);
        if (looksLikeRealPage(rr.doc)) [home, fellBack] = [rr, true];
      }
    }
    // The given site is dead or walled off entirely: a domain named after the product.
    if (!looksLikeRealPage(home.doc) && !opts.vendorUrl && deal.name && (deal.platform === "appsumo" || isMarketplaceUrl(dealRes.finalUrl))) {
      const guessed = await guessVendorDomain(deal.name, inputUrl, (u) => fetchForGuess(u));
      if (guessed && !sameSiteUrl(guessed, home.base)) {
        const g = await fetchDoc("vendor_home", guessed, ctx, true);
        if (looksLikeRealPage(g.doc)) {
          [home, fellBack] = [g, true];
          warnings.push(`The vendor link on the deal page (${deal.vendorUrl}) could not be read; ${guessed} was used because its homepage title names "${deal.name}".`);
        }
      }
    }
    // Report the site actually read: a short link or a fallback stands for the vendor's real domain.
    if (fellBack || SHORTENERS.test(hostOf(deal.vendorUrl).replace(/^www\./, ""))) deal.vendorUrl = new URL(home.base).origin + "/";
  }
  docs.push(home.doc);
  if (home.doc.via === "reader") warnings.push("Vendor homepage was read through a rendering reader (r.jina.ai) because a plain fetch got no readable text.");
  if (home.doc.via === "wayback") warnings.push(`Vendor homepage could not be fetched live; its latest Wayback capture (${home.doc.capturedAt}) was read instead.`);
  if (!looksLikeRealPage(home.doc))
    warnings.push(
      home.doc.status === 200
        ? "Vendor site renders only with JavaScript, so its official pages could not be read as text."
        : opts.asOf && home.doc.status === 404
          ? `No Wayback capture of the vendor homepage before ${opts.asOf}.`
          : `Vendor homepage could not be fetched (HTTP ${home.doc.status}).`,
    );
  let links = linksOf(home);
  const vendorHome = home.base;
  const origins = [new URL(vendorHome).origin];
  // Read from a landing subpage: the root site's own links (footer: terms, pricing) count too.
  if (ctx.live && looksLikeRealPage(home.doc) && !isRootPage(vendorHome)) {
    const root = rootOf(vendorHome);
    if (root && root !== vendorHome) {
      const r = await fetchDoc("vendor_home", root, ctx);
      if (looksLikeRealPage(r.doc)) {
        links = [...links, ...linksOf(r)];
        origins.push(new URL(r.base).origin);
      }
    }
  }
  const sitemap = ctx.live && looksLikeRealPage(home.doc) ? await sitemapUrls(origins[0], ctx) : [];
  const candidates = (kind: "vendor_pricing" | "terms" | "refund") => [
    ...new Set(origins.flatMap((o, i) => findCandidates(links, i === 0 ? vendorHome : o + "/", kind, sitemap))),
  ];
  // Reader/Wayback for subpages only when the homepage itself needed them, and only for linked pages.
  const viaHeavy = !!home.doc.via;
  const linked = (cands: string[]) => new Set(viaHeavy ? cands.filter((c) => links.some((l) => l.href === c)).slice(0, 2) : []);

  // 3. Pricing, terms, refund (in parallel; each tries links, sitemap, then common paths)
  const used = new Set<string>([vendorHome]);
  const [pc, tc, rc] = [candidates("vendor_pricing"), candidates("terms"), candidates("refund")];
  const [pricingPage, terms, refund] = await Promise.all([
    firstGood("vendor_pricing", pc, used, ctx, linked(pc)),
    firstGood("terms", tc, used, ctx, linked(tc)),
    firstGood("refund", rc, used, ctx, linked(rc)),
  ]);
  const pricing = pricingPage ?? (ctx.live && looksLikeRealPage(home.doc) ? homePricing(home.doc, links) : null);
  if (pricing) docs.push(pricing);
  else if (/pricing/i.test(home.doc.text)) warnings.push("No separate pricing page; pricing may be on the homepage.");
  else warnings.push("Vendor pricing page not found.");
  if (pricing && !pricingPage) warnings.push("Pricing was read from the pricing section of the vendor's homepage.");
  if (terms) docs.push(terms);
  else warnings.push("Vendor terms of service not found.");
  if (refund && refund.url !== terms?.url) docs.push(refund);
  else warnings.push("No separate vendor refund page; refund terms come from the deal page and ToS.");

  // Honest coverage: official vendor pages count only if the homepage answered and terms or pricing were read.
  const vendorReached = home.doc.status === 200 && !!(terms || pricing);
  if (!vendorReached) warnings.unshift("Could not reach the vendor's own site: its terms and pricing pages could not be read.");
  return save(file, { inputUrl, collectedAt: now(), deal, docs, warnings, vendorReached, ...(opts.asOf ? { asOf: opts.asOf } : {}) });
}

/** Domain-guess probe: plain fetch, then curl when a bot shield blocks it. */
async function fetchForGuess(url: string): Promise<FetchResult> {
  const r = await safeFetch(url, undefined, 8_000);
  return BLOCKED(r.status) ? curlFetch(url, 8_000).then((c) => (c.status === 200 ? c : r)).catch(() => r) : r;
}

async function save(file: string, b: EvidenceBundle): Promise<EvidenceBundle> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(b, null, 1));
  return b;
}
