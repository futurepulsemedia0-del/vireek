/**
 * Pack engine — pure, deterministic, no I/O.
 *
 * INVARIANT (kept by every plan and checked by the server): for each tracked artifact,
 *   base === content of that artifact in the INSTALLED pack version, or null when the
 *   artifact is account-owned (detached). `live` is what the account actually uses.
 *   "Customized" simply means live !== base. Customizations are never overwritten:
 *   a pack change only reaches `live` when live still equals base (three-way merge).
 */

import { flattenPack } from './schema';
import type {
  AccountState, Artifact, ArtifactId, Conflict, InstallEvent, Op, PackManifest, Plan, PlanSummary, Resolution,
} from './types';
import { artifactId } from './schema';

/* ------------------------------ equality ------------------------------ */

/** Deep equality for JSON values, independent of object key order (mirrors Postgres jsonb `=`). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (typeof a === 'object') {
    if (Array.isArray(b)) return false;
    const ka = Object.keys(a as object), kb = Object.keys(b as object);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

const clone = <T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

export function isCustomized(t: { live: unknown; base: unknown | null }): boolean {
  return t.base !== null && !jsonEqual(t.live, t.base);
}

export function customizedIds(state: AccountState): ArtifactId[] {
  return Object.keys(state).filter((id) => isCustomized(state[id]));
}

/* ------------------------------ plan building ------------------------------ */

const emptySummary = (): PlanSummary => ({ created: 0, updated: 0, removed: 0, rebased: 0, detached: 0, preservedCustomized: 0, conflicts: 0, unchanged: 0 });

function finish(plan: Omit<Plan, 'summary'>, preserved: number, unchanged: number): Plan {
  const s = emptySummary();
  for (const o of plan.ops) {
    if (o.op === 'create') s.created++;
    else if (o.op === 'update') s.updated++;
    else if (o.op === 'remove') s.removed++;
    else if (o.op === 'rebase') s.rebased++;
    else s.detached++;
  }
  s.preservedCustomized = preserved;
  s.conflicts = plan.conflicts.length;
  s.unchanged = unchanged;
  return { ...plan, summary: s };
}

/**
 * Plan an install (empty/uninstalled state) or an upgrade (installed state) to `next`.
 * Idempotent: planning the version that is already installed yields zero ops.
 * `resolutions[id] === 'take_pack'` overwrites a customization with the pack's content for that artifact.
 */
export function planSync(
  kind: 'install' | 'upgrade',
  next: PackManifest,
  state: AccountState,
  fromVersion: string | null,
  resolutions: Record<ArtifactId, Resolution> = {},
): Plan {
  const wanted = new Map<ArtifactId, Artifact>(flattenPack(next).map((a) => [artifactId(a.kind, a.key), a]));
  const ops: Op[] = [];
  const conflicts: Conflict[] = [];
  let preserved = 0, unchanged = 0;

  for (const [id, art] of wanted) {
    const n = art.content;
    const t = state[id];
    if (!t) {
      ops.push({ op: 'create', id, liveBefore: null, liveAfter: clone(n), baseBefore: null, baseAfter: clone(n) });
      continue;
    }
    const take = resolutions[id] === 'take_pack';
    if (t.base === null) {
      // Account-owned artifact that the pack now also defines: adopt tracking, keep the account's content.
      if (take && !jsonEqual(t.live, n)) ops.push({ op: 'update', id, liveBefore: clone(t.live), liveAfter: clone(n), baseBefore: null, baseAfter: clone(n) });
      else {
        ops.push({ op: 'rebase', id, liveBefore: clone(t.live), liveAfter: clone(t.live), baseBefore: null, baseAfter: clone(n) });
        if (!jsonEqual(t.live, n)) preserved++;
      }
      continue;
    }
    const packChanged = !jsonEqual(t.base, n);
    const customized = !jsonEqual(t.live, t.base);
    if (!packChanged) {
      if (take && customized) ops.push({ op: 'update', id, liveBefore: clone(t.live), liveAfter: clone(n), baseBefore: clone(t.base), baseAfter: clone(n) });
      else { unchanged++; if (customized) preserved++; }
    } else if (!customized || take) {
      ops.push({ op: 'update', id, liveBefore: clone(t.live), liveAfter: clone(n), baseBefore: clone(t.base), baseAfter: clone(n) });
    } else if (jsonEqual(t.live, n)) {
      ops.push({ op: 'rebase', id, liveBefore: clone(t.live), liveAfter: clone(t.live), baseBefore: clone(t.base), baseAfter: clone(n) });
    } else {
      // Customized AND changed by the pack: keep the account's version, move the base so the
      // invariant holds, and report it. "Reset to pack" remains available (resolutions).
      conflicts.push({ id, reason: 'customized_and_changed_by_pack', base: clone(t.base), live: clone(t.live), next: clone(n) });
      ops.push({ op: 'rebase', id, liveBefore: clone(t.live), liveAfter: clone(t.live), baseBefore: clone(t.base), baseAfter: clone(n) });
      preserved++;
    }
  }

  // Artifacts the new version no longer ships.
  for (const [id, t] of Object.entries(state)) {
    if (wanted.has(id) || t.base === null) continue;
    if (jsonEqual(t.live, t.base)) ops.push({ op: 'remove', id, liveBefore: clone(t.live), liveAfter: null, baseBefore: clone(t.base), baseAfter: null });
    else {
      ops.push({ op: 'detach', id, liveBefore: clone(t.live), liveAfter: clone(t.live), baseBefore: clone(t.base), baseAfter: null });
      preserved++;
    }
  }

  return finish({ kind, packId: next.id, fromVersion, toVersion: next.version, ops, conflicts }, preserved, unchanged);
}

