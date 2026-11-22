// /staff/sanctions — sanctions screening review queue and gate settings (Vireek employees only).
// Data: sanctions-admin edge function (re-checks is_vireek_staff server-side); route sits behind <StaffRoute>.
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldAlert } from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useToast } from '@/contexts/ToastContext';
import { useSEO } from '@/lib/seo';
import { useSanctionsT } from '@/i18n/sanctionsNamespace';
import {
  SanctionsAdminError, decideCase, fetchCases, fetchOverview, updateSettings,
  type CaseFilter, type Decision, type SanctionsCase, type SanctionsOverview,
} from '@/lib/sanctionsAdminApi';

const FILTERS: readonly CaseFilter[] = ['active', 'open', 'escalated', 'cleared', 'blocked'];
const fieldClass = 'focus-ring mt-1 w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-text-primary';

function SEO() {
  useSEO({ title: 'Sanctions screening — Staff', description: 'Internal: sanctions screening review queue.', canonical: 'https://vireek.com/staff/sanctions' });
  return null;
}

function Stat({ label, value, bad }: { label: string; value: number; bad?: boolean }) {
  return (
    <Card interactive={false} className="p-4">
      <p className="text-sm font-medium text-text-secondary">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${bad && value > 0 ? 'text-danger' : 'text-text-primary'}`}>{value}</p>
    </Card>
  );
}

function CaseCard({ c, busy, onDecide }: { c: SanctionsCase; busy: boolean; onDecide: (c: SanctionsCase, d: Decision, note: string) => void }) {
  const { t } = useSanctionsT();
  const [note, setNote] = useState('');
  const live = c.status === 'open' || c.status === 'escalated';
  const noteOk = note.trim().length >= 3;
  const noteId = `note-${c.id}`;
  return (
    <Card interactive={false} className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-text-primary">
          {t(`cases.checkpoint.${c.checkpoint}`)} · <span className="text-text-secondary">{t(`cases.status.${c.status}`)}</span>
        </p>
        <p className="text-sm tabular-nums text-text-secondary">{t('cases.score')}: {c.top_score === null ? '—' : c.top_score.toFixed(2)}</p>
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div><dt className="text-text-secondary">{t('cases.subject')}</dt><dd className="text-text-primary" dir="auto">{c.subject.name}{c.subject.aliases.length ? ` (${c.subject.aliases.join(', ')})` : ''}</dd></div>
        <div><dt className="text-text-secondary">{t('cases.country')}</dt><dd className="text-text-primary">{c.subject.country ?? '—'}</dd></div>
        <div className="sm:col-span-2"><dt className="text-text-secondary">{t('cases.account')}</dt><dd className="break-all text-text-primary" dir="ltr">{c.account_owner_id ?? t('cases.noAccount')}</dd></div>
      </dl>
      {c.matches.length > 0 && (
        <div className="mt-3">
          <p className="text-sm font-medium text-text-secondary">{t('cases.matches')}</p>
          <ul className="mt-1 space-y-1 text-sm">
            {c.matches.slice(0, 5).map((m) => (
              <li key={`${m.listId}:${m.entryId}`} className="text-text-primary">
                <span dir="auto">{m.name}</span> <span className="text-text-secondary" dir="ltr">· {m.listId}/{m.entryId} · {m.score.toFixed(2)}</span>
                {m.dobMismatch && <span className="ms-2 rounded-full bg-warning-subtle px-2 py-0.5 text-xs text-warning">{t('cases.dobMismatch')}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {c.resolution && <p className="mt-3 text-sm text-text-secondary" dir="auto">{c.resolution}</p>}
      {live && (
        <div className="mt-4">
          <label htmlFor={noteId} className="block text-sm font-medium text-text-secondary">{t('cases.decisionNote')}</label>
          <textarea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} className={fieldClass} />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" disabled={busy || !noteOk} onClick={() => onDecide(c, 'clear', note.trim())}>{t('cases.clear')}</Button>
            {c.status === 'open' && <Button variant="secondary" size="sm" disabled={busy || !noteOk} onClick={() => onDecide(c, 'escalate', note.trim())}>{t('cases.escalate')}</Button>}
            <Button variant="primary" size="sm" disabled={busy || !noteOk} onClick={() => onDecide(c, 'confirm_block', note.trim())}>{t('cases.block')}</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

export function StaffSanctionsPage() {
  const { t } = useSanctionsT();
  const { toast } = useToast();
  const [overview, setOverview] = useState<SanctionsOverview | null>(null);
  const [cases, setCases] = useState<SanctionsCase[]>([]);
  const [filter, setFilter] = useState<CaseFilter>('active');
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'forbidden'>('loading');
  const [busy, setBusy] = useState<string | null>(null);

  const [mode, setMode] = useState<'shadow' | 'enforce'>('enforce');
  const [threshold, setThreshold] = useState('0.80');
  const [timeoutMs, setTimeoutMs] = useState('3000');
  const [countries, setCountries] = useState('');
  const [reason, setReason] = useState('');
  const [ackShadow, setAckShadow] = useState(false);

  const load = useCallback(async (f: CaseFilter) => {
    setState('loading');
    try {
      const [o, c] = await Promise.all([fetchOverview(), fetchCases(f)]);
      setOverview(o);
      setCases(c);
      if (o.settings) {
        setMode(o.settings.mode);
        setThreshold(Number(o.settings.review_threshold).toFixed(2));
        setTimeoutMs(String(o.settings.provider_timeout_ms));
        setCountries(o.settings.restricted_countries.join(', '));
      }
      setState('ready');
    } catch (e) {
      setState(e instanceof SanctionsAdminError && e.status === 403 ? 'forbidden' : 'error');
    }
  }, []);

  useEffect(() => { void load(filter); }, [load, filter]);

  const decide = async (c: SanctionsCase, d: Decision, note: string) => {
    setBusy(c.id);
    try {
      await decideCase(c.id, d, note);
      toast(t('cases.done'), 'success');
    } catch (e) {
      toast(e instanceof SanctionsAdminError && e.status === 409 ? t('cases.alreadyDecided') : t('cases.failed'), 'error');
    } finally {
      setBusy(null);
      await load(filter);
    }
  };

  const save = async () => {
    setBusy('settings');
    try {
      const codes = countries.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
      await updateSettings(
        { mode, review_threshold: Number(threshold), provider_timeout_ms: Number(timeoutMs), restricted_countries: codes, acknowledge_shadow: mode === 'shadow' ? ackShadow : undefined },
        reason.trim(),
      );
      toast(t('settings.saved'), 'success');
      setReason('');
      setAckShadow(false);
      await load(filter);
    } catch {
      toast(t('settings.failed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const shadow = overview?.effectiveMode === 'shadow';
  const reasonOk = reason.trim().length >= 3 && (mode !== 'shadow' || ackShadow);

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen bg-bg-primary px-4 pb-20 pt-28 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <ShieldAlert className="text-accent" size={22} aria-hidden="true" />
                <h1 className="text-2xl font-bold tracking-tight text-text-primary">{t('title')}</h1>
              </div>
              <p className="mt-1 text-sm text-text-secondary">{t('subtitle')}</p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => void load(filter)} loading={state === 'loading'} loadingLabel={t('loading')}>
              <RefreshCw size={16} aria-hidden="true" />
              {t('refresh')}
            </Button>
          </div>

          <div aria-live="polite" className="mt-6">
            {state === 'loading' && <p className="text-text-secondary">{t('loading')}</p>}
            {state === 'forbidden' && <p role="alert" className="text-danger">{t('forbidden')}</p>}
            {state === 'error' && <p role="alert" className="text-danger">{t('loadError')}</p>}
          </div>

          {state === 'ready' && overview && (
            <>
              <div role="status" className={`mt-2 rounded-xl border px-4 py-3 text-sm ${shadow ? 'border-warning/40 bg-warning-subtle text-warning' : 'border-border bg-bg-secondary text-text-secondary'}`}>
                <p className="font-semibold">{shadow ? t('mode.shadow') : t('mode.enforce')}</p>
                <p>{shadow ? t('mode.shadowBanner') : t('mode.enforceBanner')}</p>
                {overview.failedClosed && <p className="mt-1">{t('mode.failedClosed')}</p>}
                {overview.forcedEnforce && <p className="mt-1">{t('mode.forced')}</p>}
              </div>

              <section aria-labelledby="ready-h" className="mt-6">
                <h2 id="ready-h" className="text-lg font-semibold text-text-primary">{t('readiness.title')}</h2>
                <ul className="mt-2 space-y-1 text-sm">
                  <li className={overview.providerConfigured ? 'text-success' : 'text-danger'}>{overview.providerConfigured ? t('readiness.providerOk') : t('readiness.providerMissing', { problem: overview.providerProblem ?? 'unknown' })}</li>
                  <li className={overview.hashSecretConfigured ? 'text-success' : 'text-danger'}>{overview.hashSecretConfigured ? t('readiness.secretOk') : t('readiness.secretMissing')}</li>
                </ul>
              </section>

              <section aria-label={t('title')} className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-3">
                <Stat label={t('stats.open')} value={overview.openCases} bad />
                <Stat label={t('stats.escalated')} value={overview.escalatedCases} bad />
                <Stat label={t('stats.held')} value={overview.heldAccounts} bad />
                <Stat label={t('stats.blocked')} value={overview.blockedAccounts} />
                <Stat label={t('stats.errors24h')} value={overview.screenings24h.error ?? 0} bad />
                <Stat label={t('stats.wouldDeny24h')} value={overview.shadowWouldDeny24h} />
              </section>

              <section aria-labelledby="cases-h" className="mt-10">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 id="cases-h" className="text-lg font-semibold text-text-primary">{t('cases.title')}</h2>
                  <div role="group" aria-label={t('cases.title')} className="flex flex-wrap gap-2">
                    {FILTERS.map((f) => (
                      <Button key={f} variant={f === filter ? 'primary' : 'secondary'} size="sm" aria-pressed={f === filter} onClick={() => setFilter(f)}>{t(`cases.filter.${f}`)}</Button>
                    ))}
                  </div>
                </div>
                {cases.length === 0 ? (
                  <p className="mt-4 text-sm text-text-secondary">{t('cases.empty')}</p>
                ) : (
                  <div className="mt-4 space-y-4">{cases.map((c) => <CaseCard key={c.id} c={c} busy={busy === c.id} onDecide={(cc, d, n) => void decide(cc, d, n)} />)}</div>
                )}
              </section>

              <section aria-labelledby="settings-h" className="mt-10">
                <h2 id="settings-h" className="text-lg font-semibold text-text-primary">{t('settings.title')}</h2>
                <div className="mt-4 grid max-w-3xl gap-4 sm:grid-cols-2">
                  <label className="block text-sm font-medium text-text-secondary">{t('settings.mode')}
                    <select className={fieldClass} value={mode} onChange={(e) => setMode(e.target.value === 'shadow' ? 'shadow' : 'enforce')}>
                      <option value="enforce">{t('mode.enforce')}</option>
                      <option value="shadow">{t('mode.shadow')}</option>
                    </select>
                  </label>
                  <label className="block text-sm font-medium text-text-secondary">{t('settings.threshold')}
                    <input className={fieldClass} inputMode="decimal" dir="ltr" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
                  </label>
                  <label className="block text-sm font-medium text-text-secondary">{t('settings.timeout')}
                    <input className={fieldClass} inputMode="numeric" dir="ltr" value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} />
                  </label>
                  <label className="block text-sm font-medium text-text-secondary sm:col-span-2">{t('settings.countries')}
                    <input className={fieldClass} dir="ltr" value={countries} onChange={(e) => setCountries(e.target.value)} />
                    <span className="mt-1 block text-xs font-normal text-text-secondary">{t('settings.countriesHint')}</span>
                  </label>
                  <label className="block text-sm font-medium text-text-secondary sm:col-span-2">{t('settings.reason')}
                    <input className={fieldClass} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
                  </label>
                  {mode === 'shadow' && (
                    <label className="flex items-start gap-2 text-sm text-text-secondary sm:col-span-2">
                      <input type="checkbox" className="mt-1" checked={ackShadow} onChange={(e) => setAckShadow(e.target.checked)} />
                      {t('settings.shadowAck')}
                    </label>
                  )}
                </div>
                <Button className="mt-4" variant="primary" size="sm" disabled={!reasonOk || busy === 'settings'} onClick={() => void save()}>{t('settings.save')}</Button>
              </section>
            </>
          )}
        </div>
      </main>
    </>
  );
}
