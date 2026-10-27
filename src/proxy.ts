// Unknown docket case slugs get a real 404. The page calls notFound() too, but with Cache
// Components the shell has already streamed with HTTP 200 by then.
import { NextResponse, type NextRequest } from "next/server";
import docket from "@/docket/index.json";

const slugs = new Set((docket as { slug: string }[]).map((e) => e.slug));

export function proxy(req: NextRequest) {
  const slug = req.nextUrl.pathname.split("/")[2] ?? "";
  if (slug && !slugs.has(decodeURIComponent(slug))) {
    // Rewrite to a path no route matches: Next serves its not-found page with status 404.
    return NextResponse.rewrite(new URL("/docket-case-not-found", req.url));
  }
  return NextResponse.next();
}

export const config = { matcher: "/docket/:slug" };
