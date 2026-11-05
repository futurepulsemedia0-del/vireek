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
  e: { userId: string | null; component: "sms_segment" | "recording_storage" | "transcription" | "embeddings" | "vision"; quantity: number; unit: string; source: string; ref: string | null },
): Promise<void> {
  if (!Number.isFinite(e.quantity) || e.quantity <= 0) return;
  try {
    const { error } = await admin.from("cost_usage_events").upsert(
      { user_id: e.userId, component: e.component, quantity: e.quantity, unit: e.unit, source: e.source, ref: e.ref },
      { onConflict: "source,ref", ignoreDuplicates: true },
    );
    if (error) console.error("[usage-event] not recorded:", error.message);
  } catch (err) {
    console.error("[usage-event] not recorded:", err);
  }
}
