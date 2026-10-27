"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { DealReport } from "@/lib/pipeline";
import { ReportView } from "./report";

const DEMOS = [
  { name: "TinyEmail", url: "https://appsumo.com/products/tinyemail/" },
  { name: "SheetXAI", url: "https://appsumo.com/products/sheetxai/" },
  { name: "ChatPlayground AI", url: "https://appsumo.com/products/chatplayground-ai/" },
];

const STAGES = [
  "Collecting the deal page, vendor pricing, terms and refund policy",
  "Extracting the seller's claims and the vendor's fine print",
  "Mining buyer reviews for patterns",
  "Checking domain age (RDAP) and first Wayback capture",
  "Prosecution and defense are building their cases",
  "The judge is ruling on verified exhibits only",
];

type Result = (DealReport & { cached?: boolean; generatedAt?: string }) | null;

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Result>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);

  async function run(target: string, fresh = false) {
    const u = target.trim();
    if (!u) return;
    setUrl(u);
    setLoading(true);
    setError(null);
    setReport(null);
    setStage(0);
    timer.current = setInterval(() => setStage((s) => Math.min(s + 1, STAGES.length - 1)), 8000);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: u, fresh }),
      });
      const body = await res.json();
      if (!res.ok) {
        const msg =
          res.status === 429
            ? "Rate limit reached for this hour. Try one of the demo deals, which are cached."
            : res.status === 402
              ? "The demo's model budget is used up."
              : body.error || `Request failed (${res.status}).`;
        throw new Error(msg);
      }
      setReport(body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (timer.current) clearInterval(timer.current);
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-5 py-10 sm:py-14">
      <header className="mb-8">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">Case file · Lifetime deal due diligence</p>
        <h1 className="mt-2 font-serif text-4xl sm:text-5xl">Deal Interrogator</h1>
        <p className="mt-3 max-w-2xl text-muted">
          Paste a lifetime-deal URL. We put the seller&apos;s claims on trial against the vendor&apos;s own pricing, terms
          and refund policy, and what buyers say in reviews. Every point in the score carries a quote checked word for
          word against its source.
        </p>
        <p className="mt-3 text-sm">
          <Link href="/docket" className="font-semibold underline hover:text-muted">
            Browse The Docket →
          </Link>{" "}
          <span className="text-muted">about 200 live AppSumo deals, already judged.</span>
        </p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(url);
        }}
        className="flex flex-col gap-2 sm:flex-row"
      >
        <input
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://appsumo.com/products/..."
          className="min-w-0 flex-1 rounded-md border border-rule bg-white px-4 py-3 font-mono text-sm outline-none focus:border-ink"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-md bg-ink px-6 py-3 text-sm font-semibold text-paper disabled:opacity-50"
        >
          {loading ? "Interrogating…" : "Interrogate"}
        </button>
      </form>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Demo cases:</span>
        {DEMOS.map((d) => (
          <button
            key={d.url}
            disabled={loading}
            onClick={() => run(d.url)}
            className="rounded-full border border-rule bg-white px-3 py-1 hover:border-ink disabled:opacity-50"
          >
            {d.name}
          </button>
        ))}
      </div>

      {loading && (
        <section className="mt-10 rounded-lg border border-rule bg-white p-6">
          <div className="indeterminate relative h-1 overflow-hidden rounded bg-rule" />
          <ol className="mt-5 space-y-2 text-sm">
            {STAGES.map((s, i) => (
              <li key={s} className={i < stage ? "text-muted line-through" : i === stage ? "font-semibold" : "text-muted/60"}>
                <span className="mr-2 font-mono text-xs">{String(i + 1).padStart(2, "0")}</span>
                {s}
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs text-muted">A fresh case takes about a minute.</p>
        </section>
      )}

      {error && <p className="mt-8 rounded-md border border-skip/40 bg-white p-4 text-sm text-skip">{error}</p>}

      {report && <ReportView report={report} onRerun={() => run(report.deal.url, true)} />}

      <footer className="mt-16 border-t border-rule pt-4 text-xs text-muted">
        Built for the Meta AI Developer Hackathon on Muse Spark and Muse Wonder. Not financial advice; read the receipts.
      </footer>
    </main>
  );
}
