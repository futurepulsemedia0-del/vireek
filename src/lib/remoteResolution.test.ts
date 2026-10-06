import { describe, it, expect } from 'vitest';
import {
  brierLabel,
  calibrationReady,
  canCloseJob,
  friendlyDbError,
  isActive,
  pct,
  pendingStep,
  rate,
  stepsProgress,
  timeLeftLabel,
  validateSettings,
  validateSymptom,
  type RrSettings,
  type RrStep,
} from './remoteResolution';

const step = (id: string, result: RrStep['result']): RrStep => ({ id, title: id, instructions: id, expected: '', safety_note: '', minutes: 1, result });
const okSettings: RrSettings = { enabled: true, truck_roll_cost_cents: 25000, attempt_threshold: 55, verification_hours: 72, hold_hours: 6 };

describe('remoteResolution helpers', () => {
  it('knows which statuses are active or closable', () => {
    expect(isActive('intake')).toBe(true);
    expect(isActive('resolved_pending')).toBe(false);
    expect(canCloseJob('resolved_pending')).toBe(true);
    expect(canCloseJob('dispatch_required')).toBe(false);
  });
  it('validates the symptom text', () => {
    expect(validateSymptom('ac')).not.toBeNull();
    expect(validateSymptom('AC is not cooling')).toBeNull();
    expect(validateSymptom('x'.repeat(1001))).not.toBeNull();
  });
  it('validates settings ranges', () => {
    expect(validateSettings(okSettings)).toEqual([]);
    expect(validateSettings({ ...okSettings, attempt_threshold: 10 })).toHaveLength(1);
    expect(validateSettings({ ...okSettings, truck_roll_cost_cents: -1, hold_hours: 99 })).toHaveLength(2);
  });
  it('computes rates safely', () => {
    expect(rate(1, 4)).toBe(25);
    expect(rate(1, 0)).toBeNull();
    expect(pct(null)).toBe('—');
    expect(pct(33.333, 1)).toBe('33.3%');
  });
  it('gates calibration on sample size', () => {
    expect(calibrationReady({ attempted: 9 })).toBe(false);
    expect(calibrationReady({ attempted: 10 })).toBe(true);
    expect(brierLabel(null)).toBe('No data yet');
    expect(brierLabel(0.1)).toBe('Excellent');
    expect(brierLabel(0.4)).toBe('Poorly calibrated');
  });
  it('finds the next pending step and progress', () => {
    const steps = [step('s1', 'no_change'), step('s2', null), step('s3', null)];
    expect(pendingStep(steps)?.id).toBe('s2');
    expect(stepsProgress(steps)).toEqual({ done: 1, total: 3 });
    expect(pendingStep([step('s1', 'fixed')])).toBeNull();
  });
  it('formats time left', () => {
    const now = Date.parse('2027-03-15T10:00:00Z');
    expect(timeLeftLabel('2027-03-15T10:30:00Z', now)).toBe('30m left');
    expect(timeLeftLabel('2027-03-15T13:05:00Z', now)).toBe('3h 5m left');
    expect(timeLeftLabel('2027-03-18T10:00:00Z', now)).toBe('3d 0h left');
    expect(timeLeftLabel('2027-03-15T09:00:00Z', now)).toBe('ended');
    expect(timeLeftLabel(null, now)).toBe('');
  });
  it('translates database errors', () => {
    expect(friendlyDbError('RR_NOT_DISPATCHABLE: only scheduled')).toContain('scheduled');
    expect(friendlyDbError('RR_FORBIDDEN: only the account owner can change these settings')).toContain('owner');
    expect(friendlyDbError('x'.repeat(300))).toBe('Something went wrong. Please try again.');
  });
});
