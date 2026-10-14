/**
 * Vireek Universal Identity Layer — pure logic (no I/O).
 *
 * Everything the UI needs that is not a database call lives here so it is unit-tested:
 * universal-ID validation (mirrors identity_checksum() in SQL), the lifecycle state machine
 * (mirrors identity_transition_allowed()), defensive payload normalisers, a deterministic graph
 * layout, and server-error → human message mapping. Backed by
 * supabase/migrations/20270415000000_universal_identity_layer.sql.
 */

// ---------------------------------------------------------------------------------------------
// Entity types
// ---------------------------------------------------------------------------------------------

export const ENTITY_TYPES = [
  'person', 'company', 'property', 'equipment', 'service', 'technician',
  'contractor', 'part', 'agent', 'outcome', 'evidence', 'transaction',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ENTITY_TYPE_META: Record<EntityType, { code: string; label: string; plural: string; hint: string; color: string }> = {
  person: { code: 'PER', label: 'Person', plural: 'People', hint: 'A human: customer, occupant, owner', color: '#3b82f6' },
  company: { code: 'CMP', label: 'Company', plural: 'Companies', hint: 'A legal organisation or business account', color: '#8b5cf6' },
  property: { code: 'PRP', label: 'Property', plural: 'Properties', hint: 'A building, unit or service site', color: '#14b8a6' },
  equipment: { code: 'EQP', label: 'Equipment', plural: 'Equipment', hint: 'A physical unit with a serial number', color: '#f59e0b' },
  service: { code: 'SVC', label: 'Service', plural: 'Services', hint: 'A job, visit or service event', color: '#ec4899' },
  technician: { code: 'TEC', label: 'Technician', plural: 'Technicians', hint: 'A field professional identity', color: '#22c55e' },
  contractor: { code: 'CTR', label: 'Contractor', plural: 'Contractors', hint: 'An external contracting party', color: '#f97316' },
  part: { code: 'PRT', label: 'Part', plural: 'Parts', hint: 'A component or consumable', color: '#a855f7' },
  agent: { code: 'AGT', label: 'Agent', plural: 'Agents', hint: 'An AI or automated actor', color: '#06b6d4' },
  outcome: { code: 'OUT', label: 'Outcome', plural: 'Outcomes', hint: 'The result of a service', color: '#84cc16' },
  evidence: { code: 'EVD', label: 'Evidence', plural: 'Evidence', hint: 'A proof artefact: photo, reading, signature', color: '#64748b' },
  transaction: { code: 'TXN', label: 'Transaction', plural: 'Transactions', hint: 'Money moving: invoice, payment, claim', color: '#eab308' },
};

export const isEntityType = (v: unknown): v is EntityType =>
  typeof v === 'string' && (ENTITY_TYPES as readonly string[]).includes(v);

// ---------------------------------------------------------------------------------------------
// Universal ID  VRK-EQP-8F3K2M9QX7T4N6BA-7Q
// ---------------------------------------------------------------------------------------------

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const UID_RE = /^VRK-(PER|CMP|PRP|EQP|SVC|TEC|CTR|PRT|AGT|OUT|EVD|TXN)-([0-9A-HJKMNP-TV-Z]{16})-([0-9A-HJKMNP-TV-Z]{2})$/;

/** Weighted ASCII sum mod 1024 over `typeCode + body`, as 2 base32 chars. Identical to identity_checksum() in SQL. */
export function identityChecksum(compact: string): string {
  let sum = 0;
  for (let i = 0; i < compact.length; i += 1) sum += compact.charCodeAt(i) * (i + 1);
  const chk = sum % 1024;
  return B32[Math.floor(chk / 32)] + B32[chk % 32];
}

export interface ParsedUid { code: string; type: EntityType; body: string; checksum: string }

const CODE_TO_TYPE = Object.fromEntries(ENTITY_TYPES.map((t) => [ENTITY_TYPE_META[t].code, t])) as Record<string, EntityType>;

/** Normalises user input (case, whitespace) and validates format AND checksum. Returns null when invalid. */
export function parseIdentityUid(input: string): ParsedUid | null {
  const m = UID_RE.exec(input.trim().toUpperCase());
  if (!m) return null;
  const [, code, body, checksum] = m;
  if (identityChecksum(code + body) !== checksum) return null;
  return { code, type: CODE_TO_TYPE[code], body, checksum };
}

export const isValidIdentityUid = (input: string): boolean => parseIdentityUid(input) !== null;

/** `VRK-EQP-8F3K…N6BA-7Q` for tight UI spaces; the full ID is always one click away. */
export function shortUid(uid: string): string {
  const p = parseIdentityUid(uid);
  return p ? `VRK-${p.code}-${p.body.slice(0, 4)}…${p.body.slice(-4)}-${p.checksum}` : uid;
}

/** True when the query looks like a universal ID (so search can jump straight to it). */
export const looksLikeUid = (q: string): boolean => /^VRK-/i.test(q.trim());

// ---------------------------------------------------------------------------------------------
// Lifecycle (mirror of identity_transition_allowed)
// ---------------------------------------------------------------------------------------------

export const LIFECYCLE_STATES = ['draft', 'active', 'suspended', 'disputed', 'retired', 'merged', 'erased'] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const LIFECYCLE_META: Record<LifecycleState, { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted'; description: string }> = {
  draft: { label: 'Draft', tone: 'muted', description: 'Registered but not yet confirmed.' },
  active: { label: 'Active', tone: 'ok', description: 'Live and usable across the ecosystem.' },
  suspended: { label: 'Suspended', tone: 'warn', description: 'Temporarily blocked; can be reactivated.' },
  disputed: { label: 'Disputed', tone: 'warn', description: 'Identity or data is under dispute.' },
  retired: { label: 'Retired', tone: 'muted', description: 'No longer in service. History is kept.' },
  merged: { label: 'Merged', tone: 'muted', description: 'Duplicate; resolves to the surviving entity.' },
  erased: { label: 'Erased', tone: 'bad', description: 'Personal data removed. The ID is never reused.' },
};

export function allowedTransitions(from: LifecycleState): LifecycleState[] {
  switch (from) {
    case 'draft': return ['active', 'retired'];
    case 'active': return ['suspended', 'disputed', 'retired'];
    case 'suspended': return ['active', 'disputed', 'retired'];
    case 'disputed': return ['active', 'suspended', 'retired'];
    case 'retired': return ['active'];
    default: return [];
  }
}

export const canTransition = (from: LifecycleState, to: LifecycleState): boolean => allowedTransitions(from).includes(to);
export const transitionNeedsReason = (to: LifecycleState): boolean => to === 'suspended' || to === 'disputed' || to === 'retired';
export const isTerminal = (s: LifecycleState): boolean => s === 'merged' || s === 'erased';

// ---------------------------------------------------------------------------------------------
// Assurance / confidence
// ---------------------------------------------------------------------------------------------

export const ASSURANCE_LEVELS = ['unverified', 'self_asserted', 'system_derived', 'verified', 'authoritative'] as const;
export type Assurance = (typeof ASSURANCE_LEVELS)[number];

export const ASSURANCE_LABELS: Record<Assurance, string> = {
  unverified: 'Unverified', self_asserted: 'Self-asserted', system_derived: 'System-derived', verified: 'Verified', authoritative: 'Authoritative',
};

export const SOURCE_LABELS: Record<string, string> = {
  user_entry: 'Entered by a person', system_derived: 'Derived by the system', import: 'Imported', sensor: 'Sensor reading',
  document: 'Document', customer_attested: 'Attested by customer', third_party: 'Third party', ai_inference: 'AI inference', authoritative: 'Authoritative registry',
};

export function confidenceLabel(c: number): 'High' | 'Good' | 'Fair' | 'Low' {
  if (c >= 0.85) return 'High';
  if (c >= 0.7) return 'Good';
  if (c >= 0.5) return 'Fair';
  return 'Low';
}

export const formatConfidence = (c: number): string => `${Math.round(clamp01(c) * 100)}%`;

// ---------------------------------------------------------------------------------------------
// Normalised payload types (the database returns jsonb; never trust its shape in the UI)
// ---------------------------------------------------------------------------------------------

export interface IdentityEntity {
  id: string; uid: string; entity_type: EntityType; scope: 'tenant' | 'global'; display_name: string;
  lifecycle_state: LifecycleState; lifecycle_reason: string | null; merged_into_id: string | null;
  confidence: number; assurance: Assurance; version: number; created_at: string | null; updated_at: string | null;
  attributes: Record<string, unknown>; attributes_redacted: boolean;
}
export interface IdentityRef { id: string; system: string; ref_type: string; ref_value: string; status: 'active' | 'retired'; created_at: string | null }
export interface IdentityRelationship {
  id: string; rel_type: string; status: 'active' | 'ended'; direction: 'in' | 'out'; label: string; confidence: number;
  valid_from: string | null; valid_to: string | null; other_id: string; other_uid: string | null; other_type: EntityType | null; other_name: string;
}
export interface IdentityProvenance {
  id: string; claim_path: string; source_type: string; source_system: string | null; source_ref: string | null; method: string | null;
  actor_type: string; confidence: number; recorded_at: string | null;
}
export interface IdentityEvent {
  seq: number; event_type: string; actor_type: string; reason: string | null; diff_keys: string[]; event_hash: string; occurred_at: string | null;
  payload: Record<string, unknown> | null;
}
export interface IdentityGrant { id: string; grantee_kind: 'tenant' | 'agent'; grantee_id: string; actions: string[]; purpose: string; expires_at: string | null; created_at: string | null }
export interface IdentityPermissions { read_attributes: boolean; link: boolean; write: boolean; manage: boolean }
export interface IdentityDossier {
  found: boolean; entity: IdentityEntity | null; permissions: IdentityPermissions;
  refs: IdentityRef[]; relationships: IdentityRelationship[]; provenance: IdentityProvenance[]; events: IdentityEvent[]; grants: IdentityGrant[];
}
export interface GraphNode { id: string; uid: string; entity_type: EntityType; display_name: string; lifecycle_state: LifecycleState; confidence: number; depth: number }
export interface GraphEdge { id: string; src: string; dst: string; rel_type: string; status: 'active' | 'ended'; confidence: number }
export interface IdentityGraph { found: boolean; root_id: string; nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }
export interface SearchResult { total: number; limit: number; offset: number; items: IdentityEntity[] }
export interface CoverageRow { key: string; label: string; total: number; registered: number }
export interface IdentityOverview {
  entities: number; by_type: Partial<Record<EntityType, number>>; by_state: Partial<Record<LifecycleState, number>>;
  relationships: number; events: number; provenance_claims: number; grants_given: number; grants_received: number;
  avg_confidence: number | null; coverage: CoverageRow[];
}
export interface ChainStatus { found: boolean; valid: boolean; events: number; broken_at_seq: number | null }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown): boolean => v === true;
export const clamp01 = (n: number): number => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : d);

