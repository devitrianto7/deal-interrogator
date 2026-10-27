import type { Metadata } from "next";
import Link from "next/link";
import data from "@/backtest/results.json";

export const metadata: Metadata = {
  title: "Backtest · Deal Interrogator",
  description:
    "Would Deal Interrogator have flagged lifetime deals that later shut down or revoked lifetime access? Re-run on Wayback Machine snapshots from before each event.",
};

type Signal = {
  label: string;
  points: number;
  max: number;
  finding: string;
  quote: string | null;
  quoteSource: string | null;
  quoteUrl: string | null;
};

type Case = {
  slug: string;
  name: string;
  group: "failed" | "control" | string;
  eventType: string;
  eventDate: string | null;
  event: string;
  source: string;
  asOf: string;
  dealUrl: string;
  dealSnapshot?: string | null;
  capturedAt?: string | null;
  leadDays?: number | null;
  score?: number;
  verdict?: "Buy" | "Wait" | "Skip" | "Unverified";
  verdictNote?: string | null;
  guard?: "terms_unreadable" | "no_reviews" | "vendor_unreachable" | null;
  missing?: string[];
  topSignals?: Signal[];
  error?: string;
};

type Summary = {
  n: number;
  errors: number;
  Buy: number;
  Wait: number;
  Skip: number;
  Unverified: number;
  guards: { terms_unreadable: number; no_reviews: number; vendor_unreachable: number };
  flaggedOnScore: number;
  meanScore: number | null;
};

const results = data as unknown as {
  generatedAt: string;
  modelSpendUsd: number;
  summary: { failed: Summary; control: Summary };
  cases: Case[];
};

const VERDICT_COLOR = { Buy: "text-buy", Wait: "text-wait", Skip: "text-skip", Unverified: "text-muted" } as const;
const GUARD_LABEL = {
  terms_unreadable: "Coverage guard (terms unreadable)",
  no_reviews: "No-reviews rule",
  vendor_unreachable: "Unverified (vendor site unreadable)",
} as const;

const fmtAsOf = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const months = (days?: number | null) => (days == null ? null : Math.round(days / 30.4));

