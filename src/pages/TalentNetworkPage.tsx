import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Briefcase, ExternalLink, Lock, Plus } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { ApplicantPanel } from '@/components/talent/ApplicantPanel';
import { RatingForm } from '@/components/talent/RatingForm';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  APPLICATION_STATUS_LABEL, BUSINESS_TAGS, EMPTY_POSTING, PIPELINE, TRADES, WORKER_TAGS, completeEngagement, fetchApplications,
  fetchBusinessEngagements, fetchPostings, formatDateRange, formatPay, markOnboardingItem, postingToInput, savePosting, setPostingStatus,
  tradeLabel, validatePosting, type ApplicationRow, type ChecklistItem, type EngagementRow, type PostingInput, type PostingRow, type PostingStatus,
} from '@/lib/talentNetwork';

type Tab = 'postings' | 'applicants' | 'engagements';
const selectClass = 'w-full rounded-xl border border-border bg-bg-secondary px-3.5 py-3 text-sm text-text-primary focus:border-accent focus:outline-none';
const STATUS_TONE: Record<PostingStatus, string> = {
  draft: 'bg-bg-tertiary text-text-secondary', open: 'bg-green-500/10 text-green-500', paused: 'bg-amber-500/10 text-amber-500',
  filled: 'bg-accent/10 text-accent', closed: 'bg-bg-tertiary text-text-secondary',
};

