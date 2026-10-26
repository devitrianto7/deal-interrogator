// Simple fixed-window per-IP limiter (in memory, single instance).
const hits = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(ip: string, limit = Number(process.env.RATE_LIMIT_PER_HOUR ?? 10), windowMs = 3_600_000) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now > h.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1 };
  }
  h.count += 1;
  return { ok: h.count <= limit, remaining: Math.max(0, limit - h.count) };
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
}
