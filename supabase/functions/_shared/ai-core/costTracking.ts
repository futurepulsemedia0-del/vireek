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
      was_fallback: input.response.wasFallback,
      attempt_count: input.attempts.length,
      provider_chain: input.attempts,
      ok: true,
    });
  } catch (err) {
    console.error("[ai-core] failed to write ai_usage_logs:", err);
  }
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
export async function checkBudget(accountId?: string): Promise<void> {
  if (!accountId) return; // بدون accountId چیزی برای enforce کردن نیست

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

    if (pct >= 100 && limit.hard_stop) {
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
