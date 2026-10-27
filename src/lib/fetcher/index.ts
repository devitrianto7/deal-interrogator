// collectEvidence(dealUrl): deal page -> vendor homepage -> pricing, terms,
// refund pages. Returns an EvidenceBundle and caches it on disk so demo deals
// replay instantly (and identically) without refetching.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeFetch } from "./http";
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

function makeDoc(kind: DocKind, url: string, status: number, title: string, text: string, error?: string): SourceDoc {
  return { kind, url, status, title, text: cap(text), chars: text.length, fetchedAt: now(), ...(error ? { error } : {}) };
}

async function fetchDoc(kind: DocKind, url: string): Promise<{ doc: SourceDoc; html: string }> {
  const t0 = Date.now();
  try {
    const r = await safeFetch(url);
    console.log(`[fetch] ${kind} ${url} ${r.status} ${Date.now() - t0}ms`);
    const isHtml = /html|xml/i.test(r.contentType) || r.body.trimStart().startsWith("<");
    const { title, text } = isHtml ? htmlToText(r.body) : { title: "", text: normalize(r.body) };
    return { doc: makeDoc(kind, r.finalUrl, r.status, title, text), html: isHtml ? r.body : "" };
  } catch (e) {
    console.log(`[fetch] ${kind} ${url} ERR ${(e as Error).message} ${Date.now() - t0}ms`);
    return { doc: makeDoc(kind, url, 0, "", "", (e as Error).message), html: "" };
  }
}

const looksLikeRealPage = (d: SourceDoc) =>
  d.status === 200 && d.text.length >= MIN_TEXT && !/\b(404|not found|page not found)\b/i.test(d.title);

async function firstGood(kind: DocKind, candidates: string[], exclude: Set<string>, max = 5): Promise<SourceDoc | null> {
  for (const url of candidates.slice(0, max)) {
    if (exclude.has(url)) continue;
    const { doc } = await fetchDoc(kind, url);
    if (looksLikeRealPage(doc) && !exclude.has(doc.url) && plausibleDoc(kind, doc.url, doc.title)) return doc;
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

export async function collectEvidence(inputUrl: string, opts: { fresh?: boolean; vendorUrl?: string } = {}): Promise<EvidenceBundle> {
  const key = createHash("sha256").update(inputUrl.trim() + "|" + (opts.vendorUrl ?? "")).digest("hex").slice(0, 16);
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
  const dealRes = await safeFetch(inputUrl);
  if (dealRes.status !== 200) throw new DealUnavailableError(`Deal page returned HTTP ${dealRes.status}`);
  let deal: DealInfo;
  if (isAppSumoUrl(inputUrl) && !isAppSumoUrl(dealRes.finalUrl))
    throw new DealUnavailableError("AppSumo redirected away from this product page: the deal has likely ended or the URL is wrong.");
  if (isAppSumoUrl(dealRes.finalUrl)) {
    const { deal: d, dealText } = await parseAppSumo(dealRes.finalUrl, dealRes.body);
    deal = d;
    docs.push(makeDoc("deal", dealRes.finalUrl, 200, `${d.name} | AppSumo`, dealText));
  } else if (isMarketplaceUrl(dealRes.finalUrl)) {
    // Third-party marketplace: the vendor is whoever the page links out to, never the marketplace itself.
    const { title, text } = htmlToText(dealRes.body);
    const name = productName(dealRes.body, dealRes.finalUrl);
    deal = { ...genericDeal(dealRes.finalUrl, name, []), ...marketplaceTerms(text), vendorUrl: null };
    if (!opts.vendorUrl) {
      const ranked = rankVendorLinks(extractLinks(dealRes.body, dealRes.finalUrl), dealRes.finalUrl, name);
      deal.vendorUrl = ranked[0] ?? (await guessVendorDomain(name, dealRes.finalUrl));
    }
    docs.push(makeDoc("deal", dealRes.finalUrl, 200, title, text));
  } else {
    const { title, text } = htmlToText(dealRes.body);
    deal = genericDeal(dealRes.finalUrl, title, extractLinks(dealRes.body, dealRes.finalUrl));
    docs.push(makeDoc("deal", dealRes.finalUrl, 200, title, text));
  }
  if (opts.vendorUrl) deal.vendorUrl = opts.vendorUrl;
  // A vendor "site" on the marketplace's own domain is the marketplace's pages, not the vendor's.
  if (deal.vendorUrl && isMarketplaceUrl(dealRes.finalUrl) && (sameSiteUrl(deal.vendorUrl, dealRes.finalUrl) || isMarketplaceUrl(deal.vendorUrl)))
    deal.vendorUrl = null;

  // 2. Vendor homepage
  if (!deal.vendorUrl) {
    warnings.push("Could not reach the vendor's own site: no vendor website found on the deal page (pass vendorUrl to compare against official pages).");
    return save(file, { inputUrl, collectedAt: now(), deal, docs, warnings, vendorReached: false });
  }
  const home = await fetchDoc("vendor_home", deal.vendorUrl);
  docs.push(home.doc);
  if (!looksLikeRealPage(home.doc))
    warnings.push(
      home.doc.status === 200
        ? "Vendor site renders only with JavaScript, so its official pages could not be read as text."
        : `Vendor homepage could not be fetched (HTTP ${home.doc.status}).`,
    );
  const links = home.html ? extractLinks(home.html, home.doc.url) : [];
  const vendorHome = home.doc.url;

  // 3. Pricing, terms, refund (in parallel; each tries links then common paths)
  const used = new Set<string>([vendorHome]);
  const [pricing, terms, refund] = await Promise.all([
    firstGood("vendor_pricing", findCandidates(links, vendorHome, "vendor_pricing"), used),
    firstGood("terms", findCandidates(links, vendorHome, "terms"), used),
    firstGood("refund", findCandidates(links, vendorHome, "refund"), used),
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
  return save(file, { inputUrl, collectedAt: now(), deal, docs, warnings, vendorReached });
}

async function save(file: string, b: EvidenceBundle): Promise<EvidenceBundle> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(b, null, 1));
  return b;
}
