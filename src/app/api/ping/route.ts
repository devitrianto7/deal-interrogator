import { callModel, type Role } from "@/lib/meta";
import { BUDGET_USD, BudgetExceededError, getBasetenSpend, getSpend } from "@/lib/budget";
import { clientIp, rateLimit } from "@/lib/ratelimit";


// GET /api/ping : one tiny call each to an extractor, an advocate (Baseten when switched on) and the judge.
export async function GET(req: Request) {
  const rl = rateLimit(clientIp(req));
  if (!rl.ok) return Response.json({ error: "rate_limited" }, { status: 429 });

  try {
    const roles: Role[] = ["extractor", "prosecutor", "judge"];
    const results = [];
    for (const role of roles) {
      const r = await callModel(role, [{ role: "user", content: "Reply with exactly: OK" }], {
        maxTokens: 200,
        reasoningEffort: "minimal",
      });
      results.push({ role, model: r.label, reply: r.text, costUsd: r.costUsd, basetenUsd: r.basetenUsd, ...(r.fallback ? { fallback: r.fallback } : {}) });
    }
    const spend = await getSpend();
    const baseten = await getBasetenSpend();
    return Response.json({ ok: true, results, spentUsd: spend.spentUsd, budgetUsd: BUDGET_USD, basetenSpentUsd: baseten.spentUsd });
  } catch (e) {
    if (e instanceof BudgetExceededError) return Response.json({ error: e.message }, { status: 402 });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
