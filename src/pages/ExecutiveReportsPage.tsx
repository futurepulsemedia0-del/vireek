// src/pages/ExecutiveReportsPage.tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Eye, FileBarChart, Loader2, Save, Send } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList } from '@/components/Skeleton';
import {
  STATUS_LABEL, commonTimeZones, defaultDraft, fetchReports, fetchSettings, formatMoney, formatPct,
  getPdfUrl, runReportAction, saveSettings, validateDraft,
  type ExecutiveReportRow, type ExecutiveReportSettingsDraft, type ReportAction,
} from '@/lib/executiveReport';

const STATUS_STYLE: Record<ExecutiveReportRow['status'], string> = {
  ready: 'bg-accent/10 text-accent',
  sent: 'bg-success-500/10 text-success-500',
  partial: 'bg-warning-500/10 text-warning-500',
  failed: 'bg-danger/10 text-danger',
};

const selectClass =
  'w-full rounded-xl border border-border bg-bg-secondary px-4 py-3 text-base text-text-primary focus-visible:border-accent focus-visible:outline-none';

function Toggle({ id, checked, onChange, label, hint }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-3 text-sm">
      <input id={id} type="checkbox" className="mt-1 h-4 w-4" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="font-medium text-text-primary">{label}</span>
        {hint && <span className="block text-xs text-text-secondary">{hint}</span>}
      </span>
    </label>
  );
}

