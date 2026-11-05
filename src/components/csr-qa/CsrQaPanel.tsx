import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardCheck, Loader2, ShieldAlert } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/contexts/ToastContext';
import { useAutopilotT } from '@/i18n/autopilotNamespace';
import {
  DEFAULT_QA_SETTINGS, MIN_AGENT_SAMPLE, QA_DIMENSIONS, fairnessReport, fetchAgentNames, fetchQaReviews, fetchQaSettings,
  markQaReviewed, runQaScoring, saveQaSettings, type CsrQaReview, type CsrQaSettings,
} from '@/lib/voiceAutopilot';

const RETENTION = [30, 60, 90, 180, 365];
const UNASSIGNED = '__none__';

export function CsrQaPanel() {
  const { t } = useAutopilotT();
  const { toast } = useToast();
  const [settings, setSettings] = useState<CsrQaSettings>(DEFAULT_QA_SETTINGS);
  const [draft, setDraft] = useState({ enabled: false, employee_transparency: false, retention_days: 90 });
  const [ack, setAck] = useState(false);
  const [reviews, setReviews] = useState<CsrQaReview[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const s = await fetchQaSettings();
      setSettings(s);
      setDraft({ enabled: s.enabled, employee_transparency: s.employee_transparency, retention_days: s.retention_days });
      setAck(!!s.policy_ack_at);
      if (s.enabled) {
        const [r, n] = await Promise.all([fetchQaReviews(), fetchAgentNames().catch(() => new Map<string, string>())]);
        setReviews(r); setNames(n);
      } else { setReviews([]); }
    } catch { setError(true); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try { await saveQaSettings(draft, draft.enabled && ack); toast(t('settings.saved'), 'success'); await load(); }
    catch { toast(t('qa.ownerOnly'), 'error'); } finally { setSaving(false); }
  };
  const run = async () => {
    setRunning(true);
    try { const r = await runQaScoring(); toast(t('qa.ran', r), 'success'); await load(); } catch { toast(t('qa.runFailed'), 'error'); } finally { setRunning(false); }
  };
  const confirm = async (id: string) => {
    try { await markQaReviewed(id); setReviews((rs) => rs.map((r) => (r.id === id ? { ...r, status: 'human_reviewed' } : r))); }
    catch { toast(t('qa.confirmFailed'), 'error'); }
  };

  const fairness = useMemo(
    () => fairnessReport(reviews.map((r) => ({ agentId: r.agent_id ?? UNASSIGNED, at: r.call_at, overall: r.overall, scenario: r.scenario ?? 'other', afterHours: r.after_hours, language: r.language })), Date.now()),
    [reviews],
  );
  const nameOf = (id: string) => (id === UNASSIGNED ? t('qa.unassigned') : names.get(id) ?? t('qa.unassigned'));
  const dirty = draft.enabled !== settings.enabled || draft.employee_transparency !== settings.employee_transparency || draft.retention_days !== settings.retention_days || (draft.enabled && !settings.policy_ack_at && ack);
  const canEnable = !draft.enabled || ack;

  if (loading) return <Skeleton className="h-64 rounded-2xl" />;
  if (error) {
    return (
      <div role="alert" className="flex flex-col gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
        <span className="text-text-primary">{t('common.loadError')}</span>
        <Button type="button" variant="secondary" size="sm" onClick={() => void load()}>{t('common.tryAgain')}</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section aria-labelledby="qa-title" className="rounded-2xl border border-border bg-bg-secondary p-5">
        <h3 id="qa-title" className="flex items-center gap-2 text-base font-semibold text-text-primary"><ClipboardCheck size={18} aria-hidden="true" className="text-accent" />{t('qa.title')}</h3>
        <p className="mt-1 text-sm text-text-secondary">{t('qa.intro')}</p>
        <div role="note" className="mt-3 flex items-start gap-2 rounded-xl border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-text-primary">
          <ShieldAlert size={16} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />
          <p><strong>{t('qa.policyTitle')}.</strong> {t('qa.policy')}</p>
        </div>
        <div className="mt-4 space-y-4">
          <Switch checked={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} label={t('qa.enable')} hint={!settings.enabled ? t('qa.offBody') : undefined} />
          {draft.enabled && (
            <>
              <label className="flex min-h-[44px] items-start gap-3 text-sm text-text-primary">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="focus-ring mt-1 h-4 w-4" />{t('qa.ack')}
              </label>
              <Switch checked={draft.employee_transparency} onChange={(v) => setDraft({ ...draft, employee_transparency: v })} label={t('qa.transparency')} hint={t('qa.transparencyHint')} />
              <div>
                <label htmlFor="qa-ret" className="mb-1.5 block text-sm font-medium text-text-primary">{t('qa.retention')}</label>
                <select id="qa-ret" value={draft.retention_days} onChange={(e) => setDraft({ ...draft, retention_days: Number(e.target.value) })} className="focus-ring w-full max-w-xs rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary">
                  {RETENTION.map((d) => (<option key={d} value={d}>{t('qa.days', { n: d })}</option>))}
                </select>
              </div>
            </>
          )}
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          {settings.enabled && (
            <Button type="button" variant="secondary" onClick={run} disabled={running}>
              {running ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
              {running ? t('qa.running') : t('qa.run')}
            </Button>
          )}
          <Button type="button" onClick={save} disabled={!dirty || saving || !canEnable}>{saving ? t('common.saving') : t('common.save')}</Button>
        </div>
      </section>

      {settings.enabled && reviews.length === 0 && <EmptyState icon={ClipboardCheck} title={t('qa.empty')} description={t('qa.emptyBody')} />}

      {settings.enabled && reviews.length > 0 && (
        <>
          <section aria-labelledby="qa-agents" className="rounded-2xl border border-border bg-bg-secondary p-5">
            <h3 id="qa-agents" className="text-base font-semibold text-text-primary">{t('qa.agents')}</h3>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead><tr className="text-xs text-text-secondary">
                  <th scope="col" className="py-2 pr-3 font-medium">{t('qa.agent')}</th><th scope="col" className="py-2 pr-3 font-medium">{t('qa.calls')}</th>
                  <th scope="col" className="py-2 pr-3 font-medium">{t('qa.raw')}</th><th scope="col" className="py-2 pr-3 font-medium">{t('qa.adjusted')}</th><th scope="col" className="py-2 font-medium">{t('qa.trend')}</th>
                </tr></thead>
                <tbody>
                  {fairness.agents.map((a) => (
                    <tr key={a.agentId} className="border-t border-border">
                      <th scope="row" className="py-2 pr-3 font-medium text-text-primary">{nameOf(a.agentId)}</th>
                      <td className="py-2 pr-3 text-text-primary">{a.n}</td>
                      {a.suppressed ? <td colSpan={3} className="py-2 text-xs text-text-secondary">{t('qa.tooFew', { n: MIN_AGENT_SAMPLE })}</td> : (
                        <>
                          <td className="py-2 pr-3 text-text-primary">{a.rawMean?.toFixed(0)}</td>
                          <td className="py-2 pr-3 text-text-primary">{a.adjustedMean?.toFixed(0)}</td>
                          <td className="py-2 text-text-secondary">{a.trend?.reliable && a.trend.direction ? t(`qa.${a.trend.direction}`) : ''}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h4 className="mt-4 text-sm font-semibold text-text-primary">{t('qa.fairnessTitle')}</h4>
            <ul className="mt-1 space-y-1 text-xs text-text-secondary">
              {fairness.mixSensitive.length > 0 && <li>{t('qa.mixSensitive', { names: fairness.mixSensitive.map(nameOf).join(', ') })}</li>}
              {fairness.languageGapFlags.map((f) => (<li key={f.a + f.b}>{t('qa.languageGap', f)}</li>))}
              {fairness.mixSensitive.length === 0 && fairness.languageGapFlags.length === 0 && <li>{t('qa.fairnessOk')}</li>}
            </ul>
          </section>

          <section aria-labelledby="qa-reviews" className="rounded-2xl border border-border bg-bg-secondary p-5">
            <h3 id="qa-reviews" className="text-base font-semibold text-text-primary">{t('qa.reviews')}</h3>
            <ul className="mt-3 space-y-2">
              {reviews.slice(0, 30).map((r) => (
                <li key={r.id} className="rounded-xl border border-border bg-bg-primary px-4 py-3 text-sm">
                  <button type="button" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)} className="focus-ring flex min-h-[44px] w-full items-center justify-between gap-2 rounded text-left">
                    <span className="text-text-primary">{nameOf(r.agent_id ?? UNASSIGNED)} · {new Date(r.call_at).toLocaleDateString()}</span>
                    <span className="font-semibold text-text-primary">{t('qa.overall')}: {r.overall ?? t('qa.notApplicable')}</span>
                  </button>
                  {open === r.id && (
                    <div className="mt-2 space-y-3">
                      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {QA_DIMENSIONS.map((d) => (<div key={d}><dt className="text-xs text-text-secondary">{t(`qa.dim.${d}`)}</dt><dd className="font-semibold text-text-primary">{r.scores[d] ?? t('qa.notApplicable')}</dd></div>))}
                      </dl>
                      {r.clips.length > 0 && (<div><h4 className="text-xs font-semibold text-text-secondary">{t('qa.clips')}</h4><ul className="mt-1 space-y-0.5 text-xs text-text-primary">
                        {r.clips.map((c, i) => (<li key={i}>{t('qa.clip', { from: c.startTurn + 1, to: c.endTurn + 1, dimension: t(`qa.dim.${c.dimension}`) })} — {t(`qa.${c.note}`)}</li>))}</ul></div>)}
                      {r.coaching.length > 0 && (<div><h4 className="text-xs font-semibold text-text-secondary">{t('qa.coaching')}</h4><ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-text-primary">
                        {r.coaching.map((c) => (<li key={c}>{t(`qa.coach.${c}`)}</li>))}</ul></div>)}
                      <p className="text-xs text-text-secondary">{r.status === 'human_reviewed' ? t('qa.confirmed') : t('qa.auto')}</p>
                      {r.status === 'auto' && <Button type="button" variant="secondary" size="sm" onClick={() => void confirm(r.id)}>{t('qa.confirm')}</Button>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
