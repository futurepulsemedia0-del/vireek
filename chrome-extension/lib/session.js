// Supabase Auth (GoTrue REST) session for the extension. Owned by the service worker only:
// tokens never reach content scripts. Dependencies are injected so it is unit-testable.

const KEY = 'vk_session';
const SKEW_MS = 60_000;

export class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createSession({ config, fetchImpl = fetch, storage, now = () => Date.now() }) {
  let inflight = null;
  const headers = (token) => ({
    'Content-Type': 'application/json',
    apikey: config.SUPABASE_ANON_KEY,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });
  const auth = async (path, body, token) => {
    let res;
    try {
      res = await fetchImpl(`${config.SUPABASE_URL}/auth/v1/${path}`, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify(body),
      });
    } catch {
      throw new AuthError('network', 'network');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error_description || data.msg || data.message || 'auth_failed';
      throw new AuthError(
        res.status === 400 || res.status === 401 || res.status === 422 ? 'invalid' : 'server',
        String(msg),
      );
    }
    return data;
  };
  const save = async (d) => {
    const s = {
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_at: d.expires_at ? d.expires_at * 1000 : now() + (d.expires_in ?? 3600) * 1000,
      user: d.user ? { id: d.user.id, email: d.user.email, factors: d.user.factors ?? [] } : null,
    };
    await storage.set({ [KEY]: s });
    return s;
  };
  const load = async () => (await storage.get(KEY))[KEY] ?? null;

  const api = {
    load,
    async status() {
      const s = await load();
      return { signedIn: Boolean(s?.refresh_token), email: s?.user?.email ?? null };
    },
    async signIn(email, password) {
      const s = await save(
        await auth('token?grant_type=password', { email: String(email).trim(), password }),
      );
      return {
        mfaFactor:
          s.user?.factors?.find((f) => f.status === 'verified' && f.factor_type === 'totp')?.id ??
          null,
      };
    },
    async verifyMfa(code) {
      const s = await load();
      const factor = s?.user?.factors?.find(
        (f) => f.status === 'verified' && f.factor_type === 'totp',
      );
      if (!s || !factor) throw new AuthError('invalid', 'no_factor');
      const ch = await auth(`factors/${factor.id}/challenge`, {}, s.access_token);
      const d = await auth(
        `factors/${factor.id}/verify`,
        { challenge_id: ch.id, code: String(code).trim() },
        s.access_token,
      );
      await save({ ...d, user: d.user ?? { ...s.user } });
    },
    async refresh() {
      if (inflight) return inflight;
      inflight = (async () => {
        const s = await load();
        if (!s?.refresh_token) throw new AuthError('signed_out', 'signed_out');
        try {
          const d = await auth('token?grant_type=refresh_token', {
            refresh_token: s.refresh_token,
          });
          return (await save({ ...d, user: d.user ?? s.user })).access_token;
        } catch (e) {
          if (e.code === 'invalid') await storage.remove(KEY);
          throw e;
        }
      })().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    async getAccessToken() {
      const s = await load();
      if (!s) throw new AuthError('signed_out', 'signed_out');
      return s.expires_at - SKEW_MS > now() ? s.access_token : api.refresh();
    },
    async signOut() {
      const s = await load();
      await storage.remove(KEY);
      if (s?.access_token) auth('logout', {}, s.access_token).catch(() => {});
    },
  };
  return api;
}
