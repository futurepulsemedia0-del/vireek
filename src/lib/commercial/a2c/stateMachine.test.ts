import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STAGES, SOURCES, type Stage } from './types';
import { TRANSITIONS, checkTransition, userNextStages } from './stateMachine';

// The v1 CASE table from 20280302000000_commercial_approval_to_cash.sql — none of it may regress.
const V1: Record<string, string[]> = {
  draft: ['sent', 'paid', 'void'],
  blocked_needs_approval: ['sent', 'void'],
  sent: ['received', 'approved', 'rejected', 'paid', 'void'],
  received: ['approved', 'rejected', 'paid', 'void'],
  approved: ['rejected', 'paid', 'void'],
  rejected: ['sent', 'received', 'approved', 'paid', 'void'],
};

const legal = new Set(TRANSITIONS.map((t) => `${t.from}>${t.to}`));

describe('state machine: every (from, to) pair', () => {
  for (const from of STAGES) {
    for (const to of STAGES) {
      if (from === to) continue;
      it(`${from} -> ${to} is ${legal.has(`${from}>${to}`) ? 'legal' : 'illegal'}`, () => {
        const sources = TRANSITIONS.find((t) => t.from === from && t.to === to)?.sources ?? [];
        // the strongest source set the table allows, with a reason, must succeed; with no table row it must fail
        const results = SOURCES.map((s) => checkTransition(from, to, s, 'valid reason'));
        if (legal.has(`${from}>${to}`)) {
          for (const s of SOURCES) {
            const r = checkTransition(from, to, s, 'valid reason');
            expect(r.ok, `${s}`).toBe(sources.includes(s));
          }
        } else {
          expect(results.every((r) => !r.ok && r.error === 'illegal_transition')).toBe(true);
        }
      });
    }
  }
});

describe('state machine: rules', () => {
  it('same-stage is an idempotent no-op', () => {
    for (const s of STAGES) expect(checkTransition(s, s, 'user')).toEqual({ ok: true, transition: null });
  });
  it('keeps every v1 transition legal for user/system callers (no regression)', () => {
    for (const [from, tos] of Object.entries(V1)) {
      for (const to of tos) expect(legal.has(`${from}>${to}`), `${from}>${to}`).toBe(true);
    }
  });
  it('void is terminal; paid only leaves nowhere', () => {
    expect(TRANSITIONS.some((t) => t.from === 'void')).toBe(false);
    expect(TRANSITIONS.some((t) => t.from === 'paid')).toBe(false);
  });
  it('only the system can mark paid; only a user can write off', () => {
    for (const t of TRANSITIONS.filter((x) => x.to === 'paid')) expect(t.sources).toEqual(['system']);
    for (const t of TRANSITIONS.filter((x) => x.to === 'written_off' && x.from !== 'written_off')) expect(t.sources).toEqual(['user']);
  });
  it('rejection, dispute, write-off and void need a reason', () => {
    for (const t of TRANSITIONS.filter((x) => ['rejected', 'disputed', 'written_off', 'void'].includes(x.to))) expect(t.requiresReason, `${t.from}>${t.to}`).toBe(true);
    expect(checkTransition('sent', 'rejected', 'user', '  ')).toEqual({ ok: false, error: 'reason_required' });
    expect(checkTransition('sent', 'rejected', 'user', 'ab')).toEqual({ ok: false, error: 'reason_required' });
    expect(checkTransition('sent', 'rejected', 'portal', 'PO missing').ok).toBe(true);
  });
  it('a portal or email parse can never mark paid, void or write off', () => {
    for (const src of ['portal', 'email_parse'] as const) {
      for (const to of ['paid', 'void', 'written_off'] as const) {
        for (const from of STAGES) expect(checkTransition(from as Stage, to, src, 'valid reason').ok && from !== to).toBe(false);
      }
    }
  });
  it('a rejected invoice can be resubmitted', () => {
    expect(checkTransition('rejected', 'sent', 'user').ok).toBe(true);
  });
  it('userNextStages never offers paid or void', () => {
    for (const s of STAGES) expect(userNextStages(s)).not.toEqual(expect.arrayContaining(['paid']));
    expect(userNextStages('sent')).toEqual(expect.arrayContaining(['received', 'approved', 'rejected', 'disputed']));
  });
});

describe('state machine: parity with the SQL migration', () => {
  it('commercial_stage_transitions seed equals TRANSITIONS exactly', () => {
    const sql = readFileSync('supabase/migrations/20290312000000_commercial_a2c_v2.sql', 'utf8');
    const block = sql.split('INSERT INTO commercial_stage_transitions')[1].split('ON CONFLICT')[0];
    const rows = [...block.matchAll(/\('(\w+)','(\w+)','\{([\w,]+)\}',(true|false)\)/g)].map((m) => ({
      from: m[1], to: m[2], sources: m[3].split(','), requiresReason: m[4] === 'true',
    }));
    const ts = TRANSITIONS.map((t) => ({ from: t.from, to: t.to, sources: [...t.sources], requiresReason: t.requiresReason }));
    expect(rows).toEqual(ts);
  });
  it('the stage CHECK in SQL lists exactly STAGES', () => {
    const sql = readFileSync('supabase/migrations/20290312000000_commercial_a2c_v2.sql', 'utf8');
    const m = sql.match(/commercial_invoice_tracking_stage_check CHECK \(stage IN \(([^)]*)\)\)/);
    const list = (m?.[1] ?? '').match(/'(\w+)'/g)?.map((x) => x.replace(/'/g, '')) ?? [];
    expect([...list].sort()).toEqual([...STAGES].sort());
  });
});
