// Non-AppSumo lifetime-deal marketplaces (DealMirror, StackSocial, SaaSMantra...).
// Their product pages are the "deal" doc, but the vendor is someone else: find the
// vendor's own site from outbound links (or a guessed domain whose homepage names
// the product), and read the marketplace's own deal terms with simple regexes.
// Never fall back to the marketplace's own homepage/terms as if they were the vendor's.
import * as cheerio from "cheerio";
import { safeFetch, type FetchResult } from "./http";
import { htmlToText, type FoundLink } from "./extract";
import type { DealInfo, DocKind } from "./types";

const MARKETPLACES = [
  "dealmirror.com",
  "saasmantra.com",
  "stacksocial.com",
  "stackcommerce.com",
  "pitchground.com",
  "dealfuel.com",
  "rockethub.com",
  "dealify.com",
  "ltdexplorer.com",
  "grabltd.com",
  "primeclub.co",
  "prime-club.com",
  "saasprime.com",
  "dealmango.com",
  "lifetimo.com",
  "ltdhunt.com",
  "saaspirate.com",
  "softwaredeals.club",
  "dealsumo.com",
  "appsumo.com",
];

// Outbound hosts that are never the vendor: social, payments, CDNs, review and help-desk sites.
const NOT_VENDOR = [
  "facebook.com", "fb.com", "twitter.com", "x.com", "linkedin.com", "youtube.com", "youtu.be", "instagram.com",
  "tiktok.com", "pinterest.com", "reddit.com", "discord.gg", "discord.com", "t.me", "telegram.me", "whatsapp.com",
  "wa.me", "medium.com", "github.com", "google.com", "goo.gl", "apple.com", "microsoft.com",
  "paypal.com", "stripe.com", "paddle.com", "gumroad.com", "lemonsqueezy.com", "fastspring.com", "chargebee.com",
  "cloudflare.com", "jsdelivr.net", "unpkg.com", "googleapis.com", "gstatic.com", "wp.com", "wordpress.org",
  "gravatar.com", "amazonaws.com", "cloudfront.net", "bunnycdn.com", "vimeo.com", "loom.com", "wistia.com",
  "trustpilot.com", "g2.com", "capterra.com", "producthunt.com", "getapp.com", "sitejabber.com", "bbb.org",
  "trustradius.com", "saasworthy.com", "tawk.help", "tawk.to", "zendesk.com", "intercom.help", "intercom.io",
  "freshdesk.com", "helpscoutdocs.com", "featurebase.app", "canny.io", "notion.site", "gitbook.io", "typeform.com",
  "paperform.co", "calendly.com", "bit.ly",
];

// Hosting suffixes where the vendor owns only a subdomain (foo.pages.dev is "foo", not "pages.dev").
const HOSTED_SUFFIXES = [
  "pages.dev", "vercel.app", "netlify.app", "github.io", "herokuapp.com", "web.app", "firebaseapp.com",
  "onrender.com", "fly.dev", "framer.website", "framer.ai", "webflow.io", "carrd.co", "wixsite.com",
  "bubbleapps.io", "softr.app", "replit.app", "glitch.me", "azurewebsites.net",
];

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};
const onDomain = (host: string, d: string) => host === d || host.endsWith("." + d);

/** Registrable site of a host: "app.chatplayground.ai" -> "chatplayground.ai", "foo.pages.dev" -> "foo.pages.dev". */
export function siteOf(host: string): string {
  const h = host.replace(/^www\./, "");
  const hosted = HOSTED_SUFFIXES.find((s) => onDomain(h, s) && h !== s);
  const parts = h.split(".");
  if (hosted) return parts.slice(-(hosted.split(".").length + 1)).join(".");
  const twoPart = /^(co|com|net|org|gov|ac|edu)\.[a-z]{2}$/.test(parts.slice(-2).join("."));
  return parts.slice(twoPart ? -3 : -2).join(".");
}

// Subdomains that are the vendor's own marketing or app hosts. Any other subdomain may be a
// customer site on a hosting platform (creator.teachery.co is not Teachery).
const OWN_SUBDOMAIN = /^(www\d?|info|get|go|try|landing|lp|pages?|home|start|join|app|my|local|en|us|web|site|hello|offer|promo)$/i;

