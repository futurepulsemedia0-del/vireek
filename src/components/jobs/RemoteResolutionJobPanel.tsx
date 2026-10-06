import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, Clipboard, Link2, Loader2, PhoneCall, PlayCircle, Truck, Undo2, Wifi } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { useRealtimeSubscription } from '@/lib/realtime';
import type { Job } from '@/lib/supabase';
import {
  BAND_META,
  CATEGORY_LABELS,
  DISPATCH_REASON_LABELS,
  LIMITS,
  METRIC_LABELS,
  STATUS_META,
  canCloseJob,
  formatUsd,
  isActive,
  timeLeftLabel,
  validateSymptom,
  type RrCase,
  type RrSignal,
  type RrTone,
} from '@/lib/remoteResolution';
import {
  closeJobRemote,
  dispatchCase,
  fetchCaseForJob,
  fetchSignals,
  getResolveLink,
  reopenCase,
  startCase,
  submitStaffTurn,
  withdrawCase,
} from '@/lib/remoteResolutionApi';

const TONE_TEXT: Record<RrTone, string> = {
  success: 'text-success-500',
  warning: 'text-warning-500',
  danger: 'text-danger',
  neutral: 'text-text-secondary',
};
const TONE_BAR: Record<RrTone, string> = {
  success: 'bg-success-500',
  warning: 'bg-warning-500',
  danger: 'bg-danger',
  neutral: 'bg-text-secondary',
};

