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
}