export function normalizeEntity(raw: unknown): IdentityEntity | null {
  const r = obj(raw);
  const id = str(r.id);
  if (!id || !isEntityType(r.entity_type)) return null;
  return {
    id, uid: str(r.uid), entity_type: r.entity_type, scope: r.scope === 'global' ? 'global' : 'tenant', display_name: str(r.display_name, 'Unnamed'),
    lifecycle_state: oneOf(r.lifecycle_state, LIFECYCLE_STATES, 'active'), lifecycle_reason: strOrNull(r.lifecycle_reason), merged_into_id: strOrNull(r.merged_into_id),
    confidence: clamp01(num(r.confidence, 0.5)), assurance: oneOf(r.assurance, ASSURANCE_LEVELS, 'unverified'), version: num(r.version, 1),
    created_at: strOrNull(r.created_at), updated_at: strOrNull(r.updated_at), attributes: obj(r.attributes), attributes_redacted: bool(r.attributes_redacted),
  };
}

export function normalizeDossier(raw: unknown): IdentityDossier {
  const r = obj(raw);
  const entity = normalizeEntity(r.entity);
  const p = obj(r.permissions);
  return {
    found: bool(r.found) && entity !== null, entity,
    permissions: { read_attributes: bool(p.read_attributes), link: bool(p.link), write: bool(p.write), manage: bool(p.manage) },
    refs: arr(r.refs).map((x) => { const o = obj(x); return { id: str(o.id), system: str(o.system), ref_type: str(o.ref_type), ref_value: str(o.ref_value), status: o.status === 'retired' ? 'retired' as const : 'active' as const, created_at: strOrNull(o.created_at) }; }).filter((x) => x.id),
    relationships: arr(r.relationships).map((x) => {
      const o = obj(x);
      const out = o.direction !== 'in';
      return {
        id: str(o.id), rel_type: str(o.rel_type), status: o.status === 'ended' ? 'ended' as const : 'active' as const, direction: out ? 'out' as const : 'in' as const,
        label: str(out ? o.label : o.inverse_label, str(o.rel_type).replace(/_/g, ' ')), confidence: clamp01(num(o.confidence, 0.5)),
        valid_from: strOrNull(o.valid_from), valid_to: strOrNull(o.valid_to), other_id: str(o.other_id), other_uid: strOrNull(o.other_uid),
        other_type: isEntityType(o.other_type) ? o.other_type : null, other_name: str(o.other_name, 'Restricted entity'),
      };
    }).filter((x) => x.id && x.other_id),
    provenance: arr(r.provenance).map((x) => { const o = obj(x); return { id: str(o.id), claim_path: str(o.claim_path, '*'), source_type: str(o.source_type), source_system: strOrNull(o.source_system), source_ref: strOrNull(o.source_ref), method: strOrNull(o.method), actor_type: str(o.actor_type), confidence: clamp01(num(o.confidence, 0.5)), recorded_at: strOrNull(o.recorded_at) }; }).filter((x) => x.id),
    events: arr(r.events).map((x) => { const o = obj(x); return { seq: num(o.seq), event_type: str(o.event_type), actor_type: str(o.actor_type), reason: strOrNull(o.reason), diff_keys: arr(o.diff_keys).filter((k): k is string => typeof k === 'string'), event_hash: str(o.event_hash), occurred_at: strOrNull(o.occurred_at), payload: o.payload && typeof o.payload === 'object' ? obj(o.payload) : null }; }).filter((x) => x.seq > 0),
    grants: arr(r.grants).map((x) => { const o = obj(x); return { id: str(o.id), grantee_kind: o.grantee_kind === 'agent' ? 'agent' as const : 'tenant' as const, grantee_id: str(o.grantee_id), actions: arr(o.actions).filter((a): a is string => typeof a === 'string'), purpose: str(o.purpose), expires_at: strOrNull(o.expires_at), created_at: strOrNull(o.created_at) }; }).filter((x) => x.id),
  };
}

