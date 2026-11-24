import type { Stage, TransitionSource } from './types';

/**
 * Invoice stage state machine (PURE). This table is the TypeScript mirror of
 * `commercial_stage_transitions` in the v2 migration — stateMachine.test.ts parses the SQL file and fails
 * if the two ever drift. `requiresReason` transitions must carry a >= 3 character reason.
 */
export interface Transition {
  readonly from: Stage;
  readonly to: Stage;
  readonly sources: readonly TransitionSource[];
  readonly requiresReason: boolean;
}

export const TRANSITIONS: readonly Transition[] = [
  { from: 'draft', to: 'ready', sources: ['user', 'system'], requiresReason: false },
  { from: 'draft', to: 'sent', sources: ['user', 'system'], requiresReason: false },
  { from: 'draft', to: 'paid', sources: ['system'], requiresReason: false },
  { from: 'draft', to: 'void', sources: ['user', 'system'], requiresReason: true },
  { from: 'ready', to: 'draft', sources: ['user', 'system'], requiresReason: false },
  { from: 'ready', to: 'sent', sources: ['user', 'system'], requiresReason: false },
  { from: 'ready', to: 'void', sources: ['user', 'system'], requiresReason: true },
  { from: 'blocked_needs_approval', to: 'draft', sources: ['user', 'system'], requiresReason: false },
  { from: 'blocked_needs_approval', to: 'ready', sources: ['user', 'system'], requiresReason: false },
  { from: 'blocked_needs_approval', to: 'sent', sources: ['user', 'system'], requiresReason: false },
  { from: 'blocked_needs_approval', to: 'void', sources: ['user', 'system'], requiresReason: true },
  { from: 'sent', to: 'received', sources: ['user', 'system', 'portal', 'email_parse'], requiresReason: false },
  { from: 'sent', to: 'approved', sources: ['user', 'portal', 'email_parse'], requiresReason: false },
  { from: 'sent', to: 'rejected', sources: ['user', 'portal', 'email_parse'], requiresReason: true },
  { from: 'sent', to: 'disputed', sources: ['user', 'portal', 'email_parse'], requiresReason: true },
  { from: 'sent', to: 'paid', sources: ['system'], requiresReason: false },
  { from: 'sent', to: 'written_off', sources: ['user'], requiresReason: true },
  { from: 'sent', to: 'void', sources: ['user', 'system'], requiresReason: true },
  { from: 'received', to: 'approved', sources: ['user', 'portal', 'email_parse'], requiresReason: false },
  { from: 'received', to: 'rejected', sources: ['user', 'portal', 'email_parse'], requiresReason: true },
  { from: 'received', to: 'disputed', sources: ['user', 'portal', 'email_parse'], requiresReason: true },
  { from: 'received', to: 'paid', sources: ['system'], requiresReason: false },
  { from: 'received', to: 'written_off', sources: ['user'], requiresReason: true },
  { from: 'received', to: 'void', sources: ['user', 'system'], requiresReason: true },
  { from: 'approved', to: 'rejected', sources: ['user', 'portal', 'email_parse'], requiresReason: true },
  { from: 'approved', to: 'disputed', sources: ['user', 'portal', 'email_parse'], requiresReason: true },
  { from: 'approved', to: 'paid', sources: ['system'], requiresReason: false },
  { from: 'approved', to: 'written_off', sources: ['user'], requiresReason: true },
  { from: 'approved', to: 'void', sources: ['user', 'system'], requiresReason: true },
  { from: 'rejected', to: 'sent', sources: ['user', 'system'], requiresReason: false },
  { from: 'rejected', to: 'received', sources: ['user', 'portal', 'email_parse'], requiresReason: false },
  { from: 'rejected', to: 'approved', sources: ['user', 'portal', 'email_parse'], requiresReason: false },
  { from: 'rejected', to: 'disputed', sources: ['user', 'portal', 'email_parse'], requiresReason: true },
  { from: 'rejected', to: 'paid', sources: ['system'], requiresReason: false },
  { from: 'rejected', to: 'written_off', sources: ['user'], requiresReason: true },
  { from: 'rejected', to: 'void', sources: ['user', 'system'], requiresReason: true },
  { from: 'disputed', to: 'approved', sources: ['user', 'portal', 'email_parse'], requiresReason: false },
  { from: 'disputed', to: 'rejected', sources: ['user', 'portal', 'email_parse'], requiresReason: true },
  { from: 'disputed', to: 'sent', sources: ['user', 'system'], requiresReason: false },
  { from: 'disputed', to: 'paid', sources: ['system'], requiresReason: false },
  { from: 'disputed', to: 'written_off', sources: ['user'], requiresReason: true },
  { from: 'disputed', to: 'void', sources: ['user', 'system'], requiresReason: true },
  { from: 'written_off', to: 'paid', sources: ['system'], requiresReason: false },
];

const INDEX: ReadonlyMap<string, Transition> = new Map(TRANSITIONS.map((t) => [`${t.from}>${t.to}`, t]));

export type TransitionError = 'illegal_transition' | 'source_not_allowed' | 'reason_required';
export type TransitionCheck = { ok: true; transition: Transition | null } | { ok: false; error: TransitionError };

export function checkTransition(from: Stage, to: Stage, source: TransitionSource, reason?: string | null): TransitionCheck {
  if (from === to) return { ok: true, transition: null }; // idempotent no-op, exactly like the SQL function
  const t = INDEX.get(`${from}>${to}`);
  if (!t) return { ok: false, error: 'illegal_transition' };
  if (!t.sources.includes(source)) return { ok: false, error: 'source_not_allowed' };
  if (t.requiresReason && (reason ?? '').trim().length < 3) return { ok: false, error: 'reason_required' };
  return { ok: true, transition: t };
}

/** Stages a human can offer in the UI from `from` (drives the buttons; the server still re-checks). */
export function userNextStages(from: Stage): Stage[] {
  const userStageSet: ReadonlySet<Stage> = new Set<Stage>(['draft', 'ready', 'sent', 'received', 'approved', 'rejected', 'disputed', 'written_off']);
  return TRANSITIONS.filter((t) => t.from === from && t.sources.includes('user') && userStageSet.has(t.to)).map((t) => t.to);
}

export const TERMINAL_STAGES: readonly Stage[] = ['void'];
