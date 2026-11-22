// Small helpers shared by the edge-function tests (the "request builder + env injector" layer).
// It sits ON TOP of the existing harness and does not replace it:
//   edgeHarness.ts  -> loadHandler() (Deno.serve capture + mutable env), post()/get()/options(), jsonOf(), captureErrors()
//   fakeSupabase.ts -> FakeDb (in-memory PostgREST model + call log)
//   edgeKit.ts      -> bearer requests, fake JWTs, tenant/role seeding, log capture, sha256
/* eslint-disable @typescript-eslint/no-explicit-any */
import { vi } from 'vitest';
import type { FakeDb } from './fakeSupabase.ts';
import { post } from './edgeHarness.ts';

/** Stable ids: two tenants (A = owner under test, B = a different account) plus actors. */
export const ID = {
  ownerA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  ownerB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  admin: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  tech: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  staff: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  billing: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
} as const;

export const BASE_ENV = {
  SUPABASE_URL: 'http://db.test',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
} as const;

/** POST with a bearer token. */
export const authed = (body: unknown, token: string | null = 'tok-owner', extra: Record<string, string> = {}) =>
  post(body, { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra });

const b64url = (s: string) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A structurally valid (unsigned) JWT. Only the payload is meaningful, e.g. { aal: 'aal2' }. */
export const fakeJwt = (claims: Record<string, unknown> = {}) =>
  `${b64url(JSON.stringify({ alg: 'none' }))}.${b64url(JSON.stringify(claims))}.sig`;

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Registers a bearer token -> user and (optionally) a team_members row, so authenticate() resolves a role. */
export function seedUser(
  db: FakeDb,
  token: string,
  userId: string,
  team?: { ownerId: string; role: string; permissions?: Record<string, boolean>; inviteStatus?: string; id?: string; name?: string },
) {
  db.users[token] = { id: userId, email: `${userId.slice(0, 4)}@x.test` };
  if (team) {
    db.seed('team_members', [{
      id: team.id ?? `tm-${userId.slice(0, 4)}`, user_id: userId, account_owner_id: team.ownerId, role: team.role,
      permissions: team.permissions ?? {}, invite_status: team.inviteStatus ?? 'active', member_name: team.name ?? 'Member', member_email: `${userId.slice(0, 4)}@x.test`,
    }]);
  }
}

/** Captures every console line (log/warn/error) so tests can prove secrets and PII never reach the logs. */
export function captureLogs() {
  const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  const lines = () => spies.flatMap((s) => s.mock.calls.map((c) => c.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')));
  return { lines, text: () => lines().join('\n') };
}
