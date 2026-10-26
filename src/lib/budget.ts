import { promises as fs } from "fs";
import path from "path";

// Meta Model API has no hard spend cap, so we enforce one here.
// Ledger is a local JSON file; good enough for a single instance.
const LEDGER = path.join(process.cwd(), ".data", "usage.json");
export const BUDGET_USD = Number(process.env.BUDGET_USD ?? 140);

type Ledger = { spentUsd: number; calls: number; updatedAt: string };

async function read(): Promise<Ledger> {
  try {
    return JSON.parse(await fs.readFile(LEDGER, "utf8")) as Ledger;
  } catch {
    return { spentUsd: 0, calls: 0, updatedAt: new Date().toISOString() };
  }
}

export async function getSpend(): Promise<Ledger> {
  return read();
}

export class BudgetExceededError extends Error {
  constructor(spent: number) {
    super(`Budget guard: $${spent.toFixed(4)} spent of $${BUDGET_USD} cap. Refusing new model calls.`);
    this.name = "BudgetExceededError";
  }
}

export async function assertBudget(): Promise<void> {
  const l = await read();
  if (l.spentUsd >= BUDGET_USD) throw new BudgetExceededError(l.spentUsd);
}

let queue: Promise<unknown> = Promise.resolve();
export function recordSpend(usd: number): Promise<Ledger> {
  const job = queue.then(async () => {
    const l = await read();
    l.spentUsd += usd;
    l.calls += 1;
    l.updatedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(LEDGER), { recursive: true });
    await fs.writeFile(LEDGER, JSON.stringify(l, null, 2));
    return l;
  });
  queue = job.catch(() => undefined);
  return job;
}
