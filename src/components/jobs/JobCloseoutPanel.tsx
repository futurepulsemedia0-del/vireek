import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Circle, ClipboardCheck, ExternalLink, Loader2, ShieldAlert } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  OWNER_LABELS,
  RISK_BADGE,
  STATUS_LABELS,
  STEP_LABELS,
  blockingDependency,
  canSubmitStep,
  deadlineRisk,
  eligibilityCopy,
  evidenceLabel,
  fetchCanSubmit,
  fetchJobCloseout,
  formatCents,
  nextStatuses,
  patchStep,
  requiresApprover,
  ruleFreshness,
  safeHttpUrl,
  setEvidence,
  startCloseout,
  todayISO,
  transitionStep,
  type JobCloseout,
  type RiskLevel,
  type StepDetail,
  type StepStatus,
} from '@/lib/installCloseout';

interface PendingAction {
  stepId: string;
  to: StepStatus;
}

export function JobCloseoutPanel({ job }: { job: { id: string } }) {
  const { t } = useTranslation('dashboard');
  const { toast } = useToast();
  const [data, setData] = useState<JobCloseout | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [canSubmit, setCanSubmit] = useState(false);
  const [installDate, setInstallDate] = useState(todayISO());
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [note, setNote] = useState('');
  const [reference, setReference] = useState('');
  const [evidenceRef, setEvidenceRef] = useState<Record<string, string>>({});
  const [showTimeline, setShowTimeline] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await fetchJobCloseout(job.id));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [job.id, toast]);

  useEffect(() => {
    setLoading(true);
    void load();
    void fetchCanSubmit().then(setCanSubmit);
  }, [load]);

  const run = async (key: string, fn: () => Promise<void>, okMsg?: string) => {
    setBusy(key);
    try {
      await fn();
      if (okMsg) toast(okMsg, 'success');
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const steps = data?.steps ?? [];
  const today = todayISO();
  const gate = useMemo(
    () => steps.find((s) => s.step_kind === 'rebate' && s.pre_approval_required && s.pre_approval_status !== 'approved' && s.status !== 'waived' && s.status !== 'done'),
    [steps],
  );

  if (loading) {
    return (
      <section className="rounded-lg border border-border bg-bg-secondary p-3">
        <p className="flex items-center gap-2 text-xs text-text-secondary">
          <Loader2 size={14} className="animate-spin" /> {t('closeout.loading', { defaultValue: 'Loading closeout...' })}
        </p>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="rounded-lg border border-border bg-bg-secondary p-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <ClipboardCheck size={16} className="text-accent" /> {t('closeout.title', { defaultValue: 'Install Closeout' })}
        </div>
        <p className="mt-1 text-xs text-text-secondary">
          {t('closeout.startHelp', {
            defaultValue: 'Track the permit, inspection, warranty registration, rebate claim and customer documents so no money or coverage is lost silently.',
          })}
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Input
            type="date"
            label={t('closeout.installDate', { defaultValue: 'Install date' })}
            value={installDate}
            onChange={(e) => setInstallDate(e.target.value)}
            className="max-w-[180px]"
          />
          <Button
            size="sm"
            disabled={busy === 'start' || !installDate}
            onClick={() => run('start', async () => void (await startCloseout(job.id, installDate)), t('closeout.started', { defaultValue: 'Closeout started.' }))}
          >
            {busy === 'start' ? <Loader2 size={14} className="animate-spin" /> : null}
            {t('closeout.start', { defaultValue: 'Start closeout' })}
          </Button>
        </div>
      </section>
    );
  }

  const confirm = async () => {
    if (!pending) return;
    const { stepId, to } = pending;
    await run(
      `t-${stepId}`,
      async () => {
        await transitionStep(stepId, to, note, reference);
        setPending(null);
        setNote('');
        setReference('');
      },
      t('closeout.updated', { defaultValue: 'Step updated.' }),
    );
  };

  const stepLite = steps.map((s) => ({ step_kind: s.step_kind, status: s.status }));

  const renderStep = (s: StepDetail) => {
    const risk = deadlineRisk(s, today);
    const missing = s.evidence.filter((e) => !e.present).map((e) => e.key);
    const dep = blockingDependency(s.step_kind, stepLite);
    const submitCheck = canSubmitStep(
      { step_kind: s.step_kind, status: s.status, missing_evidence: missing, pre_approval_required: s.pre_approval_required, pre_approval_status: s.pre_approval_status },
      stepLite,
    );
    const src = safeHttpUrl(s.source_url);
    const fresh = ruleFreshness(s.rule_verified_at, today);
    const closed = s.status === 'done' || s.status === 'waived';
    const actions = nextStatuses(s.status).filter((to) => !requiresApprover(to) || canSubmit);
    const isPending = pending?.stepId === s.id;

    return (
      <li key={s.id} className="rounded-lg border border-border bg-bg-primary p-3">
        <div className="flex flex-wrap items-center gap-2">
          {closed ? <CheckCircle2 size={16} className="text-success" /> : <Circle size={16} className="text-text-secondary" />}
          <span className="text-sm font-semibold text-text-primary">{STEP_LABELS[s.step_kind]}</span>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${RISK_BADGE[risk]}`}>{STATUS_LABELS[s.status]}</span>
          <span className="text-xs text-text-secondary">
            {OWNER_LABELS[s.owner_role]}
            {s.deadline ? ` · ${t('closeout.due', { defaultValue: 'due' })} ${s.deadline}` : ` · ${t('closeout.noDeadline', { defaultValue: 'no deadline set' })}`}
            {s.days_left !== null && !closed ? ` (${s.days_left < 0 ? `${Math.abs(s.days_left)}d overdue` : `${s.days_left}d left`})` : ''}
          </span>
        </div>

        {s.estimated_value_cents > 0 && !closed && (
          <p className="mt-1 text-xs text-text-secondary">
            {t('closeout.atStake', { defaultValue: 'At stake (estimate)' })}: {formatCents(s.estimated_value_cents)}
          </p>
        )}

        {s.step_kind === 'rebate' && (
          <p className="mt-1 text-xs text-text-secondary">{eligibilityCopy(s.source_url)}</p>
        )}

        {s.pre_approval_required && s.pre_approval_status !== 'approved' && !closed && (
          <div role="alert" className="mt-2 flex items-start gap-2 rounded-md bg-danger/10 p-2 text-xs text-danger">
            <ShieldAlert size={14} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <strong>{t('closeout.preApprovalTitle', { defaultValue: 'Pre-approval required before work starts.' })}</strong>{' '}
              {t('closeout.preApprovalStatus', { defaultValue: 'Status' })}: {s.pre_approval_status}.
              {canSubmit && (
                <span className="mt-1 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="focus-ring rounded-md border border-danger/40 px-2 py-1 font-medium"
                    disabled={busy === `p-${s.id}`}
                    onClick={() => run(`p-${s.id}`, () => patchStep(s.id, { pre_approval_status: 'approved' }), t('closeout.updated', { defaultValue: 'Step updated.' }))}
                  >
                    {t('closeout.markApproved', { defaultValue: 'Mark reservation approved' })}
                  </button>
                  <button
                    type="button"
                    className="focus-ring rounded-md border border-danger/40 px-2 py-1 font-medium"
                    disabled={busy === `p-${s.id}`}
                    onClick={() => run(`p-${s.id}`, () => patchStep(s.id, { pre_approval_status: 'denied' }))}
                  >
                    {t('closeout.markDenied', { defaultValue: 'Mark denied' })}
                  </button>
                </span>
              )}
            </div>
          </div>
        )}

        {s.evidence.length > 0 && (
          <ul className="mt-2 space-y-1">
            {s.evidence.map((e) => (
              <li key={e.key} className="flex flex-wrap items-center gap-2 text-xs">
                {e.present ? <CheckCircle2 size={13} className="text-success" /> : <AlertTriangle size={13} className="text-warning-500" />}
                <span className={e.present ? 'text-text-primary' : 'text-warning-500'}>{evidenceLabel(e.key)}</span>
                {e.ref && <span className="text-text-secondary">· {e.ref}</span>}
                {e.manual && !closed && (
                  e.present ? (
                    <button
                      type="button"
                      className="focus-ring text-text-secondary underline"
                      onClick={() => run(`e-${e.key}`, () => setEvidence(data.closeout.id, e.key, false))}
                    >
                      {t('closeout.remove', { defaultValue: 'remove' })}
                    </button>
                  ) : (
                    <span className="flex items-center gap-1">
                      <input
                        aria-label={`${evidenceLabel(e.key)} reference`}
                        value={evidenceRef[e.key] ?? ''}
                        onChange={(ev) => setEvidenceRef((m) => ({ ...m, [e.key]: ev.target.value }))}
                        placeholder={t('closeout.refPlaceholder', { defaultValue: 'Number / link' })}
                        maxLength={500}
                        className="focus-ring w-32 rounded-md border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary"
                      />
                      <button
                        type="button"
                        className="focus-ring rounded-md border border-border px-2 py-1 text-xs font-medium text-text-primary"
                        disabled={busy === `e-${e.key}`}
                        onClick={() => run(`e-${e.key}`, () => setEvidence(data.closeout.id, e.key, true, evidenceRef[e.key]))}
                      >
                        {t('closeout.attach', { defaultValue: 'Mark attached' })}
                      </button>
                    </span>
                  )
                )}
              </li>
            ))}
          </ul>
        )}

        {s.rule_name && (
          <p className="mt-2 text-[11px] text-text-secondary">
            {t('closeout.rule', { defaultValue: 'Rule' })}: {s.rule_name}
            {src && (
              <a href={src} target="_blank" rel="noopener noreferrer" className="ml-1 inline-flex items-center gap-0.5 text-accent underline">
                {t('closeout.source', { defaultValue: 'source' })} <ExternalLink size={10} />
              </a>
            )}
            {' · '}
            {fresh === 'unverified'
              ? t('closeout.unverified', { defaultValue: 'never verified - re-check the source' })
              : `${t('closeout.verified', { defaultValue: 'verified' })} ${s.rule_verified_at}${fresh === 'stale' ? ` (${t('closeout.stale', { defaultValue: 'stale - re-verify' })})` : ''}`}
          </p>
        )}

        {s.reference_number && <p className="mt-1 text-[11px] text-text-secondary">Ref: {s.reference_number}</p>}
        {s.waive_reason && <p className="mt-1 text-[11px] text-text-secondary">Waived: {s.waive_reason}</p>}
        {dep && !closed && <p className="mt-1 text-[11px] text-text-secondary">{t('closeout.waitsFor', { defaultValue: 'Waits for' })}: {STEP_LABELS[dep]}</p>}

        {!closed && actions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {actions.map((to) => {
              const blocked = to === 'awaiting_approval' && missing.length > 0;
              const label =
                to === 'submitted'
                  ? t('closeout.approveSubmit', { defaultValue: 'Approve - I submitted this' })
                  : STATUS_LABELS[to];
              return (
                <button
                  key={to}
                  type="button"
                  disabled={blocked || (to === 'submitted' && !submitCheck.ok)}
                  title={blocked ? `Missing: ${missing.map(evidenceLabel).join(', ')}` : to === 'submitted' && !submitCheck.ok ? submitCheck.reason ?? '' : undefined}
                  onClick={() => {
                    if (requiresApprover(to) || s.status === 'missed') {
                      setPending({ stepId: s.id, to });
                    } else {
                      void run(`t-${s.id}`, () => transitionStep(s.id, to));
                    }
                  }}
                  className="focus-ring rounded-md border border-border px-2.5 py-1 text-xs font-medium text-text-primary hover:border-accent/50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}

        {!closed && s.status === 'awaiting_approval' && !submitCheck.ok && (
          <p className="mt-1 text-[11px] text-warning-500">{submitCheck.reason}</p>
        )}

        {isPending && pending && (
          <div className="mt-2 space-y-2 rounded-md border border-border bg-bg-secondary p-2">
            <p className="text-xs text-text-secondary">
              {pending.to === 'submitted'
                ? t('closeout.humanNotice', { defaultValue: 'Vireek never files anything for you. Confirm you submitted this yourself (portal, email, mail) and add the confirmation number.' })
                : pending.to === 'waived'
                  ? t('closeout.waiveNotice', { defaultValue: 'Waiving removes this step from the deadline engine. A reason is required and is logged.' })
                  : t('closeout.noteNotice', { defaultValue: 'Add a short note.' })}
            </p>
            {pending.to === 'submitted' && (
              <Input
                label={t('closeout.confirmation', { defaultValue: 'Confirmation / reference number' })}
                value={reference}
                maxLength={120}
                onChange={(e) => setReference(e.target.value)}
              />
            )}
            <Input
              label={t('closeout.note', { defaultValue: 'Note' })}
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="flex gap-2">
              <Button size="sm" disabled={busy === `t-${s.id}`} onClick={() => void confirm()}>
                {busy === `t-${s.id}` ? <Loader2 size={14} className="animate-spin" /> : null}
                {t('closeout.confirm', { defaultValue: 'Confirm' })}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setPending(null); setNote(''); setReference(''); }}>
                {t('closeout.cancel', { defaultValue: 'Cancel' })}
              </Button>
            </div>
          </div>
        )}
      </li>
    );
  };

  return (
    <section className="rounded-lg border border-border bg-bg-secondary p-3">
      <div className="flex flex-wrap items-center gap-2">
        <ClipboardCheck size={16} className="text-accent" />
        <h3 className="text-sm font-semibold text-text-primary">{t('closeout.title', { defaultValue: 'Install Closeout' })}</h3>
        <span className="text-xs text-text-secondary">
          {data.closeout.status === 'done'
            ? t('closeout.allDone', { defaultValue: 'All steps closed' })
            : `${t('closeout.installed', { defaultValue: 'Installed' })} ${data.closeout.install_date ?? '-'}`}
        </span>
      </div>

      {gate && (
        <div role="alert" className="mt-2 flex items-start gap-2 rounded-md bg-danger/10 p-2 text-xs text-danger">
          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
          <span>
            <strong>{t('closeout.gateTitle', { defaultValue: 'Do not start this job yet.' })}</strong>{' '}
            {t('closeout.gateBody', { defaultValue: 'A rebate program needs its reservation approved first, otherwise the rebate can be voided. The system blocks moving the job to En route / In progress until this is resolved.' })}
          </span>
        </div>
      )}

      <ul className="mt-3 space-y-2">{steps.map(renderStep)}</ul>

      <button
        type="button"
        className="focus-ring mt-3 text-xs text-text-secondary underline"
        onClick={() => setShowTimeline((v) => !v)}
      >
        {showTimeline ? t('closeout.hideTimeline', { defaultValue: 'Hide audit timeline' }) : t('closeout.showTimeline', { defaultValue: 'Show audit timeline' })}
      </button>
      {showTimeline && (
        <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-[11px] text-text-secondary">
          {data.events.map((ev) => (
            <li key={ev.id}>
              {new Date(ev.created_at).toLocaleString()} · {ev.event_type.replace(/_/g, ' ')}
              {ev.from_status && ev.to_status && ev.from_status !== ev.to_status ? ` (${ev.from_status} → ${ev.to_status})` : ''}
              {ev.note ? ` - ${ev.note}` : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
