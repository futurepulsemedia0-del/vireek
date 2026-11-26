// supabase/functions/_shared/portal/stateMachine.ts
// Pure, dependency-free submission lifecycle. The SQL function portal_apply_transition() enforces the SAME matrix
// inside the database (source of truth); this module mirrors it for UI gating and unit tests. If you change one, change both
// (portalStateMachine.test.ts parses the migration and fails on drift).

export const PORTAL_STATES = [
  "queued", "prepared", "awaiting_human", "submitting", "submitted", "acknowledged",
  "approved", "rejected", "scheduled_for_payment", "paid", "failed", "cancelled",
] as const;
export type PortalState = (typeof PORTAL_STATES)[number];

export const PORTAL_CHANNELS = ["email", "assisted", "api", "automation"] as const;
export type PortalChannel = (typeof PORTAL_CHANNELS)[number];

export const TRANSITIONS: Readonly<Record<PortalState, readonly PortalState[]>> = {
  queued: ["prepared", "cancelled", "failed"],
  prepared: ["awaiting_human", "submitting", "cancelled", "failed"],
  awaiting_human: ["submitting", "submitted", "cancelled", "failed"],
  submitting: ["submitted", "awaiting_human", "failed"],
  submitted: ["acknowledged", "approved", "rejected", "scheduled_for_payment", "paid", "failed"],
  acknowledged: ["approved", "rejected", "scheduled_for_payment", "paid"],
  approved: ["scheduled_for_payment", "paid"],
  rejected: [],
  scheduled_for_payment: ["paid"],
  paid: [],
  failed: ["queued"],
  cancelled: [],
};

/** States after which a portal is still expected to change the status (polling continues). */
export const POLLABLE_STATES: readonly PortalState[] = ["submitted", "acknowledged", "approved", "scheduled_for_payment"];
/** States that free the (invoice, profile) slot so a corrected packet may be submitted again. */
export const SLOT_RELEASING_STATES: readonly PortalState[] = ["rejected", "failed", "cancelled"];
/** Channels that require a human click/confirmation before the first external side effect. */
export const HUMAN_GATED_CHANNELS: readonly PortalChannel[] = ["assisted"];

export function canTransition(from: PortalState, to: PortalState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: PortalState, to: PortalState): void {
  if (!canTransition(from, to)) throw new Error(`illegal_transition:${from}->${to}`);
}

export function isTerminal(s: PortalState): boolean {
  return TRANSITIONS[s].length === 0;
}

export function isPortalState(v: unknown): v is PortalState {
  return typeof v === "string" && (PORTAL_STATES as readonly string[]).includes(v);
}

/** A rejection must carry the portal's reason text (it becomes the "fix and resubmit" task). */
export function validateRejection(reason: string | null | undefined): string {
  const r = (reason ?? "").trim();
  if (r.length < 3) throw new Error("rejection_reason_required");
  return r.slice(0, 2000);
}
