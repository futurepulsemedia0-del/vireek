import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  apiKeyHygiene,
  computePosture,
  type AgentSandboxPolicy,
  type IdentityBaseline,
  type PostureInput,
} from '@/lib/aiSecurity';

const NOW = new Date('2027-01-10T00:00:00Z').getTime();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const identityOff: IdentityBaseline = { sso_enforced: false, require_mfa_for_team: false, ip_restriction_enabled: false, session_idle_minutes: 0, session_max_hours: 0 };
const identityOn: IdentityBaseline = { sso_enforced: true, require_mfa_for_team: true, ip_restriction_enabled: true, session_idle_minutes: 30, session_max_hours: 12 };

const policy = (agent: string): AgentSandboxPolicy => ({
  id: agent,
  agent_source: agent,
  enabled: true,
  allowed_domains: ['customers'],
  max_records_per_run: 100,
  allow_external_send: false,
  allow_write: false,
  updated_at: daysAgo(1),
});

function base(overrides: Partial<PostureInput> = {}): PostureInput {
  return { settings: DEFAULT_SETTINGS, sandboxPolicies: [], knownAgents: ['a', 'b'], identity: identityOff, isolation: null, keyIssues: [], openEvents: [], ...overrides };
}

describe('apiKeyHygiene', () => {
  it('flags keys past the rotation age', () => {
    const r = apiKeyHygiene([{ id: '1', name: 'old', key_prefix: 'vrk_a', last_used_at: daysAgo(1), created_at: daysAgo(120) }], 90, NOW);
    expect(r).toHaveLength(1);
    expect(r[0].issue).toBe('rotation_due');
  });

  it('flags never-used keys older than 30 days and long-idle keys', () => {
    const r = apiKeyHygiene(
      [
        { id: '1', name: 'never', key_prefix: 'a', last_used_at: null, created_at: daysAgo(45) },
        { id: '2', name: 'idle', key_prefix: 'b', last_used_at: daysAgo(100), created_at: daysAgo(60) },
        { id: '3', name: 'fresh', key_prefix: 'c', last_used_at: null, created_at: daysAgo(5) },
      ],
      90,
      NOW,
    );
    expect(r.map((x) => x.id)).toEqual(['1', '2']);
  });
});

describe('computePosture', () => {
  it('scores a fully hardened account highly', () => {
    const p = computePosture(
      base({
        settings: { ...DEFAULT_SETTINGS, pii_mode: 'full', injection_mode: 'block', sandbox_mode: 'enforce', allowed_providers: ['anthropic'] },
        sandboxPolicies: [policy('a'), policy('b')],
        identity: identityOn,
        isolation: [{ table_name: 't', rls_enabled: true, policy_count: 2, open_policy_count: 0, risk: 'ok' }],
      }),
    );
    expect(p.score).toBeGreaterThanOrEqual(95);
    expect(p.label).toBe('Hardened');
  });

  it('penalises disabled protections', () => {
    const p = computePosture(base({ settings: { ...DEFAULT_SETTINGS, pii_mode: 'off', injection_mode: 'monitor', sandbox_mode: 'off' } }));
    expect(p.score).toBeLessThan(40);
    expect(p.label).toBe('At risk');
  });

  it('drops the isolation check to zero when a table lacks RLS', () => {
    const p = computePosture(base({ isolation: [{ table_name: 'x', rls_enabled: false, policy_count: 0, open_policy_count: 0, risk: 'critical' }] }));
    expect(p.checks.find((c) => c.id === 'isolation')?.earned).toBe(0);
  });

  it('only counts OPEN incidents', () => {
    const p = computePosture(
      base({
        openEvents: [
          { severity: 'critical', status: 'resolved' },
          { severity: 'high', status: 'open' },
        ],
      }),
    );
    expect(p.checks.find((c) => c.id === 'incidents')?.earned).toBe(0.4);
  });
});
