export default function Home() {
  return (
    <main className="mx-auto flex max-w-2xl flex-1 flex-col justify-center gap-4 p-8">
      <h1 className="text-3xl font-semibold">Deal Interrogator</h1>
      <p className="text-neutral-600">
        Paste a lifetime-deal URL. We cross-examine the vendor&apos;s claims against their own pages, fine print, and
        reviews, then rule Buy / Wait / Skip with a quoted receipt for every point.
      </p>
      <p className="text-sm text-neutral-500">S0 scaffold. Health check: /api/ping</p>
    </main>
  );
}
