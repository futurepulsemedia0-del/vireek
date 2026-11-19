import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Button } from '@/components/ui/Button';
import { supabase } from '@/lib/supabase';
import { useOauthconsentT } from '@/i18n/oauthconsentNamespace';
import {
  describeRedirect, errorRedirect, isHighRisk, parseAuthorizeParams, resourceIsOurs, savePending, successRedirect, takePending, clearPending,
  type AuthorizeRequest, type OAuthScope,
} from '@/lib/oauthConsent';

type View =
  | { kind: 'loading' }
  | { kind: 'error'; code: string }
  | { kind: 'consent'; request: AuthorizeRequest; clientName: string }
  | { kind: 'redirecting' };

const ISSUER = (): string => window.location.origin;

/** OAuth authorization endpoint for the MCP server: the owner reviews and approves (or denies) one app. */
function ConsentScreen() {
  const { t } = useOauthconsentT();
  const location = useLocation();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [selected, setSelected] = useState<OAuthScope[]>([]);
  const [busy, setBusy] = useState(false);

  const search = useMemo(() => location.search || takePending(window.sessionStorage, Date.now(), false) || '', [location.search]);

  const leave = useCallback((url: string) => { clearPending(window.sessionStorage); setView({ kind: 'redirecting' }); window.location.assign(url); }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const parsed = parseAuthorizeParams(search);
      if (!parsed.ok) { if (alive) setView({ kind: 'error', code: parsed.reason }); return; }
      const req = parsed.request;
      const { data, error } = await supabase.rpc('mcp_oauth_authorize_preview', {
        p_client_id: req.clientId, p_redirect_uri: req.redirectUri, p_resource: req.resource, p_challenge: req.codeChallenge, p_method: req.method,
      });
      if (!alive) return;
      if (error) { setView({ kind: 'error', code: error.code === '42501' ? 'forbidden' : 'generic' }); return; }
      if (!data?.ok) {
        const code = String(data?.error ?? 'generic');
        if (data?.redirectable) { leave(errorRedirect(req, code, ISSUER(), data?.description)); return; }
        setView({ kind: 'error', code }); return;
      }
      if (!resourceIsOurs(req.resource, import.meta.env.VITE_SUPABASE_URL as string)) {
        leave(errorRedirect(req, 'invalid_target', ISSUER(), 'resource must be the Vireek MCP server')); return;
      }
      setSelected(req.scopes);
      setView({ kind: 'consent', request: req, clientName: String(data.client_name ?? '') });
    })().catch(() => { if (alive) setView({ kind: 'error', code: 'generic' }); });
    return () => { alive = false; };
  }, [search, leave]);

  const decide = async (approve: boolean) => {
    if (view.kind !== 'consent' || busy) return;
    const req = view.request;
    if (approve && selected.length === 0) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc('mcp_oauth_authorize_decide', {
        p_client_id: req.clientId, p_redirect_uri: req.redirectUri, p_resource: req.resource, p_challenge: req.codeChallenge,
        p_method: req.method, p_scopes: selected, p_approve: approve,
      });
      if (error || !data?.ok) {
        if (data?.redirectable) { leave(errorRedirect(req, String(data.error ?? 'server_error'), ISSUER(), data.description)); return; }
        setView({ kind: 'error', code: error?.code === '42501' ? 'forbidden' : 'generic' }); return;
      }
      leave(data.approved && data.code ? successRedirect(req, String(data.code), ISSUER()) : errorRedirect(req, 'access_denied', ISSUER(), 'The owner denied the request'));
    } catch { setView({ kind: 'error', code: 'generic' }); }
    finally { setBusy(false); }
  };

  const toggle = (s: OAuthScope) => setSelected((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 p-4" aria-busy={view.kind === 'loading' || busy}>
      {view.kind === 'loading' && <p role="status" className="text-text-secondary">{t('loading')}</p>}
      {view.kind === 'redirecting' && <p role="status" className="text-text-secondary">{t('redirecting')}</p>}

      {view.kind === 'error' && (
        <section role="alert" className="rounded-2xl border border-border bg-bg-secondary p-5">
          <h1 className="text-lg font-semibold text-text-primary">{t('error.title')}</h1>
          <p className="mt-2 text-sm text-text-secondary">{t(`error.${view.code}`, { defaultValue: t('error.generic') })}</p>
          <Link to="/dashboard" className="focus-ring mt-4 inline-flex min-h-[44px] items-center text-sm font-semibold text-accent">{t('back')}</Link>
        </section>
      )}

      {view.kind === 'consent' && (
        <section className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-5" aria-labelledby="oauth-title">
          <h1 id="oauth-title" className="text-lg font-semibold text-text-primary">{t('title')}</h1>
          <p className="text-sm text-text-primary">{t('intro', { client: view.clientName })}</p>
          <p className="text-xs text-text-secondary">{t('redirectTo')}: <bdi className="font-semibold">{describeRedirect(view.request.redirectUri)}</bdi></p>

          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-text-primary">{t('scopesTitle')}</legend>
            <p className="text-xs text-text-secondary">{t('scopesHelp')}{view.request.scopeWasDefaulted ? ` ${t('scopesDefaulted')}` : ''}</p>
            {view.request.scopes.map((s) => (
              <label key={s} className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-xl border border-border px-3 text-sm">
                <input type="checkbox" className="h-5 w-5" checked={selected.includes(s)} onChange={() => toggle(s)} disabled={busy} />
                <span className="flex-1 text-text-primary">{t(`scope.${s}`, { defaultValue: s })}</span>
                <span className={isHighRisk(s) ? 'text-xs font-semibold text-warning' : 'text-xs text-text-secondary'}>{isHighRisk(s) ? t('highRisk') : t('readOnly')}</span>
              </label>
            ))}
          </fieldset>

          <p className="text-xs text-text-secondary">{t('guard')}</p>
          {selected.length === 0 && <p role="status" className="text-xs text-danger">{t('noScope')}</p>}
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => void decide(true)} disabled={busy || selected.length === 0}>{busy ? t('working') : t('approve')}</Button>
            <Button variant="secondary" onClick={() => void decide(false)} disabled={busy}>{t('deny')}</Button>
          </div>
        </section>
      )}
    </main>
  );
}

/** Saves the query before ProtectedRoute can redirect to /login (it keeps only the path), then renders the screen. */
export function OAuthAuthorizePage() {
  const location = useLocation();
  useEffect(() => { if (location.search) savePending(location.search, window.sessionStorage); }, [location.search]);
  return <ProtectedRoute><ConsentScreen /></ProtectedRoute>;
}
export default OAuthAuthorizePage;
