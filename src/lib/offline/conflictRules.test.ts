import { describe, expect, it } from 'vitest';
import { resolveConflict } from './conflictRules';

describe('resolveConflict', () => {
  it('discards only the two "office is ahead" cases', () => {
    expect(resolveConflict('status', 'server_ahead')).toBe('discard');
    expect(resolveConflict('safety_flag', 'newer_flag_on_server')).toBe('discard');
  });
  it('parks everything else, never dropping field data by default', () => {
    expect(resolveConflict('status', 'job_cancelled')).toBe('park');
    expect(resolveConflict('status', undefined)).toBe('park');
    expect(resolveConflict('artifact', 'server_ahead')).toBe('park');
    expect(resolveConflict('note', 'newer_flag_on_server')).toBe('park');
    expect(resolveConflict('location', 'anything')).toBe('park');
  });
});
