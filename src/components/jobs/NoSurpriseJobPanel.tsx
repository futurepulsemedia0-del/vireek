import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Bot, Clipboard, Link2, Loader2, MessageSquare, Plus, Send, ShieldCheck, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { NoSurpriseBadge } from '@/components/NoSurpriseBadge';
import { useToast } from '@/contexts/ToastContext';
import { useRealtimeSubscription } from '@/lib/realtime';
import type { Job } from '@/lib/supabase';
import {
  CERT_REASON_LABELS,
  EXPIRY_CHOICES,
  LIMITS,
  NECESSITY_META,
  RISK_META,
  STATUS_META,
  approvalMessage,
  draftFromAssessment,
  effectiveStatus,
  emptyDraft,
  formatRange,
  formatUsd,
  timeLeftLabel,
  validateDraft,
  type AiAssessment,
  type Certification,
  type DraftOption,
  type Necessity,
  type NoSurpriseDraft,
  type NoSurpriseRequest,
  type RiskLevel,
} from '@/lib/noSurprise';
import {
  assessWithAi,
  createRequest,
  fetchJobCertification,
  fetchJobRequests,
  getApprovalLink,
  withdrawRequest,
} from '@/lib/noSurpriseApi';

const TONE_TEXT = {
  success: 'text-success-500',
  warning: 'text-warning-500',
  danger: 'text-danger',
  neutral: 'text-text-secondary',
} as const;

const SELECT_CLASS =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-3 text-sm text-text-primary focus-visible:border-accent';