export function normalizeGraph(raw: unknown): IdentityGraph {
  const r = obj(raw);
  const nodes = arr(r.nodes).map((x): GraphNode | null => {
    const o = obj(x);
    if (!str(o.id) || !isEntityType(o.entity_type)) return null;
    return { id: str(o.id), uid: str(o.uid), entity_type: o.entity_type, display_name: str(o.display_name, 'Unnamed'), lifecycle_state: oneOf(o.lifecycle_state, LIFECYCLE_STATES, 'active'), confidence: clamp01(num(o.confidence, 0.5)), depth: Math.max(0, num(o.depth)) };
  }).filter((n): n is GraphNode => n !== null);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = arr(r.edges).map((x): GraphEdge => { const o = obj(x); return { id: str(o.id), src: str(o.src), dst: str(o.dst), rel_type: str(o.rel_type), status: o.status === 'ended' ? 'ended' : 'active', confidence: clamp01(num(o.confidence, 0.5)) }; })
    .filter((e) => e.id && ids.has(e.src) && ids.has(e.dst));
  return { found: bool(r.found) && nodes.length > 0, root_id: str(r.root_id), nodes, edges, truncated: bool(r.truncated) };
}

export function normalizeSearch(raw: unknown): SearchResult {
  const r = obj(raw);
  return { total: num(r.total), limit: num(r.limit, 25), offset: num(r.offset), items: arr(r.items).map(normalizeEntity).filter((e): e is IdentityEntity => e !== null) };
}