export const planInstall = (next: PackManifest, state: AccountState = {}) => planSync('install', next, state, null);
export const planUpgrade = (next: PackManifest, state: AccountState, fromVersion: string, resolutions?: Record<ArtifactId, Resolution>) =>
  planSync('upgrade', next, state, fromVersion, resolutions);

/** "Reset to pack default" for chosen artifacts at the installed version. */
export function planReset(installed: PackManifest, state: AccountState, ids: ArtifactId[]): Plan {
  const res: Record<ArtifactId, Resolution> = {};
  for (const id of ids) res[id] = 'take_pack';
  return planSync('upgrade', installed, state, installed.version, res);
}

/**
 * Plan the rollback of the LAST non-reverted event. Only artifacts still exactly as that event
 * left them are reverted; anything the account changed since is kept (and re-based).
 */
export function planRollback(packId: string, event: InstallEvent, state: AccountState): Plan {
  const ops: Op[] = [];
  let preserved = 0, unchanged = 0;

  for (const o of [...event.ops].reverse()) {
    const cur = state[o.id];
    if (o.op === 'remove') {
      if (!cur) ops.push({ op: 'create', id: o.id, liveBefore: null, liveAfter: clone(o.liveBefore), baseBefore: null, baseAfter: clone(o.baseBefore) });
      else unchanged++;
      continue;
    }
    if (!cur) { unchanged++; continue; }
    const base = cur.base === null ? null : clone(cur.base);
    const live = clone(cur.live);
    if (o.op === 'create') {
      if (jsonEqual(cur.live, o.liveAfter)) ops.push({ op: 'remove', id: o.id, liveBefore: live, liveAfter: null, baseBefore: base, baseAfter: null });
      else { ops.push({ op: 'detach', id: o.id, liveBefore: live, liveAfter: live, baseBefore: base, baseAfter: null }); preserved++; }
    } else if (o.op === 'update') {
      if (jsonEqual(cur.live, o.liveAfter)) ops.push({ op: 'update', id: o.id, liveBefore: live, liveAfter: clone(o.liveBefore), baseBefore: base, baseAfter: clone(o.baseBefore) });
      else { ops.push({ op: o.baseBefore === null ? 'detach' : 'rebase', id: o.id, liveBefore: live, liveAfter: live, baseBefore: base, baseAfter: clone(o.baseBefore) }); preserved++; }
    } else {
      // rebase / detach: only the tracking changes; restore the previous base.
      if (jsonEqual(base, o.baseBefore)) unchanged++;
      else ops.push({ op: o.baseBefore === null ? 'detach' : 'rebase', id: o.id, liveBefore: live, liveAfter: live, baseBefore: base, baseAfter: clone(o.baseBefore) });
      if (isCustomized({ live: cur.live, base: o.baseBefore })) preserved++;
    }
  }
  return finish({ kind: 'rollback', packId, fromVersion: event.toVersion, toVersion: event.fromVersion, ops, conflicts: [] }, preserved, unchanged);
}

