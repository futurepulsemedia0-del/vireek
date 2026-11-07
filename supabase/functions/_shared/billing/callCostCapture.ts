// supabase/functions/_shared/billing/callCostCapture.ts
//
// Extracts the provider-REPORTED cost from a Vapi end-of-call-report and stores it per component.
// These are provider-reported numbers (basis = 'provider_reported'): measured by the provider, but
// NOT yet reconciled against a monthly invoice. Never throws: cost capture must not break call handling.
import { buildLedgerRow, componentToResource } from "../economics/ledgerWriter.ts";
import { usdToMicro } from "../economics/microDollars.ts";
export const VAPI_COMPONENT_MAP = {
  transport: "carrier",
  stt: "asr",
  llm: "llm",
  tts: "tts",
  vapi: "voice_platform",
} as const;

export interface CostLineInput {
  component: string;
  amountUsd: number;
}

interface CostMessageLike {
  cost?: unknown;
  costBreakdown?: unknown;
  call?: { type?: unknown } | null;
}

function money(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function carrierComponent(callType: unknown): string {
  const t = typeof callType === "string" ? callType.toLowerCase() : "";
  if (t.includes("outbound")) return "carrier_outbound";
  if (t.includes("inbound")) return "carrier_inbound";
  return "carrier_unclassified"; // direction unknown: never guess
}

/** Pure. Unknown keys are ignored; any unexplained remainder of `cost` is kept as its own line. */
export function extractVapiCostLines(message: CostMessageLike): CostLineInput[] {
  const total = money(message.cost);
  const raw = message.costBreakdown;
  const lines: CostLineInput[] = [];

  if (raw && typeof raw === "object") {
    const bd = raw as Record<string, unknown>;
    for (const [key, component] of Object.entries(VAPI_COMPONENT_MAP)) {
      const amount = money(bd[key]);
      if (amount === null || amount === 0) continue;
      lines.push({
        component: component === "carrier" ? carrierComponent(message.call?.type) : component,
        amountUsd: amount,
      });
    }
  }

  const explained = lines.reduce((s, l) => s + l.amountUsd, 0);
  if (total !== null) {
    const rest = total - explained;
    if (lines.length === 0 && total > 0) lines.push({ component: "provider_total_unbroken", amountUsd: total });
    else if (rest > 0.0001) lines.push({ component: "provider_other", amountUsd: Number(rest.toFixed(6)) });
  }
  return lines;
}

interface UpsertClient {
  from(table: string): {
    upsert(rows: unknown, opts: { onConflict: string; ignoreDuplicates?: boolean }): PromiseLike<{ error: { message: string } | null }>;
  };
}

/** Idempotent: unique (vapi_call_id, component), so webhook retries overwrite instead of duplicating. */
export async function recordCallCostLines(
  admin: UpsertClient,
  args: { userId: string; vapiCallId: string | null; lines: CostLineInput[] },
): Promise<void> {
  if (!args.vapiCallId || args.lines.length === 0) return;
  try {
    const rows = args.lines.map((l) => ({
      user_id: args.userId,
      vapi_call_id: args.vapiCallId,
      component: l.component,
      amount_usd: l.amountUsd,
      basis: "provider_reported",
      source: "vapi_end_of_call_report",
    }));
    const { error } = await admin.from("call_cost_components").upsert(rows, { onConflict: "vapi_call_id,component" });
    if (error) console.error("[call-cost] not recorded:", error.message);
    const ledgerRows = args.lines.map((l) =>
      buildLedgerRow({
        accountId: args.userId,
        provider: "vapi",
        resourceType: componentToResource(l.component),
        component: l.component,
        costMicro: usdToMicro(l.amountUsd),
        basis: "provider_reported",
        callId: args.vapiCallId,
        source: "vapi_end_of_call_report",
        ref: `${args.vapiCallId}:${l.component}`,
      }),
    );
    const { error: ledgerErr } = await admin.from("cost_ledger").upsert(ledgerRows, { onConflict: "source,ref", ignoreDuplicates: true });
    if (ledgerErr) console.error("[cost-ledger] not recorded:", ledgerErr.message);
  } catch (err) {
    console.error("[call-cost] not recorded:", err);
  }
}
