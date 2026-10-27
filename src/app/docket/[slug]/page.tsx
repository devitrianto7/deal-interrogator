import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import docket from "@/docket/index.json";
import type { DealReport } from "@/lib/pipeline";
import type { DocketEntry } from "../types";
import { DocketReport } from "./docket-report";

const entries = docket as DocketEntry[];

export function generateStaticParams() {
  return entries.map((e) => ({ slug: e.slug }));
}

export async function generateMetadata({ params }: PageProps<"/docket/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const e = entries.find((x) => x.slug === slug);
  return e
    ? { title: `${e.name}: ${e.verdict} (${e.score}/100) · The Docket`, description: e.signals[0]?.finding }
    : { title: "The Docket" };
}

export default async function DocketCase({ params }: PageProps<"/docket/[slug]">) {
  const { slug } = await params;
  if (!entries.some((e) => e.slug === slug)) notFound();
  const report = (await import(`@/docket/${slug}.json`)).default as DealReport;

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-5 py-10 sm:py-14">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
        <Link href="/docket" className="underline hover:text-ink">
          ← The Docket
        </Link>{" "}
        · Case file
      </p>
      <DocketReport report={report} />
      <footer className="mt-16 border-t border-rule pt-4 text-xs text-muted">
        Snapshot report from The Docket. Not financial advice; read the receipts.
      </footer>
    </main>
  );
}
