import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { SkeletonCardList } from '@/components/Skeleton';
import { useFairSaleT } from '@/i18n/fairSaleNamespace';
import { errorMessage, listEvents, verifyChain, type FairSaleEvent } from '@/lib/fairSale';

const humanize = (s: string) => s.replace(/_/g, ' ');

export function LogTab({ canManage }: { canManage: boolean }) {
  const { t, language } = useFairSaleT();
  const [events, setEvents] = useState<FairSaleEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setEvents(await listEvents()); } catch (e) { setError(errorMessage(e, t('dash.errors.generic'))); setEvents([]); }
  }, [t]);
  useEffect(() => { void load(); }, [load]);

  const sessions = useMemo(() => Array.from(new Set((events ?? []).map((e) => e.session_id))), [events]);
  useEffect(() => { if (!session && sessions[0]) setSession(sessions[0]); }, [sessions, session]);

  const verify = async () => {
    if (!session) return;
    setBusy(true);
    setResult(null);
    try {
      const bad = await verifyChain(session);
      setResult(bad === null ? t('log.intact') : t('log.broken', { id: bad }));
    } catch (e) {
      setResult(errorMessage(e, t('dash.errors.generic')));
    } finally {
      setBusy(false);
    }
  };

  if (!events) return <SkeletonCardList count={2} rows={3} />;

  return (
    <div className="mt-4 space-y-3">
      <p className="text-sm text-text-secondary">{t('log.intro')}</p>
      {error && <p role="alert" className="text-sm text-danger-500">{error}</p>}
      {canManage && sessions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-bg-secondary p-3">
          <label htmlFor="fs-verify-session" className="text-sm text-text-secondary">{t('log.sessionLabel')}</label>
          <select id="fs-verify-session" value={session} onChange={(e) => { setSession(e.target.value); setResult(null); }}
            className="focus-ring rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary" dir="ltr">
            {sessions.map((s) => <option key={s} value={s}>{s.slice(0, 8)}</option>)}
          </select>
          <Button type="button" size="sm" variant="secondary" loading={busy} onClick={() => void verify()}>{t('log.verify')}</Button>
          <span role="status" aria-live="polite" className="text-sm text-text-primary">{result ?? ''}</span>
        </div>
      )}
      {events.length === 0 && !error ? (
        <p className="rounded-2xl border border-border bg-bg-secondary p-5 text-sm text-text-secondary">{t('log.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
          <table className="w-full min-w-[640px] text-start text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-text-secondary">
                <th className="px-3 py-2 text-start font-medium">{t('log.cols.time')}</th>
                <th className="px-3 py-2 text-start font-medium">{t('log.cols.event')}</th>
                <th className="px-3 py-2 text-start font-medium">{t('log.cols.protection')}</th>
                <th className="px-3 py-2 text-start font-medium">{t('log.cols.choice')}</th>
                <th className="px-3 py-2 text-start font-medium">{t('log.cols.actor')}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 text-text-secondary">{new Date(e.created_at).toLocaleString(language)}</td>
                  <td className="px-3 py-2 text-text-primary">{t(`log.events.${e.event_type}`, { defaultValue: humanize(e.event_type) })}</td>
                  <td className="px-3 py-2 text-text-secondary">{e.protection ? t(`log.protections.${e.protection}`, { defaultValue: humanize(e.protection) }) : '—'}</td>
                  <td className="px-3 py-2 text-text-secondary">{e.choice ? humanize(e.choice) : '—'}</td>
                  <td className="px-3 py-2 text-text-secondary">{humanize(e.actor_type)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
