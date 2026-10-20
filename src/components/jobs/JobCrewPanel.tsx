import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Plus, Trash2, Users } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { JobSection, Pill, SectionError, SectionSkeleton } from '@/components/jobs/detail/JobSection';
import {
  COMMISSION_MODE_HINTS,
  COMMISSION_MODE_LABELS,
  COMMISSION_MODE_OPTIONS,
  LABOR_MODE_HINTS,
  LABOR_MODE_LABELS,
  LABOR_MODE_OPTIONS,
  MAX_CREW_SIZE,
  ROLE_LABELS,
  ROLE_OPTIONS,
  bpsToPercentInput,
  draftFromCrew,
  formatBps,
  formatCents,
  formatMinutes,
  normalizeSkills,
  percentInputToBps,
  plannedCommissionShares,
  plannedLaborShares,
  seedManualShares,
  skillGaps,
  validateCrewDraft,
  type CommissionSplitMode,
  type CrewDraft,
  type CrewRole,
  type JobCrew,
  type LaborSplitMode,
} from '@/lib/jobCrew';
import { dissolveJobCrew, fetchCrewCandidates, fetchJobCrew, saveJobCrew, type CrewCandidate } from '@/lib/jobCrewApi';

const field =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';

type TextKey = `${string}:labor` | `${string}:commission`;

const ROLE_STYLE: Record<CrewRole, string> = {
  lead: 'bg-accent/15 text-accent',
  helper: 'bg-bg-tertiary text-text-secondary',
  apprentice: 'bg-amber-500/10 text-amber-500',
};

/**
 * Crew for one job: a lead plus helpers/apprentices with role-based labor
 * split, per-person time, commission split and required skills.
 * Self-contained: loads and saves through jobCrewApi (RPCs enforce permissions).
 */
