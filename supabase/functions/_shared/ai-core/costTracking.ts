// supabase/functions/_shared/ai-core/costTracking.ts
//
// Vireek AI Core — Cost Management. Converts raw token counts into a
// dollar figure, writes every AI Core call to `ai_usage_logs` for the
// Cost dashboard, and enforces the per-account monthly budget cap in
// `ai_budget_limits` (if that account has one).
//
// This is the ONLY file that knows $/token pricing and the ONLY file
// that writes ai_usage_logs, so every number on the dashboard comes
// from one code path.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import type { NormalizedChatRequest, NormalizedChatResponse, ProviderId, TaskType } from "./types.ts";
import { AiCoreError } from "./types.ts";
import type { RouteChatResult } from "./router.ts";
import { isOptionalAiTask } from "../billing/costPolicy.ts";
import { appendCostEvent, usdEvent, type LedgerCorrelation } from "../economics/ledgerWriter.ts";
  cohere: {
    // command-r-plus (آداپتور پیش‌فرض). منابع عمومی قیمت‌ها را متفاوت گزارش می‌کنند؛ پیش‌فرض محافظه‌کارانه.
    // قبل از اتکا، cohere.com/pricing را بررسی و در صورت نیاز با AI_PRICE_OVERRIDES_JSON اصلاح کنید.
    default: { inputPer1M: 2.5, outputPer1M: 10.0 },
  },
  openrouter: {

// ---------------------------------------------------------------------
// Pricing — $ per 1,000,000 tokens. Approximate list prices at the time
// this file was written. OpenRouter/Cloudflare route to many different
// underlying models, so their numbers are rough blended estimates, not
// billing-grade truth. Override without a redeploy via the Supabase
// secret AI_PRICE_OVERRIDES_JSON (a JSON blob shaped like PRICE_TABLE,
// merged on top of these defaults).
// ---------------------------------------------------------------------

interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
}

type ProviderPriceMap = Record<string, ModelPrice> & { default: ModelPrice };

const PRICE_TABLE: Record<ProviderId, ProviderPriceMap> = {
  anthropic: {
    default: { inputPer1M: 3.0, outputPer1M: 15.0 },
    "claude-sonnet-5": { inputPer1M: 3.0, outputPer1M: 15.0 },
    "claude-haiku-4-5-20251001": { inputPer1M: 0.8, outputPer1M: 4.0 },
  },
  gemini: {
    default: { inputPer1M: 0.3, outputPer1M: 2.5 },
    "gemini-2.5-flash": { inputPer1M: 0.3, outputPer1M: 2.5 },
  },
  groq: {
    default: { inputPer1M: 0.59, outputPer1M: 0.79 },
    "llama-3.3-70b-versatile": { inputPer1M: 0.59, outputPer1M: 0.79 },
  },
  cerebras: {
    default: { inputPer1M: 0.6, outputPer1M: 0.6 },
  },
  cloudflare: {
    // Workers AI بر اساس "neuron" قیمت‌گذاری می‌شه نه $/token، پس تبدیل دقیقی
    // وجود نداره — این‌جا صفر می‌ذاریم تا هزینه‌ی ساختگی نمایش داده نشه.
    default: { inputPer1M: 0, outputPer1M: 0 },
  },
  openrouter: {
    // "openrouter/auto" هر بار می‌تونه یک مدل زیرین متفاوت انتخاب کنه که این
    // آداپتور فعلاً برنمی‌گردونه — این یک تخمین میانگین تقریبیه.
    default: { inputPer1M: 1.0, outputPer1M: 3.0 },
  },
};

