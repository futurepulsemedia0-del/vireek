/**
 * Staff review workflow: draft → in review → approved (legal reviewer named) →
 * retired, with a full event trail. Only Vireek compliance staff see this tab.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, TriangleAlert } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { RULE_KINDS, SURFACES } from '../../../supabase/functions/_shared/compliance-rules/types';
import {
  KIND_LABELS, STATUS_LABELS, SURFACE_LABELS, ComplianceError, allowedActions, fetchReviewEvents, fetchStaffVersions, formatJurisdiction,
  saveDraft, transitionVersion, validateVersionDraft, type ReviewEvent, type RuleKind, type StaffRole, type StaffVersion,
  type Surface, type TransitionAction, type VersionStatus,
} from '@/lib/complianceRules';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary transition-colors focus-visible:border-accent';
const areaClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 font-mono text-xs text-text-primary transition-colors focus-visible:border-accent';

const STATUS_STYLE: Record<VersionStatus, string> = {
  draft: 'bg-bg-tertiary text-text-secondary', in_review: 'bg-warning-500/10 text-warning-500', approved: 'bg-success-500/10 text-success-500',
  rejected: 'bg-danger/10 text-danger', retired: 'bg-bg-tertiary text-text-secondary',
};
const FILTERS: Array<VersionStatus | 'all'> = ['in_review', 'draft', 'rejected', 'approved', 'retired', 'all'];
const msg = (e: unknown) => (e instanceof ComplianceError ? e.message : 'Something went wrong. Please try again.');

interface FormState {
  versionId?: string; packSlug: string; packName: string; jurisdiction: string; ruleKey: string; kind: RuleKind;
  severity: 'block' | 'require' | 'warn' | 'info'; appliesTo: Surface[]; title: string; ownerExplanation: string;
  paramsText: string; sourcesText: string; effectiveFrom: string; effectiveTo: string;
}

const EMPTY_FORM: FormState = {
  packSlug: '', packName: '', jurisdiction: 'US-', ruleKey: '', kind: 'required_notice', severity: 'require', appliesTo: [],
  title: '', ownerExplanation: '', paramsText: '{}', sourcesText: '[{"citation":"","type":"statute","url":""}]', effectiveFrom: '', effectiveTo: '',
};

function toForm(v: StaffVersion): FormState {
  return {
    versionId: v.id, packSlug: v.packSlug, packName: v.packName, jurisdiction: v.jurisdiction, ruleKey: v.ruleKey, kind: v.kind,
    severity: v.severity, appliesTo: v.appliesTo, title: v.title, ownerExplanation: v.ownerExplanation,
    paramsText: JSON.stringify(v.params, null, 2), sourcesText: JSON.stringify(v.sourceRefs, null, 2),
    effectiveFrom: v.effectiveFrom, effectiveTo: v.effectiveTo ?? '',
  };
}

/** Pure: parse + validate the editor form. Returns the payload or a list of problems. */
export function parseForm(f: FormState): { ok: true; payload: Parameters<typeof saveDraft>[0] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  let params: unknown = null;
  let sources: unknown = null;
  try { params = JSON.parse(f.paramsText); } catch { errors.push('Parameters are not valid JSON.'); }
  try { sources = JSON.parse(f.sourcesText); } catch { errors.push('Sources are not valid JSON.'); }
  if (!Array.isArray(sources)) { if (errors.length === 0 || !errors.some((e) => e.startsWith('Sources'))) errors.push('Sources must be a JSON list.'); sources = []; }
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(f.packSlug)) errors.push('Pack slug must be lowercase letters, numbers and dashes (e.g. us-tx).');
  if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(f.ruleKey)) errors.push('Rule key must be lowercase letters, numbers and dashes.');
  if (errors.length) return { ok: false, errors };
  const draft = {
    jurisdiction: f.jurisdiction.trim(), kind: f.kind, severity: f.severity, appliesTo: f.appliesTo, title: f.title, ownerExplanation: f.ownerExplanation,
    params, sourceRefs: sources as Array<{ citation?: string }>, effectiveFrom: f.effectiveFrom, effectiveTo: f.effectiveTo || null,
  };
  const problems = validateVersionDraft(draft);
  if (problems.length) return { ok: false, errors: problems };
  return { ok: true, payload: { ...draft, versionId: f.versionId, packSlug: f.packSlug, packName: f.packName || undefined, ruleKey: f.ruleKey } };
}

