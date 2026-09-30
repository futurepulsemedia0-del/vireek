import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, ShieldCheck, Sparkles, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCard } from '@/components/Skeleton';
import { NoSurpriseBadge } from '@/components/NoSurpriseBadge';
import {
  NECESSITY_META,
  RISK_META,
  declineNeedsAcknowledgement,
  formatRange,
  formatUsd,
  respondErrorMessage,
  timeLeftLabel,
  type NoSurpriseOption,
  type NoSurpriseRoom,
  type PublicRequest,
} from '@/lib/noSurprise';
import { fetchRoom, respondToRequest } from '@/lib/noSurpriseApi';

const POLL_MS = 20_000;
const DECLINE_VALUE = '__decline';

const TONE_CHIP = {
  danger: 'border-danger/30 bg-danger/5 text-danger',
  warning: 'border-warning-500/30 bg-warning-500/5 text-warning-500',
  neutral: 'border-border bg-bg-primary text-text-secondary',
} as const;

function formatWhen(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ============================================================
// ONE PENDING REQUEST
// ============================================================

function DecisionCard({ request, token, onDecided }: { request: PublicRequest; token: string; onDecided: () => void }) {
  const recommended = request.options.find((o) => o.recommended && o.kind === 'perform') ?? request.options.find((o) => o.kind === 'perform');
  const [choice, setChoice] = useState<string>(recommended?.id ?? DECLINE_VALUE);
  const [signedName, setSignedName] = useState('');
  const [note, setNote] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const selected: NoSurpriseOption | undefined = request.options.find((o) => o.id === choice);
  const approving = selected?.kind === 'perform';
  const needsAck = !approving && declineNeedsAcknowledgement(request);
  const necessity = NECESSITY_META[request.necessity];
  const risk = RISK_META[request.risk_level];

  const canSubmit = approving ? signedName.trim().length >= 2 : !needsAck || acknowledged;

  const submit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    const res = await respondToRequest({
      token,
      requestId: request.id,
      decision: approving ? 'approve' : 'decline',
      optionId: choice === DECLINE_VALUE ? null : choice,
      signedName: signedName || undefined,
      note: note || undefined,
      acknowledged,
    });
    setSubmitting(false);
    if (res.ok) {
      onDecided();
      return;
    }
    setError(respondErrorMessage(res.error));
    if (res.error === 'expired' || res.error === 'already_resolved') onDecided();
  };

  return (
    <Card className="!p-5 hover:!translate-y-0 sm:!p-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-warning-500/30 bg-warning-500/5 px-2.5 py-1 text-[11px] font-semibold text-warning-500">
          <AlertTriangle size={12} aria-hidden="true" /> Additional work may be required
        </span>
        <span className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${TONE_CHIP[necessity.tone]}`}>{necessity.label}</span>
        <span className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${TONE_CHIP[risk.tone]}`}>{risk.label}</span>
        <span className="ml-auto flex items-center gap-1 text-[11px] text-text-secondary">
          <Clock size={12} aria-hidden="true" /> {timeLeftLabel(request.expires_at, now)}
        </span>
      </div>

      <h2 className="mt-3 text-lg font-bold text-text-primary">{request.title}</h2>
      <p className="mt-1 text-xs text-text-secondary">{necessity.hint}</p>

      <div className="mt-4 space-y-3">
        <div>
          <p className="text-xs font-semibold text-text-secondary">Why this came up</p>
          <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-text-primary">{request.why}</p>
        </div>

        <div className="rounded-xl border border-border bg-bg-primary p-3">
          <p className="text-xs font-semibold text-text-secondary">If you do nothing</p>
          <p className="mt-1 text-sm leading-relaxed text-text-primary">{request.consequence}</p>
        </div>

        <div className="rounded-xl border border-success-500/30 bg-success-500/5 p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-success-500">
            <ShieldCheck size={13} aria-hidden="true" /> Your price protection
          </p>
          <p className="mt-1 text-sm leading-relaxed text-text-primary">
            Nothing is added to your bill unless you approve it below. If you approve, the most you can be charged for this item is the
            highest amount shown for the option you choose.
            {request.work_paused ? ' Your technician will wait for your answer before starting.' : ''}
          </p>
        </div>
      </div>

      <fieldset className="mt-5">
        <legend className="mb-2 text-xs font-semibold text-text-secondary">
          Your options · estimated {formatRange(request.cost_low_cents, request.cost_high_cents)}
        </legend>
        <div className="space-y-2">
          {[...request.options, null].map((opt) => {
            const value = opt ? opt.id : DECLINE_VALUE;
            const active = choice === value;
            return (
              <label
                key={value}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors focus-within:ring-2 focus-within:ring-accent/40 ${
                  active ? 'border-accent bg-accent/5' : 'border-border bg-bg-primary hover:border-accent/40'
                }`}
              >
                <input
                  type="radio"
                  name={`choice-${request.id}`}
                  value={value}
                  checked={active}
                  onChange={() => {
                    setChoice(value);
                    setError(null);
                  }}
                  className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-accent,#2563eb)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-text-primary">{opt ? opt.label : 'No, I do not want this'}</span>
                    {opt?.recommended && (
                      <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">Recommended</span>
                    )}
                  </span>
                  {opt?.description && <span className="mt-0.5 block text-xs leading-relaxed text-text-secondary">{opt.description}</span>}
                  {!opt && <span className="mt-0.5 block text-xs text-text-secondary">No extra charge. Nothing is added to your bill.</span>}
                </span>
                <span className="shrink-0 text-right text-sm font-bold text-text-primary">
                  {opt ? (opt.kind === 'defer' ? '$0' : formatRange(opt.cost_low_cents, opt.cost_high_cents)) : '$0'}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-4 space-y-3">
        {approving ? (
          <Input
            label="Type your full name to approve"
            value={signedName}
            onChange={(e) => setSignedName(e.target.value)}
            autoComplete="name"
            maxLength={120}
            required
            helperText={`You are approving "${selected?.label}" for no more than ${formatUsd(selected?.cost_high_cents)}.`}
          />
        ) : (
          needsAck && (
            <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-warning-500/30 bg-warning-500/5 p-3">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0"
              />
              <span className="text-xs leading-relaxed text-text-primary">
                I understand: {request.consequence}
              </span>
            </label>
          )
        )}

        <Textarea
          label="Note for the technician (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={1000}
        />

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <Button
          type="button"
          variant={approving ? 'primary' : 'secondary'}
          className="w-full"
          disabled={!canSubmit || submitting}
          onClick={submit}
        >
          {submitting
            ? 'Recording your decision…'
            : approving
              ? `Approve — up to ${formatUsd(selected?.cost_high_cents)}`
              : 'Confirm: do not add this'}
        </Button>

        <p className="text-center text-[11px] leading-relaxed text-text-secondary">
          Your decision is recorded with the date and time in this job’s tamper-evident evidence record.
          {request.ai_assisted ? ' This explanation was drafted with AI assistance and reviewed by your technician.' : ''}
        </p>
      </div>
    </Card>
  );
}

// ============================================================
// RESOLVED HISTORY
// ============================================================

function ResolvedRow({ request }: { request: PublicRequest }) {
  const chosen = request.options.find((o) => o.id === request.decided_option_id);
  const approved = request.status === 'approved';
  const Icon = approved ? CheckCircle2 : XCircle;
  const tone = approved ? 'text-success-500' : 'text-text-secondary';

  let line = '';
  if (approved) {
    line = `Approved${chosen ? ` “${chosen.label}”` : ''} — up to ${formatUsd(request.approved_cost_high_cents)}${request.signed_name ? ` · signed ${request.signed_name}` : ''}`;
  } else if (request.status === 'declined') {
    line = chosen ? `Not now — “${chosen.label}”. No extra charge.` : 'Declined. No extra charge.';
  } else {
    line = 'No decision was made in time. No extra charge.';
  }

  return (
    <li className="flex items-start gap-3 rounded-xl border border-border bg-bg-primary p-3">
      <Icon size={16} className={`mt-0.5 shrink-0 ${tone}`} aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-primary">{request.title}</p>
        <p className="mt-0.5 text-xs text-text-secondary">{line}</p>
        {request.decided_at && <p className="mt-0.5 text-[11px] text-text-secondary">{formatWhen(request.decided_at)}</p>}
      </div>
    </li>
  );
}

// ============================================================
// PANEL
// ============================================================

interface NoSurpriseCustomerPanelProps {
  token: string;
  /** standalone = full page context (shows empty/invalid states); embedded = renders nothing when the link is unknown. */
  standalone?: boolean;
  onRoomLoaded?: (room: NoSurpriseRoom | null) => void;
}

export function NoSurpriseCustomerPanel({ token, standalone = false, onRoomLoaded }: NoSurpriseCustomerPanelProps) {
  const [room, setRoom] = useState<NoSurpriseRoom | null | undefined>(undefined);
  const alive = useRef(true);
  const loadedRef = useRef(onRoomLoaded);
  loadedRef.current = onRoomLoaded;

  const load = useCallback(async () => {
    const data = await fetchRoom(token);
    if (!alive.current) return;
    setRoom(data);
    loadedRef.current?.(data);
  }, [token]);

  useEffect(() => {
    alive.current = true;
    void load();
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(poll);
    };
  }, [load]);

  const { pending, resolved } = useMemo(() => {
    const list = room?.requests ?? [];
    return {
      pending: list.filter((r) => r.status === 'pending' && new Date(r.expires_at).getTime() > Date.now()),
      resolved: list.filter((r) => r.status !== 'pending' || new Date(r.expires_at).getTime() <= Date.now()),
    };
  }, [room]);

  if (room === undefined) return <SkeletonCard rows={3} />;

  if (room === null) {
    return standalone ? (
      <EmptyState
        icon={XCircle}
        title="This link isn’t valid"
        description="It may have been mistyped or is no longer active. Please contact the business directly."
      />
    ) : null;
  }

  const cert = room.certification;
  const showBadge = cert && (cert.level === 'certified' || cert.level === 'protected' || cert.level === 'awaiting_customer' || cert.level === 'unverified');

  return (
    <section aria-label="No-Surprise price protection" className="space-y-4">
      {showBadge && cert && <NoSurpriseBadge level={cert.level} headHash={cert.evidence_head_hash} />}

      {pending.map((r) => (
        <DecisionCard key={r.id} request={r} token={token} onDecided={() => void load()} />
      ))}

      {standalone && pending.length === 0 && resolved.length === 0 && (
        <EmptyState
          icon={Sparkles}
          title="Nothing needs your approval"
          description="If your technician finds something that could add to your bill, you’ll see it here first — and nothing is added without your OK."
        />
      )}

      {resolved.length > 0 && (
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-text-secondary">
            <Sparkles size={13} aria-hidden="true" /> Decisions on this job
          </p>
          <ul className="space-y-2">
            {resolved.map((r) => (
              <ResolvedRow key={r.id} request={r} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
