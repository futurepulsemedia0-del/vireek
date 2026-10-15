import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  createRule,
  createStarterConfig,
  defaultTarget,
  isOpenAt,
  normalizeConfig,
  removeDepartment,
  simulateCall,
  validateConfig,
  wallClockNow,
} from './callRouting';
import type { CallRoutingConfig, RoutingContext, SimulationInput } from './callRouting';

const WEEKDAY = { open: '08:00', close: '17:00', closed: false };

// 2026-10-05 is a Monday, 2026-10-04 a Sunday.
const ctx: RoutingContext = {
  assistantName: 'Sarah',
  businessHours: { mon: WEEKDAY, tue: WEEKDAY, wed: WEEKDAY, thu: WEEKDAY, fri: WEEKDAY, sat: { closed: true }, sun: { closed: true } },
  holidays: [{ id: 'h1', date: '2026-12-25', label: 'Christmas' }],
  members: [
    { id: 'm1', name: 'Maria', phone: '+15125550101', languages: ['Spanish'] },
    { id: 'm2', name: 'Ali', phone: null, languages: ['Persian'] },
  ],
};

const call = (over: Partial<SimulationInput> = {}): SimulationInput => ({
  at: { date: '2026-10-05', time: '10:00' },
  language: 'English',
  departmentId: null,
  emergency: false,
  ringOutcome: 'answered',
  ...over,
});

function config(over: Partial<CallRoutingConfig> = {}): CallRoutingConfig {
  return { ...createStarterConfig('America/Chicago'), ...over };
}

describe('isOpenAt', () => {
  it('is open inside hours and closed outside / on closed days', () => {
    expect(isOpenAt(ctx.businessHours, { date: '2026-10-05', time: '10:00' }).open).toBe(true);
    expect(isOpenAt(ctx.businessHours, { date: '2026-10-05', time: '17:00' }).open).toBe(false);
    expect(isOpenAt(ctx.businessHours, { date: '2026-10-04', time: '10:00' }).open).toBe(false);
  });

  it('supports shifts that cross midnight', () => {
    const night = { mon: { open: '18:00', close: '02:00' } };
    expect(isOpenAt(night, { date: '2026-10-05', time: '23:30' }).open).toBe(true);
    expect(isOpenAt(night, { date: '2026-10-05', time: '01:00' }).open).toBe(true);
    expect(isOpenAt(night, { date: '2026-10-05', time: '12:00' }).open).toBe(false);
  });

  it('treats unconfigured hours as open but reports it', () => {
    expect(isOpenAt(null, { date: '2026-10-05', time: '03:00' })).toEqual({ open: true, configured: false });
  });
});

describe('wallClockNow', () => {
  it('converts an instant into the business time zone', () => {
    const wc = wallClockNow('Asia/Tokyo', new Date('2026-10-05T20:30:00Z'));
    expect(wc).toEqual({ date: '2026-10-06', time: '05:30' });
  });
});

