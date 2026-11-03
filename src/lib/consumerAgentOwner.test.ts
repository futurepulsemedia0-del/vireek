import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

// ---------------------------------------------------------------- owner-side pure helpers
import { parseServiceList, reasonFromError, statusKey, type ConsumerAgentSettings, type Preview } from './consumerAgent';

describe('owner helpers (src/lib/consumerAgent.ts)', () => {
  const base = { enabled: true, kill_switch: false } as ConsumerAgentSettings;
  const pv = (over: Partial<Preview>): Preview => ({ live: true, blockers: [], profile: null, never_exposed: [], ...over });
  it('maps database errors to stable reason codes', () => {
    expect(reasonFromError('not_ready')).toBe('not_ready');
    expect(reasonFromError('forbidden')).toBe('forbidden');
    expect(reasonFromError('kill_switch_on')).toBe('kill_switch_on');
    expect(reasonFromError('new row violates check constraint "x"')).toBe('invalid');
    expect(reasonFromError(undefined)).toBe('unknown');
  });
  it('parses the auto-accept service list: trims, dedupes, caps', () => {
    expect(parseServiceList(' Drain Cleaning , ,Drain Cleaning,Leak Detection ')).toEqual(['Drain Cleaning', 'Leak Detection']);
    expect(parseServiceList(Array.from({ length: 40 }, (_, i) => `s${i}`).join(','))).toHaveLength(20);
  });
  it('status: kill switch beats everything, blockers beat live', () => {
    expect(statusKey({ ...base, kill_switch: true }, pv({}))).toBe('killed');
    expect(statusKey(base, pv({ blockers: ['hours_missing'] }))).toBe('blocked');
    expect(statusKey(base, pv({}))).toBe('live');
    expect(statusKey({ ...base, enabled: false }, pv({ live: false }))).toBe('off');
  });
});
