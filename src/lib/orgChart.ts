// Pure logic for the team org chart (/dashboard/team/org-chart).
// No React, no network - everything here is unit-tested in orgChart.test.ts.

export type AccessRole = 'owner' | 'admin' | 'technician' | 'member';

export interface OrgMember {
  id: string;
  name: string;
  /** Only returned to managers. */
  email: string | null;
  photo_url: string | null;
  access_role: AccessRole;
  title: string | null;
  /** null = reports to the account owner (the chart root). */
  reports_to_id: string | null;
  invite_status: string;
  is_me: boolean;
  /** Start of the person's current position (ISO). */
  since: string | null;
}

export interface OrgOwner {
  name: string;
  company: string | null;
}

export interface OrgOverview {
  can_manage: boolean;
  owner: OrgOwner;
  members: OrgMember[];
}

export interface HistoryEntry {
  id: string;
  access_role: AccessRole;
  title: string | null;
  reports_to_name: string | null;
  started_at: string;
  ended_at: string | null;
  note: string | null;
  changed_by_name: string | null;
}

export interface OrgNode {
  member: OrgMember;
  children: OrgNode[];
  /** 0 = reports directly to the owner. */
  depth: number;
  /** Everyone below this person, at any depth. */
  reportCount: number;
}

export interface OrgSummary {
  headcount: number;
  pending: number;
  managers: number;
  levels: number;
  widestSpan: number;
}

export const TITLE_MAX = 80;
export const NOTE_MAX = 280;

export const ROLE_LABELS: Record<AccessRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  technician: 'Technician',
  member: 'Member',
};

// ============================================================
// NORMALISATION (RPC payloads -> safe, typed values)
// ============================================================

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

function asRole(v: unknown): AccessRole {
  return v === 'owner' || v === 'admin' || v === 'technician' ? v : 'member';
}

export function normalizeOverview(raw: unknown): OrgOverview {
  const d = (raw ?? {}) as { can_manage?: unknown; owner?: { name?: unknown; company?: unknown } | null; members?: unknown };
  const seen = new Set<string>();
  const members: OrgMember[] = [];
  for (const item of Array.isArray(d.members) ? d.members : []) {
    const m = (item ?? {}) as Record<string, unknown>;
    const id = str(m.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    members.push({
      id,
      name: str(m.name) ?? 'Unnamed',
      email: str(m.email),
      photo_url: str(m.photo_url),
      access_role: asRole(m.access_role),
      title: str(m.title),
      reports_to_id: str(m.reports_to_id),
      invite_status: str(m.invite_status) ?? 'active',
      is_me: m.is_me === true,
      since: str(m.since),
    });
  }
  return {
    can_manage: d.can_manage === true,
    owner: { name: str(d.owner?.name) ?? 'Account owner', company: str(d.owner?.company) },
    members,
  };
}

export function normalizeHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryEntry[] = [];
  for (const item of raw) {
    const h = (item ?? {}) as Record<string, unknown>;
    const id = str(h.id);
    const startedAt = str(h.started_at);
    if (!id || !startedAt) continue;
    out.push({
      id,
      access_role: asRole(h.access_role),
      title: str(h.title),
      reports_to_name: str(h.reports_to_name),
      started_at: startedAt,
      ended_at: str(h.ended_at),
      note: str(h.note),
      changed_by_name: str(h.changed_by_name),
    });
  }
  return out;
}

// ============================================================
// TREE
// ============================================================

const byName = (a: OrgMember, b: OrgMember) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);

/**
 * Builds the reporting tree. Members whose manager is missing - or who sit in a
 * loop caused by bad data - become top-level so nobody ever disappears.
 */
export function buildOrgTree(members: OrgMember[]): { roots: OrgNode[]; maxDepth: number } {
  const ids = new Set(members.map((m) => m.id));
  const childrenOf = new Map<string, OrgMember[]>();
  const rootMembers: OrgMember[] = [];
  for (const m of members) {
    if (m.reports_to_id && m.reports_to_id !== m.id && ids.has(m.reports_to_id)) {
      const list = childrenOf.get(m.reports_to_id) ?? [];
      list.push(m);
      childrenOf.set(m.reports_to_id, list);
    } else {
      rootMembers.push(m);
    }
  }

  const visited = new Set<string>();
  let maxDepth = 0;
  const build = (m: OrgMember, depth: number): OrgNode => {
    visited.add(m.id);
    maxDepth = Math.max(maxDepth, depth);
    const children = (childrenOf.get(m.id) ?? [])
      .filter((c) => !visited.has(c.id))
      .sort(byName)
      .map((c) => build(c, depth + 1));
    return { member: m, children, depth, reportCount: children.reduce((n, c) => n + 1 + c.reportCount, 0) };
  };

  const roots = [...rootMembers].sort(byName).map((m) => build(m, 0));
  // Anything still unvisited is part of a loop: surface it at the top level.
  for (const m of [...members].sort(byName)) {
    if (!visited.has(m.id)) roots.push(build(m, 0));
  }
  return { roots, maxDepth };
}

