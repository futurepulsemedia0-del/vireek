// supabase/functions/_shared/portal/packet.ts
// Assisted mode: turns a profile version + invoice packet into a checklist and copy-ready values for a human.
import type { PortalPacket } from "./adapter.ts";

export interface ProfileConfig {
  required_fields: { key: string; label: string; source: keyof PortalPacket | `fields.${string}`; required: boolean }[];
  checklist: { id: string; text: string }[];
  status_map: Record<string, string>;
}
export interface CopyField { key: string; label: string; value: string; missing: boolean; required: boolean }

function pick(p: PortalPacket, source: string): string {
  if (source.startsWith("fields.")) return p.fields[source.slice(7)] ?? "";
  const v = (p as unknown as Record<string, unknown>)[source];
  if (typeof v === "number") return source.endsWith("_cents") ? (v / 100).toFixed(2) : String(v);
  return typeof v === "string" ? v : "";
}

export function buildCopyFields(p: PortalPacket, cfg: ProfileConfig): CopyField[] {
  return cfg.required_fields.map((f) => {
    const value = pick(p, f.source);
    return { key: f.key, label: f.label, value, missing: f.required && value.trim() === "", required: f.required };
  });
}
export const readyForHuman = (fields: CopyField[]) => fields.every((f) => !f.missing);

/** Only https deep links are ever rendered as clickable. */
export function safeDeepLink(u: string | null | undefined): string | null {
  if (!u) return null;
  try { const x = new URL(u); return x.protocol === "https:" && !x.username && !x.password ? x.toString() : null; } catch { return null; }
}

/** A human-recorded confirmation must carry a reference number OR an uploaded screenshot. */
export function validateConfirmation(c: { reference?: string | null; evidenceId?: string | null }): string | null {
  const ref = (c.reference ?? "").trim();
  if (!ref && !c.evidenceId) return "reference_or_evidence_required";
  if (ref.length > 200) return "reference_too_long";
  return null;
}
