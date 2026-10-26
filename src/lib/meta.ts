import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { costUsd } from "./pricing";
import { assertBudget, recordSpend } from "./budget";

export type Role = "judge" | "prosecutor" | "defender" | "extractor";

// Decided 2026-10-27: Judge on Muse Wonder; everything else on Muse Spark
// (contributor variant in dev, standard for the demo).
const SPARK = process.env.MODEL_MODE === "demo" ? "muse-spark-1.3" : "muse-spark-1.3-contributor";
export const MODEL_FOR: Record<Role, string> = {
  judge: "muse-wonder-1.0",
  prosecutor: SPARK,
  defender: SPARK,
  extractor: SPARK,
};

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.MODEL_API_KEY;
    if (!apiKey) throw new Error("MODEL_API_KEY is not set");
    client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey });
  }
  return client;
}

export type CallOptions = {
  maxTokens?: number; // reasoning tokens count toward this, so leave headroom
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "max";
  json?: boolean;
};

export async function callModel(role: Role, messages: ChatCompletionMessageParam[], opts: CallOptions = {}) {
  await assertBudget();
  const model = MODEL_FOR[role];
  const res = await getClient().chat.completions.create({
    model,
    messages,
    max_tokens: opts.maxTokens ?? 4000,
    ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
    ...(opts.json ? { response_format: { type: "json_object" as const } } : {}),
  } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);
  const usd = costUsd(model, res.usage);
  const ledger = await recordSpend(usd);
  return {
    model,
    text: res.choices[0]?.message?.content ?? "",
    usage: res.usage,
    costUsd: usd,
    totalSpentUsd: ledger.spentUsd,
  };
}