function Gauge({ value, tone }: { value: number; tone: RrTone }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-bg-tertiary" role="img" aria-label={`Chance of resolving without a visit: ${value}%`}>
      <div className={`h-full rounded-full transition-all duration-500 ${TONE_BAR[tone]}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

export function RemoteResolutionJobPanel({ job }: { job: Job }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [kase, setKase] = useState<RrCase | null>(null);
  const [signals, setSignals] = useState<RrSignal[]>([]);
  const [symptom, setSymptom] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const c = await fetchCaseForJob(job.id);
      setKase(c);
      setSignals(c ? await fetchSignals(c.id) : []);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load remote resolution.', 'error');
    } finally {
      setLoading(false);
    }
  }, [job.id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Prefill the problem description from what is already on the job (call notes / dispatch note).
  useEffect(() => {
    if (!kase && !symptom) {
      const seed = String(job.dispatch_note ?? job.diagnosis_notes ?? '').trim();
      if (seed) setSymptom(seed.slice(0, LIMITS.symptom[1]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id]);

  useRealtimeSubscription<Record<string, unknown>>({
    channelName: `rr-case-${job.id}`,
    table: 'remote_resolution_cases',
    event: '*',
    filter: `job_id=eq.${job.id}`,
    onChange: () => void load(),
    enabled: true,
  });

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      toast(ok, 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong.', 'error');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(getResolveLink(job.reschedule_token));
      toast('Link copied. Send it to the customer.', 'success');
    } catch {
      toast('Could not copy. Select the link manually.', 'error');
    }
  };

  if (loading) return null;
  if (!kase && job.job_status !== 'scheduled') return null;

  const meta = kase ? STATUS_META[kase.status] : null;
  const active = kase ? isActive(kase.status) : false;
  const prob = kase?.probability ?? null;
  const band = kase?.band ? BAND_META[kase.band] : null;
  const symptomError = symptom.trim() ? validateSymptom(symptom) : null;
  const sensorSignals = signals.filter((s) => s.kind === 'sensor');
  const sensor = sensorSignals.length ? (sensorSignals[sensorSignals.length - 1].value as Record<string, { latest: number }>) : undefined;

  return (
    <section className="rounded-xl border border-border bg-bg-primary" aria-label="Remote Resolution">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="focus-ring flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <PhoneCall size={15} aria-hidden="true" /> Remote Resolution
          {meta && <span className={`text-xs font-medium ${TONE_TEXT[meta.tone]}`}>· {meta.label}</span>}
          {kase && active && prob != null && <span className="text-xs text-text-secondary">· {prob}%</span>}
        </span>
        {expanded ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-border px-4 py-4">
          {!kase ? (
            <div className="space-y-3">
              <p className="text-sm text-text-secondary">
                Try to solve this without a truck roll. The customer gets a link that asks a few smart questions and, when it is safe, guides them through a fix. Anything unsafe goes to dispatch immediately.
              </p>
              <Textarea
                label="What is the customer reporting?"
                rows={3}
                value={symptom}
                onChange={(e) => setSymptom(e.target.value)}
                maxLength={LIMITS.symptom[1]}
                error={symptomError ?? undefined}
              />
              <Button
                size="sm"
                disabled={busy || !symptom.trim() || !!symptomError}
                onClick={() => act(() => startCase(job.id, symptom, navigator.language), 'Remote attempt started.')}
              >
                {busy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <PlayCircle size={15} aria-hidden="true" />} Start remote attempt
              </Button>
            </div>
          ) : (
            <>
              {/* Probability */}
              <div className="space-y-2">
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium text-text-secondary">Chance of resolving without a visit</p>
                    <p className={`text-3xl font-bold ${band ? TONE_TEXT[band.tone] : 'text-text-primary'}`}>{prob == null ? '—' : `${prob}%`}</p>
                  </div>
                  <div className="text-right text-xs text-text-secondary">
                    {band && <p className={`font-semibold ${TONE_TEXT[band.tone]}`}>{band.label}</p>}
                    <p>{CATEGORY_LABELS[kase.category] ?? kase.category}</p>
                    {active && <p>{timeLeftLabel(kase.expires_at)}</p>}
                  </div>
                </div>
                {prob != null && band && <Gauge value={prob} tone={band.tone} />}
                {kase.safety_hold && (
                  <p role="alert" className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm font-medium text-danger">
                    Safety hold: {kase.safety_reasons.map((r) => r.replace(/_/g, ' ')).join(', ')}. Dispatch now.
                  </p>
                )}
                {kase.dispatch_reason && kase.status === 'dispatch_required' && (
                  <p className="text-sm text-text-secondary">Why a technician is needed: {DISPATCH_REASON_LABELS[kase.dispatch_reason]}.</p>
                )}
                {kase.status === 'resolved_remotely' && <p className="text-sm text-success-500">Verified. Saved about {formatUsd(kase.avoided_cost_cents)}.</p>}
                {kase.status === 'resolved_pending' && <p className="text-sm text-text-secondary">Customer says it is fixed. Verifying: {timeLeftLabel(kase.verification_until)}.</p>}
              </div>

              {/* Why this number */}
              {kase.factors.length > 0 && (
                <details className="rounded-lg border border-border px-3 py-2 text-sm">
                  <summary className="cursor-pointer text-xs font-semibold text-text-secondary">Why this number</summary>
                  <ul className="mt-2 space-y-1.5">
                    {kase.factors.map((f, i) => (
                      <li key={i} className="text-text-primary">
                        <span className={f.effect === 'up' ? 'text-success-500' : f.effect === 'down' ? 'text-danger' : 'text-text-secondary'}>
                          {f.effect === 'up' ? '▲' : f.effect === 'down' ? '▼' : '●'}
                        </span>{' '}
                        <span className="font-medium">{f.label}.</span> {f.detail}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {kase.hypotheses.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs font-semibold text-text-secondary">Likely causes</p>
                  <ul className="space-y-1.5">
                    {[...kase.hypotheses]
                      .sort((a, b) => b.likelihood - a.likelihood)
                      .slice(0, 4)
                      .map((h, i) => (
                        <li key={i} className="flex items-center justify-between gap-3 text-sm">
                          <span className="text-text-primary">{h.cause}</span>
                          <span className="shrink-0 text-xs text-text-secondary">
                            {Math.round(h.likelihood * 100)}% · {h.remote_fixable && !h.needs_parts ? 'self-fix' : 'technician'}
                          </span>
                        </li>
                      ))}
                  </ul>
                </div>
              )}

              {sensor && Object.keys(sensor).length > 0 && (
                <div>
                  <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-text-secondary">
                    <Wifi size={12} aria-hidden="true" /> Device readings (last 24h)
                  </p>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    {Object.entries(sensor)
                      .slice(0, 8)
                      .map(([k, v]) => (
                        <div key={k} className="flex justify-between gap-2">
                          <dt className="text-text-secondary">{METRIC_LABELS[k] ?? k}</dt>
                          <dd className="font-medium text-text-primary">{v.latest}</dd>
                        </div>
                      ))}
                  </dl>
                </div>
              )}

              {/* Evidence timeline */}
              {signals.filter((s) => ['answer', 'photo', 'audio', 'step_result'].includes(s.kind)).length > 0 && (
                <details className="rounded-lg border border-border px-3 py-2 text-sm">
                  <summary className="cursor-pointer text-xs font-semibold text-text-secondary">Evidence collected</summary>
                  <ul className="mt-2 space-y-1.5">
                    {signals
                      .filter((s) => ['answer', 'photo', 'audio', 'step_result'].includes(s.kind))
                      .map((s) => {
                        const v = s.value as { q?: string; a?: string; title?: string; result?: string; findings?: { label: string; detail: string }[] };
                        return (
                          <li key={s.id} className="text-text-primary">
                            <span className="text-xs uppercase text-text-secondary">{s.kind.replace('_', ' ')} · </span>
                            {s.kind === 'answer' && `${v.q ?? ''} → ${v.a ?? ''}`}
                            {s.kind === 'step_result' && `${v.title ?? ''}: ${(v.result ?? '').replace('_', ' ')}`}
                            {(s.kind === 'photo' || s.kind === 'audio') && ((v.findings ?? []).map((f) => `${f.label} (${f.detail})`).join('; ') || 'no usable details')}
                          </li>
                        );
                      })}
                  </ul>
                </details>
              )}

              {/* Staff answers for the customer (phone call) */}
              {active && kase.next_question && (
                <div className="space-y-2 rounded-lg border border-accent/20 bg-accent/5 p-3">
                  <p className="text-xs font-semibold text-text-secondary">Customer is on the phone? Answer for them:</p>
                  <p className="text-sm font-medium text-text-primary">{kase.next_question.text}</p>
                  {kase.next_question.type === 'yes_no' || kase.next_question.type === 'choice' ? (
                    <div className="flex flex-wrap gap-2">
                      {(kase.next_question.type === 'yes_no' ? ['yes', 'no', 'not sure'] : kase.next_question.options).map((o) => (
                        <Button
                          key={o}
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => act(() => submitStaffTurn(kase.id, { answers: [{ question_id: kase.next_question!.id, value: o }] }), 'Answer recorded.')}
                        >
                          {o}
                        </Button>
                      ))}
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <input
                        value={answer}
                        onChange={(e) => setAnswer(e.target.value)}
                        maxLength={kase.next_question.type === 'number' ? 14 : 500}
                        aria-label="Customer's answer"
                        className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                      />
                      <Button
                        size="sm"
                        disabled={busy || !answer.trim()}
                        onClick={() =>
                          act(async () => {
                            await submitStaffTurn(kase.id, { answers: [{ question_id: kase.next_question!.id, value: answer.trim() }] });
                            setAnswer('');
                          }, 'Answer recorded.')
                        }
                      >
                        Save
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {/* Actions */}
              <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                {active && (
                  <>
                    <Button size="sm" variant="secondary" onClick={copyLink}>
                      <Link2 size={14} aria-hidden="true" /> Copy customer link
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => act(() => dispatchCase(kase.id), 'Marked for dispatch.')}>
                      <Truck size={14} aria-hidden="true" /> Dispatch now
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => withdrawCase(kase.id), 'Remote attempt skipped.')}>
                      Skip remote attempt
                    </Button>
                  </>
                )}
                {canCloseJob(kase.status) && job.job_status === 'scheduled' && (
                  <Button size="sm" disabled={busy} onClick={() => act(() => closeJobRemote(job.id), 'Job closed as resolved remotely.')}>
                    <CheckCircle2 size={14} aria-hidden="true" /> Close job - resolved remotely
                  </Button>
                )}
                {canCloseJob(kase.status) && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => reopenCase(kase.id), 'Reopened. Dispatch with priority.')}>
                    <Undo2 size={14} aria-hidden="true" /> Problem returned
                  </Button>
                )}
                {!active && (
                  <button
                    type="button"
                    onClick={copyLink}
                    className="focus-ring inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-text-secondary hover:text-text-primary"
                  >
                    <Clipboard size={12} aria-hidden="true" /> Copy customer link
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
