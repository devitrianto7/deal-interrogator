import type { Metadata } from "next";
import Link from "next/link";
import docket from "@/docket/index.json";
import { DocketList } from "./docket-list";
import type { DocketEntry } from "./types";

export const metadata: Metadata = {
  title: "The Docket · Deal Interrogator",
  description: "Live lifetime deals from AppSumo and other marketplaces, each cross-examined and ruled Buy, Wait or Skip with quoted receipts.",
};

const entries = docket as DocketEntry[];

export default function DocketPage() {
  const counts = entries.reduce(
    (a, e) => ({ ...a, [e.verdict]: a[e.verdict] + 1 }),
    { Buy: 0, Wait: 0, Skip: 0, Unverified: 0 } as Record<DocketEntry["verdict"], number>,
  );
  const contradicted = entries.reduce((n, e) => n + e.court.contradicted, 0);
  const dates = entries.map((e) => e.generatedAt).filter(Boolean).sort() as string[];
  const asOf = dates.length ? dates[dates.length - 1].slice(0, 10) : null;

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-5 py-10 sm:py-14">
      <header className="mb-8">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
          <Link href="/" className="underline hover:text-ink">
            Deal Interrogator
          </Link>{" "}
          · Case file index
        </p>
        <h1 className="mt-2 font-serif text-4xl sm:text-5xl">The Docket</h1>
        <p className="mt-3 max-w-2xl text-muted">
          {entries.length} live lifetime deals from AppSumo, StackSocial, RocketHub, Dealify, DealMirror and Earlybird, each put on trial by the same engine: claims cross-examined
          against the vendor&apos;s own pricing, terms and refund policy, and buyer reviews. Every point in a score
          carries a quote checked word for word against its source.
        </p>
      </header>

      <section className={`grid grid-cols-2 gap-3 ${counts.Unverified ? "sm:grid-cols-5" : "sm:grid-cols-4"}`}>
        {[
          { label: "Cases judged", value: entries.length, tone: "text-ink" },
          { label: "Buy", value: counts.Buy, tone: "text-buy" },
          { label: "Wait", value: counts.Wait, tone: "text-wait" },
          { label: "Skip", value: counts.Skip, tone: "text-skip" },
          ...(counts.Unverified ? [{ label: "Unverified", value: counts.Unverified, tone: "text-muted" }] : []),
        ].map((c) => (
          <div key={c.label} className="rounded-lg border border-rule bg-white p-4">
            <p className="font-mono text-[11px] uppercase tracking-wide text-muted">{c.label}</p>
            <p className={`mt-1 font-serif text-4xl leading-none ${c.tone}`}>{c.value}</p>
          </div>
        ))}
      </section>
      <p className="mt-3 font-mono text-[11px] text-muted">
        {contradicted} seller claims ruled contradicted in court{asOf ? ` · judged as of ${asOf}` : ""} · 0-30 Buy, 31-60
        Wait, 61+ Skip
      </p>

      <DocketList entries={entries} />

      <footer className="mt-16 border-t border-rule pt-4 text-xs text-muted">
        Reports are snapshots from the date shown; deals and terms change. Open any case to see the receipts or run it
        fresh. Not financial advice.
      </footer>
    </main>
  );
}