interface Props { role: StaffRole; userId: string | null }

export function ReviewQueue({ role, userId }: Props) {
  const { toast } = useToast();
  const [versions, setVersions] = useState<StaffVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<VersionStatus | 'all'>('in_review');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<ReviewEvent[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [legal, setLegal] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setVersions(await fetchStaffVersions()); } catch (e) { setError(msg(e)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const selected = useMemo(() => versions.find((v) => v.id === selectedId) ?? null, [versions, selectedId]);
  useEffect(() => {
    setNotes(''); setLegal(''); setEvents([]);
    if (!selectedId) return;
    let live = true;
    fetchReviewEvents(selectedId).then((e) => { if (live) setEvents(e); }).catch(() => { /* trail is best-effort */ });
    return () => { live = false; };
  }, [selectedId]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: versions.length };
    for (const v of versions) c[v.status] = (c[v.status] ?? 0) + 1;
    return c;
  }, [versions]);
  const shown = filter === 'all' ? versions : versions.filter((v) => v.status === filter);

  const run = async (action: TransitionAction) => {
    if (!selected) return;
    setBusy(true);
    try {
      const to = await transitionVersion(selected.id, action, notes, legal);
      toast(action === 'approve' ? 'Approved — the rule is now enforced from its effective date.' : `Done: ${to}.`, 'success');
      if (action === 'discard') setSelectedId(null);
      await load();
      if (action !== 'discard') setEvents(await fetchReviewEvents(selected.id).catch(() => []));
      setNotes(''); setLegal('');
    } catch (e) { toast(msg(e), 'error'); } finally { setBusy(false); }
  };

  const submitForm = async () => {
    if (!form) return;
    const parsed = parseForm(form);
    if (!parsed.ok) return setFormErrors(parsed.errors);
    setFormErrors([]); setBusy(true);
    try {
      const id = await saveDraft(parsed.payload);
      toast('Draft saved.', 'success');
      setForm(null); setFilter('draft'); await load(); setSelectedId(id);
    } catch (e) { setFormErrors([msg(e)]); } finally { setBusy(false); }
  };

  if (loading) return <SkeletonCardList count={4} rows={2} />;
  if (error) return <EmptyState icon={TriangleAlert} title="Couldn't load the review queue" description={error} action={{ label: 'Try again', onClick: () => void load() }} />;

  const actions = selected ? allowedActions(selected, role, userId) : [];
  const needsNotes = actions.some((a) => ['approve', 'reject', 'retire'].includes(a));

  return (
    <div className="space-y-4">
      <p role="note" className="rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-sm text-text-primary">
        <strong>Legal review required.</strong> Approving a rule means a qualified attorney has confirmed the cited sources and the rule text for the stated jurisdiction and effective date. Name the reviewer when you approve.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Status filter" className="flex flex-wrap gap-1">
          {FILTERS.map((s) => (
            <button key={s} type="button" role="tab" aria-selected={filter === s} onClick={() => setFilter(s)}
              className={`focus-ring rounded-xl px-3 py-1.5 text-sm font-medium ${filter === s ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-bg-tertiary'}`}>
              {s === 'all' ? 'All' : STATUS_LABELS[s]} <span className="text-xs opacity-70">{counts[s] ?? 0}</span>
            </button>
          ))}
        </div>
        <Button type="button" size="sm" className="ml-auto" onClick={() => { setForm({ ...EMPTY_FORM }); setFormErrors([]); }}>
          <Plus className="h-4 w-4" aria-hidden /> New rule
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_1fr]">
        <ul className="max-h-[32rem] space-y-2 overflow-y-auto" aria-label="Rule versions">
          {shown.length === 0 && <li className="text-sm text-text-secondary">Nothing here.</li>}
          {shown.map((v) => (
            <li key={v.id}>
              <button type="button" onClick={() => { setSelectedId(v.id); setForm(null); }} aria-current={selectedId === v.id}
                className={`focus-ring w-full rounded-xl border p-3 text-left ${selectedId === v.id ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary hover:border-accent/40'}`}>
                <div className="flex items-center gap-2">
                  <span className={`rounded-md px-1.5 py-0.5 text-xs font-medium ${STATUS_STYLE[v.status]}`}>{STATUS_LABELS[v.status]}</span>
                  <span className="text-xs text-text-secondary">{formatJurisdiction(v.jurisdiction)} · v{v.version}</span>
                </div>
                <p className="mt-1 text-sm font-medium text-text-primary">{v.title}</p>
                <p className="text-xs text-text-secondary">{KIND_LABELS[v.kind]}</p>
              </button>
            </li>
          ))}
        </ul>

        <div className="min-w-0">
          {form ? (
            <section className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-4" aria-label="Rule editor">
              <h3 className="text-base font-semibold text-text-primary">{form.versionId ? 'Edit draft' : 'New rule version'}</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <Input label="Pack slug" placeholder="us-tx" value={form.packSlug} disabled={!!form.versionId} onChange={(e) => setForm({ ...form, packSlug: e.target.value })} />
                <Input label="Pack name" placeholder="Texas" value={form.packName} disabled={!!form.versionId} onChange={(e) => setForm({ ...form, packName: e.target.value })} />
                <Input label="Jurisdiction" placeholder="US or US-TX" value={form.jurisdiction} disabled={!!form.versionId} onChange={(e) => setForm({ ...form, jurisdiction: e.target.value.toUpperCase() })} />
                <Input label="Rule key" placeholder="telemarketing-hours" value={form.ruleKey} disabled={!!form.versionId} onChange={(e) => setForm({ ...form, ruleKey: e.target.value })} />
                <div>
                  <label htmlFor="rq-kind" className="mb-1.5 block text-sm font-medium text-text-primary">Kind</label>
                  <select id="rq-kind" className={selectClass} value={form.kind} disabled={!!form.versionId} onChange={(e) => setForm({ ...form, kind: e.target.value as RuleKind })}>
                    {RULE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="rq-sev" className="mb-1.5 block text-sm font-medium text-text-primary">Severity</label>
                  <select id="rq-sev" className={selectClass} value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as FormState['severity'] })}>
                    <option value="block">Blocks the action</option><option value="require">Requires an action</option><option value="warn">Warning</option><option value="info">Info</option>
                  </select>
                </div>
              </div>
              <fieldset>
                <legend className="mb-1 text-sm font-medium text-text-primary">Applies to</legend>
                <div className="flex flex-wrap gap-3">
                  {SURFACES.map((s) => (
                    <label key={s} className="flex items-center gap-1.5 text-sm text-text-primary">
                      <input type="checkbox" className="accent-accent" checked={form.appliesTo.includes(s)}
                        onChange={(e) => setForm({ ...form, appliesTo: e.target.checked ? [...form.appliesTo, s] : form.appliesTo.filter((x) => x !== s) })} />
                      {SURFACE_LABELS[s]}
                    </label>
                  ))}
                </div>
              </fieldset>
              <Input label="Title" value={form.title} maxLength={200} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              <div>
                <label htmlFor="rq-expl" className="mb-1.5 block text-sm font-medium text-text-primary">Explanation shown to the owner</label>
                <textarea id="rq-expl" rows={3} className={areaClass.replace('font-mono text-xs', 'text-sm')} value={form.ownerExplanation} maxLength={2000} onChange={(e) => setForm({ ...form, ownerExplanation: e.target.value })} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Input label="Effective from" type="date" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
                <Input label="Effective until (optional, exclusive)" type="date" value={form.effectiveTo} onChange={(e) => setForm({ ...form, effectiveTo: e.target.value })} />
              </div>
              <div>
                <label htmlFor="rq-params" className="mb-1.5 block text-sm font-medium text-text-primary">Parameters (JSON)</label>
                <textarea id="rq-params" rows={7} spellCheck={false} className={areaClass} value={form.paramsText} onChange={(e) => setForm({ ...form, paramsText: e.target.value })} />
              </div>
              <div>
                <label htmlFor="rq-src" className="mb-1.5 block text-sm font-medium text-text-primary">Sources (JSON list — citation required)</label>
                <textarea id="rq-src" rows={5} spellCheck={false} className={areaClass} value={form.sourcesText} onChange={(e) => setForm({ ...form, sourcesText: e.target.value })} />
              </div>
              {formErrors.length > 0 && (
                <ul role="alert" className="list-disc space-y-0.5 pl-5 text-sm text-danger">{formErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>
              )}
              <div className="flex gap-2">
                <Button type="button" size="sm" disabled={busy} onClick={() => void submitForm()}>{busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Save draft</Button>
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setForm(null)}>Cancel</Button>
              </div>
            </section>
          ) : selected ? (
            <section className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-4" aria-label="Version detail">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[selected.status]}`}>{STATUS_LABELS[selected.status]}</span>
                  <span className="text-xs text-text-secondary">{formatJurisdiction(selected.jurisdiction)} · {KIND_LABELS[selected.kind]} · v{selected.version}</span>
                </div>
                <h3 className="mt-1 text-base font-semibold text-text-primary">{selected.title}</h3>
                <p className="mt-1 text-sm text-text-secondary">{selected.ownerExplanation}</p>
                <p className="mt-1 text-xs text-text-secondary">
                  Effective {selected.effectiveFrom} → {selected.effectiveTo ?? 'open'} · authored by {selected.authoredByEmail ?? 'unknown'}
                  {selected.legalReviewer && <> · legal review: {selected.legalReviewer}</>}
                </p>
              </div>
              {selected.status === 'rejected' && selected.reviewNotes && (
                <p className="rounded-lg border border-danger/40 bg-danger/10 p-2.5 text-sm text-text-primary"><strong>Changes requested:</strong> {selected.reviewNotes}</p>
              )}
              <div>
                <p className="text-xs font-semibold text-text-primary">Sources</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-text-secondary">
                  {selected.sourceRefs.map((s, i) => <li key={i}>{s.citation}{s.note ? ` — ${s.note}` : ''}</li>)}
                </ul>
              </div>
              <details>
                <summary className="cursor-pointer text-xs font-semibold text-text-primary">Parameters</summary>
                <pre className="mt-1 max-h-60 overflow-auto rounded-lg bg-bg-primary p-2 text-xs text-text-secondary">{JSON.stringify(selected.params, null, 2)}</pre>
              </details>

              {needsNotes && (
                <div className="space-y-2">
                  <div>
                    <label htmlFor="rq-notes" className="mb-1.5 block text-sm font-medium text-text-primary">Review notes</label>
                    <textarea id="rq-notes" rows={2} className={areaClass.replace('font-mono text-xs', 'text-sm')} value={notes} onChange={(e) => setNotes(e.target.value)} />
                  </div>
                  {actions.includes('approve') && <Input label="Legal reviewer (attorney or firm)" value={legal} maxLength={120} onChange={(e) => setLegal(e.target.value)} />}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {(selected.status === 'draft' || selected.status === 'rejected') && (
                  <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => { setForm(toForm(selected)); setFormErrors([]); }}>Edit</Button>
                )}
                {actions.map((a) => (
                  <Button key={a} type="button" size="sm" variant={a === 'approve' || a === 'submit' ? 'primary' : 'secondary'} disabled={busy} onClick={() => void run(a)}>
                    {a === 'submit' ? 'Submit for review' : a === 'withdraw' ? 'Withdraw' : a === 'approve' ? 'Approve' : a === 'reject' ? 'Request changes' : a === 'retire' ? 'Retire' : 'Discard draft'}
                  </Button>
                ))}
                {actions.length === 0 && <p className="text-xs text-text-secondary">No actions available for your role on this version.</p>}
              </div>

              <div>
                <p className="text-xs font-semibold text-text-primary">History</p>
                <ol className="mt-1 space-y-1">
                  {events.map((e) => (
                    <li key={e.id} className="text-xs text-text-secondary">
                      {new Date(e.createdAt).toLocaleString()} · <strong className="text-text-primary">{e.action}</strong> by {e.actorEmail ?? 'system'}
                      {e.selfReview && <span className="ml-1 rounded bg-warning-500/10 px-1 text-warning-500">self-review</span>}
                      {e.notes && <span> — {e.notes}</span>}
                    </li>
                  ))}
                </ol>
              </div>
            </section>
          ) : (
            <EmptyState icon={TriangleAlert} title="Select a rule version" description="Pick a version on the left to read it, review it, or create a new one." />
          )}
        </div>
      </div>
    </div>
  );
}
