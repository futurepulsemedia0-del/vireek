import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ClipboardCheck, Plus, Search, History } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { CloseoutBoard, type RiskFilter } from '@/components/closeout/CloseoutBoard';
import { CloseoutCaseDrawer } from '@/components/closeout/CloseoutCaseDrawer';
import { CloseoutRulesPanel } from '@/components/closeout/CloseoutRulesPanel';
import { CloseoutSummaryPanel } from '@/components/closeout/CloseoutSummaryPanel';
import {
  DEFAULT_SETTINGS, ESTIMATE_DISCLAIMER, RULES_DISCLAIMER, fetchCloseoutCases, fetchCloseoutPrograms, fetchCloseoutSettings,
  fetchCloseoutSteps, fetchJobsWithoutCase, fetchRecentEvents, formatCents, moneyAtRisk, openCloseoutCase, riskCounts, todayIso,
  type CloseoutCase, type CloseoutEvent, type CloseoutProgram, type CloseoutSettings, type CloseoutStep, type CloseoutEvidence,
} from '@/lib/installCloseout';
import { supabase } from '@/lib/supabase';

type Tab = 'board' | 'rules' | 'summary' | 'audit';
const TABS: { key: Tab; label: string }[] = [
  { key: 'board', label: 'Closeout board' }, { key: 'rules', label: 'Rules' },
  { key: 'summary', label: 'Monthly summary' }, { key: 'audit', label: 'Audit log' },
];
const FILTERS: { key: RiskFilter; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'overdue', label: 'Overdue' }, { key: 'critical', label: 'Due ≤ office window' },
  { key: 'at_risk', label: 'At risk' }, { key: 'blocked', label: 'Blocks job start' },
];
const field = 'focus-ring rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

