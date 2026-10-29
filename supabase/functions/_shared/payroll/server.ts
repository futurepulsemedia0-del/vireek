// supabase/functions/_shared/payroll/server.ts
//
// Server-only helpers shared by payroll-connect and payroll-sync: Gusto token lifecycle.
// Gusto ROTATES the refresh token on every refresh, so the new pair is persisted BEFORE it is used.

import { ProviderError, decryptSecret, encryptSecret } from './engine.ts';
import { buildGustoTokenRequest, parseGustoToken } from './gusto.ts';

// Minimal structural type so this file needs no Supabase import.
interface AdminLike {
  from(table: string): {
    select(cols: string): { eq(col: string, val: string): { maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null; error: unknown }> } };
    upsert(row: Record<string, unknown>, opts: { onConflict: string }): PromiseLike<{ error: unknown }>;
    update(row: Record<string, unknown>): { eq(col: string, val: string): PromiseLike<{ error: unknown }> };
  };
}

export interface TokenManagerOpts {
  admin: AdminLike;
  connectionId: string;
  owner: string;
  encKey: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  environment: 'production' | 'sandbox';
  fetchImpl?: typeof fetch;
}

export function createTokenManager(o: TokenManagerOpts) {
  const doFetch = o.fetchImpl ?? fetch;

  async function readSecrets() {
    const { data } = await o.admin.from('payroll_connection_secrets').select('access_token_enc, refresh_token_enc, expires_at').eq('connection_id', o.connectionId).maybeSingle();
    if (!data) throw new ProviderError('unauthorized');
    return {
      accessEnc: String(data.access_token_enc),
      refreshEnc: String(data.refresh_token_enc),
      expiresAt: data.expires_at ? Date.parse(String(data.expires_at)) : null,
    };
  }

  async function refresh(): Promise<string> {
    const before = await readSecrets();
    const refreshToken = await decryptSecret(before.refreshEnc, o.encKey);
    const req = buildGustoTokenRequest('refresh', { environment: o.environment, clientId: o.clientId, clientSecret: o.clientSecret, redirectUri: o.redirectUri, refreshToken });
    const res = await doFetch(req.url, { method: 'POST', headers: req.headers, body: req.body });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Another invocation may have rotated the token a moment ago: use its result if so.
      const now = await readSecrets();
      if (now.refreshEnc !== before.refreshEnc) return decryptSecret(now.accessEnc, o.encKey);
      await o.admin.from('payroll_connections').update({ status: 'error', last_error: 'Authorization expired. Reconnect your payroll provider.' }).eq('id', o.connectionId);
      throw new ProviderError('unauthorized');
    }
    const t = parseGustoToken(json);
    await o.admin.from('payroll_connection_secrets').upsert(
      {
        connection_id: o.connectionId,
        user_id: o.owner,
        access_token_enc: await encryptSecret(t.accessToken, o.encKey),
        refresh_token_enc: await encryptSecret(t.refreshToken ?? refreshToken, o.encKey),
        expires_at: t.expiresInSec ? new Date(Date.now() + t.expiresInSec * 1000).toISOString() : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'connection_id' },
    );
    return t.accessToken;
  }

  return {
    refreshAccessToken: refresh,
    async getAccessToken(): Promise<string> {
      const s = await readSecrets();
      if (s.expiresAt !== null && s.expiresAt - Date.now() < 120_000) return refresh();
      return decryptSecret(s.accessEnc, o.encKey);
    },
  };
}
