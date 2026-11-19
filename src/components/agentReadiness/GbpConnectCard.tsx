import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { useAgentReadinessT } from '@/i18n/agentReadinessNamespace';
import { loadGbpConnection, selectGbpLocation, startGbpConnect, type GbpConnection, type GbpReturn } from '@/lib/gbpConnect';

interface Props { canManage: boolean; returned: GbpReturn | null }

/** Connect / choose / reconnect Google Business Profile. Read-only use; tokens never reach the browser. */
export function GbpConnectCard({ canManage, returned }: Props) {
  const { t } = useAgentReadinessT();
  const { toast } = useToast();
  const [conn, setConn] = useState<GbpConnection | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [picked, setPicked] = useState<string>('');
  const [busy, setBusy] = useState<'connect' | 'save' | null>(null);
  const err = (code: string) => t(`errors.${code}`, { defaultValue: t('errors.unknown') });

  const load = useCallback(async () => {
    setStatus('loading');
    try { const c = await loadGbpConnection(); setConn(c); setPicked(c.locationName ?? c.candidates[0]?.location ?? ''); setStatus('ready'); }
    catch { setStatus('error'); }
  }, []);
  useEffect(() => { if (canManage) void load(); }, [canManage, load]);

  async function connect() {
    setBusy('connect');
    const res = await startGbpConnect();
    if (!res.ok) { setBusy(null); toast(err(res.code), 'error'); return; }
    window.location.assign(res.url);
  }
  async function save() {
    if (!picked) return;
    setBusy('save');
    const res = await selectGbpLocation(picked);
    setBusy(null);
    if (!res.ok) { toast(err(res.code), 'error'); return; }
    toast(t('gbp.saved'), 'success');
    await load();
  }

  if (!canManage) return null;
  const multi = (conn?.candidates.length ?? 0) > 1;
  const returnText = returned
    ? returned.status === 'error' ? t(`gbp.return.${returned.reason ?? 'unknown'}`, { defaultValue: t('gbp.return.unknown') })
      : returned.status === 'choose' ? t('gbp.return.choose') : t('gbp.return.connected')
    : null;

  return (
    <section className="mb-6 rounded-2xl border border-border bg-bg-secondary p-5" aria-labelledby="ar-gbp">
      <h2 id="ar-gbp" className="text-base font-semibold text-text-primary">{t('gbp.title')}</h2>
      <p className="mt-1 text-sm text-text-secondary">{t('gbp.readOnly')}</p>
      {returnText && <p role={returned?.status === 'error' ? 'alert' : 'status'} className="mt-2 text-sm text-text-primary">{returnText}</p>}

      {status === 'loading' && <p className="mt-3 text-sm text-text-secondary">{t('gbp.loading')}</p>}
      {status === 'error' && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="text-sm text-text-primary">{t('gbp.loadError')}</p>
          <Button size="sm" variant="ghost" onClick={() => void load()}>{t('retry')}</Button>
        </div>
      )}

      {status === 'ready' && conn?.state === 'not_connected' && (
        <div className="mt-3">
          <Button size="sm" loading={busy === 'connect'} loadingLabel={t('gbp.connecting')} onClick={() => void connect()}>{t('gbp.connect')}</Button>
        </div>
      )}

      {status === 'ready' && conn && conn.state !== 'not_connected' && (
        <div className="mt-3 space-y-3">
          {conn.state === 'connected' && <p className="text-sm text-text-primary">{t('gbp.connectedTo', { name: conn.locationTitle ?? conn.locationName ?? '' })}</p>}
          {conn.state === 'needs_choice' && <p className="text-sm text-text-primary">{t('gbp.chooseHint')}</p>}
          {conn.candidates.length > 0 && (multi || conn.state === 'needs_choice') && (
            <fieldset className="space-y-2">
              <legend className="sr-only">{t('gbp.chooseLegend')}</legend>
              {conn.candidates.map((c) => (
                <label key={c.location} className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
                  <input type="radio" name="gbp-location" value={c.location} checked={picked === c.location} onChange={() => setPicked(c.location)} />
                  <span>{c.title}</span>
                </label>
              ))}
              <Button size="sm" loading={busy === 'save'} loadingLabel={t('gbp.saving')} disabled={!picked || picked === conn.locationName} onClick={() => void save()}>{t('gbp.save')}</Button>
            </fieldset>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="ghost" loading={busy === 'connect'} loadingLabel={t('gbp.connecting')} onClick={() => void connect()}>{t('gbp.reconnect')}</Button>
            <p className="text-xs text-text-secondary">{t('gbp.rescanHint')}</p>
          </div>
        </div>
      )}
    </section>
  );
}
