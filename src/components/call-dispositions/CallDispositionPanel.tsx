import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ClipboardCheck, ListChecks, Sparkles } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { formatDateTime, formatTimeAgo } from '@/lib/callDetail';
import {
  DISPOSITIONS,
  DISPOSITION_OUTCOMES,
  NOTE_MAX,
  callerLabel,
  describeDispositionError,
  emptyDispositionDraft,
  followUpIsActive,
  selectOutcome,
  shouldSendFollowUp,
  suggestDisposition,
  toFollowUpPayload,
  validateDisposition,
  type DispositionDraft,
  type DispositionOutcome,
  type DispositionRow,
  type SuggestableCall,
} from '@/lib/callDisposition';
import {
  fetchDisposition,
  fetchFollowUp,
  saveDisposition,
  type LinkedFollowUp,
} from '@/lib/callDispositionApi';
import { fetchAssignees, type Assignee } from '@/lib/tasksApi';
import { PRIORITY_LABELS, type TaskPriority } from '@/lib/tasks';

export interface DispositionCall extends SuggestableCall {
  id: string;
  caller_name: string | null;
  caller_phone: string | null;
}

interface Props {
  call: DispositionCall;
  accountOwnerId: string;
  /** Anyone allowed to view the call may tag it; RLS has the final say. */
  canEdit: boolean;
}

type LoadState = 'loading' | 'ready' | 'error';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';

const FOLLOW_UP_BADGE: Record<'required' | 'optional' | 'none', string | null> = {
  required: 'Follow-up required',
  optional: 'Follow-up optional',
  none: null,
};