/** The part of the web that speaks for a vendor host: its registrable site, unless the host is a non-marketing subdomain. */
export function scopeOf(host: string): string {
  const h = host.toLowerCase().replace(/^www\./, "");
  const site = siteOf(h);
  if (h === site) return site;
  const sub = h.slice(0, -(site.length + 1));
  return !sub.includes(".") && OWN_SUBDOMAIN.test(sub) ? site : h;
}

export function isMarketplaceUrl(url: string): boolean {
  const h = hostOf(url);
  return !!h && MARKETPLACES.some((d) => onDomain(h, d));
}

/** True when both URLs belong to the same registrable site. */
export function sameSiteUrl(a: string, b: string): boolean {
  const ha = hostOf(a);
  const hb = hostOf(b);
  return !!ha && !!hb && siteOf(ha) === siteOf(hb);
}

const key = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
const TRAILING = /\s*(lifetime deal|lifetime subscription|lifetime access|lifetime|ltd|deal|review|exclusive)\s*$/i;

function slugOf(url: string): string {
  const segs = new URL(url).pathname.split("/").filter(Boolean);
  return (segs[segs.length - 1] ?? "").toLowerCase();
}

/** Product name from the page: the H1 or title segment that matches the URL slug, before any ":" or "|". */
export function productName(html: string, url: string): string {
  const $ = cheerio.load(html);
  const h1 = $("h1").first().text().replace(/\s+/g, " ").trim();
  const title = $("title").first().text().replace(/\s+/g, " ").trim();
  const clean = (s: string) => s.replace(TRAILING, "").replace(TRAILING, "").trim();
  const parts = [h1.split(/\s*[:|–—]\s*|\s+-\s+/)[0], ...title.split(/\s*[:|·–—]\s*|\s+-\s+/)]
    .map(clean)
    .filter((p) => p.length >= 2 && p.length <= 60);
  const slug = key(slugOf(url));
  const match = parts.find((p) => {
    const k = key(p);
    return k.length >= 3 && (slug.startsWith(k) || k.startsWith(slug.slice(0, Math.max(4, Math.min(slug.length, 8)))));
  });
  return match ?? parts[0] ?? (title || h1);
}

function nameMatchesHost(name: string, slug: string, host: string): number {
  const label = key(siteOf(host).split(".")[0]);
  if (label.length < 4) return 0;
  const n = key(name);
  const s = key(slug);
  if (label === n || label === s) return 3;
  if ((n.length >= 4 && (n.includes(label) || label.includes(n))) || (s.length >= 4 && (s.startsWith(label) || label.includes(s)))) return 2;
  return 0;
}

/** Outbound vendor-site candidates from a marketplace page, best first (origins). */
export function rankVendorLinks(links: FoundLink[], dealUrl: string, name: string): string[] {
  const slug = slugOf(dealUrl);
  const scored = new Map<string, number>();
  for (const l of links) {
    const h = hostOf(l.href);
    if (!h || !/^https?:/.test(l.href)) continue;
    if (sameSiteUrl(l.href, dealUrl) || isMarketplaceUrl(l.href) || NOT_VENDOR.some((d) => onDomain(h, d))) continue;
    let s = nameMatchesHost(name, slug, h);
    if (!s) continue;
    if (name && l.text.toLowerCase().includes(name.toLowerCase())) s += 1;
    if (/visit|website|official|homepage/i.test(l.text)) s += 1;
    const site = siteOf(h);
    // Keep the link's own origin when it is the site itself (or www.); otherwise the site root.
    const origin = h === site ? new URL(l.href).origin + "/" : `https://${site}/`;
    scored.set(origin, Math.max(scored.get(origin) ?? 0, s));
  }
  return [...scored.entries()].sort((a, b) => b[1] - a[1]).map(([o]) => o);
}

const PARKED = /for sale|domain (is )?(available|parked)|buy this domain|parked|godaddy|namecheap|sedo|dan\.com|hugedomains/i;

