/**
 * Attribute-based, field-level and record-level access (pure domain logic).
 *
 * Typed model on purpose (no free-form expression language) so the SQL function
 * `authz_allows(...)` can implement the exact same semantics natively and the two
 * can be parity-tested. Decision order:
 *
 *   1. Owner                          -> allow (owners can never lock themselves out)
 *   2. Record ACL (active entries)    -> explicit deny beats explicit allow; either beats policies
 *   3. Attribute policies             -> every APPLICABLE policy's requirements must pass
 *   4. Otherwise                      -> the caller's base decision (existing RLS/permission result)
 */

export type AbacAction = 'select' | 'insert' | 'update' | 'delete';

export interface PrincipalAttrs {
  userId: string;
  isOwner: boolean;
  /** Empty = not location-restricted. */
  locationIds: readonly string[];
  /** Empty = not team-restricted. */
  teamIds: readonly string[];
  clearances: readonly string[];
}

export interface RecordAttrs {
  resource: string;
  recordId: string;
  locationId: string | null;
  teamId: string | null;
  valueCents: number | null;
  sensitivityTags: readonly string[];
}

export interface AbacPolicy {
  id: string;
  resource: string;
  actions: readonly AbacAction[];
  enabled: boolean;
  // applies when ALL set conditions hold:
  appliesMinValueCents: number | null;
  appliesTags: readonly string[];
  // requirements the principal must meet when the policy applies:
  requireLocationMatch: boolean;
  requireTeamMatch: boolean;
  requireClearance: string | null;
}

export interface AclEntry {
  resource: string;
  recordId: string;
  userId: string;
  effect: 'allow' | 'deny';
  actions: readonly AbacAction[];
  expiresAt: string | null;
}

export type FieldStrategy = 'redact' | 'null' | 'partial';

export interface FieldMaskRule {
  resource: string;
  field: string;
  strategy: FieldStrategy;
  /** Principals holding this clearance see the real value. */
  exemptClearance: string | null;
}

export interface Decision {
  allowed: boolean;
  /** Machine-readable reason, stable for tests and for the policy simulator UI. */
  reason:
    | 'owner'
    | 'acl_deny'
    | 'acl_allow'
    | 'policy_location'
    | 'policy_team'
    | 'policy_clearance'
    | 'base_allowed'
    | 'base_denied';
  policyId: string | null;
}

function policyApplies(p: AbacPolicy, r: RecordAttrs): boolean {
  if (p.appliesMinValueCents !== null && (r.valueCents === null || r.valueCents < p.appliesMinValueCents)) return false;
  if (p.appliesTags.length > 0 && !p.appliesTags.some((t) => r.sensitivityTags.includes(t))) return false;
  return true;
}

/** Fail-closed: a restricted principal never matches a record that has no location/team. */
function matches(restrictedTo: readonly string[], value: string | null): boolean {
  if (restrictedTo.length === 0) return true;
  return value !== null && restrictedTo.includes(value);
}

export function decide(
  principal: PrincipalAttrs,
  record: RecordAttrs,
  action: AbacAction,
  ctx: { policies: readonly AbacPolicy[]; acl: readonly AclEntry[]; baseAllowed: boolean; now: string },
): Decision {
  if (principal.isOwner) return { allowed: true, reason: 'owner', policyId: null };

  const active = ctx.acl.filter(
    (e) =>
      e.userId === principal.userId &&
      e.resource === record.resource &&
      e.recordId === record.recordId &&
      e.actions.includes(action) &&
      (e.expiresAt === null || Date.parse(e.expiresAt) > Date.parse(ctx.now)),
  );
  if (active.some((e) => e.effect === 'deny')) return { allowed: false, reason: 'acl_deny', policyId: null };
  if (active.some((e) => e.effect === 'allow')) return { allowed: true, reason: 'acl_allow', policyId: null };

  for (const p of [...ctx.policies].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!p.enabled || p.resource !== record.resource || !p.actions.includes(action) || !policyApplies(p, record)) continue;
    if (p.requireLocationMatch && !matches(principal.locationIds, record.locationId)) {
      return { allowed: false, reason: 'policy_location', policyId: p.id };
    }
    if (p.requireTeamMatch && !matches(principal.teamIds, record.teamId)) {
      return { allowed: false, reason: 'policy_team', policyId: p.id };
    }
    if (p.requireClearance !== null && !principal.clearances.includes(p.requireClearance)) {
      return { allowed: false, reason: 'policy_clearance', policyId: p.id };
    }
  }
  return { allowed: ctx.baseAllowed, reason: ctx.baseAllowed ? 'base_allowed' : 'base_denied', policyId: null };
}

function maskPartial(value: string): string {
  if (value.length <= 4) return '•'.repeat(value.length);
  return `${'•'.repeat(value.length - 4)}${value.slice(-4)}`;
}

/** Returns a copy of the row with masked fields replaced. Owners and exempt clearances see real values. */
export function maskRecord<T extends Record<string, unknown>>(
  row: T,
  resource: string,
  principal: PrincipalAttrs,
  rules: readonly FieldMaskRule[],
): T {
  if (principal.isOwner) return row;
  const out: Record<string, unknown> = { ...row };
  for (const rule of rules) {
    if (rule.resource !== resource || !(rule.field in out)) continue;
    if (rule.exemptClearance !== null && principal.clearances.includes(rule.exemptClearance)) continue;
    const current = out[rule.field];
    if (current === null || current === undefined) continue;
    if (rule.strategy === 'null') out[rule.field] = null;
    else if (rule.strategy === 'redact') out[rule.field] = typeof current === 'number' ? 0 : '••••';
    else out[rule.field] = typeof current === 'string' ? maskPartial(current) : null;
  }
  return out as T;
}

/** Policy simulation: who can see this record? */
export function whoCanSee(
  record: RecordAttrs,
  principals: readonly PrincipalAttrs[],
  ctx: { policies: readonly AbacPolicy[]; acl: readonly AclEntry[]; baseAllowed: (p: PrincipalAttrs) => boolean; now: string },
): { userId: string; decision: Decision }[] {
  return principals.map((p) => ({
    userId: p.userId,
    decision: decide(p, record, 'select', { ...ctx, baseAllowed: ctx.baseAllowed(p) }),
  }));
}

/** Policy simulation: what can this person see? */
export function whatCanSee(
  principal: PrincipalAttrs,
  records: readonly RecordAttrs[],
  ctx: { policies: readonly AbacPolicy[]; acl: readonly AclEntry[]; baseAllowed: boolean; now: string },
): { recordId: string; decision: Decision }[] {
  return records.map((r) => ({ recordId: r.recordId, decision: decide(principal, r, 'select', ctx) }));
}
