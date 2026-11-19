// scripts/demo/guard.mjs
// The only gate in front of demo seeding. Pure (no I/O) so it is unit-tested. Fails CLOSED: anything that is
// not explicitly a demo/staging run against an explicitly confirmed project is refused before any network call.

export const ALLOWED_DEMO_ENVS = Object.freeze(['demo', 'staging']);

export class DemoGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DemoGuardError';
    this.code = code;
  }
}

/** "https://abcd1234.supabase.co" -> "abcd1234"; localhost / 127.0.0.1 -> "local"; anything else -> null. */
export function projectRefFromUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]') return 'local';
  const m = /^([a-z0-9]{8,32})\.supabase\.(co|in|red)$/i.exec(u.hostname);
  return m && u.protocol === 'https:' ? m[1].toLowerCase() : null;
}

/**
 * @param {Record<string,string|undefined>} env  process.env-like
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {{ demoEnv: string, url: string|null, serviceKey: string|null, ref: string|null, dryRun: boolean }}
 */
export function assertDemoAllowed(env, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const demoEnv = String(env.DEMO_ENV ?? '').trim();
  if (!demoEnv) {
    throw new DemoGuardError('demo_env_missing', `Refusing to run: DEMO_ENV is not set. Set DEMO_ENV to one of: ${ALLOWED_DEMO_ENVS.join(', ')}.`);
  }
  if (!ALLOWED_DEMO_ENVS.includes(demoEnv)) {
    throw new DemoGuardError('demo_env_invalid', `Refusing to run: DEMO_ENV="${demoEnv}" is not allowed. Allowed: ${ALLOWED_DEMO_ENVS.join(', ')}.`);
  }
  if (String(env.NODE_ENV ?? '').toLowerCase() === 'production') {
    throw new DemoGuardError('node_env_production', 'Refusing to run: NODE_ENV=production.');
  }
  if (dryRun) return { demoEnv, url: null, serviceKey: null, ref: null, dryRun };

  const url = String(env.SUPABASE_URL ?? '').trim();
  const serviceKey = String(env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (!url || !serviceKey) {
    throw new DemoGuardError('credentials_missing', 'Refusing to run: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment (never in code).');
  }
  const ref = projectRefFromUrl(url);
  if (!ref) throw new DemoGuardError('url_invalid', 'Refusing to run: SUPABASE_URL is not a https://<ref>.supabase.co or local URL.');

  const denied = String(env.DEMO_DENY_PROJECT_REFS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (denied.includes(ref)) throw new DemoGuardError('project_denied', `Refusing to run: project "${ref}" is on DEMO_DENY_PROJECT_REFS.`);

  const confirm = String(env.DEMO_CONFIRM_PROJECT_REF ?? '').trim().toLowerCase();
  if (confirm !== ref) {
    throw new DemoGuardError('project_unconfirmed', `Refusing to run: set DEMO_CONFIRM_PROJECT_REF=${ref} to confirm that "${ref}" is a demo/staging project.`);
  }
  return { demoEnv, url: url.replace(/\/$/, ''), serviceKey, ref, dryRun };
}
