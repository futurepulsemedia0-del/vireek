// /staff/abuse — fraud & abuse operations console (Vireek employees only).
// Data: fraud-admin edge function (re-checks is_vireek_staff server-side); route sits behind <StaffRoute>.
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldAlert } from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { Card } from '@/components/ui/Card';
import { useToast } from '@/contexts/ToastContext';
import { useSEO } from '@/lib/seo';
import { useAbuseT } from '@/i18n/abuseNamespace';
import {
  FraudAdminError, decideApproval, fetchApprovals, fetchCases, fetchOverview, fetchWeeklyReport, setOrgStatus, updateCase, updateKillSwitch, updateRollout,
  type FraudCase, type PendingApproval, type FraudOverview, type FraudSettings, type OrgStatus, type Severity,
} from '@/lib/fraudAdminApi';

type KillKey = 'kill_outbound_calls' | 'kill_sms' | 'kill_international' | 'kill_otp_sms';
const KILL_KEYS: readonly KillKey[] = ['kill_outbound_calls', 'kill_sms', 'kill_international', 'kill_otp_sms'];

const SEVERITY_STYLE: Record<Severity, string> = {
  low: 'bg-bg-tertiary text-text-secondary',
  medium: 'bg-warning-500/10 text-warning-500',
  high: 'bg-danger/10 text-danger',
};

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function SEO() {
  useSEO({ title: 'Fraud & abuse — Staff', description: 'Internal: fraud and abuse controls.', canonical: 'https://vireek.com/staff/abuse' });
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

export function StaffAbusePage() {
  const { t } = useAbuseT();
  const { toast } = useToast();
  const [overview, setOverview] = useState<FraudOverview | null>(null);
  const [cases, setCases] = useState<FraudCase[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'forbidden'>('loading');
  const [busy, setBusy] = useState<string | null>(null);
  const [killReason, setKillReason] = useState('');
  const [report, setReport] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const [o, c, a] = await Promise.all([fetchOverview(), fetchCases(), fetchApprovals()]);
      setOverview(o);
      setCases(c);
      setApprovals(a);
      setState('ready');
    } catch (e) {
      setState(e instanceof FraudAdminError && e.status === 403 ? 'forbidden' : 'error');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = async (key: KillKey | 'enforce', next: boolean) => {
    if (killReason.trim().length < 3) { toast(t('kill.reasonLabel'), 'error'); return; }
    setBusy(key);
    try {
      await updateKillSwitch({ [key]: next }, killReason.trim());
      setOverview((o) => (o && o.settings ? { ...o, settings: { ...o.settings, [key]: next } as FraudSettings } : o));
      toast(t('kill.applied'), 'success');
    } catch {
      toast(t('loadError'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const rollout = async (patch: Parameters<typeof updateRollout>[0]) => {
    if (killReason.trim().length < 3) { toast(t('kill.reasonLabel'), 'error'); return; }
    setBusy('rollout');
    try {
      await updateRollout(patch, killReason.trim());
      toast(t('kill.applied'), 'success');
      await load();
    } catch {
      toast(t('loadError'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const decide = async (a: PendingApproval, decision: 'approved' | 'rejected') => {
    setBusy(`${a.user_id}:${a.campaign}`);
    try {
      await decideApproval(a.user_id, a.campaign, decision);
      toast(t('approvals.done'), 'success');
      await load();
    } catch {
      toast(t('cases.failed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const act = async (c: FraudCase, status: OrgStatus) => {
    const reason = window.prompt(t('cases.reasonPrompt'));
    if (!reason || reason.trim().length < 3) return;
    setBusy(c.id);
    try {
      await setOrgStatus(c.user_id, status, reason.trim(), status === 'throttled' ? 1 : undefined);
      if (status === 'active') await updateCase(c.id, 'resolved', reason.trim());
      toast(t('cases.done'), 'success');
      await load();
    } catch {
      toast(t('cases.failed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const resolve = async (c: FraudCase) => {
    setBusy(c.id);
    try {
      await updateCase(c.id, 'resolved', 'Reviewed: no action needed');
      await load();
    } catch {
      toast(t('cases.failed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const makeReport = async () => {
    setBusy('report');
    try { setReport(await fetchWeeklyReport()); } catch { toast(t('report.failed'), 'error'); } finally { setBusy(null); }
  };

  const settings = overview?.settings ?? null;
  const denied = Object.entries(overview?.denied24h ?? {}).sort((a, b) => b[1] - a[1]);
  const total24h = denied.reduce((s, [, n]) => s + n, 0);

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
            <Button variant="secondary" size="sm" onClick={() => void load()} loading={state === 'loading'} loadingLabel={t('loading')}>
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
              <section aria-label={t('title')} className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
                <Stat label={t('stats.openCases')} value={overview.openCases} bad />
                <Stat label={t('stats.suspended')} value={overview.suspended} bad />
                <Stat label={t('stats.throttled')} value={overview.throttled} />
                <Stat label={t('stats.denied24h')} value={total24h} />
              </section>

              <section aria-labelledby="kill-h" className="mt-10">
                <h2 id="kill-h" className="text-lg font-semibold text-text-primary">{t('kill.title')}</h2>
                <p className="mt-1 text-sm text-text-secondary">{t('kill.hint')}</p>
                <label className="mt-4 block text-sm font-medium text-text-secondary" htmlFor="kill-reason">{t('kill.reasonLabel')}</label>
                <input
                  id="kill-reason" value={killReason} onChange={(e) => setKillReason(e.target.value)} maxLength={300}
                  className="focus-ring mt-1 w-full max-w-xl rounded-lg border border-border bg-bg-secondary px-3 py-2 text-text-primary"
                />
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  {settings && KILL_KEYS.map((k) => (
                    <Switch key={k} label={t(`kill.${k}`)} checked={settings[k]} loading={busy === k} onChange={(v) => void toggle(k, v)} />
                  ))}
                  {settings && <Switch label={t('kill.enforce')} checked={settings.enforce} loading={busy === 'enforce'} onChange={(v) => void toggle('enforce', v)} />}
                </div>
              </section>

              <section aria-labelledby="rollout-h" className="mt-10">
                <h2 id="rollout-h" className="text-lg font-semibold text-text-primary">{t('rollout.title')}</h2>
                <p className="mt-1 text-sm text-text-secondary">{t('rollout.hint')}</p>
                {settings && (
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <label className="block text-sm font-medium text-text-secondary">
                      {t('rollout.consent')}
                      <select
                        className="focus-ring mt-1 w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-text-primary"
                        value={settings.consent_mode} disabled={busy === 'rollout'}
                        onChange={(e) => void rollout({ consent_mode: e.target.value as FraudSettings['consent_mode'] })}
                      >
                        <option value="off">{t('rollout.off')}</option>
                        <option value="log">{t('rollout.log')}</option>
                        <option value="enforce">{t('rollout.enforce')}</option>
                      </select>
                    </label>
                    <label className="block text-sm font-medium text-text-secondary">
                      {t('rollout.freeMinutes')}
                      <select
                        className="focus-ring mt-1 w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-text-primary"
                        value={settings.free_minutes_mode} disabled={busy === 'rollout'}
                        onChange={(e) => void rollout({ free_minutes_mode: e.target.value as FraudSettings['free_minutes_mode'] })}
                      >
                        <option value="monthly">{t('rollout.monthly')}</option>
                        <option value="lifetime">{t('rollout.lifetime')}</option>
                      </select>
                    </label>
                  </div>
                )}
              </section>

              <section aria-labelledby="appr-h" className="mt-10">
                <h2 id="appr-h" className="text-lg font-semibold text-text-primary">{t('approvals.title')}</h2>
                {approvals.length === 0 ? <p className="mt-2 text-text-secondary">{t('approvals.empty')}</p> : (
                  <ul className="mt-3 space-y-2">
                    {approvals.map((a) => (
                      <li key={`${a.user_id}:${a.campaign}`} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3">
                        <span className="text-sm text-text-primary"><span className="font-mono text-xs">{a.user_id}</span> · {a.campaign}</span>
                        <span className="flex gap-2">
                          <Button size="sm" variant="secondary" disabled={busy === `${a.user_id}:${a.campaign}`} onClick={() => void decide(a, 'approved')}>{t('approvals.approve')}</Button>
                          <Button size="sm" variant="danger" disabled={busy === `${a.user_id}:${a.campaign}`} onClick={() => void decide(a, 'rejected')}>{t('approvals.reject')}</Button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section aria-labelledby="denied-h" className="mt-10">
                <h2 id="denied-h" className="text-lg font-semibold text-text-primary">{t('denied.title')}</h2>
                {denied.length === 0 ? <p className="mt-2 text-text-secondary">{t('denied.empty')}</p> : (
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {denied.map(([code, n]) => (
                      <li key={code} className="rounded-full bg-bg-tertiary px-3 py-1 text-sm text-text-primary"><span className="font-mono">{code}</span> · {n}</li>
                    ))}
                  </ul>
                )}
              </section>

              <section aria-labelledby="loss-h" className="mt-10">
                <h2 id="loss-h" className="text-lg font-semibold text-text-primary">{t('loss.title')}</h2>
                <p className="mt-1 text-sm text-text-secondary">{t('loss.hint')}</p>
                <div className="mt-3 overflow-x-auto rounded-xl border border-border">
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">{t('loss.title')}</caption>
                    <thead className="bg-bg-secondary text-text-secondary">
                      <tr>
                        <th scope="col" className="px-4 py-3">{t('loss.plan')}</th>
                        <th scope="col" className="px-4 py-3 text-right">{t('loss.unverified')}</th>
                        <th scope="col" className="px-4 py-3 text-right">{t('loss.verified')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.lossBounds.map((b) => (
                        <tr key={b.plan} className="border-t border-border">
                          <th scope="row" className="px-4 py-3 font-medium text-text-primary">{b.plan}</th>
                          <td className="px-4 py-3 text-right tabular-nums text-text-primary">{usd(b.unverifiedCents)}</td>
                          <td className="px-4 py-3 text-right tabular-nums text-text-primary">{usd(b.verifiedCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section aria-labelledby="cases-h" className="mt-10">
                <h2 id="cases-h" className="text-lg font-semibold text-text-primary">{t('cases.title')}</h2>
                {cases.length === 0 ? <p className="mt-2 text-text-secondary">{t('cases.empty')}</p> : (
                  <div className="mt-3 overflow-x-auto rounded-xl border border-border">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-bg-secondary text-text-secondary">
                        <tr>
                          <th scope="col" className="px-4 py-3">{t('cases.account')}</th>
                          <th scope="col" className="px-4 py-3">{t('cases.severity')}</th>
                          <th scope="col" className="px-4 py-3">{t('cases.summary')}</th>
                          <th scope="col" className="px-4 py-3">{t('cases.actions')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cases.map((c) => (
                          <tr key={c.id} className="border-t border-border align-top">
                            <td className="px-4 py-3 font-mono text-xs text-text-primary">{c.user_id}</td>
                            <td className="px-4 py-3"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLE[c.severity]}`}>{t(`severity.${c.severity}`)}</span></td>
                            <td className="px-4 py-3 text-text-primary">
                              <p>{c.title}</p>
                              {c.appeal_text && <p className="mt-2 text-text-secondary"><strong>{t('cases.appeal')}:</strong> {c.appeal_text}</p>}
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex flex-wrap gap-2">
                                <Button size="sm" variant="danger" disabled={busy === c.id} onClick={() => void act(c, 'suspended')}>{t('cases.suspend')}</Button>
                                <Button size="sm" variant="secondary" disabled={busy === c.id} onClick={() => void act(c, 'throttled')}>{t('cases.throttle')}</Button>
                                <Button size="sm" variant="secondary" disabled={busy === c.id} onClick={() => void act(c, 'active')}>{t('cases.restore')}</Button>
                                <Button size="sm" variant="ghost" disabled={busy === c.id} onClick={() => void resolve(c)}>{t('cases.resolve')}</Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section aria-labelledby="report-h" className="mt-10">
                <h2 id="report-h" className="text-lg font-semibold text-text-primary">{t('report.title')}</h2>
                <Button className="mt-3" variant="secondary" size="sm" onClick={() => void makeReport()} loading={busy === 'report'} loadingLabel={t('loading')}>{t('report.generate')}</Button>
                {report && <pre className="mt-3 whitespace-pre-wrap rounded-xl border border-border bg-bg-secondary p-4 text-sm text-text-primary">{report}</pre>}
              </section>
            </>
          )}
        </div>
      </main>
    </>
  );
}
