export type Verdict = "Buy" | "Wait" | "Skip" | "Unverified";

export type DocketEntry = {
  slug: string;
  name: string;
  url: string;
  score: number;
  verdict: Verdict;
  verdictNote: string | null;
  signals: {
    label: string;
    points: number;
    max: number;
    finding: string;
    quote: string | null;
    source: string | null;
    sourceUrl: string | null;
  }[];
  court: { confirmed: number; contradicted: number; unverifiable: number };
  price: number | null;
  originalPrice: number | null;
  reviews: number | null;
  rating: number | null;
  generatedAt: string | null;
};