export function summarizeOrg(members: OrgMember[], roots: OrgNode[], maxDepth: number): OrgSummary {
  const managerIds = new Set(members.map((m) => m.reports_to_id).filter((id): id is string => !!id));
  const spans = new Map<string, number>();
  for (const m of members) {
    if (m.reports_to_id) spans.set(m.reports_to_id, (spans.get(m.reports_to_id) ?? 0) + 1);
  }
  const ownerSpan = roots.length;
  return {
    headcount: members.filter((m) => m.invite_status !== 'pending').length,
    pending: members.filter((m) => m.invite_status === 'pending').length,
    managers: members.filter((m) => managerIds.has(m.id)).length,
    // The owner is level 1; each tree depth adds one.
    levels: members.length === 0 ? 1 : maxDepth + 2,
    widestSpan: Math.max(ownerSpan, ...spans.values(), 0),
  };
}

/** Ids of everyone below `id` (any depth). */
export function descendantIds(members: OrgMember[], id: string): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const m of members) {
    if (m.reports_to_id) childrenOf.set(m.reports_to_id, [...(childrenOf.get(m.reports_to_id) ?? []), m.id]);
  }
  const out = new Set<string>();
  const stack = [...(childrenOf.get(id) ?? [])];
  while (stack.length) {
    const next = stack.pop() as string;
    if (out.has(next) || next === id) continue;
    out.add(next);
    stack.push(...(childrenOf.get(next) ?? []));
  }
  return out;
}

/** People `memberId` may report to: everyone except themselves and their own reports (no loops). */
export function eligibleManagers(members: OrgMember[], memberId: string): OrgMember[] {
  const blocked = descendantIds(members, memberId);
  blocked.add(memberId);
  return members.filter((m) => !blocked.has(m.id)).sort(byName);
}

/** The chain of managers above `id`, nearest first (stops safely on bad data). */
export function managerChain(members: OrgMember[], id: string): OrgMember[] {
  const byId = new Map(members.map((m) => [m.id, m]));
  const out: OrgMember[] = [];
  const seen = new Set<string>([id]);
  let cur = byId.get(id)?.reports_to_id ?? null;
  while (cur && !seen.has(cur)) {
    const m = byId.get(cur);
    if (!m) break;
    out.push(m);
    seen.add(cur);
    cur = m.reports_to_id;
  }
  return out;
}

// ============================================================
// SEARCH
// ============================================================

/**
 * `matches` = people whose name, title or email contain the query;
 * `visible` = matches plus all their managers (so results keep their context).
 * An empty query matches everyone.
 */
export function searchOrg(members: OrgMember[], query: string): { matches: Set<string>; visible: Set<string> } {
  const q = query.trim().toLowerCase();
  if (!q) {
    const all = new Set(members.map((m) => m.id));
    return { matches: all, visible: all };
  }
  const matches = new Set<string>();
  for (const m of members) {
    const hay = `${m.name} ${m.title ?? ''} ${m.email ?? ''} ${ROLE_LABELS[m.access_role]}`.toLowerCase();
    if (hay.includes(q)) matches.add(m.id);
  }
  const visible = new Set(matches);
  for (const id of matches) for (const mgr of managerChain(members, id)) visible.add(mgr.id);
  return { matches, visible };
}

// ============================================================
// FORM + DISPLAY HELPERS
// ============================================================

export interface PositionForm {
  title: string;
  reportsTo: string; // '' = the owner
  note: string;
}

export function validatePositionForm(form: PositionForm): Partial<Record<'title' | 'note', string>> {
  const errors: Partial<Record<'title' | 'note', string>> = {};
  if (form.title.trim().length > TITLE_MAX) errors.title = `Keep the title to ${TITLE_MAX} characters or fewer.`;
  if (form.note.trim().length > NOTE_MAX) errors.note = `Keep the note to ${NOTE_MAX} characters or fewer.`;
  return errors;
}

export function positionChanged(member: OrgMember, form: PositionForm): boolean {
  return (member.title ?? '') !== form.title.trim() || (member.reports_to_id ?? '') !== form.reportsTo;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : '';
  return (first + last).toUpperCase() || '?';
}

/** "2 yrs 3 mos", "5 mos", "Less than a month". */
export function tenureLabel(sinceIso: string | null, now: number = Date.now()): string {
  if (!sinceIso) return '';
  const start = new Date(sinceIso);
  if (Number.isNaN(start.getTime())) return '';
  const end = new Date(now);
  let months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  if (end.getDate() < start.getDate()) months -= 1;
  if (months < 1) return 'Less than a month';
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const y = years > 0 ? `${years} ${years === 1 ? 'yr' : 'yrs'}` : '';
  const m = rest > 0 ? `${rest} ${rest === 1 ? 'mo' : 'mos'}` : '';
  return [y, m].filter(Boolean).join(' ');
}

export function periodLabel(startIso: string, endIso: string | null): string {
  const fmt = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  };
  return `${fmt(startIso)} – ${endIso ? fmt(endIso) : 'Present'}`;
}

type DbErrorLike = { code?: string; message?: string } | null;

export function orgErrorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const e = err as DbErrorLike;
  if (!e) return fallback;
  if (e.code === '42501') return e.message && !/not authorised/i.test(e.message) ? e.message : "You don't have permission to do that.";
  if (e.message && (e.code === 'P0001' || e.code === 'P0002')) return e.message;
  if (e.message && /Failed to fetch|NetworkError|network/i.test(e.message)) return "You're offline — check your connection and try again.";
  return fallback;
}