export function ExecutiveReportsPage() {
  const { user, isOwner, profileLoading } = useAuth();
  const { toast } = useToast();

  const [draft, setDraft] = useState<ExecutiveReportSettingsDraft>(() => defaultDraft(Intl.DateTimeFormat().resolvedOptions().timeZone));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reports, setReports] = useState<ExecutiveReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<ReportAction | null>(null);
  const [confirmSend, setConfirmSend] = useState(false);

  const zones = useMemo(() => commonTimeZones(draft.timezone), [draft.timezone]);
  const patch = (p: Partial<ExecutiveReportSettingsDraft>) => setDraft((d) => ({ ...d, ...p }));

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setLoadError(false);
    try {
      const [settings, rows] = await Promise.all([fetchSettings(user.id), fetchReports()]);
      if (settings) setDraft(settings);
      setReports(rows);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (user && isOwner) void load();
  }, [user, isOwner, load]);

  const persist = useCallback(async (): Promise<boolean> => {
    if (!user) return false;
    const found = validateDraft(draft);
    setErrors(found);
    if (Object.keys(found).length) {
      toast('Please fix the highlighted fields', 'error');
      return false;
    }
    await saveSettings(user.id, draft);
    return true;
  }, [user, draft, toast]);

  const onSave = async () => {
    setSaving(true);
    try {
      if (await persist()) toast('Report settings saved', 'success');
    } catch {
      toast('Could not save settings', 'error');
    } finally {
      setSaving(false);
    }
  };

  const onAction = async (action: ReportAction) => {
    setBusy(action);
    try {
      if (!(await persist())) return;
      const res = await runReportAction(action, action === 'send_now' ? { resend: false } : {});
      if (action === 'preview' && res.report.pdf_url) window.open(res.report.pdf_url, '_blank', 'noopener');
      const d = res.delivery as { ok?: boolean; error?: string | null; status?: string; sent?: number; total?: number } | null;
      if (action === 'send_test') toast(d?.ok ? 'Test report sent to your email' : `Test email failed: ${d?.error ?? 'unknown error'}`, d?.ok ? 'success' : 'error');
      else if (action === 'send_now') toast(d?.status === 'sent' ? `Report sent to ${d.sent} recipient(s)` : `Send finished: ${d?.status ?? 'unknown'}${d?.error ? ` — ${d.error}` : ''}`, d?.status === 'sent' ? 'success' : 'error');
      else toast(`Report for ${res.report.period_label} is ready`, 'success');
      setReports(await fetchReports());
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Request failed', 'error');
    } finally {
      setBusy(null);
    }
  };

  const openPdf = async (row: ExecutiveReportRow) => {
    if (!row.pdf_path) return;
    try {
      window.open(await getPdfUrl(row.pdf_path), '_blank', 'noopener');
    } catch {
      toast('Could not open the PDF', 'error');
    }
  };

  const header = (
    <div className="mb-6 flex items-center gap-3">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
        <FileBarChart size={22} aria-hidden="true" />
      </span>
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Executive Monthly Report</h1>
        <p className="text-sm text-text-secondary">A PDF and email summary for owners: revenue, jobs, close rate, recovered calls, margin, top technicians, goals and AI commentary.</p>
      </div>
    </div>
  );

  if (profileLoading) {
    return <DashboardLayout><div className="mx-auto max-w-5xl px-4 py-8 sm:px-6"><SkeletonCardList count={2} /></div></DashboardLayout>;
  }
  if (!isOwner) {
    return (
      <DashboardLayout>
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
          {header}
          <EmptyState icon={FileBarChart} title="Owner access only" description="Executive reports contain company-wide financials. Ask the account owner to manage them." />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        {header}

        {loading ? (
          <SkeletonCardList count={3} />
        ) : loadError ? (
          <EmptyState icon={FileBarChart} title="Couldn't load report settings" description="Check your connection and try again." action={{ label: 'Retry', onClick: () => void load() }} />
        ) : (
          <div className="space-y-6">
            <Card>
              <h2 className="mb-4 text-lg font-semibold text-text-primary">Schedule & recipients</h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Toggle id="er-enabled" checked={draft.enabled} onChange={(v) => patch({ enabled: v })} label="Send automatically every month" hint="The previous month's report is sent on the day and hour below, in your time zone." />
                </div>
                <Input label="Day of month (1–28)" type="number" inputMode="numeric" min={1} max={28} value={draft.send_day} onChange={(e) => patch({ send_day: e.target.value })} error={errors.send_day} />
                <Input label="Hour (0–23, local)" type="number" inputMode="numeric" min={0} max={23} value={draft.send_hour} onChange={(e) => patch({ send_hour: e.target.value })} error={errors.send_hour} />
                <div className="sm:col-span-2">
                  <label htmlFor="er-timezone" className="mb-1.5 block text-sm font-medium text-text-primary">Time zone</label>
                  <select id="er-timezone" className={selectClass} value={draft.timezone} onChange={(e) => patch({ timezone: e.target.value })}>
                    {zones.map((z) => <option key={z} value={z}>{z}</option>)}
                  </select>
                  {errors.timezone && <p role="alert" className="mt-1.5 text-xs text-danger">{errors.timezone}</p>}
                </div>
                <Toggle id="er-owner" checked={draft.include_owner} onChange={(v) => patch({ include_owner: v })} label="Account owner" />
                <Toggle id="er-coowners" checked={draft.include_co_owners} onChange={(v) => patch({ include_co_owners: v })} label="Other owners on the team" />
                <div className="sm:col-span-2">
                  <Textarea label="Extra recipients" rows={2} placeholder="partner@company.com, cfo@company.com" value={draft.extra_recipients} onChange={(e) => patch({ extra_recipients: e.target.value })} error={errors.extra_recipients} helperText="Up to 10 emails, separated by commas or new lines." />
                </div>
                <div className="sm:col-span-2">
                  <Toggle id="er-ai" checked={draft.ai_commentary_enabled} onChange={(v) => patch({ ai_commentary_enabled: v })} label="AI commentary" hint="Every number in the commentary is verified against your data; otherwise a data-only summary is used." />
                </div>
              </div>
            </Card>

            <Card>
              <h2 className="mb-1 text-lg font-semibold text-text-primary">Monthly goals</h2>
              <p className="mb-4 text-sm text-text-secondary">Leave a goal empty to leave it out of the report.</p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Input label="Revenue goal ($)" type="number" inputMode="decimal" min={0} value={draft.revenue_goal} onChange={(e) => patch({ revenue_goal: e.target.value })} error={errors.revenue_goal} />
                <Input label="Jobs completed goal" type="number" inputMode="numeric" min={0} value={draft.jobs_goal} onChange={(e) => patch({ jobs_goal: e.target.value })} error={errors.jobs_goal} />
                <Input label="Close rate goal (%)" type="number" inputMode="decimal" min={0} max={100} value={draft.close_rate_goal_pct} onChange={(e) => patch({ close_rate_goal_pct: e.target.value })} error={errors.close_rate_goal_pct} />
                <Input label="Gross margin goal (%)" type="number" inputMode="decimal" min={0} max={100} value={draft.margin_goal_pct} onChange={(e) => patch({ margin_goal_pct: e.target.value })} error={errors.margin_goal_pct} />
              </div>
            </Card>

            <div className="flex flex-wrap gap-3">
              <Button onClick={() => void onSave()} disabled={saving || busy !== null}>
                {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />} Save settings
              </Button>
              <Button variant="secondary" onClick={() => void onAction('preview')} disabled={saving || busy !== null}>
                {busy === 'preview' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />} Preview last month
              </Button>
              <Button variant="secondary" onClick={() => void onAction('send_test')} disabled={saving || busy !== null}>
                {busy === 'send_test' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Send size={16} aria-hidden="true" />} Email me a test
              </Button>
              <Button variant="ghost" onClick={() => setConfirmSend(true)} disabled={saving || busy !== null}>
                Send to all recipients now
              </Button>
            </div>

            <section aria-labelledby="er-history">
              <h2 id="er-history" className="mb-3 text-lg font-semibold text-text-primary">Report history</h2>
              {reports.length === 0 ? (
                <EmptyState icon={FileBarChart} title="No reports generated" description="Use “Preview last month” to generate your first report now." />
              ) : (
                <ul className="space-y-3">
                  {reports.map((r) => (
                    <li key={r.id}>
                      <Card>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="font-semibold text-text-primary">{r.period_label}</h3>
                              <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                              {r.commentary_source === 'ai' && <span className="rounded-full bg-bg-tertiary px-2.5 py-0.5 text-xs text-text-secondary">AI commentary</span>}
                            </div>
                            {r.commentary?.headline && <p className="mt-1 text-sm text-text-secondary">{r.commentary.headline}</p>}
                            {r.metrics && (
                              <p className="mt-2 text-sm text-text-primary">
                                {formatMoney(r.metrics.current.revenue)} revenue · {r.metrics.current.jobsCompleted} jobs · close rate {formatPct(r.metrics.current.closeRatePct)} · margin {formatPct(r.metrics.current.marginPct)}
                              </p>
                            )}
                            {r.last_error && r.status !== 'sent' && <p role="alert" className="mt-1 text-xs text-danger">{r.last_error}</p>}
                          </div>
                          {r.pdf_path && (
                            <Button variant="secondary" size="sm" onClick={() => void openPdf(r)}>
                              <Download size={16} aria-hidden="true" /> PDF
                            </Button>
                          )}
                        </div>
                      </Card>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmSend}
        title="Send the report now?"
        description="Last month's report will be emailed to every configured recipient. Recipients who already received it are skipped."
        confirmLabel="Send report"
        onCancel={() => setConfirmSend(false)}
        onConfirm={async () => { setConfirmSend(false); await onAction('send_now'); }}
      />
    </DashboardLayout>
  );
}
