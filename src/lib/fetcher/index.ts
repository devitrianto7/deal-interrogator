// collectEvidence(dealUrl): deal page -> vendor homepage -> pricing, terms,
// refund pages. Returns an EvidenceBundle and caches it on disk so demo deals
// replay instantly (and identically) without refetching.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeFetch, type FetchResult } from "./http";
import { archiveFetch, asOfCutoff } from "./wayback";
import { cap, extractLinks, htmlToText, normalize, type FoundLink } from "./extract";
import { isAppSumoUrl, parseAppSumo } from "./appsumo";
import { findCandidates } from "./discover";
import { guessVendorDomain, isMarketplaceUrl, marketplaceTerms, plausibleDoc, productName, rankVendorLinks, sameSiteUrl } from "./marketplace";
import type { DealInfo, DocKind, EvidenceBundle, SourceDoc } from "./types";

export type { EvidenceBundle, SourceDoc, DealInfo } from "./types";

export class DealUnavailableError extends Error {}

const CACHE_DIR = path.join(process.cwd(), ".data", "cache");
const CACHE_TTL_MS = 24 * 3_600_000;
const MIN_TEXT = 300;

const now = () => new Date().toISOString();

function makeDoc(kind: DocKind, url: string, status: number, title: string, text: string, error?: string, capturedAt?: string | null): SourceDoc {
  return { kind, url, status, title, text: cap(text), chars: text.length, fetchedAt: now(), ...(error ? { error } : {}), ...(capturedAt ? { capturedAt } : {}) };
}

// Live mode reads the page now; as-of mode reads the latest Wayback capture before the as-of day.
// `base` is the page's own URL (for resolving links); the doc URL is what the report cites
// (the live URL, or the Wayback snapshot URL in as-of mode).
type Getter = (url: string) => Promise<FetchResult & { snapshotUrl?: string | null; capturedAt?: string | null }>;
const getterFor = (asOf?: string): Getter => (asOf ? (u) => archiveFetch(u, asOf) : (u) => safeFetch(u));

async function fetchDoc(kind: DocKind, url: string, get: Getter): Promise<{ doc: SourceDoc; html: string; base: string }> {
  const t0 = Date.now();
  try {
    const r = await get(url);
    console.log(`[fetch] ${kind} ${url} ${r.status} ${Date.now() - t0}ms`);
    const isHtml = /html|xml/i.test(r.contentType) || r.body.trimStart().startsWith("<");
    const { title, text } = isHtml ? htmlToText(r.body) : { title: "", text: normalize(r.body) };
    return { doc: makeDoc(kind, r.snapshotUrl ?? r.finalUrl, r.status, title, text, undefined, r.capturedAt), html: isHtml ? r.body : "", base: r.finalUrl };
  } catch (e) {
    console.log(`[fetch] ${kind} ${url} ERR ${(e as Error).message} ${Date.now() - t0}ms`);
    return { doc: makeDoc(kind, url, 0, "", "", (e as Error).message), html: "", base: url };
  }
}

const looksLikeRealPage = (d: SourceDoc) =>
  d.status === 200 && d.text.length >= MIN_TEXT && !/\b(404|not found|page not found)\b/i.test(d.title);

async function firstGood(kind: DocKind, candidates: string[], exclude: Set<string>, get: Getter, max = 5): Promise<SourceDoc | null> {
  for (const url of candidates.slice(0, max)) {
    if (exclude.has(url)) continue;
    const { doc, base } = await fetchDoc(kind, url, get);
    if (looksLikeRealPage(doc) && !exclude.has(base) && plausibleDoc(kind, base, doc.title)) return doc;
  }
  return null;
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
  const get = getterFor(opts.asOf);
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

  // 2. Vendor homepage
  if (!deal.vendorUrl) {
    warnings.push("Could not reach the vendor's own site: no vendor website found on the deal page (pass vendorUrl to compare against official pages).");
    return save(file, { inputUrl, collectedAt: now(), deal, docs, warnings, vendorReached: false, ...(opts.asOf ? { asOf: opts.asOf } : {}) });
  }
  const home = await fetchDoc("vendor_home", deal.vendorUrl, get);
  docs.push(home.doc);
  if (!looksLikeRealPage(home.doc))
    warnings.push(
      home.doc.status === 200
        ? "Vendor site renders only with JavaScript, so its official pages could not be read as text."
        : opts.asOf && home.doc.status === 404
          ? `No Wayback capture of the vendor homepage before ${opts.asOf}.`
          : `Vendor homepage could not be fetched (HTTP ${home.doc.status}).`,
    );
  const links = home.html ? extractLinks(home.html, home.base) : [];
  const vendorHome = home.base;

  // 3. Pricing, terms, refund (in parallel; each tries links then common paths)
  const used = new Set<string>([vendorHome]);
  const [pricing, terms, refund] = await Promise.all([
    firstGood("vendor_pricing", findCandidates(links, vendorHome, "vendor_pricing"), used, get),
    firstGood("terms", findCandidates(links, vendorHome, "terms"), used, get),
    firstGood("refund", findCandidates(links, vendorHome, "refund"), used, get),
  ]);
  if (pricing) docs.push(pricing);
  else if (/pricing/i.test(home.doc.text)) warnings.push("No separate pricing page; pricing may be on the homepage.");
  else warnings.push("Vendor pricing page not found.");
  if (terms) docs.push(terms);
  else warnings.push("Vendor terms of service not found.");
  if (refund && refund.url !== terms?.url) docs.push(refund);
  else warnings.push("No separate vendor refund page; refund terms come from the deal page and ToS.");

  // Honest coverage: official vendor pages count only if the homepage answered and terms or pricing were read.
  const vendorReached = home.doc.status === 200 && !!(terms || pricing);
  if (!vendorReached) warnings.unshift("Could not reach the vendor's own site: its terms and pricing pages could not be read.");
  return save(file, { inputUrl, collectedAt: now(), deal, docs, warnings, vendorReached, ...(opts.asOf ? { asOf: opts.asOf } : {}) });
}

async function save(file: string, b: EvidenceBundle): Promise<EvidenceBundle> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(b, null, 1));
  return b;
}