export function JobCrewPanel({
  jobId,
  ownerId,
  leadTechnicianId,
  onChanged,
}: {
  jobId: string;
  ownerId: string;
  leadTechnicianId: string | null;
  /** Called after a save so the page can re-read the job (the lead may have changed). */
  onChanged?: () => void;
}) {
  const { toast } = useToast();
  const [crew, setCrew] = useState<JobCrew | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const requestRef = useRef(0);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CrewDraft | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [skillsText, setSkillsText] = useState('');
  const [candidates, setCandidates] = useState<CrewCandidate[]>([]);
  const [candidatesFailed, setCandidatesFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const load = useCallback(async () => {
    const req = ++requestRef.current;
    setStatus((s) => (s === 'ready' ? s : 'loading'));
    try {
      const next = await fetchJobCrew(jobId);
      if (req !== requestRef.current) return;
      setCrew(next);
      setStatus('ready');
    } catch {
      if (req !== requestRef.current) return;
      setStatus('error');
    }
  }, [jobId]);

  useEffect(() => {
    setEditing(false);
    setConfirmRemove(false);
    void load();
  }, [load, leadTechnicianId]);

  const candidateById = useMemo(() => new Map(candidates.map((c) => [c.id, c])), [candidates]);

  // Manual percentage text -> draft with real basis points (-1 marks unreadable text).
  const effectiveDraft = useMemo<CrewDraft | null>(() => {
    if (!draft) return null;
    return {
      ...draft,
      requiredSkills: normalizeSkills(skillsText.split(',')),
      members: draft.members.map((m) => ({
        ...m,
        laborBps: draft.laborMode === 'manual' ? percentInputToBps(texts[`${m.technicianId}:labor`] ?? '') ?? -1 : m.laborBps,
        commissionBps: draft.commissionMode === 'manual' ? percentInputToBps(texts[`${m.technicianId}:commission`] ?? '') ?? -1 : m.commissionBps,
      })),
    };
  }, [draft, texts, skillsText]);

  const problem = effectiveDraft ? validateCrewDraft(effectiveDraft) : null;

  const gapsPreview = useMemo(() => {
    if (!effectiveDraft) return [];
    return skillGaps(
      effectiveDraft.requiredSkills,
      effectiveDraft.members.map((m) => candidateById.get(m.technicianId)?.skills ?? []),
    );
  }, [effectiveDraft, candidateById]);

  const seedTexts = useCallback((d: CrewDraft, prev: Record<string, string>) => {
    const seeded = seedManualShares(d);
    const next = { ...prev };
    seeded.members.forEach((m) => {
      const lk: TextKey = `${m.technicianId}:labor`;
      const ck: TextKey = `${m.technicianId}:commission`;
      if (next[lk] === undefined) next[lk] = bpsToPercentInput(m.laborBps);
      if (next[ck] === undefined) next[ck] = bpsToPercentInput(m.commissionBps);
    });
    return next;
  }, []);

  const startEdit = useCallback(async () => {
    const d = draftFromCrew(crew, leadTechnicianId);
    setDraft(d);
    setTexts(seedTexts(d, {}));
    setSkillsText(d.requiredSkills.join(', '));
    setFormError(null);
    setConfirmRemove(false);
    setEditing(true);
    setCandidatesFailed(false);
    try {
      setCandidates(await fetchCrewCandidates(ownerId));
    } catch {
      setCandidatesFailed(true);
    }
  }, [crew, leadTechnicianId, ownerId, seedTexts]);

  const cancelEdit = () => {
    setEditing(false);
    setFormError(null);
    setConfirmRemove(false);
  };

  const updateDraft = (fn: (d: CrewDraft) => CrewDraft) => {
    if (!draft) return;
    const next = fn(draft);
    setDraft(next);
    setTexts((t) => seedTexts(next, t));
  };

  const addMember = () => {
    updateDraft((d) => {
      const used = new Set(d.members.map((m) => m.technicianId));
      const free = candidates.find((c) => !used.has(c.id));
      if (!free || d.members.length >= MAX_CREW_SIZE) return d;
      return { ...d, members: [...d.members, { technicianId: free.id, role: 'helper', laborBps: 0, commissionBps: 0 }] };
    });
  };

  const setRole = (index: number, role: CrewRole) =>
    updateDraft((d) => ({
      ...d,
      // Only one lead: promoting someone demotes the previous lead to helper.
      members: d.members.map((m, i) => (i === index ? { ...m, role } : role === 'lead' && m.role === 'lead' ? { ...m, role: 'helper' } : m)),
    }));

  const setTechnician = (index: number, technicianId: string) =>
    updateDraft((d) => ({ ...d, members: d.members.map((m, i) => (i === index ? { ...m, technicianId } : m)) }));

  const removeMember = (index: number) => updateDraft((d) => ({ ...d, members: d.members.filter((_, i) => i !== index) }));

  const submit = async () => {
    if (!effectiveDraft || saving) return;
    const err = validateCrewDraft(effectiveDraft);
    if (err) {
      setFormError(err);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const { skillGaps: gaps } = await saveJobCrew(jobId, effectiveDraft);
      toast(gaps.length > 0 ? `Crew saved. Missing skills: ${gaps.join(', ')}` : 'Crew saved', gaps.length > 0 ? 'info' : 'success');
      setEditing(false);
      await load();
      onChanged?.();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not save the crew.');
    } finally {
      setSaving(false);
    }
  };

  const removeCrew = async () => {
    if (saving) return;
    setSaving(true);
    setFormError(null);
    try {
      await dissolveJobCrew(jobId);
      toast('Crew removed', 'success');
      setEditing(false);
      setConfirmRemove(false);
      await load();
      onChanged?.();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not remove the crew.');
    } finally {
      setSaving(false);
    }
  };

  // ---------- states ----------

  if (status === 'loading' && !crew) {
    return (
      <JobSection title="Crew" icon={Users}>
        <SectionSkeleton rows={2} />
      </JobSection>
    );
  }
  if (status === 'error' && !crew) {
    return (
      <JobSection title="Crew" icon={Users}>
        <SectionError onRetry={() => void load()} />
      </JobSection>
    );
  }
  // Not allowed to see this job's crew, or nothing to show and nothing the viewer can do.
  if (!crew || (!crew.has_crew && !crew.can_manage)) return null;

  const manageButton = crew.can_manage && !editing && (crew.has_crew || leadTechnicianId) && (
    <Button size="sm" variant="secondary" onClick={() => void startEdit()}>
      {crew.has_crew ? 'Edit crew' : 'Build a crew'}
    </Button>
  );

  // ---------- read view ----------

  if (!editing) {
    return (
      <JobSection title="Crew" icon={Users} action={manageButton || undefined}>
        {!crew.has_crew ? (
          <p className="text-sm text-text-secondary">
            {leadTechnicianId
              ? 'One technician on this job. Build a crew to add helpers, split labor and commission, and track each person’s time.'
              : 'Assign a lead technician from the Jobs board first, then build a crew.'}
          </p>
        ) : (
          <div className="space-y-3">
            {crew.skill_gaps.length > 0 && (
              <p className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-500" role="status">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                No one on this crew has: {crew.skill_gaps.join(', ')}
              </p>
            )}
            <ul className="divide-y divide-border">
              {crew.members.map((m) => (
                <li key={m.assignment_id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5 first:pt-0 last:pb-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <Pill className={ROLE_STYLE[m.role]}>{ROLE_LABELS[m.role]}</Pill>
                    <span className="truncate text-sm font-semibold text-text-primary">{m.name}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-text-secondary">
                    <span>Time {formatMinutes(m.net_minutes)}</span>
                    {m.labor_bps !== null && <span>Labor {formatBps(m.labor_bps)}</span>}
                    {m.commission_bps !== null && <span>Commission {formatBps(m.commission_bps)}</span>}
                    {m.labor_cost_cents !== null && <span>Cost {formatCents(m.labor_cost_cents)}</span>}
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-xs text-text-secondary">
              Labor: {LABOR_MODE_LABELS[crew.labor_mode]} · Commission: {COMMISSION_MODE_LABELS[crew.commission_mode]} · Total time {formatMinutes(crew.total_minutes)}
              {crew.required_skills.length > 0 && ` · Needs ${crew.required_skills.join(', ')}`}
            </p>
          </div>
        )}
      </JobSection>
    );
  }

  // ---------- edit view ----------

  if (!draft || !effectiveDraft) return null;
  const plannedLabor = plannedLaborShares(effectiveDraft);
  const plannedCommission = plannedCommissionShares(effectiveDraft);
  const usedIds = new Set(draft.members.map((m) => m.technicianId));
  const canAdd = draft.members.length < MAX_CREW_SIZE && candidates.some((c) => !usedIds.has(c.id));
  const label = 'mb-1 block text-xs font-semibold text-text-secondary';

  return (
    <JobSection title="Crew" icon={Users}>
      <div className="space-y-4">
        {candidatesFailed && <SectionError message="Could not load your technicians." onRetry={() => void startEdit()} />}

        <div className="space-y-3">
          {draft.members.map((m, i) => (
            <div key={`${m.technicianId}:${i}`} className="rounded-xl border border-border p-3">
              <div className="grid gap-2 sm:grid-cols-[1fr_9rem_auto] sm:items-end">
                <div>
                  <label className={label} htmlFor={`crew-tech-${i}`}>
                    Technician
                  </label>
                  <select id={`crew-tech-${i}`} className={field} value={m.technicianId} onChange={(e) => setTechnician(i, e.target.value)} disabled={saving || m.role === 'lead'}>
                    {candidates
                      .filter((c) => c.id === m.technicianId || !usedIds.has(c.id))
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    {!candidateById.has(m.technicianId) && <option value={m.technicianId}>Current technician</option>}
                  </select>
                </div>
                <div>
                  <label className={label} htmlFor={`crew-role-${i}`}>
                    Role
                  </label>
                  <select id={`crew-role-${i}`} className={field} value={m.role} onChange={(e) => setRole(i, e.target.value as CrewRole)} disabled={saving}>
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  aria-label={`Remove ${candidateById.get(m.technicianId)?.name ?? 'technician'} from the crew`}
                  onClick={() => removeMember(i)}
                  disabled={saving || m.role === 'lead'}
                >
                  <Trash2 size={15} aria-hidden="true" />
                </Button>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-text-secondary">
                {draft.laborMode === 'manual' ? (
                  <label className="flex items-center gap-2">
                    Labor %
                    <input
                      inputMode="decimal"
                      className={`${field} w-24`}
                      value={texts[`${m.technicianId}:labor`] ?? ''}
                      onChange={(e) => setTexts((t) => ({ ...t, [`${m.technicianId}:labor`]: e.target.value }))}
                      disabled={saving}
                    />
                  </label>
                ) : (
                  <span>Labor {formatBps(plannedLabor[i] ?? 0)}</span>
                )}
                {draft.commissionMode === 'manual' ? (
                  <label className="flex items-center gap-2">
                    Commission %
                    <input
                      inputMode="decimal"
                      className={`${field} w-24`}
                      value={texts[`${m.technicianId}:commission`] ?? ''}
                      onChange={(e) => setTexts((t) => ({ ...t, [`${m.technicianId}:commission`]: e.target.value }))}
                      disabled={saving}
                    />
                  </label>
                ) : (
                  <span>Commission {formatBps(plannedCommission[i] ?? 0)}</span>
                )}
                {(candidateById.get(m.technicianId)?.skills.length ?? 0) > 0 && (
                  <span className="truncate">Skills: {candidateById.get(m.technicianId)?.skills.join(', ')}</span>
                )}
              </div>
            </div>
          ))}
          <Button size="sm" variant="secondary" type="button" onClick={addMember} disabled={saving || !canAdd}>
            <Plus size={15} aria-hidden="true" /> Add helper
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={label} htmlFor="crew-labor-mode">
              Labor split
            </label>
            <select
              id="crew-labor-mode"
              className={field}
              value={draft.laborMode}
              onChange={(e) => updateDraft((d) => ({ ...d, laborMode: e.target.value as LaborSplitMode }))}
              disabled={saving}
            >
              {LABOR_MODE_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {LABOR_MODE_LABELS[o]}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-text-secondary">{LABOR_MODE_HINTS[draft.laborMode]}</p>
          </div>
          <div>
            <label className={label} htmlFor="crew-commission-mode">
              Commission split
            </label>
            <select
              id="crew-commission-mode"
              className={field}
              value={draft.commissionMode}
              onChange={(e) => updateDraft((d) => ({ ...d, commissionMode: e.target.value as CommissionSplitMode }))}
              disabled={saving}
            >
              {COMMISSION_MODE_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {COMMISSION_MODE_LABELS[o]}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-text-secondary">{COMMISSION_MODE_HINTS[draft.commissionMode]}</p>
          </div>
        </div>

        <div>
          <label className={label} htmlFor="crew-skills">
            Required skills (comma separated)
          </label>
          <input id="crew-skills" className={field} value={skillsText} onChange={(e) => setSkillsText(e.target.value)} placeholder="hvac, electrical" disabled={saving} />
          {gapsPreview.length > 0 && (
            <p className="mt-1 flex items-start gap-2 text-xs font-medium text-amber-500" role="status">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
              No one on this crew has: {gapsPreview.join(', ')}. You can still save.
            </p>
          )}
        </div>

        {(formError || problem) && (
          <p className="rounded-xl bg-red-500/10 px-3 py-2 text-xs font-medium text-red-500" role="alert">
            {formError ?? problem}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void submit()} disabled={saving || !!problem}>
              {saving ? 'Saving…' : draft.members.length === 0 ? 'Done' : 'Save crew'}
            </Button>
            <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={saving}>
              Cancel
            </Button>
          </div>
          {crew.has_crew &&
            (confirmRemove ? (
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                Remove the crew and keep only the lead?
                <Button size="sm" variant="secondary" onClick={() => void removeCrew()} disabled={saving}>
                  Yes, remove
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)} disabled={saving}>
                  No
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)} disabled={saving}>
                Remove crew
              </Button>
            ))}
        </div>
      </div>
    </JobSection>
  );
}
