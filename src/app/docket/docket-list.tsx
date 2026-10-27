"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { DocketEntry, Verdict } from "./types";

const TONE: Record<Verdict, string> = { Buy: "text-buy", Wait: "text-wait", Skip: "text-skip", Unverified: "text-muted" };
const BAR: Record<Verdict, string> = { Buy: "bg-buy", Wait: "bg-wait", Skip: "bg-skip", Unverified: "bg-muted" };

export function DocketList({ entries }: { entries: DocketEntry[] }) {
  const [filter, setFilter] = useState<Verdict | "All">("All");
  const [sort, setSort] = useState<"risk-desc" | "risk-asc" | "name">("risk-desc");
  const [q, setQ] = useState("");

  const chips: (Verdict | "All")[] = ["All", "Buy", "Wait", "Skip"];
  if (entries.some((e) => e.verdict === "Unverified")) chips.push("Unverified");

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = entries.filter(
      (e) => (filter === "All" || e.verdict === filter) && (!needle || e.name.toLowerCase().includes(needle)),
    );
    return [...list].sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name) : sort === "risk-asc" ? a.score - b.score : b.score - a.score,
    );
  }, [entries, filter, sort, q]);

  return (
    <section className="mt-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2 text-sm">
          {chips.map((v) => (
            <button
              key={v}
              onClick={() => setFilter(v)}
              aria-pressed={filter === v}
              className={`rounded-full border px-3 py-1 ${
                filter === v ? "border-ink bg-ink text-paper" : "border-rule bg-white hover:border-ink"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="flex gap-2 text-sm">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search deals"
            className="w-40 rounded-md border border-rule bg-white px-3 py-1.5 outline-none focus:border-ink"
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            className="rounded-md border border-rule bg-white px-2 py-1.5"
            aria-label="Sort"
          >
            <option value="risk-desc">Riskiest first</option>
            <option value="risk-asc">Safest first</option>
            <option value="name">Name A-Z</option>
          </select>
        </div>
      </div>

      <p className="mt-4 font-mono text-[11px] uppercase tracking-wide text-muted">{rows.length} cases</p>
      <ol className="mt-2 divide-y divide-rule rounded-lg border border-rule bg-white">
        {rows.map((e) => (
          <li key={e.slug}>
            <Link href={`/docket/${e.slug}`} className="flex gap-4 p-4 hover:bg-paper sm:p-5">
              <div className="w-14 shrink-0 text-right">
                <span className="font-serif text-3xl leading-none">{e.score}</span>
                <div className="mt-1.5 h-1 overflow-hidden rounded bg-rule">
                  <div className={`h-full ${BAR[e.verdict]}`} style={{ width: `${e.score}%` }} />
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h2 className="font-serif text-lg leading-snug">{e.name}</h2>
                  <span className={`font-mono text-xs font-bold uppercase tracking-widest ${TONE[e.verdict]}`}>
                    {e.verdict}
                  </span>
                </div>
                <p className="mt-0.5 font-mono text-[11px] text-muted">
                  {e.price != null ? `$${e.price}` : "price n/a"}
                  {e.reviews ? ` · ${e.reviews} reviews${e.rating ? `, ${e.rating}/5` : ""}` : ""}
                  {" · court: "}
                  <span className="text-skip">{e.court.contradicted} contradicted</span>
                  {" · "}
                  <span className="text-buy">{e.court.confirmed} confirmed</span>
                  {` · ${e.court.unverifiable} unverifiable`}
                </p>
                {e.signals.length > 0 && (
                  <ul className="mt-2 space-y-1.5">
                    {e.signals.map((s) => (
                      <li key={s.label} className="text-sm">
                        <span className="font-mono text-xs">
                          {s.points}/{s.max}
                        </span>{" "}
                        <span className="font-semibold">{s.label}</span>
                        {s.quote && (
                          <q className="ml-1 font-serif text-[14px] text-muted">
                            {s.quote.length > 160 ? `${s.quote.slice(0, 157)}…` : s.quote}
                          </q>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {e.verdictNote && <p className="mt-2 text-xs text-wait">{e.verdictNote}</p>}
              </div>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