function formatWhen(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ============================================================
// COMPOSER
// ============================================================

type ComposerStep = 'findings' | 'form';

function Composer({ job, onCancel, onCreated }: { job: Job; onCancel: () => void; onCreated: (r: NoSurpriseRequest) => void }) {
  const { toast } = useToast();
  const [step, setStep] = useState<ComposerStep>('findings');
  const [findings, setFindings] = useState('');
  const [assessing, setAssessing] = useState(false);
  const [draft, setDraft] = useState<NoSurpriseDraft>(emptyDraft);
  const [aiAssisted, setAiAssisted] = useState(false);
  const [aiNotes, setAiNotes] = useState<Pick<AiAssessment, 'missing_info' | 'confidence' | 'safety_flag'> | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const findingsOk = findings.trim().length >= LIMITS.findings[0];

  const runAi = async () => {
    if (!findingsOk || assessing) return;
    setAssessing(true);
    try {
      const a = await assessWithAi({ jobId: job.id, findings });
      setDraft(draftFromAssessment(a));
      setAiAssisted(true);
      setAiNotes({ missing_info: a.missing_info, confidence: a.confidence, safety_flag: a.safety_flag });
      setStep('form');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'AI draft failed. You can write it yourself.', 'error');
    } finally {
      setAssessing(false);
    }
  };

  const patch = (p: Partial<NoSurpriseDraft>) => setDraft((d) => ({ ...d, ...p }));
  const patchOption = (i: number, p: Partial<DraftOption>) =>
    setDraft((d) => ({ ...d, options: d.options.map((o, idx) => (idx === i ? { ...o, ...p } : o)) }));

  const setRecommended = (i: number) =>
    setDraft((d) => ({ ...d, options: d.options.map((o, idx) => ({ ...o, recommended: idx === i && o.kind === 'perform' })) }));

  const addOption = () =>
    setDraft((d) =>
      d.options.length >= LIMITS.maxOptions
        ? d
        : { ...d, options: [...d.options, { label: '', description: '', kind: 'perform', low: '', high: '', recommended: false }] },
    );

  const removeOption = (i: number) =>
    setDraft((d) => (d.options.length <= 1 ? d : { ...d, options: d.options.filter((_, idx) => idx !== i) }));

  const submit = async () => {
    const problems = validateDraft(draft);
    setErrors(problems);
    if (problems.length > 0 || saving) return;
    setSaving(true);
    try {
      const created = await createRequest({ jobId: job.id, draft, triggerNote: findings, aiAssisted });
      toast('Sent to the customer. Nothing is added to the bill until they approve.', 'success');
      onCreated(created);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not send this request.', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (step === 'findings') {
    return (
      <div className="space-y-3 rounded-xl border border-border bg-bg-primary p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold text-text-primary">What did you find?</p>
          <button type="button" onClick={onCancel} aria-label="Close" className="focus-ring rounded-md p-1 text-text-secondary hover:text-text-primary">
            <X size={14} />
          </button>
        </div>
        <Textarea
          value={findings}
          onChange={(e) => setFindings(e.target.value.slice(0, LIMITS.findings[1]))}
          rows={4}
          placeholder="e.g. Blower motor is drawing 40% over rated amps and the capacitor is bulging. Motor will likely fail within weeks."
          helperText="Plain facts and readings. The AI turns this into a customer-friendly explanation you can edit before sending."
        />
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={runAi} disabled={!findingsOk || assessing}>
            {assessing ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />}
            {assessing ? 'Drafting…' : 'Draft with AI'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              setAiAssisted(false);
              setStep('form');
            }}
          >
            Write it myself
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border border-border bg-bg-primary p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
          <AlertTriangle size={14} className="text-warning-500" /> Additional work may be required
        </p>
        <button type="button" onClick={onCancel} aria-label="Close" className="focus-ring rounded-md p-1 text-text-secondary hover:text-text-primary">
          <X size={14} />
        </button>
      </div>

      {aiAssisted && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 text-xs leading-relaxed text-text-primary">
          <p className="flex items-center gap-1.5 font-semibold">
            <Bot size={13} /> AI draft — review every line and price before sending. You are responsible for what the customer sees.
          </p>
          {aiNotes?.safety_flag && <p className="mt-1 font-medium text-danger">Safety-critical: follow local code and manufacturer instructions.</p>}
          {aiNotes && aiNotes.missing_info.length > 0 && (
            <p className="mt-1 text-text-secondary">Would sharpen the estimate: {aiNotes.missing_info.join(' · ')}</p>
          )}
        </div>
      )}

      <Input label="Title" value={draft.title} onChange={(e) => patch({ title: e.target.value })} maxLength={LIMITS.title[1]} required />
      <Textarea label="Why it came up (customer sees this)" value={draft.why} onChange={(e) => patch({ why: e.target.value })} rows={3} maxLength={LIMITS.why[1]} required />

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="ns-necessity" className="mb-1.5 block text-sm font-medium text-text-primary">Necessary or optional?</label>
          <select id="ns-necessity" className={SELECT_CLASS} value={draft.necessity} onChange={(e) => patch({ necessity: e.target.value as Necessity })}>
            {(Object.keys(NECESSITY_META) as Necessity[]).map((k) => (
              <option key={k} value={k}>{NECESSITY_META[k].label}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ns-risk" className="mb-1.5 block text-sm font-medium text-text-primary">Risk if skipped</label>
          <select id="ns-risk" className={SELECT_CLASS} value={draft.risk_level} onChange={(e) => patch({ risk_level: e.target.value as RiskLevel })}>
            {(Object.keys(RISK_META) as RiskLevel[]).map((k) => (
              <option key={k} value={k}>{RISK_META[k].label}</option>
            ))}
          </select>
        </div>
      </div>

      <Textarea label="If the customer does nothing…" value={draft.consequence} onChange={(e) => patch({ consequence: e.target.value })} rows={2} maxLength={LIMITS.consequence[1]} required />

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-text-primary">Options (the high price is a not-to-exceed ceiling)</legend>
        {draft.options.map((o, i) => (
          <div key={i} className="space-y-2 rounded-lg border border-border bg-bg-secondary p-3">
            <div className="flex items-center gap-2">
              <select
                aria-label={`Option ${i + 1} type`}
                className={`${SELECT_CLASS} !w-auto`}
                value={o.kind}
                onChange={(e) => {
                  const kind = e.target.value as DraftOption['kind'];
                  patchOption(i, kind === 'defer' ? { kind, low: '0', high: '0', recommended: false } : { kind });
                }}
              >
                <option value="perform">Do the work</option>
                <option value="defer">Not now</option>
              </select>
              {o.kind === 'perform' && (
                <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                  <input type="radio" name="ns-recommended" checked={o.recommended} onChange={() => setRecommended(i)} />
                  Recommended
                </label>
              )}
              <button
                type="button"
                onClick={() => removeOption(i)}
                disabled={draft.options.length <= 1}
                aria-label={`Remove option ${i + 1}`}
                className="focus-ring ml-auto rounded-md p-1.5 text-text-secondary hover:text-danger disabled:opacity-30"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <Input aria-label={`Option ${i + 1} label`} placeholder="Label, e.g. Replace blower motor" value={o.label} onChange={(e) => patchOption(i, { label: e.target.value })} maxLength={LIMITS.optionLabel[1]} />
            <Input aria-label={`Option ${i + 1} description`} placeholder="One line the customer will understand" value={o.description} onChange={(e) => patchOption(i, { description: e.target.value })} maxLength={LIMITS.optionDescription} />
            {o.kind === 'perform' && (
              <div className="grid grid-cols-2 gap-2">
                <Input aria-label={`Option ${i + 1} low price`} placeholder="Low $" inputMode="decimal" value={o.low} onChange={(e) => patchOption(i, { low: e.target.value })} />
                <Input aria-label={`Option ${i + 1} high price (ceiling)`} placeholder="High $ (ceiling)" inputMode="decimal" value={o.high} onChange={(e) => patchOption(i, { high: e.target.value })} />
              </div>
            )}
          </div>
        ))}
        {draft.options.length < LIMITS.maxOptions && (
          <Button type="button" size="sm" variant="ghost" onClick={addOption}>
            <Plus size={14} /> Add option
          </Button>
        )}
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="ns-expiry" className="mb-1.5 block text-sm font-medium text-text-primary">Customer has</label>
          <select id="ns-expiry" className={SELECT_CLASS} value={draft.expires_in_hours} onChange={(e) => patch({ expires_in_hours: Number(e.target.value) })}>
            {EXPIRY_CHOICES.map((c) => (
              <option key={c.hours} value={c.hours}>{c.label} to decide</option>
            ))}
          </select>
        </div>
        <label className="flex cursor-pointer items-center gap-2 self-end rounded-xl border border-border p-3 text-sm text-text-primary">
          <input type="checkbox" checked={draft.work_paused} onChange={(e) => patch({ work_paused: e.target.checked })} />
          I will pause until they answer
        </label>
      </div>

      {errors.length > 0 && (
        <ul role="alert" className="space-y-1 text-xs text-danger">
          {errors.map((e) => (
            <li key={e}>• {e}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={submit} disabled={saving}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          Send to customer
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ============================================================
// ONE REQUEST
// ============================================================

function RequestCard({ request, job, onChanged }: { request: NoSurpriseRequest; job: Job; onChanged: () => void }) {
  const { toast } = useToast();
  const [withdrawing, setWithdrawing] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const status = effectiveStatus(request);
  const meta = STATUS_META[status];
  const link = getApprovalLink(job.reschedule_token);
  const chosen = request.options.find((o) => o.id === request.decided_option_id);

  const copy = async (text: string, okMsg: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg, 'success');
    } catch {
      toast('Could not copy. Select and copy it manually.', 'error');
    }
  };

  const message = approvalMessage({ customerName: job.customer_name, businessName: null, title: request.title, link });

  const doWithdraw = async () => {
    setBusy(true);
    try {
      await withdrawRequest(request.id, reason);
      toast('Request withdrawn.', 'success');
      setWithdrawing(false);
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not withdraw.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="space-y-2 rounded-lg border border-border bg-bg-primary p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`text-xs font-semibold ${TONE_TEXT[meta.tone]}`}>{meta.label}</span>
        <span className="text-[11px] text-text-secondary">
          {NECESSITY_META[request.necessity].label} · {RISK_META[request.risk_level].label}
        </span>
        {request.ai_assisted && (
          <span className="inline-flex items-center gap-1 text-[11px] text-text-secondary">
            <Bot size={11} /> AI-assisted
          </span>
        )}
        <span className="ml-auto text-[11px] text-text-secondary">
          {status === 'pending' ? timeLeftLabel(request.expires_at) : formatWhen(request.decided_at ?? request.created_at)}
        </span>
      </div>

      <p className="text-sm font-medium text-text-primary">{request.title}</p>
      <p className="text-xs text-text-secondary">Estimate {formatRange(request.cost_low_cents, request.cost_high_cents)} · sent by {request.created_by_name ?? 'staff'}</p>

      {status === 'approved' && (
        <p className="text-xs font-medium text-success-500">
          Approved{chosen ? ` “${chosen.label}”` : ''} up to {formatUsd(request.approved_cost_high_cents)} · signed {request.signed_name}
        </p>
      )}
      {status === 'declined' && (
        <p className="text-xs text-text-secondary">
          {chosen ? `Deferred (“${chosen.label}”)` : 'Declined'}
          {request.risk_acknowledged ? ' — customer acknowledged the consequence.' : '.'}
        </p>
      )}
      {request.decision_note && <p className="text-xs italic text-text-secondary">“{request.decision_note}”</p>}

      {status === 'pending' && !withdrawing && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={() => copy(link, 'Approval link copied.')}>
            <Link2 size={13} /> Copy link
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => copy(message, 'Message copied.')}>
            <Clipboard size={13} /> Copy message
          </Button>
          {job.customer_phone && (
            <a
              href={`sms:${job.customer_phone}?body=${encodeURIComponent(message)}`}
              className="focus-ring inline-flex min-h-[40px] items-center justify-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary hover:border-accent/40"
            >
              <MessageSquare size={13} /> Text customer
            </a>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={() => setWithdrawing(true)}>
            Withdraw
          </Button>
        </div>
      )}

      {status === 'pending' && withdrawing && (
        <div className="space-y-2">
          <Input aria-label="Reason for withdrawing" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={doWithdraw} disabled={busy}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : null} Confirm withdraw
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setWithdrawing(false)}>
              Keep
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

// ============================================================
// PANEL
// ============================================================

export function NoSurpriseJobPanel({ job }: { job: Job }) {
  const [requests, setRequests] = useState<NoSurpriseRequest[]>([]);
  const [cert, setCert] = useState<Certification | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [composing, setComposing] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const [list, status] = await Promise.all([fetchJobRequests(job.id), fetchJobCertification(job.id).catch(() => null)]);
      if (!alive.current) return;
      setRequests(list);
      setCert(status);
      setUnavailable(false);
    } catch {
      // migration not applied yet, or no access: hide the panel instead of breaking the job card
      if (alive.current) setUnavailable(true);
    } finally {
      if (alive.current) setLoaded(true);
    }
  }, [job.id]);

  useEffect(() => {
    void load();
  }, [load, job.job_status, job.invoice_amount, job.quote_id]);

  const pendingCount = useMemo(() => requests.filter((r) => effectiveStatus(r) === 'pending').length, [requests]);

  useRealtimeSubscription<Record<string, unknown>>({
    channelName: `no-surprise-${job.id}`,
    table: 'no_surprise_requests',
    event: '*',
    filter: `job_id=eq.${job.id}`,
    onChange: () => void load(),
    enabled: expanded || pendingCount > 0,
  });

  // Deadline passes while the panel is open: refresh once so the server records the expiry.
  useEffect(() => {
    const soonest = requests
      .filter((r) => r.status === 'pending')
      .map((r) => new Date(r.expires_at).getTime())
      .sort((a, b) => a - b)[0];
    if (!soonest) return;
    const delay = Math.min(Math.max(soonest - Date.now() + 1500, 1500), 2_147_000_000);
    const t = setTimeout(() => void load(), delay);
    return () => clearTimeout(t);
  }, [requests, load]);

  if (!loaded || unavailable) return null;

  const closed = ['completed', 'cancelled', 'no_show'].includes(job.job_status);
  const level = cert?.level ?? 'protected';
  const reasons = (cert?.reasons ?? []).filter((r) => !(r === 'open_request' && pendingCount === 0));

  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="focus-ring flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text-primary">
          <ShieldCheck size={16} className="text-accent" />
          No-Surprise
          {cert && <NoSurpriseBadge level={level} variant="compact" />}
          {pendingCount > 0 && (
            <span className="rounded-full bg-warning-500/10 px-2 py-0.5 text-[11px] font-semibold text-warning-500">{pendingCount} waiting</span>
          )}
        </span>
        <span className="text-xs text-text-secondary">{expanded ? 'Hide' : 'Details'}</span>
      </button>

      {expanded && (
        <div className="mt-3 space-y-4 border-t border-border/60 pt-3">
          {cert && <NoSurpriseBadge level={level} headHash={cert.evidence_head_hash} />}

          {cert && (cert.baseline_cents != null || cert.approved_extra_cents > 0) && (
            <dl className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border border-border bg-bg-secondary p-2">
                <dt className="text-[10px] text-text-secondary">Agreed estimate</dt>
                <dd className="text-sm font-bold text-text-primary">{formatUsd(cert.baseline_cents)}</dd>
              </div>
              <div className="rounded-lg border border-border bg-bg-secondary p-2">
                <dt className="text-[10px] text-text-secondary">Approved extras (max)</dt>
                <dd className="text-sm font-bold text-text-primary">{formatUsd(cert.approved_extra_cents)}</dd>
              </div>
              <div className="rounded-lg border border-border bg-bg-secondary p-2">
                <dt className="text-[10px] text-text-secondary">Invoice ceiling</dt>
                <dd className="text-sm font-bold text-text-primary">{formatUsd(cert.ceiling_cents)}</dd>
              </div>
            </dl>
          )}

          {reasons.length > 0 && level !== 'certified' && (
            <ul className="space-y-1 text-xs">
              {reasons.map((r) => (
                <li key={r} className="flex items-center gap-2 text-text-primary">
                  <span className="h-1.5 w-1.5 rounded-full bg-warning-500" />
                  {CERT_REASON_LABELS[r]}
                </li>
              ))}
            </ul>
          )}

          {!composing && !closed && (
            <Button type="button" size="sm" onClick={() => setComposing(true)}>
              <AlertTriangle size={14} /> Flag additional work
            </Button>
          )}
          {closed && <p className="text-xs text-text-secondary">This job is closed, so new requests can’t be added.</p>}

          {composing && (
            <Composer
              job={job}
              onCancel={() => setComposing(false)}
              onCreated={() => {
                setComposing(false);
                void load();
              }}
            />
          )}

          {requests.length > 0 && (
            <ul className="space-y-2">
              {requests.map((r) => (
                <RequestCard key={r.id} request={r} job={job} onChanged={() => void load()} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
