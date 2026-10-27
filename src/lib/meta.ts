import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { costUsd } from "./pricing";
import { assertBudget, basetenBudgetLeft, recordBasetenUsage, recordSpend } from "./budget";
import { wellFormed } from "./fetcher/extract";

export type Role = "judge" | "prosecutor" | "defender" | "extractor";
export type Provider = "meta" | "baseten";

// Decided 2026-10-27: Judge on Muse Wonder; everything else on Muse Spark
// (contributor variant in dev, standard for the demo).
const SPARK = process.env.MODEL_MODE === "demo" ? "muse-spark-1.3" : "muse-spark-1.3-contributor";
export const MODEL_FOR: Record<Role, string> = {
  judge: "muse-wonder-1.0",
  prosecutor: SPARK,
  defender: SPARK,
  extractor: SPARK,
};

// Provider switch for the Spark roles. With BASETEN_API_KEY set, the roles in SPARK_ROLES
// (default: the two advocates) go to Muse Spark Open on Baseten; SPARK_PROVIDER=meta, or no
// key, keeps every call on Meta. The Judge never leaves Meta. Decided 2026-10-27 after an
// A/B on 6 deals: same verdicts, same quote-verification rate, advocates about twice as fast.
export const BASETEN_MODEL = "meta-models/muse-spark-open-1026"; // the key is scoped to exactly this model
const BASETEN_ROLES = new Set(
  (process.env.SPARK_ROLES ?? "prosecutor,defender")
    .split(",")
    .map((s) => s.trim())
    .filter((r) => r && r !== "judge"),
);
export function providerFor(role: Role): Provider {
  return process.env.SPARK_PROVIDER !== "meta" && process.env.BASETEN_API_KEY && BASETEN_ROLES.has(role) ? "baseten" : "meta";
}

const PROVIDER_LABEL: Record<Provider, string> = { meta: "Meta", baseten: "Baseten" };
export const modelLabel = (model: string, provider: Provider) => `${model.replace(/^meta-models\//, "")} (${PROVIDER_LABEL[provider]})`;

let metaClient: OpenAI | null = null;
function getMeta(): OpenAI {
  if (!metaClient) {
    const apiKey = process.env.MODEL_API_KEY;
    if (!apiKey) throw new Error("MODEL_API_KEY is not set");
    // Cap a stalled call: the SDK default is 10 minutes with 2 retries.
    metaClient = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey, timeout: 90_000, maxRetries: 1 });
  }
  return metaClient;
}

let basetenClient: OpenAI | null = null;
function getBaseten(): OpenAI {
  if (!basetenClient) {
    // Retries are done by hand below so invalid JSON gets the same single retry as an HTTP error.
    basetenClient = new OpenAI({ baseURL: "https://inference.baseten.co/v1", apiKey: process.env.BASETEN_API_KEY, timeout: 90_000, maxRetries: 0 });
  }
  return basetenClient;
}

export type CallOptions = {
  maxTokens?: number; // reasoning tokens count toward this, so leave headroom
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "max";
  json?: boolean;
};

export type CallResult = {
  model: string;
  provider: Provider;
  label: string; // "muse-spark-open-1026 (Baseten)"
  text: string;
  usage: OpenAI.Completions.CompletionUsage | undefined;
  costUsd: number; // Meta spend only; Baseten spend is tracked in its own ledger
  basetenUsd: number;
  totalSpentUsd: number;
  fallback?: string; // why a Baseten call ended up on Meta
};

const clean = (messages: ChatCompletionMessageParam[]) =>
  // A lone surrogate (text cut mid-emoji) makes the API reject the whole request as invalid JSON.
  messages.map((m) => (typeof m.content === "string" ? { ...m, content: wellFormed(m.content) } : m));

function isJson(text: string): boolean {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    JSON.parse(t);
    return true;
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return false;
    try {
      JSON.parse(m[0]);
      return true;
    } catch {
      return false;
    }
  }
}

async function callMeta(role: Role, messages: ChatCompletionMessageParam[], opts: CallOptions): Promise<CallResult> {
  await assertBudget();
  const model = MODEL_FOR[role];
  const res = await getMeta().chat.completions.create({
    model,
    messages: clean(messages),
    max_tokens: opts.maxTokens ?? 4000,
    // Same evidence should give the same verdict: keep sampling as deterministic as the API allows.
    temperature: 0,
    seed: 7,
    ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
    ...(opts.json ? { response_format: { type: "json_object" as const } } : {}),
  } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);
  const usd = costUsd(model, res.usage);
  const ledger = await recordSpend(usd);
  return {
    model,
    provider: "meta",
    label: modelLabel(model, "meta"),
    text: res.choices[0]?.message?.content ?? "",
    usage: res.usage,
    costUsd: usd,
    basetenUsd: 0,
    totalSpentUsd: ledger.spentUsd,
  };
}

async function callBaseten(messages: ChatCompletionMessageParam[], opts: CallOptions): Promise<CallResult> {
  const res = await getBaseten().chat.completions.create({
    model: BASETEN_MODEL,
    messages: clean(messages),
    // Muse Spark Open always reasons and reasoning tokens count toward max_tokens: give it headroom.
    max_tokens: Math.round((opts.maxTokens ?? 4000) * 1.5),
    temperature: 0,
    seed: 7,
    ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
    ...(opts.json ? { response_format: { type: "json_object" as const } } : {}),
  } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);
  const usd = costUsd(BASETEN_MODEL, res.usage);
  await recordBasetenUsage(usd, res.usage);
  const choice = res.choices[0];
  const text = choice?.message?.content ?? "";
  if (choice?.finish_reason === "length") throw new Error(`hit max_tokens (${res.usage?.completion_tokens ?? "?"} tokens)`);
  if (opts.json && !isJson(text)) throw new Error("invalid JSON");
  return { model: BASETEN_MODEL, provider: "baseten", label: modelLabel(BASETEN_MODEL, "baseten"), text, usage: res.usage, costUsd: 0, basetenUsd: usd, totalSpentUsd: 0 };
}

export async function callModel(role: Role, messages: ChatCompletionMessageParam[], opts: CallOptions = {}): Promise<CallResult> {
  if (providerFor(role) === "meta") return callMeta(role, messages, opts);
  let why = (await basetenBudgetLeft()) ? "" : "Baseten budget guard reached";
  for (let attempt = 1; attempt <= 2 && !why.startsWith("Baseten budget"); attempt++) {
    try {
      return await callBaseten(messages, opts);
    } catch (e) {
      why = (e as Error).message;
      console.warn(`[baseten] ${role} attempt ${attempt} failed: ${why}`);
    }
  }
  // One retry spent: this call goes to Meta Spark, and the report says so.
  const fallback = `${role}: Baseten failed (${why.slice(0, 160)}); fell back to Meta ${MODEL_FOR[role]}`;
  console.warn(`[fallback] ${fallback}`);
  return { ...(await callMeta(role, messages, opts)), fallback };
}