export function normalizeOverview(raw: unknown): IdentityOverview {
  const r = obj(raw);
  const counts = <K extends string>(v: unknown, keys: readonly K[]): Partial<Record<K, number>> => {
    const o = obj(v); const out: Partial<Record<K, number>> = {};
    for (const k of keys) if (typeof o[k] === 'number') out[k] = o[k] as number;
    return out;
  };
  return {
    entities: num(r.entities), by_type: counts(r.by_type, ENTITY_TYPES), by_state: counts(r.by_state, LIFECYCLE_STATES),
    relationships: num(r.relationships), events: num(r.events), provenance_claims: num(r.provenance_claims),
    grants_given: num(r.grants_given), grants_received: num(r.grants_received), avg_confidence: typeof r.avg_confidence === 'number' ? r.avg_confidence : null,
    coverage: arr(r.coverage).map((x) => { const o = obj(x); return { key: str(o.key), label: str(o.label), total: num(o.total), registered: num(o.registered) }; }).filter((c) => c.key),
  };
}

export function normalizeChain(raw: unknown): ChainStatus {
  const r = obj(raw);
  return { found: bool(r.found), valid: bool(r.valid), events: num(r.events), broken_at_seq: typeof r.broken_at_seq === 'number' ? r.broken_at_seq : null };
}

// ---------------------------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------------------------

export function coveragePercent(rows: CoverageRow[]): number {
  const total = rows.reduce((s, r) => s + r.total, 0);
  if (total === 0) return 100;
  const done = rows.reduce((s, r) => s + Math.min(r.registered, r.total), 0);
  return Math.round((done / total) * 100);
}

export const coverageGap = (row: CoverageRow): number => Math.max(0, row.total - row.registered);

// ---------------------------------------------------------------------------------------------
// Graph layout — deterministic radial rings by depth (same input ⇒ same picture)
// ---------------------------------------------------------------------------------------------

