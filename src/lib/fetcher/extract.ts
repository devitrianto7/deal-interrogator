// HTML -> readable plain text, plus link discovery.
import * as cheerio from "cheerio";

export const MAX_DOC_CHARS = 60_000;

export function htmlToText(html: string): { title: string; text: string } {
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim() || $("h1").first().text().trim();
  const metaDesc = $('meta[name="description"]').attr("content")?.trim() ?? "";
  $("script, style, noscript, svg, iframe, template, form, nav, footer, [role=navigation], [aria-hidden=true]").remove();
  const main = $("main").first();
  const root = main.length && main.text().trim().length > 500 ? main : $("body");

  const blocks = "h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,blockquote,pre,div,section,article,tr,br";
  root.find(blocks).each((_, el) => {
    const tag = (el as { tagName?: string }).tagName?.toLowerCase() ?? "";
    const prefix = /^h[1-6]$/.test(tag) ? "\n\n" + "#".repeat(Number(tag[1])) + " " : tag === "li" ? "\n- " : "\n";
    $(el).prepend(prefix);
    $(el).append("\n");
  });
  let text = normalize(root.text());
  if (text.length < 200 && metaDesc) text = normalize(`${metaDesc}\n${text}`);
  return { title, text };
}

export function normalize(s: string): string {
  return s
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function cap(text: string, max = MAX_DOC_CHARS): string {
  return text.length > max ? text.slice(0, max) + "\n[...truncated]" : text;
}

export interface FoundLink {
  href: string;
  text: string;
}

export function extractLinks(html: string, base: string): FoundLink[] {
  const $ = cheerio.load(html);
  const out: FoundLink[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, el) => {
    const raw = $(el).attr("href") ?? "";
    if (raw.startsWith("#") || raw.startsWith("mailto:") || raw.startsWith("javascript:")) return;
    try {
      const u = new URL(raw, base);
      u.hash = "";
      const href = u.toString();
      if (seen.has(href)) return;
      seen.add(href);
      out.push({ href, text: $(el).text().replace(/\s+/g, " ").trim() });
    } catch {
      /* ignore bad hrefs */
    }
  });
  return out;
}

export function stripHtml(s: string): string {
  return normalize(cheerio.load(`<div>${s}</div>`)("div").text());
}
