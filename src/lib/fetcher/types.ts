// Evidence bundle shapes. Every document keeps its source URL and the exact
// text we fetched, so later quotes can be verified verbatim against it.

export type DocKind = "deal" | "vendor_home" | "vendor_pricing" | "terms" | "refund";

export interface SourceDoc {
  kind: DocKind;
  url: string;
  status: number;
  title: string;
  text: string; // normalized plain text, capped
  chars: number; // length before capping
  fetchedAt: string; // ISO
  error?: string;
  capturedAt?: string; // YYYY-MM-DD of the Wayback capture this text came from (as-of mode, or via "wayback")
  // Live-mode fallback that produced the text: "tinyfish" = TinyFish Fetch rendering,
  // "reader" = r.jina.ai rendering, "wayback" = latest capture.
  via?: "tinyfish" | "reader" | "wayback";
}

export interface DealPlan {
  name: string;
  tier: number | null;
  price: number | null;
  originalPrice: number | null;
  terms: string[];
  features: string[];
}

export interface DealReview {
  id: number | string;
  rating: number | null;
  title: string;
  text: string;
  date: string;
  url?: string;
  sample: "recent" | "critical"; // recent = newest-first page (unbiased); critical = 1-3 star filter
  dealId: number | null; // AppSumo deal id; differs from the current deal for earlier campaigns
}

export interface DealInfo {
  platform: "appsumo" | "generic";
  url: string;
  name: string;
  tagline: string;
  vendorUrl: string | null;
  price: number | null;
  originalPrice: number | null;
  refundableDays: number | null;
  startDate: string | null;
  endDate: string | null;
  purchases: number | null;
  plans: DealPlan[];
  commonFeatures: string[];
  faqs: { q: string; a: string }[];
  reviewStats: { count: number; average: number | null; distribution: Record<string, number> } | null;
  reviews: DealReview[]; // newest first, then critical (<=3) not already included
  relatedDealIds: number[]; // other deal ids seen for the same product (repeat-LTD hint)
}

export interface EvidenceBundle {
  inputUrl: string;
  collectedAt: string;
  deal: DealInfo;
  docs: SourceDoc[];
  warnings: string[];
  // False when the vendor's own official pages (home + terms or pricing) could not be read.
  // Older cached bundles lack it; treat undefined as reached.
  vendorReached?: boolean;
  asOf?: string; // YYYYMMDD: evidence reconstructed from Wayback captures before this day
}
