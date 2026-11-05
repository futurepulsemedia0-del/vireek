// supabase/functions/_shared/billing/usageEvents.ts
// Records metered usage quantities (SMS segments etc.) for unit economics. Quantities are measured/estimated
// counts; dollar cost is computed later from provider_cost_rates. Never throws: metering must not break sending.

const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€";

/** ESTIMATE of billable SMS segments (GSM-7: 160/153, UCS-2: 70/67). The carrier's count is authoritative. */
export function estimateSmsSegments(body: string): number {
  if (!body) return 0;
  let units = 0;
  let gsm = true;
  for (const ch of body) {
    if (GSM_BASIC.includes(ch)) units += 1;
    else if (GSM_EXT.includes(ch)) units += 2;
    else { gsm = false; break; }
  }
  if (gsm) return units <= 160 ? 1 : Math.ceil(units / 153);
  const u16 = body.length;
  return u16 <= 70 ? 1 : Math.ceil(u16 / 67);
}

interface InsertClient {
  from(table: string): {
    upsert(rows: unknown, opts: { onConflict: string; ignoreDuplicates: boolean }): PromiseLike<{ error: { message: string } | null }>;
  };
}

export async function recordUsageEvent(
  admin: InsertClient,
  e: { userId: string | null; component: "sms_segment" | "recording_storage" | "transcription" | "embeddings" | "vision"; quantity: number; unit: string; source: string; ref: string | null; /** true = counted/estimated by us, false = reported by the provider. Default true. */ estimated?: boolean },
): Promise<void> {
  if (!Number.isFinite(e.quantity) || e.quantity <= 0) return;
  try {
    const { error } = await admin.from("cost_usage_events").upsert(
      { user_id: e.userId, component: e.component, quantity: e.quantity, unit: e.unit, source: e.source, ref: e.ref, quantity_estimated: e.estimated ?? true },
      { onConflict: "source,ref", ignoreDuplicates: true },
    );
    if (error) console.error("[usage-event] not recorded:", error.message);
  } catch (err) {
    console.error("[usage-event] not recorded:", err);
  }
}

/** ~4 characters per token for Latin text (under-counts other scripts), so callers must record these as estimated. */
export function estimateTokensFromChars(chars: number): number {
  return Number.isFinite(chars) && chars > 0 ? Math.max(1, Math.ceil(chars / 4)) : 0;
}

export interface GeminiTokenUsage { inputTokens: number; outputTokens: number }

/** Reads Gemini `usageMetadata` (provider-reported). Returns null when absent or unusable. */
export function extractGeminiUsage(usageMetadata: unknown): GeminiTokenUsage | null {
  if (typeof usageMetadata !== "object" || usageMetadata === null) return null;
  const u = usageMetadata as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  const inputTokens = num(u.promptTokenCount);
  const outputTokens = num(u.candidatesTokenCount) + num(u.thoughtsTokenCount);
  return inputTokens + outputTokens > 0 ? { inputTokens, outputTokens } : null;
}

/** Records provider-reported Gemini tokens for a direct (non ai-core) multimodal call. Never throws, never blocks the caller's result. */
export async function recordGeminiUsage(
  admin: InsertClient,
  args: { userId: string | null; source: string; usageMetadata: unknown; component?: "vision" | "transcription" },
): Promise<void> {
  const u = extractGeminiUsage(args.usageMetadata);
  if (!u) return;
  const component = args.component ?? "vision";
  await recordUsageEvent(admin, { userId: args.userId, component, quantity: u.inputTokens, unit: "input_tokens", source: args.source, ref: null, estimated: false });
  await recordUsageEvent(admin, { userId: args.userId, component, quantity: u.outputTokens, unit: "output_tokens", source: args.source, ref: null, estimated: false });
}

/** Splits `total` tokens across items proportionally to `weights` (largest-remainder, so the parts always sum to `total`). */
export function allocateTokens(total: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const t = Math.max(0, Math.round(total));
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const sum = w.reduce((a, b) => a + b, 0);
  const raw = sum > 0 ? w.map((x) => (x / sum) * t) : w.map(() => t / n);
  const base = raw.map(Math.floor);
  let left = t - base.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const o of order) { if (left <= 0) break; base[o.i] += 1; left -= 1; }
  return base;
}