export default function InstallCloseoutPage() {
  const { isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const allowed = isOwner || permissions.can_view_all_jobs;

  const [tab, setTab] = useState<Tab>('board');
  const [steps, setSteps] = useState<CloseoutStep[]>([]);
  const [cases, setCases] = useState<CloseoutCase[]>([]);
  const [programs, setPrograms] = useState<CloseoutProgram[]>([]);
  const [settings, setSettings] = useState<CloseoutSettings>(DEFAULT_SETTINGS);
  const [evidence, setEvidence] = useState<Record<string, CloseoutEvidence[]>>({});
  const [events, setEvents] = useState<CloseoutEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<RiskFilter>('all');
  const [query, setQuery] = useState('');
  const [openCaseId, setOpenCaseId] = useState<string | null>(params.get('case'));
  const [focusStep, setFocusStep] = useState<string | null>(params.get('step'));
  const [picker, setPicker] = useState<{ id: string; customer_name: string; address: string | null }[] | null>(null);
  const [pickJob, setPickJob] = useState('');
  const [pickDate, setPickDate] = useState('');
  const today = todayIso();

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const [st, cs, pr, se] = await Promise.all([
        fetchCloseoutSteps(), fetchCloseoutCases(), fetchCloseoutPrograms(), fetchCloseoutSettings(),
      ]);
      setSteps(st); setCases(cs); setPrograms(pr); setSettings(se);
      const { data } = await supabase
        .from('closeout_evidence').select('id, step_id, kind, label, value, job_photo_id, document_id, source, created_at').limit(5000);
      const map: Record<string, CloseoutEvidence[]> = {};
      for (const e of (data ?? []) as unknown as CloseoutEvidence[]) (map[e.step_id] ??= []).push(e);
      setEvidence(map);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load Install Closeout.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (allowed) void load(); else setLoading(false); }, [allowed, load]);
  useEffect(() => {
    if (tab === 'audit') fetchRecentEvents(150).then(setEvents).catch((e) => toast(e instanceof Error ? e.message : 'Could not load the log.', 'error'));
  }, [tab, toast]);

  // ?step=<id> (from a notification) -> open that step's case
  useEffect(() => {
    if (focusStep && steps.length) {
      const s = steps.find((x) => x.id === focusStep);
      if (s) setOpenCaseId(s.case_id);
    }
  }, [focusStep, steps]);

  const money = useMemo(() => moneyAtRisk(steps, today, settings), [steps, today, settings]);
  const counts = useMemo(() => riskCounts(steps, today, settings), [steps, today, settings]);
  const openCase = cases.find((c) => c.id === openCaseId) ?? null;

  const closeDrawer = () => {
    setOpenCaseId(null); setFocusStep(null);
    if (params.get('case') || params.get('step')) setParams({}, { replace: true });
  };

  if (!allowed) {
    return (
      <DashboardLayout>
        <EmptyState icon={ClipboardCheck} title="Office and owner access only" description="Install Closeout is limited to office and owner roles." />
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold text-text-primary"><ClipboardCheck size={22} />Install Closeout</h1>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">
              Permit → inspection → warranty → rebate → customer documents, with deadlines, evidence and escalation.
              Nothing is ever submitted for you — a person approves and files every step.
            </p>
          </div>
          <Button onClick={async () => {
            try { setPicker(await fetchJobsWithoutCase()); } catch (e) { toast(e instanceof Error ? e.message : 'Could not load jobs.', 'error'); }
          }}><Plus size={16} />Open closeout</Button>
        </header>

        {picker && (
          <Card className="!p-4">
            <h2 className="mb-2 text-sm font-semibold text-text-primary">Open a closeout for a job</h2>
            {picker.length === 0 ? <p className="text-sm text-text-secondary">Every recent job already has a closeout.</p> : (
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label htmlFor="co-job" className="mb-1.5 block text-sm font-medium text-text-primary">Job</label>
                  <select id="co-job" className={`${field} min-w-[16rem]`} value={pickJob} onChange={(e) => setPickJob(e.target.value)}>
                    <option value="">Choose a job…</option>
                    {picker.map((j) => <option key={j.id} value={j.id}>{j.customer_name}{j.address ? ` — ${j.address}` : ''}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="co-date" className="mb-1.5 block text-sm font-medium text-text-primary">Install date</label>
                  <input id="co-date" type="date" className={field} value={pickDate} onChange={(e) => setPickDate(e.target.value)} />
                </div>
                <Button size="sm" disabled={!pickJob} onClick={async () => {
                  try {
                    const c = await openCloseoutCase(pickJob, pickDate || null);
                    toast('Closeout opened.', 'success'); setPicker(null); setPickJob(''); setPickDate('');
                    await load(); setOpenCaseId(c.id);
                  } catch (e) { toast(e instanceof Error ? e.message : 'Could not open the closeout.', 'error'); }
                }}>Open</Button>
                <Button size="sm" variant="ghost" onClick={() => setPicker(null)}>Cancel</Button>
              </div>
            )}
          </Card>
        )}

        <nav className="flex flex-wrap gap-1 border-b border-border" role="tablist" aria-label="Install closeout sections">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} type="button" onClick={() => setTab(t.key)}
              className={`focus-ring -mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === t.key ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
              {t.label}
            </button>
          ))}
        </nav>

        {loadError && (
          <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
            {loadError} If this is a new install, make sure the closeout migration has been applied.
          </p>
        )}

        {loading ? (<><SkeletonStatGrid count={4} /><SkeletonCardList count={3} /></>) : (
          <>
            {tab === 'board' && (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Card className="!p-4"><p className="text-xs text-text-secondary">Overdue</p><p className="mt-1 text-2xl font-semibold text-danger">{counts.overdue}</p></Card>
                  <Card className="!p-4"><p className="text-xs text-text-secondary">Critical</p><p className="mt-1 text-2xl font-semibold text-danger">{counts.critical}</p></Card>
                  <Card className="!p-4"><p className="text-xs text-text-secondary">At risk</p><p className="mt-1 text-2xl font-semibold text-warning-500">{counts.at_risk}</p></Card>
                  <Card className="!p-4">
                    <p className="text-xs text-text-secondary">Money at risk (estimate)</p>
                    <p className="mt-1 text-2xl font-semibold text-text-primary">{formatCents(money.atRiskCents)}</p>
                    <p className="mt-0.5 text-[11px] text-text-secondary">{formatCents(money.overdueCents)} already overdue · {money.stepCount} step(s)</p>
                  </Card>
                </div>
                <p className="text-[11px] text-text-secondary">{ESTIMATE_DISCLAIMER}</p>

                <div className="flex flex-wrap items-center gap-2">
                  <div role="group" aria-label="Deadline risk filter" className="flex flex-wrap gap-1">
                    {FILTERS.map((f) => (
                      <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}
                        className={`focus-ring rounded-full border px-3 py-1 text-xs font-medium ${filter === f.key ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}>
                        {f.label}
                      </button>
                    ))}
                  </div>
                  <div className="relative ml-auto">
                    <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary" />
                    <input aria-label="Search closeouts" className={`${field} pl-8`} placeholder="Search customer, address, rule" value={query} onChange={(e) => setQuery(e.target.value)} />
                  </div>
                </div>

                <CloseoutBoard steps={steps} evidenceByStep={evidence} today={today} settings={settings} filter={filter} query={query}
                  onOpen={(s) => { setFocusStep(s.id); setOpenCaseId(s.case_id); }} />
                <p className="text-[11px] text-text-secondary">{RULES_DISCLAIMER}</p>
              </div>
            )}

            {tab === 'rules' && <CloseoutRulesPanel programs={programs} settings={settings} today={today} onChanged={load} />}
            {tab === 'summary' && <CloseoutSummaryPanel today={today} />}
            {tab === 'audit' && (
              events.length === 0 ? (
                <EmptyState icon={History} title="No activity recorded yet" description="Every approval, status change, evidence change and escalation is recorded here." />
              ) : (
                <Card className="!p-4 overflow-x-auto">
                  <table className="w-full min-w-[34rem] text-left text-xs">
                    <caption className="sr-only">Closeout audit log</caption>
                    <thead><tr className="text-text-secondary"><th className="py-1 pr-3">When</th><th className="pr-3">Event</th><th className="pr-3">Change</th><th>By</th></tr></thead>
                    <tbody>
                      {events.map((e) => (
                        <tr key={e.id} className="border-t border-border text-text-primary">
                          <td className="py-1.5 pr-3 whitespace-nowrap">{new Date(e.created_at).toLocaleString()}</td>
                          <td className="pr-3">{e.event_type.replace(/_/g, ' ')}</td>
                          <td className="pr-3 text-text-secondary">{e.from_status && e.to_status && e.from_status !== e.to_status ? `${e.from_status} → ${e.to_status}` : ''}</td>
                          <td className="text-text-secondary">{e.actor_email ?? 'system'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              )
            )}
          </>
        )}
      </div>

      {openCase && (
        <CloseoutCaseDrawer
          caseId={openCase.id} focusStepId={focusStep}
          customerName={openCase.jobs?.customer_name ?? 'Job'} address={openCase.jobs?.address ?? null}
          installDate={openCase.install_date} today={today} settings={settings}
          onClose={closeDrawer} onChanged={load}
        />
      )}
    </DashboardLayout>
  );
}
