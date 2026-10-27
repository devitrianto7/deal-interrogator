"use client";

import { useState } from "react";
import type { DealReport } from "@/lib/pipeline";
import { ReportView } from "../../report";

type Report = DealReport & { cached?: boolean; generatedAt?: string };

export function DocketReport({ report: initial }: { report: Report }) {
  const [report, setReport] = useState<Report>({ ...initial, cached: true });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rerun() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: report.deal.url, fresh: true }),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(
          res.status === 429
            ? "Rate limit reached for this hour."
            : res.status === 402
              ? "The demo's model budget is used up."
              : body.error || `Request failed (${res.status}).`,
        );
      }
      setReport(body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {loading && (
        <section className="mt-6 rounded-lg border border-rule bg-white p-5">
          <div className="indeterminate relative h-1 overflow-hidden rounded bg-rule" />
          <p className="mt-3 text-sm text-muted">Re-trying the case live. A fresh run takes about a minute.</p>
        </section>
      )}
      {error && <p className="mt-6 rounded-md border border-skip/40 bg-white p-4 text-sm text-skip">{error}</p>}
      <ReportView report={report} onRerun={rerun} />
    </>
  );
}