export interface PositionedNode extends GraphNode { x: number; y: number }

export function layoutGraph(nodes: GraphNode[], width: number, height: number): PositionedNode[] {
  if (nodes.length === 0) return [];
  const cx = width / 2;
  const cy = height / 2;
  const maxDepth = nodes.reduce((m, n) => Math.max(m, n.depth), 0);
  const ringStep = maxDepth === 0 ? 0 : (Math.min(width, height) / 2 - 44) / maxDepth;
  const byDepth = new Map<number, GraphNode[]>();
  for (const n of nodes) byDepth.set(n.depth, [...(byDepth.get(n.depth) ?? []), n]);
  const out: PositionedNode[] = [];
  for (const [depth, ring] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...ring].sort((a, b) => a.entity_type.localeCompare(b.entity_type) || a.display_name.localeCompare(b.display_name) || a.id.localeCompare(b.id));
    sorted.forEach((n, i) => {
      if (depth === 0 && sorted.length === 1) { out.push({ ...n, x: cx, y: cy }); return; }
      const angle = (2 * Math.PI * i) / sorted.length - Math.PI / 2 + depth * 0.35;
      const radius = ringStep * depth;
      out.push({ ...n, x: round1(cx + radius * Math.cos(angle)), y: round1(cy + radius * Math.sin(angle)) });
    });
  }
  return out;
}
const round1 = (n: number): number => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------------------------
// Errors & presentation helpers
// ---------------------------------------------------------------------------------------------

const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated: 'Your session has expired. Sign in again.',
  forbidden: 'You do not have permission to do that.',
  version_conflict: 'Someone else changed this entity. Reload and try again.',
  ref_conflict: 'That external reference already belongs to another entity.',
  reserved_ref_system: 'The "vireek" reference system is reserved.',
  relationship_not_allowed: 'These two entity types cannot be connected that way.',
  single_active_violation: 'This relationship can only have one active target. End the current one first.',
  cycle_detected: 'That link would create a loop.',
  entity_terminal: 'This entity is merged or erased and can no longer change.',
  invalid_transition: 'That lifecycle change is not allowed from the current state.',
  reason_required: 'A reason (at least 3 characters) is required.',
  invalid_merge: 'These two entities cannot be merged. They must be the same type and both active in your account.',
  invalid_display_name: 'Enter a name between 1 and 200 characters.',
  invalid_attributes: 'Attributes must be a valid JSON object.',
  invalid_refs: 'One of the external references is malformed.',
  invalid_grantee: 'That recipient is not valid.',
  invalid_expiry: 'Access must expire within the next 366 days.',
  entity_not_found: 'That entity no longer exists.',
  relationship_not_found: 'That relationship is no longer active.',
  grant_not_found: 'That access grant is no longer active.',
};

/** Maps a Supabase/Postgres error to a message safe to show. Unknown errors never leak SQL text. */
export function identityErrorMessage(err: unknown): string {
  const msg = err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : '';
  const key = Object.keys(ERROR_MESSAGES).find((k) => msg === k || msg.includes(k));
  return key ? ERROR_MESSAGES[key] : 'Something went wrong. Please try again.';
}

/** Parses a user-typed JSON object for attributes; returns an error string instead of throwing. */
export function parseAttributesInput(text: string): { value: Record<string, unknown> } | { error: string } {
  const t = text.trim();
  if (t === '') return { value: {} };
  try {
    const v: unknown = JSON.parse(t);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'Attributes must be a JSON object, e.g. {"serial": "A123"}' };
    if (JSON.stringify(v).length > 30000) return { error: 'Attributes are too large (30 KB max).' };
    return { value: v as Record<string, unknown> };
  } catch {
    return { error: 'Attributes are not valid JSON.' };
  }
}

export function relativeTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const s = Math.round((now.getTime() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 2592000) return `${Math.round(s / 86400)} d ago`;
  if (s < 31536000) return `${Math.round(s / 2592000)} mo ago`;
  return `${Math.round(s / 31536000)} y ago`;
}

export const EVENT_LABELS: Record<string, string> = {
  created: 'Identity created', attributes_changed: 'Attributes changed', state_changed: 'Lifecycle changed', relationship_added: 'Relationship added',
  relationship_ended: 'Relationship ended', ref_added: 'External reference added', ref_retired: 'External reference retired', grant_issued: 'Access granted',
  grant_revoked: 'Access revoked', merged_into: 'Merged into another entity', merged_from: 'Absorbed a duplicate', erased: 'Personal data erased',
};
