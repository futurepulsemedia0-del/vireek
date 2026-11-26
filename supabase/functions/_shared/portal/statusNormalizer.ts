// supabase/functions/_shared/portal/statusNormalizer.ts
// Portal status vocabulary -> Vireek states. Profile mapping wins; a conservative default vocabulary is the fallback.
// Unknown text NEVER moves the state: it is flagged for a human.
import { isPortalState, type PortalState } from "./stateMachine.ts";

export const DEFAULT_VOCABULARY: Readonly<Record<string, PortalState>> = {
  received: "acknowledged", "in review": "acknowledged", "under review": "acknowledged", pending: "acknowledged",
  submitted: "submitted", approved: "approved", accepted: "approved",
  rejected: "rejected", declined: "rejected", disputed: "rejected", "on hold": "acknowledged",
  scheduled: "scheduled_for_payment", "scheduled for payment": "scheduled_for_payment", "payment scheduled": "scheduled_for_payment",
  paid: "paid", "payment issued": "paid",
};

export type Normalized = { kind: "state"; state: PortalState; raw: string } | { kind: "unknown"; raw: string };

const norm = (s: string) => s.toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();

export function normalizeStatus(raw: string, profileMap: Readonly<Record<string, string>> = {}): Normalized {
  const key = norm(raw);
  const custom = Object.entries(profileMap).find(([k]) => norm(k) === key)?.[1];
  if (custom && isPortalState(custom)) return { kind: "state", state: custom, raw };
  const def = DEFAULT_VOCABULARY[key];
  return def ? { kind: "state", state: def, raw } : { kind: "unknown", raw: raw.slice(0, 200) };
}
