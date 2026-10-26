// Verbatim quote check. A quote counts only if it appears in the fetched source
// text after light normalization (case, whitespace, curly quotes, dashes).
// Quotes with "..." must match every part, in order.

const MIN_QUOTE_CHARS = 12;

export function normQ(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201B\u2032`]/g, "'")
    .replace(/[\u201C\u201D\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[*_#>]+/g, " ") // markdown marks we add when rendering text
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export interface QuoteCheck {
  verified: boolean;
  offset: number; // index of the first part in the normalized source, -1 if not found
  reason?: string;
}

export function verifyQuote(quote: string, source: string, normalizedSource?: string): QuoteCheck {
  const q = normQ(quote).replace(/^["']+|["']+$/g, "").trim();
  if (q.length < MIN_QUOTE_CHARS) return { verified: false, offset: -1, reason: "too short" };
  const src = normalizedSource ?? normQ(source);
  const parts = q.split(/\s*\.\.\.+\s*|\s*\[\.\.\.\]\s*/).map((p) => p.trim()).filter(Boolean);
  let from = 0;
  let first = -1;
  for (const part of parts) {
    if (part.length < 4) continue;
    const at = src.indexOf(part, from);
    if (at < 0) return { verified: false, offset: -1, reason: `not found: "${part.slice(0, 60)}"` };
    if (first < 0) first = at;
    from = at + part.length;
  }
  return first < 0 ? { verified: false, offset: -1, reason: "empty" } : { verified: true, offset: first };
}
