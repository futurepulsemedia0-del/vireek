import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { fieldBase, fieldBorder } from '@/components/ui/Input';
import { isWorkflowStatus, reasonsFor } from '@/lib/jobWorkflow';
import {
  STATUS_COLOR_CLASSES,
  activeDefinitions,
  evaluateTransition,
  resolveJobDefinition,
  type StatusDefinition,
  type StatusTransition,
  type TeamRole,
} from '@/lib/statusEngine';
import { listStatusDefinitions, listStatusTransitions, moveJobToStatus } from '@/lib/statusEngineApi';
import { useStatusEngineT } from '@/i18n/statusEngineNamespace';

interface JobStatusPanelProps {
  job: { id: string; job_status: string; custom_status_id?: unknown; custom_data?: unknown };
  canEdit: boolean;
  onChanged: () => void;
}

const TEAM_ROLE_SET: readonly string[] = ['admin', 'member', 'technician'];

/**
 * Job-detail card for business-defined statuses. Renders nothing until the account has at least
 * one custom status or transition rule, so accounts that don't use the feature see no change.
 * Moves go through `move_job_to_status`; the database makes the final decision.
 */
export function JobStatusPanel({ job, canEdit, onChanged }: JobStatusPanelProps) {
  const { t, statusLabel } = useStatusEngineT();
  const { toast } = useToast();
  const { isOwner, teamMember } = useAuth();
  const uid = useId();
  const [defs, setDefs] = useState<StatusDefinition[] | null>(null);
  const [rules, setRules] = useState<StatusTransition[]>([]);
  const [targetId, setTargetId] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const role: TeamRole = isOwner ? 'owner' : TEAM_ROLE_SET.includes(teamMember?.role ?? '') ? (teamMember?.role as TeamRole) : 'member';

  const load = useCallback(async () => {
    try {
      const [d, r] = await Promise.all([listStatusDefinitions(), listStatusTransitions()]);
      setDefs(d);
      setRules(r);
    } catch {
      setDefs(null); // optional card: stay hidden instead of blocking the job page
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, job.job_status, job.custom_status_id]);

  const jobRef = useMemo(
    () => ({ job_status: job.job_status, custom_status_id: typeof job.custom_status_id === 'string' ? job.custom_status_id : null }),
    [job.job_status, job.custom_status_id],
  );
  const current = useMemo(() => (defs ? resolveJobDefinition(jobRef, defs) : null), [defs, jobRef]);
  const options = useMemo(() => (defs ? activeDefinitions(defs).filter((d) => d.id !== current?.id) : []), [defs, current]);
  const target = options.find((d) => d.id === targetId) ?? null;
  const customData = job.custom_data && typeof job.custom_data === 'object' ? (job.custom_data as Record<string, unknown>) : null;

  const verdict = useMemo(
    () => (target ? evaluateTransition({ from: current, to: target, role, rules, note, reasonCode: reasonCode || null, customData }) : null),
    [target, current, role, rules, note, reasonCode, customData],
  );

  const hasFeature = !!defs && (rules.length > 0 || defs.some((d) => !d.is_system && d.archived_at === null));
  if (!hasFeature || !defs) return null;

  const needsReason = !!target && isWorkflowStatus(target.canonical_status) && current?.canonical_status !== target.canonical_status;
  const reasons = needsReason && target && isWorkflowStatus(target.canonical_status) ? reasonsFor(target.canonical_status) : [];
  const noteNeeded = !!target && (target.requires_note || reasonCode === 'other' || (verdict && !verdict.allowed && verdict.code === 'noteRequired'));
  const blocked = verdict && !verdict.allowed ? verdict : null;
  // Missing note/reason are asked for inline; every other refusal is explained.
  const explain = blocked && blocked.code !== 'noteRequired' && blocked.code !== 'reasonRequired' ? blocked : null;
  const canApply = canEdit && !!target && !!verdict?.allowed && !busy;

  const apply = async () => {
    if (!target || !canApply) return;
    setBusy(true);
    const res = await moveJobToStatus({ jobId: job.id, definitionId: target.id, reasonCode: reasonCode || null, note });
    setBusy(false);
    if (res.ok) {
      toast(t('panel.moved'), 'success');
      setTargetId('');
      setReasonCode('');
      setNote('');
      onChanged();
      void load();
    } else {
      const base = t(`errors.${res.code === 'missing_fields' ? 'missingFields' : res.code === 'transition_not_allowed' ? 'transitionNotAllowed' : res.code === 'note_required' ? 'noteRequired' : res.code === 'reason_required' ? 'reasonRequired' : res.code}`, {
        fields: (res.fields ?? []).join(', '),
      });
      toast(base, 'error');
    }
  };

  const colors = current ? STATUS_COLOR_CLASSES[current.color] : null;

  return (
    <section aria-labelledby={`${uid}-title`} className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${uid}-title`} className="text-sm font-semibold text-text-primary">{t('panel.title')}</h2>
        {current && colors && (
          <p className="flex items-center gap-2 text-xs text-text-secondary">
            <span>{t('panel.current')}</span>
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${colors.badge}`}>
              <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${colors.dot}`} />
              {statusLabel(current)}
            </span>
          </p>
        )}
      </div>

      {canEdit && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Select label={t('panel.moveTo')} value={targetId} onChange={(e) => { setTargetId(e.target.value); setReasonCode(''); }}>
            <option value="">{t('panel.choose')}</option>
            {options.map((d) => (
              <option key={d.id} value={d.id}>{statusLabel(d)}</option>
            ))}
          </Select>

          {needsReason && (
            <Select label={t('panel.reason')} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
              <option value="">{t('panel.chooseReason')}</option>
              {reasons.map((r) => (
                <option key={r.code} value={r.code}>{r.label}</option>
              ))}
            </Select>
          )}

          {noteNeeded && (
            <div className="sm:col-span-2">
              <label htmlFor={`${uid}-note`} className="mb-1 block text-xs font-medium text-text-secondary">{t('panel.note')}</label>
              <textarea
                id={`${uid}-note`}
                rows={2}
                maxLength={1000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className={`${fieldBase} ${fieldBorder(false)} min-h-[4rem]`}
              />
            </div>
          )}
        </div>
      )}

      <div aria-live="polite" className="mt-3 min-h-[1.25rem] text-xs text-text-secondary">
        {explain && <p role="status">{t(`errors.${explain.code}`, { fields: (explain.code === 'missingFields' ? explain.fields ?? [] : []).join(', ') })}</p>}
      </div>

      {canEdit && (
        <div className="mt-2 flex justify-end">
          <Button type="button" size="sm" disabled={!canApply} loading={busy} onClick={() => void apply()}>
            {t('panel.apply')}
          </Button>
        </div>
      )}
    </section>
  );
}
