import { describe, expect, it } from 'vitest';

const files = import.meta.glob('../../supabase/migrations/*loyalty*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('loyalty migrations', () => {
  it('creates loyalty_accounts in exactly one migration (no colliding copy)', () => {
    const owners = Object.entries(files)
      .filter(([, sql]) => /CREATE TABLE IF NOT EXISTS (public\.)?loyalty_accounts\b/.test(sql))
      .map(([name]) => name);
    expect(owners).toHaveLength(1);
  });
});
