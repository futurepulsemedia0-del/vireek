// supabase/functions/_shared/audit/webhookHook.ts
// Called from vapi-webhook BEFORE tenant resolution. Only touches calls our audit created (metadata.vireek_audit_call_id),
// so every other event passes through untouched. Never throws into the webhook: failures are logged and reported as
// "not handled" only when nothing was done.

import { buildAuditDeps } from "./deps.ts";
import { vapiCallToReport } from "./providers.ts";
import { applyProviderEvent } from "./service.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// deno-lint-ignore no-explicit-any
export function auditCallIdOf(message: any): string | null {
  const id = message?.call?.metadata?.vireek_audit_call_id;
  return typeof id === "string" && UUID.test(id) ? id.toLowerCase() : null;
}

// deno-lint-ignore no-explicit-any
export async function handleAuditWebhookEvent(message: any): Promise<boolean> {
  const auditCallId = auditCallIdOf(message);
  if (!auditCallId) return false;
  const type = message?.type;
  if (type !== "status-update" && type !== "end-of-call-report") return true; // ours, but nothing to do
  try {
    const d = buildAuditDeps();
    const providerCallId = typeof message.call?.id === "string" ? message.call.id : null;
    if (type === "status-update") {
      await applyProviderEvent(d, { type, providerCallId, auditCallId, status: String(message.status ?? ""), at: new Date().toISOString() });
    } else {
      const report = vapiCallToReport({
        ...(message.call ?? {}), endedReason: message.endedReason ?? message.call?.endedReason,
        startedAt: message.startedAt ?? message.call?.startedAt, endedAt: message.endedAt ?? message.call?.endedAt,
        analysis: message.analysis ?? message.call?.analysis, artifact: message.artifact ?? message.call?.artifact,
        cost: message.cost ?? message.call?.cost,
      });
      if (typeof message.durationSeconds === "number") report.durationSeconds = Math.round(message.durationSeconds);
      await applyProviderEvent(d, { type, providerCallId, auditCallId, report });
    }
  } catch (e) {
    console.error(JSON.stringify({ scope: "audit", event: "webhook_hook_error", message: String((e as Error)?.message ?? e).slice(0, 200) }));
  }
  return true;
}
