"use client";

import type { DealReport } from "@/lib/pipeline";
import type { SignalScore, Evidence } from "@/lib/score";
import type { ClaimTrial, Exhibit } from "@/lib/courtroom";

type Report = DealReport & { cached?: boolean; generatedAt?: string };

const VERDICT_STYLE = {
  Buy: { color: "text-buy", bg: "bg-buy", line: "Low risk on the evidence we could read." },
  Wait: { color: "text-wait", bg: "bg-wait", line: "Real concerns. Read the receipts before you buy." },
  Skip: { color: "text-skip", bg: "bg-skip", line: "The evidence points against this deal." },
  Unverified: { color: "text-muted", bg: "bg-muted", line: "Not enough evidence: we could not reach the vendor's own site." },
} as const;

const RULING_STYLE = {
  confirmed: "bg-buy text-white",
  contradicted: "bg-skip text-white",
  unverifiable: "bg-rule text-ink",
} as const;

const SOURCE_LABEL: Record<string, string> = {
  deal: "Deal page",
  terms: "Terms",
  refund: "Refund policy",
  vendor_pricing: "Vendor pricing",
  vendor_home: "Vendor site",
  review: "Review",
  rdap: "RDAP",
  stats: "Review stats",
  wayback: "Wayback",
};

function host(u?: string) {
  try {
    return u ? new URL(u).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

function Receipt({ e }: { e: Evidence }) {
  return (
    <li className="border-l-2 border-rule pl-3">
      {["rdap", "wayback", "stats"].includes(e.source) ? (
        <span className="text-[15px]">{e.quote}</span>
      ) : (
        <q className="font-serif text-[15px] leading-snug">{e.quote}</q>
      )}
      <div className="mt-1 font-mono text-[11px] uppercase tracking-wide text-muted">
        {SOURCE_LABEL[e.source] ?? e.source}
        {e.url && (
          <>
            {" · "}
            <a href={e.url} target="_blank" rel="noreferrer" className="underline hover:text-ink">
              {host(e.url)}
            </a>
          </>
        )}
      </div>
    </li>
  );
}

function SignalRow({ s }: { s: SignalScore }) {
  const pct = (s.points / s.max) * 100;
  const tone = pct >= 70 ? "bg-skip" : pct > 0 ? "bg-wait" : "bg-buy";
  return (
    <details className="group border-b border-rule py-4 last:border-0" open={s.points > 0 && s.evidence.length > 0}>
      <summary className="flex cursor-pointer list-none items-start gap-4">
        <div className="w-14 shrink-0 pt-0.5 text-right font-mono text-sm">
          <span className="font-semibold">{s.points}</span>
          <span className="text-muted">/{s.max}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{s.label}</span>
            {!s.checked && (
              <span className="rounded bg-rule px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide">not checked</span>
            )}
          </div>
          <div className="mt-1.5 h-1.5 w-full max-w-xs overflow-hidden rounded bg-rule">
            <div className={`h-full ${tone}`} style={{ width: `${Math.max(pct, s.points ? 4 : 0)}%` }} />
          </div>
          <p className="mt-2 text-sm text-muted">{s.finding}</p>
        </div>
        {s.evidence.length > 0 && (
          <span className="shrink-0 font-mono text-xs text-muted group-open:hidden">{s.evidence.length} receipts ▸</span>
        )}
      </summary>
      {s.evidence.length > 0 && (
        <ul className="mt-3 ml-18 space-y-3">
          {s.evidence.map((e, i) => (
            <Receipt key={i} e={e} />
          ))}
        </ul>
      )}
    </details>
  );
}

function ExhibitCard({ x, cited }: { x: Exhibit; cited: boolean }) {
  return (
    <li className={`rounded-md border bg-white p-3 ${cited ? "border-ink" : "border-rule opacity-80"}`}>
      <div className="mb-1 flex items-center justify-between font-mono text-[11px] uppercase tracking-wide text-muted">
        <span>
          {x.id} · {SOURCE_LABEL[x.source] ?? x.source}
          {x.reviewRating ? ` · ${x.reviewRating}★` : ""}
        </span>
        {cited && <span className="text-ink">cited by judge</span>}
      </div>
      <q className="font-serif text-[15px] leading-snug">{x.quote}</q>
      {x.argument && <p className="mt-1.5 text-xs text-muted">{x.argument}</p>}
      <a href={x.url} target="_blank" rel="noreferrer" className="mt-1 inline-block font-mono text-[11px] text-muted underline">
        {host(x.url)}
      </a>
    </li>
  );
}

function Trial({ t }: { t: ClaimTrial }) {
  const pros = t.exhibits.filter((e) => e.side === "prosecution");
  const def = t.exhibits.filter((e) => e.side === "defense");
  return (
    <article className="rounded-lg border border-rule bg-paper p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] uppercase tracking-wide text-muted">
            Claim {t.claimId} · {t.category}
          </p>
          <h3 className="mt-1 font-serif text-lg leading-snug">{t.claim}</h3>
          <p className="mt-1 text-sm text-muted">
            Seller&apos;s words: <q className="italic">{t.claimQuote}</q>
          </p>
        </div>
        <span className={`rounded px-2.5 py-1 font-mono text-xs font-semibold uppercase tracking-wider ${RULING_STYLE[t.ruling]}`}>
          {t.ruling}
        </span>
      </div>
      <p className="mt-3 border-l-2 border-ink pl-3 text-sm">
        <span className="font-semibold">Ruling: </span>
        {t.reasoning}
      </p>
      {t.overruled && <p className="mt-2 text-xs text-wait">Overruled by the rules of evidence: {t.overruled}</p>}
      {(pros.length > 0 || def.length > 0) && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <p className="mb-2 font-mono text-[11px] uppercase tracking-wide text-skip">Prosecution · against</p>
            {pros.length ? (
              <ul className="space-y-2">
                {pros.map((x) => (
                  <ExhibitCard key={x.id} x={x} cited={t.cited.includes(x.id)} />
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted">No admitted exhibits.</p>
            )}
          </div>
          <div>
            <p className="mb-2 font-mono text-[11px] uppercase tracking-wide text-buy">Defense · for</p>
            {def.length ? (
              <ul className="space-y-2">
                {def.map((x) => (
                  <ExhibitCard key={x.id} x={x} cited={t.cited.includes(x.id)} />
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted">No admitted exhibits.</p>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

function ScoreBar({ score }: { score: number }) {
  return (
    <div className="mt-4 max-w-md">
      <div className="relative h-2.5 overflow-hidden rounded-full">
        <div className="absolute inset-y-0 left-0 w-[31%] bg-buy/25" />
        <div className="absolute inset-y-0 left-[31%] w-[30%] bg-wait/25" />
        <div className="absolute inset-y-0 left-[61%] right-0 bg-skip/25" />
        <div className="absolute inset-y-0 w-1 -translate-x-1/2 rounded bg-ink" style={{ left: `${score}%` }} />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] uppercase tracking-wide text-muted">
        <span>0 Buy</span>
        <span>31 Wait</span>
        <span>61 Skip</span>
        <span>100</span>
      </div>
    </div>
  );
}

export function ReportView({ report, onRerun }: { report: Report; onRerun: () => void }) {
  const { deal, risk, courtroom, reviews, trace } = report;
  const v = VERDICT_STYLE[risk.verdict];
  const counts = courtroom.trials.reduce(
    (a, t) => ({ ...a, [t.ruling]: (a[t.ruling] ?? 0) + 1 }),
    {} as Record<string, number>,
  );
  const negThemes = reviews.themes.filter((t) => t.polarity === "negative" && t.hits.length);
  const posThemes = reviews.themes.filter((t) => t.polarity === "positive" && t.hits.length);

  return (
    <div className="mt-10 space-y-10">
      {/* Verdict */}
      <section className="rounded-lg border border-rule bg-white p-6 sm:p-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">The verdict on</p>
            <h2 className="mt-1 font-serif text-3xl">{deal.name}</h2>
            {deal.tagline && <p className="mt-1 text-muted">{deal.tagline}</p>}
            <p className="mt-3 text-sm">
              {deal.price != null && <span className="font-semibold">${deal.price}</span>}
              {deal.originalPrice ? <span className="text-muted"> · stated regular ${deal.originalPrice}</span> : null}
              {deal.refundableDays ? <span className="text-muted"> · {deal.refundableDays}-day marketplace refund</span> : null}
            </p>
            <div className="mt-5 flex items-end gap-3">
              <span className="font-serif text-6xl leading-none">{risk.score}</span>
              <span className="pb-1 text-muted">/ 100 risk</span>
            </div>
            <ScoreBar score={risk.score} />
          </div>
          <div className="flex shrink-0 flex-col items-start sm:items-end">
            <span className={`stamp rounded-md px-5 py-2 font-mono text-3xl font-bold uppercase ${v.color}`}>{risk.verdict}</span>
            <p className="mt-4 max-w-56 text-sm text-muted sm:text-right">{v.line}</p>
          </div>
        </div>
        {risk.verdictNote && (
          <p className="mt-6 rounded-md border border-wait/40 bg-wait/5 p-3 text-sm text-wait">{risk.verdictNote}</p>
        )}
        {courtroom.trials.length > 0 && (
          <p className="mt-6 text-sm">
            <span className="font-semibold">On trial: </span>
            {courtroom.trials.length} key claims ·{" "}
            <span className="text-skip">{counts.contradicted ?? 0} contradicted</span> ·{" "}
            <span className="text-buy">{counts.confirmed ?? 0} confirmed</span> · {counts.unverifiable ?? 0} unverifiable
          </p>
        )}
      </section>

      {/* Score breakdown */}
      <section>
        <h2 className="font-serif text-2xl">Why this score</h2>
        <p className="mt-1 text-sm text-muted">
          Eight signals, scored by fixed rules in code. The model only finds and quotes evidence; it never sets points.
        </p>
        <div className="mt-4 rounded-lg border border-rule bg-white px-5">
          {risk.signals.map((s) => (
            <SignalRow key={s.key} s={s} />
          ))}
        </div>
      </section>

      {/* Courtroom */}
      {courtroom.trials.length > 0 && (
        <section>
          <h2 className="font-serif text-2xl">The cross-examination</h2>
          <p className="mt-1 text-sm text-muted">
            A prosecutor argues against each claim, a defender argues for it, and a judge rules only on exhibits whose
            quotes were found word for word in the source. A ruling with no verified exhibit is thrown out.
          </p>
          <div className="mt-4 space-y-4">
            {courtroom.trials.map((t) => (
              <Trial key={t.claimId} t={t} />
            ))}
          </div>
        </section>
      )}

      {/* Reviews */}
      {reviews.stats && (
        <section>
          <h2 className="font-serif text-2xl">What buyers say</h2>
          <p className="mt-1 text-sm text-muted">
            {reviews.stats.count} reviews, {reviews.stats.average}/5 all-time. {reviews.trend.note}
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {[
              { title: "Complaints", list: negThemes, tone: "text-skip" },
              { title: "Praise", list: posThemes, tone: "text-buy" },
            ].map((col) => (
              <div key={col.title} className="rounded-lg border border-rule bg-white p-5">
                <p className={`font-mono text-[11px] uppercase tracking-wide ${col.tone}`}>{col.title}</p>
                {col.list.length ? (
                  <ul className="mt-3 space-y-4">
                    {col.list.map((t) => (
                      <li key={t.theme}>
                        <p className="text-sm font-semibold">
                          {t.theme.replace(/_/g, " ")} <span className="font-normal text-muted">· {t.hits.length}</span>
                        </p>
                        <p className="text-sm text-muted">{t.summary}</p>
                        {t.hits[0] && (
                          <q className="mt-1 block font-serif text-[14px] leading-snug">
                            {t.hits[0].quote}
                            {t.hits[0].rating ? ` (${t.hits[0].rating}★)` : ""}
                          </q>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-sm text-muted">None found.</p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Sources */}
      <section>
        <h2 className="font-serif text-2xl">Sources read</h2>
        <ul className="mt-3 space-y-1.5 text-sm">
          {report.sources.map((s) => (
            <li key={s.url} className="flex gap-3">
              <span className="w-28 shrink-0 font-mono text-[11px] uppercase tracking-wide text-muted">
                {SOURCE_LABEL[s.kind] ?? s.kind}
              </span>
              <a href={s.url} target="_blank" rel="noreferrer" className="min-w-0 truncate underline">
                {s.url}
              </a>
              {"via" in s && s.via && (
                <span className="shrink-0 font-mono text-[11px] text-muted">
                  {s.via === "reader" ? "via reader" : `archived ${"capturedAt" in s ? s.capturedAt : ""}`}
                </span>
              )}
            </li>
          ))}
          {trace?.registered && (
            <li className="flex gap-3">
              <span className="w-28 shrink-0 font-mono text-[11px] uppercase tracking-wide text-muted">RDAP</span>
              <a href={trace.rdapUrl} target="_blank" rel="noreferrer" className="underline">
                {trace.domain} registered {trace.registered}
              </a>
            </li>
          )}
          {trace?.firstSnapshotUrl && (
            <li className="flex gap-3">
              <span className="w-28 shrink-0 font-mono text-[11px] uppercase tracking-wide text-muted">Wayback</span>
              <a href={trace.firstSnapshotUrl} target="_blank" rel="noreferrer" className="underline">
                First capture {trace.firstSnapshot}
              </a>
            </li>
          )}
        </ul>
        {risk.coverage.missing.length > 0 && (
          <p className="mt-3 text-xs text-wait">Could not read: {risk.coverage.missing.join(", ")}.</p>
        )}
      </section>

      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-muted">
        <span>
          {report.cached ? "Cached report" : "Fresh run"}
          {report.generatedAt ? ` · ${new Date(report.generatedAt).toLocaleString()}` : ""}
        </span>
        <span>Model cost ${report.costUsd.toFixed(4)}</span>
        {courtroom.models && <span>Judge {courtroom.models.judge} · Advocates {courtroom.models.prosecutor}</span>}
        <span>{(report.ms / 1000).toFixed(0)}s</span>
        <span>{report.dropped.length + courtroom.droppedExhibits.length} unverifiable quotes discarded</span>
        <button onClick={onRerun} className="underline hover:text-ink">
          Run fresh
        </button>
      </p>
    </div>
  );
}
