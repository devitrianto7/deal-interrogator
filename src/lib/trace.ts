// Unfakeable signals: domain registration date (RDAP) and first Wayback
// Machine capture. Both are public records the vendor cannot edit.
import { safeFetch } from "./fetcher/http";

export interface VendorTrace {
  domain: string;
  registered: string | null; // ISO date
  rdapUrl: string;
  firstSnapshot: string | null; // ISO date
  firstSnapshotUrl: string | null;
  errors: string[];
}

export function registrableDomain(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const parts = host.split(".");
  // Good enough for common TLDs and two-part ccTLD suffixes like co.uk / com.au.
  const twoPart = /^(co|com|net|org|gov|ac|edu)\.[a-z]{2}$/.test(parts.slice(-2).join("."));
  return parts.slice(twoPart ? -3 : -2).join(".");
}

const isoDay = (s: string) => (Number.isNaN(Date.parse(s)) ? null : new Date(s).toISOString().slice(0, 10));

export async function vendorTrace(vendorUrl: string): Promise<VendorTrace> {
  const domain = registrableDomain(vendorUrl);
  const rdapUrl = `https://rdap.org/domain/${domain}`;
  const errors: string[] = [];

  const rdap = (async () => {
    try {
      const r = await safeFetch(rdapUrl, "application/rdap+json, application/json");
      if (r.status !== 200) throw new Error(`RDAP HTTP ${r.status}`);
      const ev = (JSON.parse(r.body).events ?? []) as { eventAction: string; eventDate: string }[];
      const reg = ev.find((e) => e.eventAction === "registration");
      return reg ? isoDay(reg.eventDate) : null;
    } catch (e) {
      errors.push(`RDAP: ${(e as Error).message}`);
      return null;
    }
  })();

  const wayback = (async () => {
    try {
      const r = await safeFetch(
        `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}&limit=1&output=json&fl=timestamp,original`,
        "application/json",
      );
      if (r.status !== 200) throw new Error(`Wayback HTTP ${r.status}`);
      const rows = JSON.parse(r.body) as string[][];
      const ts = rows[1]?.[0];
      if (!ts) return { date: null, url: null };
      const date = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
      return { date, url: `https://web.archive.org/web/${ts}/${rows[1][1]}` };
    } catch (e) {
      errors.push(`Wayback: ${(e as Error).message}`);
      return { date: null, url: null };
    }
  })();

  const [registered, wb] = await Promise.all([rdap, wayback]);
  return { domain, registered, rdapUrl, firstSnapshot: wb.date, firstSnapshotUrl: wb.url, errors };
}
