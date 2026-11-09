import { describe, it, expect } from 'vitest';
import { evaluateSweepRow, type SweepRow } from './sweep';
import { standardBusinessWindows } from './slaClock';

const row = (over: Partial<SweepRow> = {}): SweepRow => ({
  timer_id: 't1', started_at: '2027-06-07T14:00:00Z', target_minutes: 100, warn_at_pct: 80, max_pause_minutes: null,
  escalation: [{ key: 'warn', atPct: 80, notify: 'dispatcher' }, { key: 'breach', atPct: 100, notify: 'manager' }],
  calendar: { timeZone: 'America/New_York', windows: standardBusinessWindows(), holidays: [] }, pauses: [], fired_keys: [], ...over,
});

describe('evaluateSweepRow', () => {
  it('reports breach with over-minutes and both unfired steps', () => {
    const r = evaluateSweepRow(row(), '2027-06-07T15:45:00Z')!;
    expect([r.state, r.over_minutes, r.fired.map((f) => f.key)]).toEqual(['breached', 5, ['warn', 'breach']]);
  });
  it('is idempotent across sweeps: already-fired steps are not returned again', () => {
    const r = evaluateSweepRow(row({ fired_keys: ['warn', 'breach'] }), '2027-06-07T15:45:00Z')!;
    expect(r.fired).toEqual([]);
  });
  it('a capped open pause resumes the clock', () => {
    // paused 15:00Z, cap 30 min → clock runs again from 15:30Z; at 16:00Z elapsed = 60 + 30
    const r = evaluateSweepRow(row({ target_minutes: 240, pauses: [{ from: '2027-06-07T15:00:00Z', to: null }], max_pause_minutes: 30 }), '2027-06-07T16:00:00Z')!;
    expect(r.state).toBe('running');
    expect(r.pct_elapsed).toBe(37.5);
  });
  it('skips rows with an invalid calendar instead of throwing', () => {
    expect(evaluateSweepRow(row({ calendar: { timeZone: 'Nope/Zone', windows: [], holidays: [] } }), '2027-06-07T15:00:00Z')).toBeNull();
  });
});
