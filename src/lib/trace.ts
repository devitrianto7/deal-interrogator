// Unfakeable signals: domain registration date (RDAP) and first Wayback
// Machine capture. Both are public records the vendor cannot edit.
import { safeFetch } from "./fetcher/http";
import { siteOf } from "./fetcher/marketplace";
import { asOfCutoff, firstCapture } from "./fetcher/wayback";

export interface VendorTrace {
  domain: string;
  registered: string | null; // ISO date
  rdapUrl: string;
  firstSnapshot: string | null; // ISO date
  firstSnapshotUrl: string | null;
  errors: string[];
}

export function registrableDomain(url: string): string {
  // Good enough for common TLDs, two-part ccTLD suffixes like co.uk / com.au, and
  // hosting subdomains (foo.pages.dev is not a registered domain, so RDAP says "unknown").
  return siteOf(new URL(url).hostname.toLowerCase());
}

const isoDay = (s: string) => (Number.isNaN(Date.parse(s)) ? null : new Date(s).toISOString().slice(0, 10));

// As-of mode: a registration date or first capture on/after the as-of day is discarded
// (a domain re-registered after it dropped would otherwise look brand new, or leak the outcome).
export async function vendorTrace(vendorUrl: string, asOf?: string): Promise<VendorTrace> {
  const cutoffDay = asOf ? `${asOf.slice(0, 4)}-${asOf.slice(4, 6)}-${asOf.slice(6, 8)}` : null;
  if (asOf) asOfCutoff(asOf);
  const domain = registrableDomain(vendorUrl);
  const rdapUrl = `https://rdap.org/domain/${domain}`;
  const errors: string[] = [];

  const rdap = (async () => {
    try {
      const r = await safeFetch(rdapUrl, "application/rdap+json, application/json");
      if (r.status !== 200) throw new Error(`RDAP HTTP ${r.status}`);
      const ev = (JSON.parse(r.body).events ?? []) as { eventAction: string; eventDate: string }[];
      const reg = ev.find((e) => e.eventAction === "registration");
      const day = reg ? isoDay(reg.eventDate) : null;
      if (day && cutoffDay && day >= cutoffDay) {
        errors.push(`RDAP: current registration (${day}) is after the as-of date; domain was likely re-registered, so age is unknown.`);
        return null;
      }
      return day;
    } catch (e) {
      errors.push(`RDAP: ${(e as Error).message}`);
      return null;
    }
  })();

  const wayback = (async () => {
    try {
      const fc = await firstCapture(domain, asOf);
      return fc ? { date: fc.date, url: fc.url } : { date: null, url: null };
    } catch (e) {
      errors.push(`Wayback: ${(e as Error).message}`);
      return { date: null, url: null };
    }
  })();

  const [registered, wb] = await Promise.all([rdap, wayback]);
  return { domain, registered, rdapUrl, firstSnapshot: wb.date, firstSnapshotUrl: wb.url, errors };
}
