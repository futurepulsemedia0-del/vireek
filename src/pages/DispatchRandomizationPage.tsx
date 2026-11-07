import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Dices, Loader2, Power } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { RZ_NS } from '@/i18n/dispatchRandomizationNamespace';
import { summarizeDraws, validateSettings, type DrawSummary } from '@/lib/naturalRandomization';
import {
  DEFAULT_SETTINGS,
  fetchAudit,
  fetchRandomizedDecisions,
  fetchSettings,
  saveSettings,
  switchOff,
  type AuditRow,
  type RandomizationSettingsRow,
} from '@/lib/dispatchRandomizationApi';
import { fetchTechnicians } from '@/lib/opsExperimentsApi';

const card = 'rounded-2xl border border-border bg-bg-secondary p-4';
const field = 'focus-ring w-full rounded-lg border border-border bg-bg-primary px-2.5 py-1.5 text-sm text-text-primary';
const SUMMARY_DAYS = 30;
const SKIP_KEYS = ['vip_job', 'excluded_service', 'fewer_than_two_tied', 'eta_unknown', 'eta_delta_exceeded'] as const;

function parseServiceTypes(raw: string): string[] {
  return [...new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

export function DispatchRandomizationPage() {
  const { t, i18n } = useTranslation(RZ_NS);
  const { isOwner, profile, teamMember, permissions } = useAuth();
  const { toast } = useToast();
  const ownerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const canEdit = isOwner || permissions.can_manage_team;
  const num = useMemo(() => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }), [i18n.language]);
  const when = useCallback((iso: string) => new Date(iso).toLocaleString(i18n.language), [i18n.language]);

  const [settings, setSettings] = useState<RandomizationSettingsRow | null>(null);
  const [epsilon, setEpsilon] = useState(String(DEFAULT_SETTINGS.epsilon));
  const [topK, setTopK] = useState(String(DEFAULT_SETTINGS.top_k));
  const [eta, setEta] = useState(String(DEFAULT_SETTINGS.max_eta_delta_minutes));
  const [excluded, setExcluded] = useState('');
  const [ack, setAck] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<DrawSummary | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    if (!ownerId) return;
    try {
      const since = new Date(Date.now() - SUMMARY_DAYS * 86_400_000).toISOString();
      const [s, decisions, techs, log] = await Promise.all([fetchSettings(ownerId), fetchRandomizedDecisions(ownerId, since), fetchTechnicians(), fetchAudit(ownerId)]);
      setSettings(s);
      setEpsilon(String(s.epsilon));
      setTopK(String(s.top_k));
      setEta(String(s.max_eta_delta_minutes));
      setExcluded(s.excluded_service_types.join(', '));
      setSummary(summarizeDraws(decisions));
      setNames(Object.fromEntries(techs.map((x) => [x.id, x.member_name || x.member_email])));
      setAudit(log);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [ownerId]);
  useEffect(() => { void load(); }, [load]);

  const draft = useMemo(() => ({ epsilon: Number(epsilon), top_k: Number(topK), max_eta_delta_minutes: Number(eta) }), [epsilon, topK, eta]);

  async function persist(enabled: boolean) {
    if (!ownerId || !canEdit) return;
    const problems = validateSettings(draft);
    setErrors(problems);
    if (problems.length > 0) return;
    setBusy(true);
    try {
      await saveSettings(ownerId, { enabled, ...draft, excluded_service_types: parseServiceTypes(excluded) });
      toast(t(enabled ? 'toast.enabled' : 'toast.saved'), 'success');
      setAck(false);
      await load();
    } catch {
      toast(t('toast.failed'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function kill() {
    if (!ownerId || !canEdit) return;
    setBusy(true);
    try {
      await switchOff(ownerId);
      toast(t('toast.off'), 'success');
      await load();
    } catch {
      toast(t('toast.failed'), 'error');
    } finally {
      setBusy(false);
    }
  }

  const enabled = settings?.enabled === true;

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <Link to="/dashboard/assignment-rules" className="focus-ring mb-4 inline-flex items-center gap-1 text-xs font-medium text-text-secondary hover:text-accent">
          <ArrowLeft size={12} className="rtl:rotate-180" aria-hidden="true" /> {t('back')}
        </Link>
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"><Dices size={20} aria-hidden="true" /></span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">{t('title')}</h1>
            <p className="mt-1 text-sm text-text-secondary">{t('subtitle')}</p>
          </div>
        </div>

        {!canEdit && <p role="status" className="mb-4 rounded-xl border border-border bg-bg-secondary p-3 text-xs text-text-secondary">{t('readOnly')}</p>}
        {loadError && (
          <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-text-primary">
            <span>{t('loadFailed')}</span>
            <Button type="button" variant="secondary" size="sm" onClick={() => void load()}>{t('retry')}</Button>
          </div>
        )}
        {!settings && !loadError && <div className="flex justify-center py-12"><Loader2 className="animate-spin motion-reduce:animate-none text-text-secondary" aria-label={t('loading')} /></div>}

        {settings && (
          <div className="space-y-4">
            <section aria-labelledby="rz-status" className={card}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 id="rz-status" className="text-base font-semibold text-text-primary">{t('status.title')}</h2>
                  <p role="status" aria-live="polite" className={`mt-1 text-sm font-medium ${enabled ? 'text-success-500' : 'text-text-secondary'}`}>{enabled ? t('status.on') : t('status.off')}</p>
                  {settings.updated_at && <p className="mt-1 text-xs text-text-secondary">{t('status.updated', { when: when(settings.updated_at) })}</p>}
                </div>
                {enabled && canEdit && (
                  <Button type="button" variant="danger" onClick={() => void kill()} disabled={busy}>
                    <Power size={14} aria-hidden="true" /> {t('status.killSwitch')}
                  </Button>
                )}
              </div>
              <p className="mt-3 text-xs text-text-secondary">{t('status.killNote')}</p>
            </section>

            <section aria-labelledby="rz-how" className={card}>
              <h2 id="rz-how" className="text-base font-semibold text-text-primary">{t('how.title')}</h2>
              <p className="mt-2 text-sm text-text-secondary">{t('how.intro')}</p>
              <ul className="mt-3 list-disc space-y-1.5 ps-5 text-sm text-text-primary">
                {(['g1', 'g2', 'g3', 'g4', 'g5', 'g6'] as const).map((k) => <li key={k}>{t(`how.${k}`)}</li>)}
              </ul>
              <p className="mt-3 text-xs text-text-secondary">{t('how.limits')}</p>
            </section>

            <section aria-labelledby="rz-settings" className={card}>
              <h2 id="rz-settings" className="text-base font-semibold text-text-primary">{t('settings.title')}</h2>
              <div className="mt-3 grid gap-4 sm:grid-cols-3">
                <div>
                  <label htmlFor="rz-eps" className="text-sm font-medium text-text-primary">{t('settings.epsilon')}</label>
                  <input id="rz-eps" type="number" inputMode="decimal" min={0} max={10} step={0.1} disabled={!canEdit || busy} value={epsilon} onChange={(e) => setEpsilon(e.target.value)} aria-describedby="rz-eps-h" aria-invalid={errors.includes('epsilon')} className={field} />
                  <p id="rz-eps-h" className="mt-1 text-xs text-text-secondary">{t('settings.epsilonHelp')}</p>
                </div>
                <div>
                  <label htmlFor="rz-k" className="text-sm font-medium text-text-primary">{t('settings.topK')}</label>
                  <input id="rz-k" type="number" inputMode="numeric" min={2} max={5} step={1} disabled={!canEdit || busy} value={topK} onChange={(e) => setTopK(e.target.value)} aria-describedby="rz-k-h" aria-invalid={errors.includes('topK')} className={field} />
                  <p id="rz-k-h" className="mt-1 text-xs text-text-secondary">{t('settings.topKHelp')}</p>
                </div>
                <div>
                  <label htmlFor="rz-eta" className="text-sm font-medium text-text-primary">{t('settings.eta')}</label>
                  <input id="rz-eta" type="number" inputMode="numeric" min={0} max={120} step={1} disabled={!canEdit || busy} value={eta} onChange={(e) => setEta(e.target.value)} aria-describedby="rz-eta-h" aria-invalid={errors.includes('eta')} className={field} />
                  <p id="rz-eta-h" className="mt-1 text-xs text-text-secondary">{t('settings.etaHelp')}</p>
                </div>
              </div>
              <div className="mt-4">
                <label htmlFor="rz-excl" className="text-sm font-medium text-text-primary">{t('settings.excluded')}</label>
                <input id="rz-excl" type="text" disabled={!canEdit || busy} value={excluded} onChange={(e) => setExcluded(e.target.value)} aria-describedby="rz-excl-h" className={field} />
                <p id="rz-excl-h" className="mt-1 text-xs text-text-secondary">{t('settings.excludedHelp')}</p>
              </div>
              {errors.length > 0 && (
                <ul role="alert" className="mt-3 list-disc space-y-1 ps-5 text-sm text-danger">
                  {errors.map((k) => <li key={k}>{t(`errors.${k}`)}</li>)}
                </ul>
              )}
              {canEdit && (
                <div className="mt-4 space-y-3">
                  {!enabled && (
                    <label className="flex items-start gap-2 text-sm text-text-primary">
                      <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="focus-ring mt-0.5 h-4 w-4" />
                      <span>{t('settings.ack')}</span>
                    </label>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="secondary" disabled={busy} onClick={() => void persist(enabled)}>{t('settings.save')}</Button>
                    {!enabled && (
                      <Button type="button" disabled={busy || !ack} loading={busy} onClick={() => void persist(true)}>{t('settings.enable')}</Button>
                    )}
                  </div>
                </div>
              )}
            </section>

            <section aria-labelledby="rz-overview" className={card}>
              <h2 id="rz-overview" className="text-base font-semibold text-text-primary">{t('overview.title', { days: SUMMARY_DAYS })}</h2>
              {!summary || summary.total === 0 ? (
                <p className="mt-2 text-sm text-text-secondary">{t('overview.empty')}</p>
              ) : (
                <>
                  <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
                    <div><dt className="text-xs text-text-secondary">{t('overview.considered')}</dt><dd className="text-lg font-semibold text-text-primary">{num.format(summary.total)}</dd></div>
                    <div><dt className="text-xs text-text-secondary">{t('overview.drawn')}</dt><dd className="text-lg font-semibold text-text-primary">{num.format(summary.applied)}</dd></div>
                    <div><dt className="text-xs text-text-secondary">{t('overview.drawnShare')}</dt><dd className="text-lg font-semibold text-text-primary">{num.format((summary.applied / summary.total) * 100)}%</dd></div>
                  </dl>
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full text-start text-sm">
                      <caption className="mb-1 text-start text-xs font-semibold text-text-secondary">{t('overview.skipCaption')}</caption>
                      <thead><tr><th scope="col" className="py-1 text-start font-medium">{t('overview.reason')}</th><th scope="col" className="py-1 text-end font-medium">{t('overview.count')}</th></tr></thead>
                      <tbody>
                        {SKIP_KEYS.filter((k) => summary.skipped[k]).map((k) => (
                          <tr key={k} className="border-t border-border"><td className="py-1">{t(`skip.${k}`)}</td><td className="py-1 text-end">{num.format(summary.skipped[k])}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {summary.balance.rows.length > 0 && (
                    <div className="mt-4 overflow-x-auto">
                      <table className="w-full text-start text-sm">
                        <caption className="mb-1 text-start text-xs font-semibold text-text-secondary">{t('balance.caption')}</caption>
                        <thead>
                          <tr>
                            <th scope="col" className="py-1 text-start font-medium">{t('balance.technician')}</th>
                            <th scope="col" className="py-1 text-end font-medium">{t('balance.expected')}</th>
                            <th scope="col" className="py-1 text-end font-medium">{t('balance.received')}</th>
                            <th scope="col" className="py-1 text-end font-medium">{t('balance.status')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {summary.balance.rows.map((r) => {
                            const off = r.expected >= 30 && r.ratio !== null && Math.abs(r.ratio - 1) > 0.25;
                            return (
                              <tr key={r.technician_id} className="border-t border-border">
                                <td className="py-1">{names[r.technician_id] ?? t('balance.unknown')}</td>
                                <td className="py-1 text-end">{num.format(r.expected)}</td>
                                <td className="py-1 text-end">{num.format(r.observed)}</td>
                                <td className={`py-1 text-end font-medium ${off ? 'text-warning-500' : 'text-success-500'}`}>{off ? t('balance.uneven') : t('balance.fair')}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {summary.balance.failed && <p role="alert" className="mt-3 rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-text-primary">{t('balance.srmFailed')}</p>}
                </>
              )}
              <p className="mt-4 text-sm"><Link to="/dashboard/experiments" className="focus-ring font-medium text-accent hover:underline">{t('overview.experimentsLink')}</Link></p>
            </section>

            <section aria-labelledby="rz-audit" className={card}>
              <h2 id="rz-audit" className="text-base font-semibold text-text-primary">{t('audit.title')}</h2>
              {audit.length === 0 ? (
                <p className="mt-2 text-sm text-text-secondary">{t('audit.empty')}</p>
              ) : (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-start text-sm">
                    <caption className="sr-only">{t('audit.title')}</caption>
                    <thead><tr><th scope="col" className="py-1 text-start font-medium">{t('audit.when')}</th><th scope="col" className="py-1 text-start font-medium">{t('audit.change')}</th></tr></thead>
                    <tbody>
                      {audit.map((a) => {
                        const was = a.before?.enabled;
                        const now = a.after.enabled;
                        const what = was === undefined ? (now ? t('audit.createdOn') : t('audit.createdOff')) : was !== now ? (now ? t('audit.turnedOn') : t('audit.turnedOff')) : t('audit.adjusted');
                        return (
                          <tr key={a.id} className="border-t border-border">
                            <td className="py-1 pe-3 align-top">{when(a.created_at)}</td>
                            <td className="py-1">{what} <span className="text-xs text-text-secondary">({t('audit.values', { eps: a.after.epsilon, k: a.after.top_k, eta: a.after.max_eta_delta_minutes })})</span></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