function host(u?: string | null) {
  try {
    return u ? new URL(u).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

function Stat({ big, label, sub }: { big: string; label: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-rule bg-white p-5">
      <div className="font-serif text-4xl">{big}</div>
      <div className="mt-1 text-sm font-semibold">{label}</div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </div>
  );
}

function CaseRow({ c }: { c: Case }) {
  const top = c.topSignals?.[0];
  return (
    <li className="grid gap-3 border-b border-rule py-5 last:border-0 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_6.5rem]">
      <div>
        <a href={c.dealUrl} target="_blank" rel="noreferrer" className="font-semibold underline-offset-2 hover:underline">
          {c.name}
        </a>
        <div className="mt-1 font-mono text-[11px] uppercase tracking-wide text-muted">As of {fmtAsOf(c.asOf)}</div>
        {c.capturedAt && (
          <div className="font-mono text-[11px] text-muted">
            <a href={c.dealSnapshot ?? undefined} target="_blank" rel="noreferrer" className="underline hover:text-ink">
              snapshot {c.capturedAt}
            </a>
            {c.leadDays != null && <> · {months(c.leadDays)} mo before</>}
          </div>
        )}
      </div>

      <div className="min-w-0">
        <div className="text-sm">
          <span className="mr-2 rounded bg-rule px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide">{c.eventType}</span>
          {c.eventDate && <span className="mr-2 font-mono text-xs text-muted">{c.eventDate}</span>}
          {c.event}{" "}
          <a href={c.source} target="_blank" rel="noreferrer" className="font-mono text-[11px] text-muted underline hover:text-ink">
            {host(c.source)}
          </a>
        </div>
        {c.error ? (
          <p className="mt-2 text-sm text-muted">Not scored: {c.error}</p>
        ) : top ? (
          <div className="mt-3 border-l-2 border-rule pl-3">
            <div className="text-xs font-semibold">
              {top.label} · {top.points}/{top.max}
            </div>
            <div className="text-sm text-muted">{top.finding}</div>
            {top.quote && (
              <div className="mt-1">
                {["stats", "rdap", "wayback"].includes(top.quoteSource ?? "") ? (
                  <span className="text-[14px]">{top.quote}</span>
                ) : (
                  <q className="font-serif text-[14px] leading-snug">{top.quote}</q>
                )}
                {top.quoteUrl && (
                  <a href={top.quoteUrl} target="_blank" rel="noreferrer" className="ml-2 font-mono text-[11px] text-muted underline hover:text-ink">
                    {host(top.quoteUrl)}
                  </a>
                )}
              </div>
            )}
            {(c.topSignals?.length ?? 0) > 1 && (
              <div className="mt-1 font-mono text-[11px] text-muted">
                also: {c.topSignals!.slice(1).map((s) => `${s.label} ${s.points}/${s.max}`).join(" · ")}
              </div>
            )}
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted">No risk signal fired on the archived evidence.</p>
        )}
        {c.verdictNote && (
          <p className="mt-2 text-xs text-muted">
            {c.guard ? GUARD_LABEL[c.guard] : "Note"}: {c.verdictNote}
          </p>
        )}
      </div>

      <div className="sm:text-right">
        {c.verdict ? (
          <>
            <div className={`font-serif text-2xl font-semibold ${VERDICT_COLOR[c.verdict]}`}>{c.verdict}</div>
            <div className="font-mono text-sm">
              {c.score}
              <span className="text-muted">/100</span>
            </div>
          </>
        ) : (
          <div className="font-mono text-sm text-muted">n/a</div>
        )}
      </div>
    </li>
  );
}

export default function BacktestPage() {
  const f = results.summary.failed;
  const k = results.summary.control;
  const failed = results.cases.filter((c) => c.group === "failed");
  const controls = results.cases.filter((c) => c.group === "control");
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-5 py-10 sm:py-14">
      <header className="mb-10">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
          <Link href="/" className="underline hover:text-ink">
            Deal Interrogator
          </Link>{" "}
          · Case file · Backtest
        </p>
        <h1 className="mt-2 font-serif text-4xl sm:text-5xl">Would it have seen it coming?</h1>
        <p className="mt-3 max-w-2xl text-muted">
          We took lifetime deals that later shut down, revoked lifetime access or cut what buyers had paid for, and ran
          the unchanged engine on the web as it was months before each event: the deal page, the vendor&apos;s site,
          pricing and terms, all read from Wayback Machine captures. Then we did the same for deals that stayed healthy.
        </p>
      </header>

      <section aria-labelledby="results">
        <h2 id="results" className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
          Results
        </h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Stat
            big={`${f.flaggedOnScore}/${f.n}`}
            label="Failed deals flagged on score"
            sub={`Risk score above 30, i.e. Wait or Skip on the evidence itself (${pct(f.flaggedOnScore, f.n)}). Mean score ${f.meanScore ?? "–"}.`}
          />
          <Stat
            big={`${f.n - f.Buy}/${f.n}`}
            label="Failed deals not rated Buy"
            sub={`${f.Skip} Skip, ${f.Wait} Wait, ${f.Unverified} Unverified, ${f.Buy} Buy. Includes verdicts set by an evidence guard rather than the score (see below).`}
          />
          <Stat
            big={`${k.Buy}/${k.n}`}
            label="Healthy controls rated Buy"
            sub={`${k.Wait} Wait, ${k.Skip} Skip, ${k.Unverified} Unverified. Controls scoring above 30: ${k.flaggedOnScore}. Mean score ${k.meanScore ?? "–"}.`}
          />
        </div>
        <div className="mt-4 overflow-x-auto rounded-lg border border-rule bg-white">
          <table className="w-full text-left text-sm">
            <thead className="font-mono text-[11px] uppercase tracking-wide text-muted">
              <tr className="border-b border-rule">
                <th className="px-4 py-2 font-normal">Group</th>
                <th className="px-3 py-2 font-normal">Buy</th>
                <th className="px-3 py-2 font-normal">Wait</th>
                <th className="px-3 py-2 font-normal">Skip</th>
                <th className="px-3 py-2 font-normal">Unverified</th>
                <th className="px-3 py-2 font-normal">Score &gt; 30</th>
                <th className="px-3 py-2 font-normal">Set by a guard*</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["Later failed", f],
                  ["Stayed healthy", k],
                ] as const
              ).map(([name, s]) => (
                <tr key={name} className="border-b border-rule last:border-0">
                  <td className="px-4 py-2 font-semibold">
                    {name} <span className="font-normal text-muted">(n={s.n})</span>
                  </td>
                  <td className="px-3 py-2 text-buy">{s.Buy}</td>
                  <td className="px-3 py-2 text-wait">{s.Wait}</td>
                  <td className="px-3 py-2 text-skip">{s.Skip}</td>
                  <td className="px-3 py-2 text-muted">{s.Unverified}</td>
                  <td className="px-3 py-2">{s.flaggedOnScore}</td>
                  <td className="px-3 py-2 text-muted">
                    {s.guards.terms_unreadable} terms · {s.guards.no_reviews} no reviews · {s.guards.vendor_unreachable} vendor
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 rounded-lg border border-rule bg-white p-4 text-[15px]">
          <b>Reading it honestly:</b> on score alone, {f.flaggedOnScore} of {f.n} failed deals ({pct(f.flaggedOnScore, f.n)}) and {k.flaggedOnScore} of {k.n} healthy controls ({pct(k.flaggedOnScore, k.n)}) scored
          above 30. {f.flaggedOnScore / Math.max(f.n, 1) > k.flaggedOnScore / Math.max(k.n, 1) + 0.15
            ? "Failed deals were flagged more often than controls, but the sample is small."
            : "At this sample size the score does not separate deals that later failed from deals that stayed healthy."}{" "}
          The engine is cautious: it rarely says Buy for either group ({f.Buy} of {f.n} failed, {k.Buy} of {k.n} controls),
          so a Wait is common and a Buy is the stronger statement. The {f.Buy} failed deal{f.Buy === 1 ? "" : "s"} rated Buy
          {f.Buy === 1 ? " is" : " are"} the miss to study.
        </p>
        <p className="mt-2 text-xs text-muted">
          * A low score (0-30) is not shown as Buy when evidence is missing: unreadable terms turn it into Wait, zero
          reviews turn it into Wait, and an unreadable vendor site turns any non-Skip verdict into Unverified. These are
          production rules; the table shows how many verdicts they set.
        </p>
        <p className="mt-3 text-xs text-muted">
          {f.errors + k.errors > 0 && <>{f.errors + k.errors} case(s) could not be scored and are excluded from the counts. </>}
          Thresholds are the production ones (0-30 Buy, 31-60 Wait, 61+ Skip) and were not changed for this test. Model spend for the runs shown: ${results.modelSpendUsd.toFixed(2)}.
        </p>
      </section>

      <section aria-labelledby="method" className="mt-12">
        <h2 id="method" className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
          Method
        </h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-[15px]">
          <li>
            <b>Cases.</b> {f.n + f.errors} AppSumo lifetime deals with a dated, public failure: an AppSumo staff notice on
            the deal page, or buyer reports when there was no notice. {k.n + k.errors} controls: products still live in
            October 2026 with no lifetime-revocation or limit-cut complaints among their 1-2 star AppSumo reviews.
          </li>
          <li>
            <b>As-of date.</b> 90 days before the event (controls: 1 Aug 2024, more than two years ago). Each page is read
            from the newest Wayback capture strictly before that day, in raw <code className="font-mono text-sm">id_</code>{" "}
            mode, so the text is exactly what was archived.
          </li>
          <li>
            <b>No leakage.</b> If Wayback redirects to a newer capture, the page is rejected. No capture means the page
            counts as missing; the live site is never used as a fallback. Review statistics come from the archived deal
            page; review texts come from AppSumo&apos;s API but only if written before the as-of date and not edited after
            it. Domain age is measured at the as-of date, and a registration newer than it is discarded.
          </li>
          <li>
            <b>Same engine.</b> Extraction, quote verification, the courtroom and the 8-signal score are the production
            code. Only the fetcher and the &quot;now&quot; used for vendor age change in as-of mode.
          </li>
        </ol>
      </section>

      <section aria-labelledby="failed" className="mt-12">
        <h2 id="failed" className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
          Deals that later failed ({failed.length})
        </h2>
        <ul className="mt-2 rounded-lg border border-rule bg-white px-5">
          {failed.map((c) => (
            <CaseRow key={c.slug} c={c} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="controls" className="mt-12">
        <h2 id="controls" className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
          Controls that stayed healthy ({controls.length})
        </h2>
        <ul className="mt-2 rounded-lg border border-rule bg-white px-5">
          {controls.map((c) => (
            <CaseRow key={c.slug} c={c} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="limits" className="mt-12">
        <h2 id="limits" className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
          Limitations
        </h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-[15px]">
          <li>
            Small sample, chosen by us. Failures were picked because they had a dated public record and a usable
            pre-event capture; that is not a random draw of all deals.
          </li>
          <li>
            &quot;Healthy&quot; is hard to find. Screening candidates, we dropped several well-known deals (including
            AppSumo&apos;s own tools) because buyers had already reported lifetime terms being cut. Some controls may yet
            fail.
          </li>
          <li>
            Wayback coverage is uneven. Captures can be months older than the as-of date, vendor terms pages were often
            never archived (a guard then replaces a low-score Buy), and AppSumo pages captured before its current layout
            are read as plain text, without plans or reviews.
          </li>
          <li>
            The models may know a product&apos;s later fate from training. They cannot add points with that knowledge:
            every point needs a quote found verbatim in the archived text. They could still influence which archived
            quotes get extracted.
          </li>
          <li>
            Reviews deleted before today, and edits that AppSumo does not flag, are invisible to us. Model output varies
            slightly run to run, so borderline scores can move a few points.
          </li>
          <li>
            The Internet Archive stopped answering our index queries partway through the run (rate limiting), so a few
            cases could not be scored; they are listed as &quot;not scored&quot; rather than dropped.
          </li>
          <li>A Wait or Skip is a warning, not a prediction of the exact failure. Some flags fired for reasons unrelated to what later happened.</li>
        </ul>
      </section>

      <footer className="mt-16 border-t border-rule pt-4 text-xs text-muted">
        Results generated {results.generatedAt.slice(0, 10)} with <code className="font-mono">asOf</code> mode of{" "}
        <code className="font-mono">POST /api/analyze</code>. Raw results: <code className="font-mono">src/backtest/results.json</code>.
      </footer>
    </main>
  );
}