export function TalentNetworkPage() {
  const { user, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const canUse = isOwner || permissions.can_manage_team || permissions.can_view_billing;
  const tab: Tab = (['postings', 'applicants', 'engagements'] as const).find((t) => t === params.get('tab')) ?? 'postings';
  const selectedApp = params.get('app');

  const [postings, setPostings] = useState<PostingRow[]>([]);
  const [apps, setApps] = useState<ApplicationRow[]>([]);
  const [eng, setEng] = useState<EngagementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{ id?: string; input: PostingInput } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [filterPosting, setFilterPosting] = useState('');
  const [rateOpen, setRateOpen] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [p, a, e] = await Promise.all([fetchPostings(), fetchApplications(), fetchBusinessEngagements()]);
      setPostings(p); setApps(a); setEng(e);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not load Talent Network.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);
  useEffect(() => { if (user && canUse) void reload(); else setLoading(false); }, [user, canUse, reload]);

  const setTab = (t: Tab) => setParams({ tab: t });
  const openApp = (id: string | null) => setParams(id ? { tab: 'applicants', app: id } : { tab: 'applicants' });
  const shownApps = useMemo(() => apps.filter((a) => !filterPosting || a.posting_id === filterPosting), [apps, filterPosting]);
  const newCount = apps.filter((a) => a.status === 'submitted').length;

  async function save(status: PostingStatus) {
    if (!editing) return;
    const problem = validatePosting(editing.input, status === 'open');
    setFormError(problem);
    if (problem) return;
    setSaving(true);
    try {
      await savePosting(editing.input, status, editing.id);
      toast(status === 'open' ? 'Posting published.' : 'Draft saved.', 'success');
      setEditing(null);
      await reload();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not save the posting.');
    } finally {
      setSaving(false);
    }
  }

  async function run(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); toast(ok, 'success'); await reload(); } catch (e) { toast(e instanceof Error ? e.message : 'Something went wrong.', 'error'); }
  }

  if (!canUse) {
    return (
      <DashboardLayout activeLabel="Talent Network">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm text-text-secondary">Ask your account owner for the "Manage Team" or "View Billing" permission.</p>
        </div>
      </DashboardLayout>
    );
  }

  const ed = editing?.input;
  const setEd = <K extends keyof PostingInput>(k: K, v: PostingInput[K]) => setEditing((s) => (s ? { ...s, input: { ...s.input, [k]: v } } : s));

  return (
    <DashboardLayout activeLabel="Talent Network">
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Talent Network</h1>
            <p className="mt-1 text-sm text-text-secondary">Post jobs and overflow gigs, vet applicants, hire into payroll and your technician app.</p>
          </div>
          <Link to="/talent" className="inline-flex items-center gap-1.5 text-sm text-accent underline">Public job board<ExternalLink size={12} aria-hidden="true" /></Link>
        </div>

        <div role="tablist" aria-label="Talent Network sections" className="flex gap-2">
          {([['postings', 'Postings'], ['applicants', `Applicants${newCount ? ` (${newCount} new)` : ''}`], ['engagements', 'Engagements']] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
              className={`rounded-full border px-4 py-1.5 text-sm ${tab === k ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}>{l}</button>
          ))}
        </div>

        {loading && <Skeleton className="h-64 w-full rounded-2xl" />}

        {!loading && tab === 'postings' && (
          editing && ed ? (
            <section className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-6">
              <h2 className="text-lg font-semibold text-text-primary">{editing.id ? 'Edit posting' : 'New posting'}</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="pe-kind" className="mb-1.5 block text-sm font-medium text-text-primary">Type</label>
                  <select id="pe-kind" className={selectClass} value={ed.kind} onChange={(e) => { const k = e.target.value as PostingInput['kind']; setEd('kind', k); if (k === 'gig') { setEd('engagement_type', '1099'); setEd('pay_type', 'hourly'); } }}>
                    <option value="job">Job (hire)</option><option value="gig">Gig / overflow work</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="pe-trade" className="mb-1.5 block text-sm font-medium text-text-primary">Trade</label>
                  <select id="pe-trade" className={selectClass} value={ed.trade} onChange={(e) => setEd('trade', e.target.value)}>
                    {TRADES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
              </div>
              <Input label="Title" required value={ed.title} onChange={(e) => setEd('title', e.target.value)} maxLength={120} />
              <Input label="Company name shown publicly" value={ed.company_name} onChange={(e) => setEd('company_name', e.target.value)} maxLength={120} helperText="Leave blank to use your business name." />
              <Textarea label="Short summary" required value={ed.summary} onChange={(e) => setEd('summary', e.target.value)} maxLength={300} rows={2} />
              <Textarea label="Description" required value={ed.description} onChange={(e) => setEd('description', e.target.value)} maxLength={8000} rows={7} />
              <Textarea label="Requirements (one per line)" value={ed.requirements.join('\n')} onChange={(e) => setEd('requirements', e.target.value.split('\n').slice(0, 15))} rows={4} helperText="Describe job-related skills only." />
              <div className="grid gap-4 sm:grid-cols-3">
                <Input label="City" value={ed.city} onChange={(e) => setEd('city', e.target.value)} maxLength={80} />
                <Input label="State" value={ed.region} onChange={(e) => setEd('region', e.target.value)} maxLength={40} placeholder="TX" />
                <Input label="Openings" value={ed.headcount} onChange={(e) => setEd('headcount', e.target.value)} inputMode="numeric" />
              </div>
              <div className="grid gap-4 sm:grid-cols-4">
                <div>
                  <label htmlFor="pe-paytype" className="mb-1.5 block text-sm font-medium text-text-primary">Pay type</label>
                  <select id="pe-paytype" className={selectClass} value={ed.pay_type} onChange={(e) => setEd('pay_type', e.target.value)}>
                    <option value="hourly">Hourly</option><option value="salary">Annual salary</option><option value="flat">Flat fee</option>
                  </select>
                </div>
                <Input label="Pay min ($)" value={ed.pay_min} onChange={(e) => setEd('pay_min', e.target.value)} inputMode="decimal" />
                <Input label="Pay max ($)" value={ed.pay_max} onChange={(e) => setEd('pay_max', e.target.value)} inputMode="decimal" />
                {ed.kind === 'job' ? (
                  <div>
                    <label htmlFor="pe-emp" className="mb-1.5 block text-sm font-medium text-text-primary">Schedule</label>
                    <select id="pe-emp" className={selectClass} value={ed.employment_type} onChange={(e) => setEd('employment_type', e.target.value)}>
                      <option value="full_time">Full-time</option><option value="part_time">Part-time</option><option value="contract">Contract</option>
                    </select>
                  </div>
                ) : <div />}
              </div>
              {ed.kind === 'gig' && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input label="Starts" required type="date" value={ed.starts_on} onChange={(e) => setEd('starts_on', e.target.value)} />
                  <Input label="Ends" required type="date" value={ed.ends_on} onChange={(e) => setEd('ends_on', e.target.value)} />
                </div>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="pe-eng" className="mb-1.5 block text-sm font-medium text-text-primary">Engagement</label>
                  <select id="pe-eng" className={selectClass} value={ed.engagement_type} onChange={(e) => setEd('engagement_type', e.target.value as PostingInput['engagement_type'])}>
                    <option value="w2">W-2 employee</option><option value="1099">1099 contractor</option>
                  </select>
                  {ed.engagement_type === '1099' && <p className="mt-1 text-xs text-amber-500">Contractor classification is a legal determination (ABC-test states). Confirm with your advisor.</p>}
                </div>
                <div>
                  <label htmlFor="pe-refs" className="mb-1.5 block text-sm font-medium text-text-primary">References required</label>
                  <select id="pe-refs" className={selectClass} value={ed.min_references} onChange={(e) => setEd('min_references', e.target.value)}>
                    {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
              </div>
              <label className="flex items-center gap-3 text-sm text-text-primary"><input type="checkbox" checked={ed.requires_license} onChange={(e) => setEd('requires_license', e.target.checked)} />A verified trade license is required</label>
              <label className="flex items-start gap-3 text-sm text-text-primary"><input type="checkbox" className="mt-1" checked={ed.requires_background_check} onChange={(e) => setEd('requires_background_check', e.target.checked)} /><span>Require a background check <span className="text-text-secondary">(runs only after a conditional offer, with the candidate’s authorization, and follows an individualized-review process)</span></span></label>
              {formError && <p role="alert" className="text-sm text-red-500">{formError}</p>}
              <div className="flex flex-wrap gap-3">
                <Button disabled={saving} onClick={() => void save('open')}>{saving ? 'Saving…' : 'Publish'}</Button>
                <Button variant="secondary" disabled={saving} onClick={() => void save('draft')}>Save draft</Button>
                <Button variant="secondary" disabled={saving} onClick={() => { setEditing(null); setFormError(null); }}>Cancel</Button>
              </div>
            </section>
          ) : (
            <section className="space-y-3">
              <Button onClick={() => setEditing({ input: { ...EMPTY_POSTING } })}><Plus size={16} className="mr-2" />New posting</Button>
              {postings.length === 0 && <EmptyState icon={Briefcase} title="No postings yet" description="Create a job or an overflow gig to start receiving applicants." />}
              {postings.map((p) => (
                <div key={p.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-text-primary">{p.title}</p>
                      <p className="text-sm text-text-secondary">{p.kind === 'gig' ? 'Gig' : 'Job'} · {tradeLabel(p.trade)} · {formatPay(p)}{p.kind === 'gig' ? ` · ${formatDateRange(p.starts_on, p.ends_on)}` : ''} · {apps.filter((a) => a.posting_id === p.id).length} applicants</p>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_TONE[p.status]}`}>{p.status}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button variant="secondary" onClick={() => setEditing({ id: p.id, input: postingToInput(p) })}>Edit</Button>
                    {p.status === 'open' && <Button variant="secondary" onClick={() => void run(() => setPostingStatus(p.id, 'paused'), 'Posting paused.')}>Pause</Button>}
                    {(p.status === 'paused' || p.status === 'draft' || p.status === 'closed') && <Button variant="secondary" onClick={() => void run(() => setPostingStatus(p.id, 'open'), 'Posting is live.')}>{p.status === 'draft' ? 'Publish' : 'Reopen'}</Button>}
                    {(p.status === 'open' || p.status === 'paused') && <Button variant="secondary" onClick={() => void run(() => setPostingStatus(p.id, 'closed'), 'Posting closed.')}>Close</Button>}
                    {p.status === 'open' && <Link to={`/talent/jobs/${p.slug}`}><Button variant="secondary">View public page</Button></Link>}
                  </div>
                </div>
              ))}
            </section>
          )
        )}

        {!loading && tab === 'applicants' && (
          <section className="grid gap-5 lg:grid-cols-[320px_1fr]">
            <div className="space-y-3">
              <div>
                <label htmlFor="ap-filter" className="mb-1.5 block text-sm font-medium text-text-primary">Posting</label>
                <select id="ap-filter" className={selectClass} value={filterPosting} onChange={(e) => setFilterPosting(e.target.value)}>
                  <option value="">All postings</option>
                  {postings.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                </select>
              </div>
              {shownApps.length === 0 && <p className="rounded-2xl border border-border bg-bg-secondary p-5 text-sm text-text-secondary">No applicants yet.</p>}
              {[...PIPELINE, 'hired', 'rejected', 'withdrawn'].map((st) => {
                const list = shownApps.filter((a) => a.status === st);
                if (list.length === 0) return null;
                return (
                  <div key={st}>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">{APPLICATION_STATUS_LABEL[st as keyof typeof APPLICATION_STATUS_LABEL]} ({list.length})</p>
                    <ul className="space-y-2">
                      {list.map((a) => (
                        <li key={a.id}>
                          <button onClick={() => openApp(a.id)} aria-current={selectedApp === a.id}
                            className={`w-full rounded-xl border p-3 text-left text-sm ${selectedApp === a.id ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary'}`}>
                            <span className="block font-medium text-text-primary">{a.profile_snapshot.display_name ?? 'Applicant'}</span>
                            <span className="block text-xs text-text-secondary">{a.talent_postings?.title} · {new Date(a.created_at).toLocaleDateString()}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
            <div>
              {selectedApp
                ? <ApplicantPanel applicationId={selectedApp} backgroundProviderEnabled onChanged={() => void reload()} />
                : <p className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-text-secondary">Select an applicant to review.</p>}
            </div>
          </section>
        )}

        {!loading && tab === 'engagements' && (
          <section className="space-y-3">
            {eng.length === 0 && <p className="rounded-2xl border border-border bg-bg-secondary p-6 text-sm text-text-secondary">Hired workers appear here with their onboarding checklist.</p>}
            {eng.map((e) => {
              const ended = e.status === 'completed' || e.status === 'terminated';
              const items: Array<[ChecklistItem, string, string | null | undefined]> = [
                ['agreement_signed', 'Agreement signed', e.agreement_signed_at],
                ['tax_form_received', e.engagement_type === 'w2' ? 'W-4 received' : 'W-9 received', e.tax_form_received_at],
                ...(e.engagement_type === 'w2' ? [['i9_completed', 'Form I-9 completed', e.i9_completed_at] as [ChecklistItem, string, string | null | undefined]] : []),
                ['direct_deposit_set', 'Direct deposit set (optional)', e.direct_deposit_set_at],
              ];
              return (
                <div key={e.engagement_id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-text-primary">{e.worker_name} <span className="text-xs text-text-secondary">· {e.posting_title}</span></p>
                      <p className="text-sm text-text-secondary">{e.engagement_type === '1099' ? '1099 contractor' : 'W-2 employee'} · {formatDateRange(e.starts_on, e.ends_on)} · {e.status}</p>
                    </div>
                    {!ended && (
                      <div className="flex gap-2">
                        <Button variant="secondary" onClick={() => void run(() => completeEngagement(e.engagement_id, 'completed'), 'Engagement completed.')}>Mark complete</Button>
                        <Button variant="secondary" onClick={() => void run(() => completeEngagement(e.engagement_id, 'terminated'), 'Engagement ended.')}>End early</Button>
                      </div>
                    )}
                  </div>
                  {!ended && (
                    <ul className="mt-3 space-y-1.5">
                      {items.map(([key, label, at]) => (
                        <li key={key}>
                          <label className="flex items-center gap-2 text-sm text-text-primary">
                            <input type="checkbox" checked={Boolean(at)} onChange={(ev) => void run(() => markOnboardingItem(e.engagement_id, key, ev.target.checked), 'Checklist updated.')} />{label}
                          </label>
                        </li>
                      ))}
                      <li className="pt-1 text-xs text-text-secondary">Collect forms through your payroll or HR process. Never upload SSNs or ID documents here.</li>
                    </ul>
                  )}
                  {ended && (
                    rateOpen === e.engagement_id
                      ? <div className="mt-3"><RatingForm engagementId={e.engagement_id} tags={WORKER_TAGS} theirTags={BUSINESS_TAGS} onDone={() => void reload()} /></div>
                      : <Button className="mt-3" variant="secondary" onClick={() => setRateOpen(e.engagement_id)}>{e.my_rating_submitted ? 'View ratings' : 'Rate this worker'}</Button>
                  )}
                </div>
              );
            })}
          </section>
        )}
      </div>
    </DashboardLayout>
  );
}

export default TalentNetworkPage;
