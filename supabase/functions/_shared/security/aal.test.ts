import { describe, expect, it } from 'vitest';
import { jwtAal } from './aal';

const tok = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;

describe('jwtAal', () => {
  it('reads the aal claim', () => {
    expect(jwtAal(tok({ aal: 'aal2' }))).toBe('aal2');
    expect(jwtAal(tok({ aal: 'aal1' }))).toBe('aal1');
  });
  it('returns null for missing claim or garbage', () => {
    expect(jwtAal(tok({ sub: '1' }))).toBeNull();
    expect(jwtAal('garbage')).toBeNull();
    expect(jwtAal('')).toBeNull();
  });
});