/* ------------------------------ guarded apply (client mirror of the SQL) ------------------------------ */

export class GuardError extends Error {
  constructor(public readonly id: string, message: string) {
    super(`${id}: ${message}`);
    this.name = 'GuardError';
  }
}

/**
 * Applies ops to a copy of `state`, enforcing the same optimistic guards as pack_apply() in SQL:
 * the row must be in exactly the state the op expects, otherwise NOTHING is applied.
 * `manifestOf(id)` returns the content of that artifact in the TARGET version (undefined if absent).
 */
export function applyOps(state: AccountState, ops: Op[], manifestOf: (id: ArtifactId) => unknown | undefined): AccountState {
  const next: AccountState = clone(state);
  const seen = new Set<string>();
  for (const o of ops) {
    if (seen.has(o.id)) throw new GuardError(o.id, 'artifact appears twice in one plan');
    seen.add(o.id);
    const cur = next[o.id];
    if (o.op === 'create') {
      if (cur) throw new GuardError(o.id, 'already exists');
      if (o.liveBefore !== null || o.baseBefore !== null || o.liveAfter === null || o.baseAfter === null) throw new GuardError(o.id, 'malformed create');
    } else {
      if (!cur) throw new GuardError(o.id, 'does not exist');
      if (!jsonEqual(cur.live, o.liveBefore)) throw new GuardError(o.id, 'changed since the plan was made (live)');
      if (!jsonEqual(cur.base, o.baseBefore)) throw new GuardError(o.id, 'changed since the plan was made (base)');
    }
    if (o.baseAfter !== null) {
      const m = manifestOf(o.id);
      if (m === undefined || !jsonEqual(m, o.baseAfter)) throw new GuardError(o.id, 'new base is not the target version\'s content');
    }
    const liveOk = o.liveAfter === null || jsonEqual(o.liveAfter, o.liveBefore) || jsonEqual(o.liveAfter, o.baseAfter);
    if (!liveOk) throw new GuardError(o.id, 'live content may only stay as it is or become the pack content');
    if (o.op === 'remove') { if (o.liveAfter !== null || o.baseAfter !== null) throw new GuardError(o.id, 'malformed remove'); delete next[o.id]; continue; }
    if (o.op === 'detach' && o.baseAfter !== null) throw new GuardError(o.id, 'malformed detach');
    if ((o.op === 'update' || o.op === 'rebase' || o.op === 'create') && o.baseAfter === null) throw new GuardError(o.id, `malformed ${o.op}`);
    if (o.op === 'rebase' && !jsonEqual(o.liveAfter, o.liveBefore)) throw new GuardError(o.id, 'rebase must not change live');
    next[o.id] = { live: clone(o.liveAfter), base: o.baseAfter === null ? null : clone(o.baseAfter) };
  }
  return next;
}

/* ------------------------------ preview ------------------------------ */

export interface DiffLine { id: ArtifactId; action: 'add' | 'update' | 'remove' | 'keep_yours' | 'detach' | 'retrack'; note: string }

/** Human-readable preview rows for the admin UI. */
export function previewDiff(plan: Plan): DiffLine[] {
  const conflict = new Set(plan.conflicts.map((c) => c.id));
  return plan.ops.map((o): DiffLine => {
    switch (o.op) {
      case 'create': return { id: o.id, action: 'add', note: 'New — will be added' };
      case 'update': return { id: o.id, action: 'update', note: plan.kind === 'rollback' ? 'Will be restored to the earlier pack content' : 'Pack changed it and you had not customized it — will be updated' };
      case 'remove': return { id: o.id, action: 'remove', note: 'Pack no longer ships it and you never changed it — will be removed' };
      case 'detach': return { id: o.id, action: 'detach', note: 'You customized it — it stays and becomes yours (no longer pack-managed)' };
      case 'rebase': return conflict.has(o.id)
        ? { id: o.id, action: 'keep_yours', note: 'You customized it and the pack changed it too — your version is kept' }
        : { id: o.id, action: 'retrack', note: 'Your version is kept; only pack tracking moves' };
    }
  });
}