function loadOverrides(): Partial<Record<ProviderId, Partial<ProviderPriceMap>>> {
  try {
    const raw = Deno.env.get("AI_PRICE_OVERRIDES_JSON");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function getPrice(provider: ProviderId, model: string): ModelPrice {
  const overrides = loadOverrides();
  const table = { ...PRICE_TABLE[provider], ...(overrides[provider] ?? {}) } as ProviderPriceMap;
  return table[model] ?? table.default;
}

export function estimateCost(provider: ProviderId, model: string, inputTokens: number, outputTokens: number): number {
  const price = getPrice(provider, model);
  return (inputTokens / 1_000_000) * price.inputPer1M + (outputTokens / 1_000_000) * price.outputPer1M;
}

// ---------------------------------------------------------------------
// Token usage — واقعی وقتی پروایدر برمی‌گردونه، تخمینی در غیر این صورت
// ---------------------------------------------------------------------

// حدود ۴ کاراکتر به ازای هر توکن — یک قاعده‌ی سرانگشتی استاندارد برای متن
// لاتین. برای فارسی/عربی/CJK کمتر از واقعی تخمین می‌زنه، به همین خاطر این
// ردیف‌ها با tokens_estimated=true علامت می‌خورن تا داشبورد فرق بین عدد
// واقعی و تخمینی رو نشون بده، نه این‌که حدس رو به‌جای عدد قطعی نشون بده.
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface ResolvedUsage {
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}

export function resolveUsage(req: NormalizedChatRequest, response: NormalizedChatResponse): ResolvedUsage {
  if (response.usage) {
    return { ...response.usage, estimated: false };
  }
  const inputText = req.system + req.messages.map((m) => m.content).join("\n");
  return {
    inputTokens: estimateTokens(inputText),
    outputTokens: estimateTokens(response.text),
    estimated: true,
  };
}

// ---------------------------------------------------------------------
// Supabase client (service-role — این فایل فقط داخل edge functionها اجرا می‌شه)
// ---------------------------------------------------------------------

let cachedClient: ReturnType<typeof createClient> | null = null;
function db() {
  if (cachedClient) return cachedClient;
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  cachedClient = createClient(url, key, { auth: { persistSession: false } });
  return cachedClient;
}

// ---------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------

export interface LogUsageInput {
  accountId?: string;
  task: TaskType;
  source?: string;
  response: NormalizedChatResponse;
  usage: ResolvedUsage;
  attempts: RouteChatResult["attempts"];
  /** Optional W3C trace id (32 hex) so an LLM call can be joined to a voice call trace. */
  traceId?: string;
  /** Correlation ids for the cost ledger (call / job / workflow run / agent action / marketplace run). */
  correlation?: LedgerCorrelation;
}

// هیچ‌وقت throw نمی‌کنه — یک لاگ هزینه‌ی خراب نباید جوابی که داره ثبتش
// می‌کنه رو خراب کنه. خطا فقط console.error می‌شه.
export async function logUsage(input: LogUsageInput): Promise<number> {
  const cost = estimateCost(
    input.response.provider,
    input.response.model,
    input.usage.inputTokens,
    input.usage.outputTokens,
  );
  try {
    await db().from("ai_usage_logs").insert({
      account_id: input.accountId ?? null,
      task: input.task,
      source: input.source ?? null,
      provider: input.response.provider,
      model: input.response.model,
      input_tokens: input.usage.inputTokens,
      output_tokens: input.usage.outputTokens,
      tokens_estimated: input.usage.estimated,
      cost_usd: cost,
      latency_ms: input.response.latencyMs,
      ttft_ms: [...input.attempts].reverse().find((a) => a.ok)?.firstTokenMs ?? null,
      trace_id: input.traceId ?? null,
      was_fallback: input.response.wasFallback,
      attempt_count: input.attempts.length,
      provider_chain: input.attempts,
      ok: true,
    });
  } catch (err) {
    console.error("[ai-core] failed to write ai_usage_logs:", err);
  }
  await appendCostEvent(db(), usdEvent({
    accountId: input.accountId ?? null,
    provider: input.response.provider,
    resourceType: "llm_tokens",
    component: "llm",
    quantity: input.usage.inputTokens + input.usage.outputTokens,
    unit: "tokens",
    costUsd: cost,
    basis: "estimated", // list-price table in this file, not provider-reported
    taskType: input.task,
    source: "ai_core",
    ref: crypto.randomUUID(),
  }));
  await appendCostEvent(db(), usdEvent({
    accountId: input.accountId ?? null,
    provider: input.response.provider,
    resourceType: "llm_tokens",
    component: "llm",
    quantity: input.usage.inputTokens + input.usage.outputTokens,
    unit: "tokens",
    costUsd: cost,
    basis: "estimated", // list-price table in this file, not provider-reported
    taskType: input.task,
    source: "ai_core",
    ref: crypto.randomUUID(),
    ...(input.correlation ?? {}),
  }));
  return cost;
}

// یک درخواستی که روی همه‌ی پروایدرهای زنجیره شکست خورده رو هم ثبت می‌کنه تا
// نرخ خطا روی داشبورد واقعی باشه، نه فقط موفق‌ها.
export async function logFailure(
  accountId: string | undefined,
  task: TaskType,
  source: string | undefined,
  errorCode: string,
): Promise<void> {
  try {
    await db().from("ai_usage_logs").insert({
      account_id: accountId ?? null,
      task,
      source: source ?? null,
      provider: "none",
      model: "none",
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      latency_ms: 0,
      was_fallback: true,
      attempt_count: 0,
      ok: false,
      error_code: errorCode,
    });
  } catch (err) {
    console.error("[ai-core] failed to write ai_usage_logs (failure row):", err);
  }
}

// ---------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------

// Fail OPEN: هر خطایی توی خوندن جدول بودجه فقط باعث می‌شه این یک تماس
// enforce نشه، نه این‌که کل قابلیت‌های AI به‌خاطر مشکل مانیتورینگ قطع بشن.
// ---------------------------------------------------------------------
// Plan cost limit (staff-set in plan_cost_limits.hard_cost_usd, voice + AI cost this month).
// ONLY explicitly optional tasks (costPolicy.ts) are ever paused. Live-call, emergency, dispatch and
// customer-facing tasks — and any task nobody classified — are never stopped for cost reasons.
// Fail OPEN on any infrastructure error; cached 5 minutes per isolate to avoid a query per AI call.
// ---------------------------------------------------------------------
const PLAN_LIMIT_TTL_MS = 5 * 60_000;
const planLimitCache = new Map<string, { at: number; exceeded: boolean }>();

async function planCostLimitExceeded(accountId: string): Promise<boolean> {
  const cached = planLimitCache.get(accountId);
  if (cached && Date.now() - cached.at < PLAN_LIMIT_TTL_MS) return cached.exceeded;
  let exceeded = false;
  try {
    const { data: profile } = await db().from("profiles").select("plan").eq("id", accountId).maybeSingle();
    const plan = (profile as { plan?: string | null } | null)?.plan;
    if (plan) {
      const { data: limit } = await db().from("plan_cost_limits").select("hard_cost_usd").eq("plan", plan).maybeSingle();
      const hard = (limit as { hard_cost_usd?: number | string | null } | null)?.hard_cost_usd;
      if (hard !== null && hard !== undefined) {
        const now = new Date();
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const { data: cost } = await db().rpc("tenant_month_cost_total", { p_user: accountId, p_month_start: monthStart.toISOString() });
        exceeded = Number(cost ?? 0) >= Number(hard);
      }
    }
  } catch (err) {
    console.error("[ai-core] plan cost limit check failed, allowing call through:", err);
  }
  planLimitCache.set(accountId, { at: Date.now(), exceeded });
  return exceeded;
}

async function checkPlanCostLimit(accountId: string, task?: TaskType): Promise<void> {
  if (!isOptionalAiTask(task)) return; // protected tasks never pay for cost limits (and skip the lookups)
  if (await planCostLimitExceeded(accountId)) {
    // Deliberately generic: internal cost figures are never shown to customers.
    throw new AiCoreError("BUDGET_EXCEEDED", "Optional AI features are paused for this account for the rest of this billing month.");
  }
}

export async function checkBudget(accountId?: string, task?: TaskType): Promise<void> {
  if (!accountId) return; // بدون accountId چیزی برای enforce کردن نیست
  await checkPlanCostLimit(accountId, task);

  try {
    const { data: limit } = await db()
      .from("ai_budget_limits")
      .select("monthly_limit_usd, alert_threshold_pct, hard_stop")
      .eq("account_id", accountId)
      .maybeSingle();

    if (!limit) return; // این اکانت سقفی تعریف نکرده — بدون محدودیت

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const { data: rows } = await db()
      .from("ai_usage_logs")
      .select("cost_usd")
      .eq("account_id", accountId)
      .gte("created_at", monthStart.toISOString());

    const spend = (rows ?? []).reduce((sum: number, r: { cost_usd: number }) => sum + Number(r.cost_usd || 0), 0);
    const pct = (spend / Number(limit.monthly_limit_usd)) * 100;

    // The owner-set hard stop only pauses OPTIONAL tasks when the task is known; emergency/live-call tasks keep working.
    if (pct >= 100 && limit.hard_stop && (task === undefined || isOptionalAiTask(task))) {
      throw new AiCoreError(
        "BUDGET_EXCEEDED",
        `Account has spent $${spend.toFixed(2)} this month, over its $${limit.monthly_limit_usd} AI budget.`,
      );
    }
    if (pct >= limit.alert_threshold_pct) {
      console.warn(`[ai-core] account ${accountId} at ${pct.toFixed(0)}% of its monthly AI budget.`);
    }
  } catch (err) {
    if (err instanceof AiCoreError) throw err; // این یک نقض واقعی بودجه‌ست — propagate کن
    console.error("[ai-core] budget check failed, allowing call through:", err);
  }
}
