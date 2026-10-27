// Find a vendor's pricing, terms and refund pages: first from links on its
// homepage, then by trying common paths.
import type { FoundLink } from "./extract";
import { scopeOf, siteOf } from "./marketplace";
import type { DocKind } from "./types";

type Target = Extract<DocKind, "vendor_pricing" | "terms" | "refund">;

const PATTERNS: Record<Target, { href: RegExp; text: RegExp; guesses: string[] }> = {
  vendor_pricing: {
    // Matched on the last path segment: "/pricing", "/open-elms-pricing/", "/prices-packages-2", not a blog slug.
    href: /^([a-z0-9]+-){0,2}(pricing|plans|prices?)(-[a-z0-9]+){0,2}(\.html?)?$/i,
    text: /^(pricing|plans|plans & pricing|plans and pricing)$/i,
    guesses: ["/pricing", "/plans"],
  },
  terms: {
    href: /(terms|tos|terms-of-service|terms-and-conditions|legal|conditions|eula|user-agreement|policies)/i,
    text: /(terms|conditions|terms of service|terms of use|legal)/i,
    guesses: [
      "/terms",
      "/terms-of-service",
      "/terms-and-conditions",
      "/terms-of-use",
      "/terms-conditions",
      "/tos",
      "/legal/terms",
      "/pages/terms",
      "/privacy-terms",
      "/legal",
    ],
  },
  refund: {
    href: /(refund|cancellation|money-back)/i,
    text: /(refund|cancellation|money.back)/i,
    guesses: ["/refund-policy", "/refund", "/refunds", "/cancellation-policy"],
  },
};

// Same vendor site: within the vendor's scope (its registrable site, or just its own host when
// the homepage is a creator subdomain on a hosting platform).
const sameSite = (a: string, b: string) => {
  try {
    const ha = new URL(a).hostname.toLowerCase().replace(/^www\./, "");
    const scope = scopeOf(new URL(b).hostname);
    return ha === scope || ha.endsWith("." + scope);
  } catch {
    return false;
  }
};

// Articles, docs and portfolios mention "pricing" or "refund" in their slugs but are not policies.
const CONTENT_DIR = /\/(blog|news|posts?|articles?|portfolio|docs|help|kb|knowledge-?base|guides?|tutorials?|resources|academy|learn|changelog|case-studies|glossary)\//i;
// An imprint names the company; it is not terms of service.
const NOT_TERMS = /privacy|cookie|legal-notice|imprint|impressum|mentions-legales/i;

const lastSeg = (path: string) => path.split("/").filter(Boolean).pop() ?? "";
function pathMatches(target: Target, path: string): boolean {
  if (CONTENT_DIR.test(path)) return false;
  if (target === "terms" && NOT_TERMS.test(path)) return false;
  return target === "vendor_pricing" ? PATTERNS.vendor_pricing.href.test(lastSeg(path)) : PATTERNS[target].href.test(path);
}

const OWN_POLICY_TEXT = {
  terms: /^(terms|terms of (service|use)|terms (&|and) conditions|terms & privacy|legal|legal terms|tos)$/i,
  refund: /^(refund|refunds|refund policy|cancellation (&|and) refund policy|money-back guarantee)$/i,
};
// Hosts whose terms are never the vendor's own (payments, app stores, platforms, social).
const THIRD_PARTY =
  /(^|\.)(google|apple|microsoft|stripe|paypal|paddle|gumroad|lemonsqueezy|fastspring|chargebee|shopify|wordpress|wix|squarespace|webflow|facebook|twitter|x|linkedin|youtube|instagram|tiktok|github|notion|appsumo|zapier|hubspot|intercom|zendesk|cloudflare|amazon|aws)\.[a-z.]+$/i;

// Terms-ish pages that are really terms come before generic "legal" pages (an imprint is a weaker source).
const termsRank = (href: string) => (/terms|tos|conditions|eula|agreement/i.test(href) ? 0 : 1);

/** Candidate URLs for a target page: homepage links, then sitemap entries, then common paths. */
export function findCandidates(links: FoundLink[], vendorHome: string, target: Target, sitemap: string[] = []): string[] {
  const p = PATTERNS[target];
  const fromLinks = links
    .filter((l) => sameSite(l.href, vendorHome))
    .filter((l) => {
      const path = new URL(l.href).pathname;
      if (CONTENT_DIR.test(path) || (target === "terms" && NOT_TERMS.test(path))) return false;
      return pathMatches(target, path) || p.text.test(l.text);
    })
    .map((l) => l.href);
  if (target === "terms") fromLinks.sort((a, b) => termsRank(a) - termsRank(b));
  // A footer "Terms" link to the parent company's site (pinflux.in -> teknikforce.com/terms) is still the vendor's terms.
  // Not for a creator subdomain on a hosting platform: its footer links are the platform's own policies.
  const homeHost = new URL(vendorHome).hostname.toLowerCase().replace(/^www\./, "");
  if (target !== "vendor_pricing" && scopeOf(homeHost) === siteOf(homeHost))
    for (const l of links)
      if (!sameSite(l.href, vendorHome) && OWN_POLICY_TEXT[target].test(l.text) && !THIRD_PARTY.test(new URL(l.href).hostname)) fromLinks.push(l.href);
  const fromMap = sitemapMatches(sitemap, vendorHome, target);
  const origin = new URL(vendorHome).origin;
  const guesses = p.guesses.map((g) => origin + g);
  return [...new Set([...fromLinks, ...fromMap, ...guesses])];
}

/** Sitemap URLs on the vendor's site whose path names the target page (terms, pricing, refund). */
export function sitemapMatches(urls: string[], vendorHome: string, target: Target): string[] {
  const out = urls.filter((u) => {
    if (!sameSite(u, vendorHome)) return false;
    let path = "";
    try {
      path = new URL(u).pathname;
    } catch {
      return false;
    }
    if (path.split("/").filter(Boolean).length > 3) return false; // deep pages are not policies
    return pathMatches(target, path);
  });
  if (target === "terms") out.sort((a, b) => termsRank(a) - termsRank(b));
  return out.slice(0, 4);
}