describe('simulateCall', () => {
  it('lets the emergency rule win over everything else', () => {
    const cfg = config();
    cfg.rules[0].target = { kind: 'member', memberId: 'm1', ringSeconds: 20 };
    const res = simulateCall(cfg, ctx, call({ emergency: true, at: { date: '2026-12-25', time: '03:00' } }));
    expect(res.matchedRuleId).toBe(cfg.rules[0].id);
    expect(res.finalKind).toBe('member');
    expect(res.trace.filter((t) => t.status === 'skipped')).toHaveLength(2);
  });

  it('matches the holiday rule on a closure date even during normal hours', () => {
    const cfg = config();
    const res = simulateCall(cfg, ctx, call({ at: { date: '2026-12-25', time: '10:00' } }));
    expect(res.matchedRuleId).toBe(cfg.rules[1].id);
    expect(res.facts.holiday).toBe('Christmas');
  });

  it('routes after-hours calls to the hours rule and open calls to the fallback', () => {
    const cfg = config();
    expect(simulateCall(cfg, ctx, call({ at: { date: '2026-10-05', time: '22:00' } })).matchedRuleId).toBe(cfg.rules[2].id);
    expect(simulateCall(cfg, ctx, call()).matchedRuleId).toBeNull();
  });

  it('matches language rules case-insensitively and ignores unknown languages', () => {
    const lang = { ...createRule('language'), languages: ['Spanish'], target: { kind: 'member' as const, memberId: 'm1', ringSeconds: 20 } };
    const cfg = config({ rules: [lang] });
    expect(simulateCall(cfg, ctx, call({ language: 'spanish' })).finalKind).toBe('member');
    expect(simulateCall(cfg, ctx, call({ language: 'French' })).matchedRuleId).toBeNull();
    expect(simulateCall(cfg, ctx, call({ language: '' })).matchedRuleId).toBeNull();
  });

  it('escalates through overflow, fallback and finally voicemail when nobody answers', () => {
    const dept = createRule('department');
    const cfg = config({
      departments: [{ id: 'd1', name: 'Billing', memberIds: ['m1'], ringStrategy: 'sequential' }],
      rules: [{ ...dept, departmentId: 'd1', target: { kind: 'department', departmentId: 'd1', ringSeconds: 15 }, overflow: { kind: 'phone', phone: '+15125550999', ringSeconds: 10 } }],
      fallback: { kind: 'member', memberId: 'm1', ringSeconds: 10 },
    });
    const res = simulateCall(cfg, ctx, call({ departmentId: 'd1', ringOutcome: 'no_answer' }));
    expect(res.attempts.map((a) => a.stage)).toEqual(['rule', 'overflow', 'fallback', 'voicemail']);
    expect(res.finalKind).toBe('voicemail');
  });

  it('skips unreachable targets (no phone) without ringing them', () => {
    const rule = { ...createRule('hours'), target: { kind: 'member' as const, memberId: 'm2', ringSeconds: 20 }, overflow: defaultTarget('voicemail') };
    const res = simulateCall(config({ rules: [rule] }), ctx, call({ at: { date: '2026-10-05', time: '22:00' } }));
    expect(res.attempts[0].outcome).toBe('unreachable');
    expect(res.finalKind).toBe('voicemail');
  });

  it('never ends without a destination', () => {
    const res = simulateCall(config({ rules: [], fallback: { kind: 'phone', phone: '+15125550999', ringSeconds: 20 } }), ctx, call({ ringOutcome: 'no_answer' }));
    expect(res.finalKind).toBe('voicemail');
  });
});

describe('validateConfig', () => {
  it('accepts the starter flow', () => {
    expect(validateConfig(createStarterConfig('UTC'), ctx).filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('flags missing targets, bad phone numbers and empty language rules as errors', () => {
    const cfg = config({
      rules: [
        { ...createRule('language'), languages: [] },
        { ...createRule('hours'), target: { kind: 'phone', phone: '5125550101', ringSeconds: 20 } },
        { ...createRule('hours'), target: { kind: 'member', ringSeconds: 20 } },
      ],
    });
    expect(validateConfig(cfg, ctx).filter((i) => i.severity === 'error')).toHaveLength(3);
  });

  it('warns when the emergency rule is not first', () => {
    const cfg = config();
    cfg.rules = [cfg.rules[1], cfg.rules[0]];
    const msgs = validateConfig(cfg, ctx).map((i) => i.message);
    expect(msgs.some((m) => m.includes('Move the emergency rule'))).toBe(true);
  });

  it('rejects out-of-range ring times and invalid time zones', () => {
    const cfg = config({ timezone: 'Mars/Base' });
    cfg.fallback = { kind: 'phone', phone: '+15125550101', ringSeconds: 500 };
    expect(validateConfig(cfg, ctx).filter((i) => i.severity === 'error')).toHaveLength(2);
  });
});

describe('normalizeConfig', () => {
  it('returns null for garbage and sanitizes hostile jsonb', () => {
    expect(normalizeConfig(null)).toBeNull();
    expect(normalizeConfig('x')).toBeNull();
    const out = normalizeConfig({ timezone: 'Nope', rules: [{ kind: 'bogus' }, { kind: 'hours', target: { kind: 'evil', ringSeconds: 9999 } }], fallback: 5 }, 'UTC');
    expect(out?.timezone).toBe('UTC');
    expect(out?.rules).toHaveLength(1);
    expect(out?.rules[0].target).toEqual({ kind: 'ai', ringSeconds: 60 });
    expect(out?.fallback.kind).toBe('ai');
  });
});

describe('removeDepartment', () => {
  it('clears every reference so validation flags the orphaned steps', () => {
    const dept = createRule('department');
    const cfg = config({
      departments: [{ id: 'd1', name: 'Billing', memberIds: [], ringStrategy: 'simultaneous' }],
      rules: [{ ...dept, departmentId: 'd1', target: { kind: 'department', departmentId: 'd1', ringSeconds: 20 } }],
    });
    const out = removeDepartment(cfg, 'd1');
    expect(out.departments).toHaveLength(0);
    expect(out.rules[0].departmentId).toBeNull();
    expect(out.rules[0].target.departmentId).toBe('');
    expect(validateConfig(out, ctx).filter((i) => i.severity === 'error')).toHaveLength(2);
  });
});
