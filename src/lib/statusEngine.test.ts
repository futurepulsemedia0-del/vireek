import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_STATUSES,
  STATUS_COLORS,
  SYSTEM_DEFINITION_DEFAULTS,
  activeDefinitions,
  deriveKey,
  evaluateTransition,
  missingRequiredFields,
  resolveJobDefinition,
  validateDefinitionDraft,
  type StatusDefinition,
  type StatusTransition,
} from '@/lib/statusEngine';

const SQL = readFileSync(resolve(process.cwd(), 'supabase/migrations/20281110000000_status_stage_engine.sql'), 'utf8');

function def(over: Partial<StatusDefinition> & { id: string; key: string }): StatusDefinition {
  return {
    user_id: 'u1', scope: 'job', label: over.key, label_i18n: {}, color: 'neutral', canonical_status: 'scheduled',
    sort_order: 0, is_system: false, requires_note: false, required_fields: [], sla_minutes: null, version: 1,
    archived_at: null, created_at: '', updated_at: '', ...over,
  };
}
const sys = SYSTEM_DEFINITION_DEFAULTS.map((d, i) =>
  def({ id: `sys-${d.key}`, key: d.key, label: d.label, color: d.color, canonical_status: d.key, sort_order: d.sortOrder + i * 0, is_system: true }),
);
const waitingPermit = def({ id: 'c1', key: 'waiting_permit', label: 'Waiting for permit', canonical_status: 'waiting_on_customer', sla_minutes: 600 });

describe('SQL ↔ TS parity', () => {
  it('canonical list equals the CHECK list in the migration', () => {
    const block = /canonical_status text NOT NULL CHECK \(canonical_status IN \(([\s\S]*?)\)\)/.exec(SQL)?.[1] ?? '';
    const sqlList = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(sqlList).toEqual([...CANONICAL_STATUSES].sort());
  });
  it('color list equals the CHECK list', () => {
    const block = /color IN \(([^)]*)\)/.exec(SQL)?.[1] ?? '';
    expect([...block.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort()).toEqual([...STATUS_COLORS].sort());
  });
  it('seed rows equal SYSTEM_DEFINITION_DEFAULTS', () => {
    const rows = [...SQL.matchAll(/\('([a-z_]+)',\s+'([^']+)',\s+'([a-z]+)',\s+(\d+)\)/g)].map((m) => ({
      key: m[1], label: m[2], color: m[3], sortOrder: Number(m[4]),
    }));
    expect(rows).toEqual(SYSTEM_DEFINITION_DEFAULTS.map((d) => ({ ...d })));
  });
});

describe('deriveKey', () => {
  it('slugifies and keeps a leading letter', () => {
    expect(deriveKey('Waiting for permit!')).toBe('waiting_for_permit');
    expect(deriveKey('  Déjà vu ')).toBe('deja_vu');
    expect(deriveKey('2nd visit')).toBe('s_2nd_visit');
    expect(deriveKey('🙂')).toBe('');
  });
});

describe('validateDefinitionDraft', () => {
  const ok = { label: 'Awaiting inspection', color: 'info' as const, canonical_status: 'on_hold' as const };
  it('accepts a valid draft', () => expect(validateDefinitionDraft(ok, sys).ok).toBe(true));
  it('rejects duplicate label (case-insensitive) and duplicate key', () => {
    expect(validateDefinitionDraft({ ...ok, label: 'scheduled' }, sys).errors.label).toBe('labelTaken');
    expect(validateDefinitionDraft({ ...ok, label: 'Other', key: 'scheduled' }, sys).errors.key).toBe('keyTaken');
  });
  it('allows reusing the label of an archived definition', () => {
    const archived = def({ id: 'a', key: 'old', label: 'Awaiting inspection', archived_at: '2028-01-01' });
    expect(validateDefinitionDraft(ok, [...sys, archived]).ok).toBe(true);
  });
  it('SLA only for workflow canonical statuses and within range', () => {
    expect(validateDefinitionDraft({ ...ok, canonical_status: 'completed', sla_minutes: 60 }, sys).errors.sla_minutes).toBe('slaNotSupported');
    expect(validateDefinitionDraft({ ...ok, sla_minutes: 1 }, sys).errors.sla_minutes).toBe('slaOutOfRange');
    expect(validateDefinitionDraft({ ...ok, sla_minutes: 60 }, sys).ok).toBe(true);
  });
  it('validates required_fields and the 40 active cap', () => {
    expect(validateDefinitionDraft({ ...ok, required_fields: ['Bad Key'] }, sys).errors.required_fields).toBe('requiredFieldsInvalid');
    const many = Array.from({ length: 40 }, (_, i) => def({ id: `m${i}`, key: `k${i}x`, label: `L${i}` }));
    expect(validateDefinitionDraft(ok, many).errors.form).toBe('limitReached');
  });
  it('editing skips key checks and ignores itself for label uniqueness', () => {
    expect(validateDefinitionDraft({ ...ok, label: 'Waiting for permit', canonical_status: 'waiting_on_customer' }, [...sys, waitingPermit], 'c1').ok).toBe(true);
  });
});