/** Last resort: try <name>.com/.io/.ai/.app and accept one only if its homepage title names the product. */
export async function guessVendorDomain(
  name: string,
  dealUrl: string,
  fetcher: (url: string) => Promise<FetchResult> = (u) => safeFetch(u),
): Promise<string | null> {
  const bases = [...new Set([key(name), key(slugOf(dealUrl))])].filter((b) => b.length >= 4 && b.length <= 30);
  const n = key(name);
  if (!bases.length || n.length < 3) return null;
  const urls = bases.flatMap((b) => [".com", ".io", ".ai", ".app"].map((tld) => `https://${b}${tld}/`));
  const results = await Promise.all(
    urls.map(async (u) => {
      try {
        const r = await fetcher(u);
        if (r.status !== 200) return null;
        const { title } = htmlToText(r.body);
        return key(title).includes(n) && !PARKED.test(title) && !isMarketplaceUrl(r.finalUrl) ? new URL(r.finalUrl).origin + "/" : null;
      } catch {
        return null;
      }
    }),
  );
  return results.find(Boolean) ?? null;
}

/** Marketplace deal terms that simple regexes can read: price, refund window, access length, redemption deadline. */
export function marketplaceTerms(text: string): Pick<DealInfo, "price" | "originalPrice" | "refundableDays" | "faqs"> {
  const t = text.replace(/\s+/g, " ");
  const num = (s: string) => Number(s.replace(/,/g, ""));
  let price: number | null = null;
  let originalPrice: number | null = null;
  const labeled = t.match(/deal price:?\s*\$\s?([\d,]+(?:\.\d{1,2})?).{0,40}?(?:suggested|regular|retail|original|list) price:?\s*\$\s?([\d,]+(?:\.\d{1,2})?)/i);
  const pairs = labeled ? [labeled] : [...t.matchAll(/\$\s?([\d,]+(?:\.\d{2})?)\s*\/?\s*\$\s?([\d,]+(?:\.\d{2})?)/g)];
  for (const m of pairs) {
    const p = num(m[1]);
    const o = num(m[2]);
    if (p > 0 && o > p) {
      price = p;
      originalPrice = o;
      break;
    }
  }
  const refund =
    t.match(/(\d{1,3})[- ]days? money[- ]back/i) ??
    t.match(/money[- ]back guarantee:? (?:of |for )?(\d{1,3}) days/i) ??
    t.match(/refund(?:able|s)? (?:within|for|up to) (\d{1,3}) days/i);
  const faqs: { q: string; a: string }[] = [];
  const tidy = (s: string) => s.replace(/[\s\-–•|]+$/, "").trim();
  const access = t.match(/length of access:?\s*(.{1,40}?)(?=\s*(?:redemption|access options|max number|available to|deal terms|\.|$))/i);
  if (access) faqs.push({ q: "Length of access", a: tidy(access[1]) });
  const redeem = t.match(/redemption deadline:?\s*(.{1,60}?)(?=\s*(?:\d{1,3} days money|access options|max number|available to|length of access|\.|$))/i);
  if (redeem) faqs.push({ q: "Redemption deadline", a: tidy(redeem[1]) });
  return { price, originalPrice, refundableDays: refund ? Number(refund[1]) : null, faqs };
}

const LISTING_PATH = /\/(product-category|category|categories|collections?|shop|tag|tags|products?|deals?|sales?|store|search)(\/|$)/i;
const TERMS_WORDS = /terms|conditions|legal|agreement|eula|\btos\b|policies/i;

/**
 * Is this fetched page plausibly the kind of document we asked for? Rejects
 * category / product-listing pages and, for terms, pages with no terms-ish word
 * in the path or title (a guessed or link-matched URL can land on anything).
 */
export function plausibleDoc(kind: DocKind, url: string, title: string): boolean {
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  if (kind === "vendor_home" || kind === "deal") return true;
  const own = kind === "terms" ? TERMS_WORDS : kind === "refund" ? /refund|cancel|money-back|return/i : /pricing|plans|price/i;
  if (own.test(pathname)) return true;
  if (LISTING_PATH.test(pathname)) return false;
  return kind === "terms" ? TERMS_WORDS.test(title) : true;
}
