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

// Baseten spend has its own ledger and cap so it never counts against the Meta guard above.
// Credit is prepaid ($100), so the cap only stops a runaway loop; at the cap calls fall back to Meta.
const BASETEN_LEDGER = path.join(process.cwd(), ".data", "usage-baseten.json");
export const BASETEN_BUDGET_USD = Number(process.env.BASETEN_BUDGET_USD ?? 50);

type BasetenLedger = Ledger & { promptTokens: number; completionTokens: number; reasoningTokens: number };
type TokenUsage = { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } | null };

async function readBaseten(): Promise<BasetenLedger> {
  try {
    return JSON.parse(await fs.readFile(BASETEN_LEDGER, "utf8")) as BasetenLedger;
  } catch {
    return { spentUsd: 0, calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, updatedAt: new Date().toISOString() };
  }
}

export const getBasetenSpend = readBaseten;

export async function basetenBudgetLeft(): Promise<boolean> {
  return (await readBaseten()).spentUsd < BASETEN_BUDGET_USD;
}

export function recordBasetenUsage(usd: number, usage: TokenUsage | undefined | null): Promise<BasetenLedger> {
  const job = queue.then(async () => {
    const l = await readBaseten();
    l.spentUsd += usd;
    l.calls += 1;
    l.promptTokens += usage?.prompt_tokens ?? 0;
    l.completionTokens += usage?.completion_tokens ?? 0;
    l.reasoningTokens += usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    l.updatedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(BASETEN_LEDGER), { recursive: true });
    await fs.writeFile(BASETEN_LEDGER, JSON.stringify(l, null, 2));
    return l;
  });
  queue = job.catch(() => undefined);
  return job;
}