export function CallDispositionPanel({ call, accountOwnerId, canEdit }: Props) {
  const { user, profile, isOwner, permissions } = useAuth();
  const { toast } = useToast();

  const meId = user?.id ?? null;
  const selfName = profile?.full_name || profile?.company_name || user?.email || 'Me';
  const isManager = Boolean(isOwner || permissions?.can_view_all_jobs);
  const who = callerLabel(call);

  const [state, setState] = useState<LoadState>('loading');
  const [row, setRow] = useState<DispositionRow | null>(null);
  const [linked, setLinked] = useState<LinkedFollowUp | null>(null);
  const [draft, setDraft] = useState<DispositionDraft>(() => emptyDispositionDraft(meId));
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const token = useRef(0);

  const hasExisting = row?.follow_up_task_id != null;
  const suggestion = useMemo(() => suggestDisposition(call), [call]);

  const draftFromRow = useCallback(
    (r: DispositionRow | null): DispositionDraft => {
      const base = emptyDispositionDraft(meId);
      if (!r) return base;
      return { ...selectOutcome(base, r.outcome, who, meId, new Date(), r.follow_up_task_id != null), note: r.note ?? '', followUpOn: false };
    },
    [meId, who],
  );

  const load = useCallback(async (silent = false) => {
    const mine = ++token.current;
    if (!silent) setState('loading');
    setSaveError(null);
    try {
      const r = await fetchDisposition(call.id, accountOwnerId);
      let task: LinkedFollowUp | null = null;
      if (r?.follow_up_task_id) task = await fetchFollowUp(r.follow_up_task_id).catch(() => null);
      if (mine !== token.current) return;
      setRow(r);
      setLinked(task);
      setDraft(draftFromRow(r));
      setShowErrors(false);
      setState('ready');
    } catch {
      if (mine === token.current && !silent) setState('error');
    }
  }, [call.id, accountOwnerId, draftFromRow]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!canEdit || !meId) return;
    let live = true;
    fetchAssignees({ userId: meId, selfName, isManager })
      .then((rows) => {
        if (live) setAssignees(rows);
      })
      .catch(() => {
        if (live) setAssignees([{ userId: meId, name: selfName, role: 'you' }]);
      });
    return () => {
      live = false;
    };
  }, [canEdit, meId, selfName, isManager]);

  const errors = useMemo(() => validateDisposition(draft, hasExisting), [draft, hasExisting]);
  const rule = draft.outcome ? DISPOSITIONS[draft.outcome].followUp : null;
  const mustCreate = draft.outcome != null && rule === 'required' && !hasExisting;
  const sendsTask = shouldSendFollowUp(draft, hasExisting);
  const dirty =
    !row ||
    draft.outcome !== row.outcome ||
    draft.note.trim() !== (row.note ?? '') ||
    sendsTask ||
    row.source === 'ai';

  const pick = (o: DispositionOutcome) => {
    setDraft((d) => selectOutcome(d, o, who, meId, new Date(), hasExisting));
    setSaveError(null);
  };

  const patchFollowUp = (patch: Partial<DispositionDraft['followUp']>) =>
    setDraft((d) => ({ ...d, followUp: { ...d.followUp, ...patch } }));

  const handleSave = async () => {
    if (!canEdit || saving) return;
    setShowErrors(true);
    setSaveError(null);
    if (Object.keys(errors).length > 0 || !draft.outcome) return;

    const assigneeName = assignees.find((a) => a.userId === draft.followUp.assignedTo)?.name ?? null;
    setSaving(true);
    try {
      const result = await saveDisposition({
        callId: call.id,
        outcome: draft.outcome,
        note: draft.note,
        followUp: sendsTask ? toFollowUpPayload(draft.followUp, assigneeName) : null,
      });
      toast(result.taskCreated ? 'Outcome saved and follow-up task created.' : 'Outcome saved.', 'success');
      await load(true);
    } catch (e) {
      setSaveError(describeDispositionError(e));
    } finally {
      setSaving(false);
    }
  };

  // ------------------------------------------------------------ render ---
  const shell = (children: React.ReactNode) => (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark" aria-labelledby="call-outcome-title">
      <h2 id="call-outcome-title" className="mb-4 flex items-center gap-2 text-sm font-semibold text-text-primary">
        <ClipboardCheck size={16} className="text-accent" aria-hidden="true" />
        Call outcome
      </h2>
      {children}
    </section>
  );

  if (state === 'loading') {
    return shell(
      <div className="space-y-3" aria-busy="true" aria-label="Loading call outcome">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-24 w-full" />
      </div>,
    );
  }

  if (state === 'error') {
    return shell(
      <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-warning-500/40 bg-warning-500/10 px-4 py-3 text-sm text-text-primary">
        <AlertTriangle size={16} className="shrink-0 text-warning-500" aria-hidden="true" />
        <span className="flex-1">Could not load the call outcome.</span>
        <Button size="sm" variant="secondary" onClick={() => load()}>
          Try again
        </Button>
      </div>,
    );
  }

  const current = row ? DISPOSITIONS[row.outcome] : null;

  return shell(
    <div className="space-y-4">
      {/* ---- saved status ---- */}
      {row && current ? (
        <div className="space-y-2 text-sm" data-testid="disposition-status" aria-live="polite">
          <p className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${current.chipClass}`}>{current.label}</span>
            <span className="text-xs text-text-secondary">
              {row.source === 'ai'
                ? `Set by AI${row.ai_confidence != null ? ` · ${Math.round(row.ai_confidence * 100)}% confident` : ''}`
                : 'Tagged by staff'}{' '}
              · {formatTimeAgo(row.updated_at)}
            </span>
          </p>
          {row.note && <p className="whitespace-pre-wrap text-text-secondary">{row.note}</p>}
          {hasExisting && (
            <p className="flex items-center gap-2 rounded-xl border border-border bg-bg-primary p-3 text-text-secondary">
              <ListChecks size={14} className="shrink-0 text-accent" aria-hidden="true" />
              {linked ? (
                <span className="min-w-0 flex-1">
                  <Link to="/dashboard/tasks" className="focus-ring font-medium text-text-primary hover:text-accent">
                    {linked.title}
                  </Link>
                  <span className="block text-xs">
                    {linked.status === 'done' ? 'Done' : linked.status === 'in_progress' ? 'In progress' : 'Open'}
                    {linked.due_at ? ` · due ${formatDateTime(linked.due_at)}` : ''}
                    {linked.assigned_to_name ? ` · ${linked.assigned_to_name}` : ''}
                  </span>
                </span>
              ) : (
                <span>Follow-up task created.</span>
              )}
            </p>
          )}
          {row.source === 'ai' && canEdit && (
            <p className="rounded-xl border border-accent/30 bg-accent/5 p-3 text-xs text-text-primary">
              The AI picked this outcome automatically. Confirm or change it below.
            </p>
          )}
        </div>
      ) : (
        !canEdit && <p className="text-sm text-text-secondary">Outcome not recorded for this call.</p>
      )}

      {canEdit && (
        <>
          {/* ---- AI suggestion ---- */}
          {!row && suggestion && draft.outcome == null && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-accent/30 bg-accent/5 p-3 text-sm" data-testid="disposition-suggestion">
              <Sparkles size={16} className="shrink-0 text-accent" aria-hidden="true" />
              <p className="min-w-0 flex-1 text-text-primary">
                <span className="font-semibold">Suggested: {DISPOSITIONS[suggestion.outcome].label}.</span>{' '}
                <span className="text-text-secondary">{suggestion.reason}</span>
              </p>
              <Button size="sm" variant="secondary" onClick={() => pick(suggestion.outcome)}>
                Use suggestion
              </Button>
            </div>
          )}

          {/* ---- outcome picker ---- */}
          <div>
            <p id="outcome-label" className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
              How did this call end?
            </p>
            <div role="radiogroup" aria-labelledby="outcome-label" className="grid grid-cols-2 gap-2">
              {DISPOSITION_OUTCOMES.map((o) => {
                const selected = draft.outcome === o;
                return (
                  <button
                    key={o}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={saving}
                    onClick={() => pick(o)}
                    className={`focus-ring min-h-[44px] rounded-xl border px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-50 ${
                      selected ? 'border-accent bg-accent/10 text-text-primary ring-2 ring-accent/30' : 'border-border bg-bg-primary text-text-secondary hover:border-accent/40 hover:text-text-primary'
                    }`}
                  >
                    {DISPOSITIONS[o].label}
                  </button>
                );
              })}
            </div>
            {showErrors && errors.outcome && (
              <p role="alert" className="mt-1.5 text-xs text-danger">
                {errors.outcome}
              </p>
            )}
            {draft.outcome && (
              <p className="mt-2 text-xs text-text-secondary" aria-live="polite">
                {DISPOSITIONS[draft.outcome].description}
                {FOLLOW_UP_BADGE[DISPOSITIONS[draft.outcome].followUp] && (
                  <span className="ml-2 rounded-full bg-bg-tertiary px-2 py-0.5 font-medium text-text-primary">{FOLLOW_UP_BADGE[DISPOSITIONS[draft.outcome].followUp]}</span>
                )}
              </p>
            )}
          </div>

          {/* ---- note ---- */}
          <Textarea
            label="Note (optional)"
            rows={2}
            value={draft.note}
            maxLength={NOTE_MAX + 200}
            onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
            error={showErrors ? errors.note : undefined}
            disabled={saving}
          />

          {/* ---- follow-up ---- */}
          {draft.outcome && rule !== 'none' && (
            <fieldset className="space-y-3 rounded-xl border border-border bg-bg-primary p-3" data-testid="follow-up-section">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Follow-up task {rule === 'required' && !hasExisting ? '(required)' : ''}
              </legend>

              {!mustCreate && (
                <label className="flex items-center gap-2 text-sm text-text-primary">
                  <input
                    type="checkbox"
                    className="accent-accent"
                    checked={draft.followUpOn}
                    disabled={saving}
                    onChange={(e) => setDraft((d) => ({ ...d, followUpOn: e.target.checked }))}
                  />
                  {hasExisting ? 'Create another follow-up task' : 'Create a follow-up task'}
                </label>
              )}

              {(mustCreate || followUpIsActive(draft)) && (
                <div className="space-y-3">
                  <Input
                    label="Task title"
                    value={draft.followUp.title}
                    onChange={(e) => patchFollowUp({ title: e.target.value })}
                    error={showErrors ? errors.title : undefined}
                    disabled={saving}
                    required
                  />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Input
                      label="Due"
                      type="datetime-local"
                      value={draft.followUp.dueLocal}
                      onChange={(e) => patchFollowUp({ dueLocal: e.target.value })}
                      error={showErrors ? errors.dueLocal : undefined}
                      disabled={saving}
                    />
                    <div>
                      <label htmlFor="follow-up-priority" className="mb-1.5 block text-sm font-medium text-text-primary">
                        Priority
                      </label>
                      <select
                        id="follow-up-priority"
                        className={selectClass}
                        value={draft.followUp.priority}
                        disabled={saving}
                        onChange={(e) => patchFollowUp({ priority: e.target.value as TaskPriority })}
                      >
                        {(Object.keys(PRIORITY_LABELS) as TaskPriority[]).map((p) => (
                          <option key={p} value={p}>
                            {PRIORITY_LABELS[p]}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label htmlFor="follow-up-assignee" className="mb-1.5 block text-sm font-medium text-text-primary">
                      Assign to
                    </label>
                    <select
                      id="follow-up-assignee"
                      className={selectClass}
                      value={draft.followUp.assignedTo ?? ''}
                      disabled={saving}
                      onChange={(e) => patchFollowUp({ assignedTo: e.target.value || null })}
                    >
                      {isManager && <option value="">Unassigned</option>}
                      {assignees.map((a) => (
                        <option key={a.userId} value={a.userId}>
                          {a.userId === meId ? `${a.name} (you)` : a.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </fieldset>
          )}

          {saveError && (
            <p role="alert" className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-text-primary">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
              {saveError}
            </p>
          )}

          <div className="flex items-center justify-end gap-3">
            {row && !dirty && (
              <span className="flex items-center gap-1.5 text-xs text-text-secondary">
                <CheckCircle2 size={14} className="text-success-500" aria-hidden="true" /> Saved
              </span>
            )}
            <Button onClick={handleSave} disabled={saving || !dirty} size="sm">
              {saving ? 'Saving…' : row ? (row.source === 'ai' && draft.outcome === row.outcome ? 'Confirm outcome' : 'Update outcome') : 'Save outcome'}
            </Button>
          </div>
        </>
      )}
    </div>,
  );
}
