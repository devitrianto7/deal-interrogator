import { callModel, type Role } from "@/lib/meta";
import { BUDGET_USD, BudgetExceededError, getSpend } from "@/lib/budget";
import { clientIp, rateLimit } from "@/lib/ratelimit";


// GET /api/ping : one tiny call to the Spark role and the Wonder (judge) role.
export async function GET(req: Request) {
  const rl = rateLimit(clientIp(req));
  if (!rl.ok) return Response.json({ error: "rate_limited" }, { status: 429 });

  try {
    const roles: Role[] = ["extractor", "judge"];
    const results = [];
    for (const role of roles) {
      const r = await callModel(role, [{ role: "user", content: "Reply with exactly: OK" }], {
        maxTokens: 200,
        reasoningEffort: "minimal",
      });
      results.push({ role, model: r.model, reply: r.text, costUsd: r.costUsd });
    }
    const spend = await getSpend();
    return Response.json({ ok: true, results, spentUsd: spend.spentUsd, budgetUsd: BUDGET_USD });
  } catch (e) {
    if (e instanceof BudgetExceededError) return Response.json({ error: e.message }, { status: 402 });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