describe('resolveJobDefinition', () => {
  const all = [...sys, waitingPermit];
  it('falls back to the system definition (legacy rows need no backfill)', () => {
    expect(resolveJobDefinition({ job_status: 'completed' }, all)?.id).toBe('sys-completed');
  });
  it('uses the custom definition only while canonical matches job_status', () => {
    expect(resolveJobDefinition({ job_status: 'waiting_on_customer', custom_status_id: 'c1' }, all)?.id).toBe('c1');
    expect(resolveJobDefinition({ job_status: 'scheduled', custom_status_id: 'c1' }, all)?.id).toBe('sys-scheduled');
  });
  it('is null-safe when definitions are not loaded', () => {
    expect(resolveJobDefinition({ job_status: 'scheduled', custom_status_id: 'zzz' }, [])).toBeNull();
  });
  it('activeDefinitions hides archived and orders by sort_order', () => {
    const list = activeDefinitions([...sys, def({ id: 'x', key: 'xx', label: 'X', archived_at: 'now' })]);
    expect(list.some((d) => d.id === 'x')).toBe(false);
    expect(list[0]?.key).toBe('scheduled');
  });
});

describe('evaluateTransition', () => {
  const from = sys.find((d) => d.key === 'in_progress')!;
  const onHold = sys.find((d) => d.key === 'on_hold')!;
  const rule = (over: Partial<StatusTransition>): StatusTransition => ({
    id: 'r', from_definition_id: null, to_definition_id: waitingPermit.id, allowed_roles: ['admin', 'owner'], requires_note: false, ...over,
  });

  it('no rules = unrestricted, but workflow targets need a reason', () => {
    expect(evaluateTransition({ from, to: waitingPermit, role: 'technician', rules: [] })).toEqual({ allowed: false, code: 'reasonRequired' });
    expect(evaluateTransition({ from, to: waitingPermit, role: 'technician', rules: [], reasonCode: 'awaiting_access' })).toEqual({ allowed: true, needsReason: true });
  });
  it('enforces roles; owner bypasses the role list but not the existence of a rule', () => {
    const rules = [rule({ allowed_roles: ['admin'] })];
    expect(evaluateTransition({ from, to: waitingPermit, role: 'technician', rules, reasonCode: 'x' })).toEqual({ allowed: false, code: 'transitionNotAllowed' });
    expect(evaluateTransition({ from, to: waitingPermit, role: 'owner', rules, reasonCode: 'x' }).allowed).toBe(true);
    expect(evaluateTransition({ from, to: onHold, role: 'owner', rules, reasonCode: 'x' })).toEqual({ allowed: false, code: 'transitionNotAllowed' });
  });
  it('from-specific rule wins over wildcard; wrong from is rejected when only specific exists', () => {
    const rules = [rule({ from_definition_id: 'sys-scheduled' })];
    expect(evaluateTransition({ from, to: waitingPermit, role: 'admin', rules, reasonCode: 'x' }).allowed).toBe(false);
  });
  it('requires note (definition or rule) with at least 3 characters', () => {
    const noted = { ...waitingPermit, requires_note: true };
    expect(evaluateTransition({ from, to: noted, role: 'owner', rules: [], reasonCode: 'x', note: ' a ' })).toEqual({ allowed: false, code: 'noteRequired' });
    expect(evaluateTransition({ from, to: waitingPermit, role: 'owner', rules: [rule({ requires_note: true })], reasonCode: 'x' }).allowed).toBe(false);
    expect(evaluateTransition({ from, to: noted, role: 'owner', rules: [], reasonCode: 'x', note: 'abc' }).allowed).toBe(true);
  });
  it('required fields are checked and reported sorted', () => {
    const to = { ...waitingPermit, required_fields: ['permit_no', 'inspector'] };
    expect(evaluateTransition({ from, to, role: 'owner', rules: [], reasonCode: 'x', customData: { permit_no: ' ' } })).toEqual({
      allowed: false, code: 'missingFields', fields: ['inspector', 'permit_no'],
    });
    expect(missingRequiredFields(['a'], { a: 0 })).toEqual([]);
    expect(missingRequiredFields(['a'], { a: false })).toEqual([]);
  });
  it('rejects archived targets and no-op moves', () => {
    expect(evaluateTransition({ from, to: { ...waitingPermit, archived_at: 'x' }, role: 'owner', rules: [] })).toEqual({ allowed: false, code: 'archived' });
    expect(evaluateTransition({ from: waitingPermit, to: waitingPermit, role: 'owner', rules: [] })).toEqual({ allowed: false, code: 'unchanged' });
  });
  it('same canonical status needs no new reason', () => {
    const other = { ...waitingPermit, id: 'c2', key: 'waiting_quote' };
    expect(evaluateTransition({ from: waitingPermit, to: other, role: 'owner', rules: [] })).toEqual({ allowed: true, needsReason: false });
  });
});
