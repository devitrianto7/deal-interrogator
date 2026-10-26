// Find a vendor's pricing, terms and refund pages: first from links on its
// homepage, then by trying common paths.
import type { FoundLink } from "./extract";
import type { DocKind } from "./types";

type Target = Extract<DocKind, "vendor_pricing" | "terms" | "refund">;

const PATTERNS: Record<Target, { href: RegExp; text: RegExp; guesses: string[] }> = {
  vendor_pricing: {
    href: /\/(pricing|plans|price)(\/|$|\?)/i,
    text: /^(pricing|plans|plans & pricing|plans and pricing)$/i,
    guesses: ["/pricing", "/plans"],
  },
  terms: {
    href: /(terms|tos|terms-of-service|terms-and-conditions|legal\/terms|eula)/i,
    text: /(terms|conditions|terms of service|terms of use)/i,
    guesses: ["/terms", "/terms-of-service", "/terms-and-conditions", "/tos", "/legal/terms", "/legal"],
  },
  refund: {
    href: /(refund|cancellation|money-back)/i,
    text: /(refund|cancellation|money.back)/i,
    guesses: ["/refund-policy", "/refund", "/refunds", "/cancellation-policy"],
  },
};

const sameSite = (a: string, b: string) => {
  const root = (h: string) => h.replace(/^www\./, "").split(".").slice(-2).join(".");
  try {
    return root(new URL(a).hostname) === root(new URL(b).hostname);
  } catch {
    return false;
  }
};

export function findCandidates(links: FoundLink[], vendorHome: string, target: Target): string[] {
  const p = PATTERNS[target];
  const fromLinks = links
    .filter((l) => sameSite(l.href, vendorHome))
    .filter((l) => !/privacy|cookie/i.test(l.href) || target !== "terms")
    .filter((l) => p.href.test(new URL(l.href).pathname) || p.text.test(l.text))
    .map((l) => l.href);
  const origin = new URL(vendorHome).origin;
  const guesses = p.guesses.map((g) => origin + g);
  return [...new Set([...fromLinks, ...guesses])];
}
