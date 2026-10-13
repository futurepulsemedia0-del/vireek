import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  Download,
  Gift,
  Loader2,
  Lock,
  PauseCircle,
  PhoneCall,
  Undo2,
  WifiOff,
  TriangleAlert as AlertTriangle,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { SkeletonCardList } from '@/components/Skeleton';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import {
  CANCEL_REASON_OPTIONS,
  MAX_DETAIL_LENGTH,
  PAUSE_MONTH_OPTIONS,
  USAGE_WINDOW_DAYS,
  acceptWinBackOffer,
  daysUntil,
  exportAccountData,
  fetchCancellationContext,
  fetchUsageStats,
  formatLongDate,
  formatPrice,
  hasMeaningfulUsage,
  pauseSubscription,
  previewResumeDate,
  reasonSkipsAlternatives,
  resumeSubscription,
  scheduleCancellation,
  type CancelReason,
  type CancellationContext,
  type ExportKind,
  type FlowResult,
  type PauseMonths,
  type UsageStats,
} from '@/lib/cancellation';

type Step = 'survey' | 'alternatives' | 'confirm';
type Busy = 'pause' | 'offer' | 'resume' | null;
type Outcome = { kind: 'cancelled' | 'paused' | 'offer' | 'resumed'; ctx: CancellationContext };
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; ctx: CancellationContext }
  | { kind: 'no_subscription' }
  | { kind: 'ended' }
  | { kind: 'error'; message: string };

const STEPS: { id: Step; label: string }[] = [
  { id: 'survey', label: 'Feedback' },
  { id: 'alternatives', label: 'Options' },
  { id: 'confirm', label: 'Confirm' },
];

const CARD = 'rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark sm:p-6';

const EXPORT_BUTTONS: { kind: ExportKind; label: string }[] = [
  { kind: 'customers', label: 'Customers' },
  { kind: 'jobs', label: 'Jobs' },
  { kind: 'calls', label: 'Calls & transcripts' },
];

// ============================================================
// SMALL PIECES
// ============================================================

function StepIndicator({ current }: { current: Step }) {
  const idx = STEPS.findIndex((s) => s.id === current);
  return (
    <ol aria-label="Progress" className="mb-6 flex items-center gap-2 text-xs font-medium">
      {STEPS.map((s, i) => (
        <li
          key={s.id}
          aria-current={i === idx ? 'step' : undefined}
          className={`flex flex-1 items-center gap-2 ${i <= idx ? 'text-accent' : 'text-text-secondary'}`}
        >
          <span className={`h-1.5 flex-1 rounded-full ${i <= idx ? 'bg-accent' : 'bg-bg-tertiary'}`} aria-hidden="true" />
          <span className="shrink-0">{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

function UsageReminder({ stats }: { stats: UsageStats }) {
  const tiles = [
    { label: 'Calls answered', value: stats.callsAnswered },
    { label: 'Appointments booked', value: stats.appointmentsBooked },
    { label: 'Jobs completed', value: stats.jobsCompleted },
  ];
  return (
    <section aria-label="Your recent results" className="rounded-xl border border-border bg-bg-primary p-4">
      <p className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
        <PhoneCall size={15} className="text-accent" aria-hidden="true" /> Your last {USAGE_WINDOW_DAYS} days with Vireek
      </p>
      <dl className="grid grid-cols-3 gap-3 text-center">
        {tiles.map((t) => (
          <div key={t.label}>
            <dd className="text-xl font-bold text-text-primary">{t.value.toLocaleString('en-US')}</dd>
            <dt className="mt-0.5 text-[11px] leading-tight text-text-secondary">{t.label}</dt>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ExportPanel() {
  const { toast } = useToast();
  const [busy, setBusy] = useState<ExportKind | null>(null);

  const run = async (kind: ExportKind) => {
    if (busy) return;
    setBusy(kind);
    try {
      const rows = await exportAccountData(kind);
      if (rows === 0) toast('Nothing to export yet — that list is empty.', 'info');
      else toast(`Downloaded ${rows.toLocaleString('en-US')} ${kind} rows.`, 'success');
    } catch {
      toast('The export failed. Please try again.', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label="Export your data" className="rounded-xl border border-border bg-bg-primary p-4">
      <p className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <Download size={15} className="text-accent" aria-hidden="true" /> Take your data with you
      </p>
      <p className="mt-1 text-xs leading-relaxed text-text-secondary">
        Download your records as CSV files before you go. You can also do this later from Data Governance in Settings.
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        {EXPORT_BUTTONS.map((b) => (
          <Button key={b.kind} type="button" variant="secondary" size="sm" disabled={busy !== null} onClick={() => run(b.kind)}>
            {busy === b.kind ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
            {b.label}
          </Button>
        ))}
      </div>
    </section>
  );
}

// ============================================================
// PAGE
// ============================================================

export function CancelSubscriptionPage() {
  const navigate = useNavigate();
  const { isOwner, profileLoading } = useAuth();
  const { toast } = useToast();

  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [step, setStep] = useState<Step>('survey');
  const [reason, setReason] = useState<CancelReason | null>(null);
  const [detail, setDetail] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const [pauseMonths, setPauseMonths] = useState<PauseMonths>(1);
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadContext = useCallback(async () => {
    setLoad({ kind: 'loading' });
    const res = await fetchCancellationContext();
    if (!alive.current) return;
    if (res.ok) setLoad({ kind: 'ready', ctx: res.data });
    else if (res.code === 'no_subscription') setLoad({ kind: 'no_subscription' });
    else if (res.code === 'subscription_ended') setLoad({ kind: 'ended' });
    else setLoad({ kind: 'error', message: res.error });
  }, []);

  useEffect(() => {
    if (profileLoading || !isOwner) return;
    void loadContext();
    void fetchUsageStats().then((s) => alive.current && setUsage(s));
  }, [profileLoading, isOwner, loadContext]);

  // Move focus to the heading on every step change (keyboard + screen-reader users).
  useEffect(() => {
    headingRef.current?.focus();
  }, [step, outcome]);

  const goBack = () => navigate('/dashboard/billing');

  const afterAction = (kind: Outcome['kind'], res: FlowResult<CancellationContext>) => {
    if (res.ok) {
      setOutcome({ kind, ctx: res.data });
      return true;
    }
    // The state changed under us (e.g. cancelled in another tab): resync instead of guessing.
    if (['already_scheduled', 'not_pausable', 'offer_used', 'offer_unavailable', 'nothing_to_resume'].includes(res.code)) {
      toast(res.error, 'error');
      setStep('survey');
      void loadContext();
      return false;
    }
    toast(res.error, 'error');
    return false;
  };

  const onContinueFromSurvey = (ctx: CancellationContext) => {
    if (!reason) {
      setReasonError(true);
      document.getElementById('cancel-reason-first')?.focus();
      return;
    }
    const canOffer = ctx.status === 'active' || ctx.status === 'trialing';
    setStep(reasonSkipsAlternatives(reason) || !canOffer ? 'confirm' : 'alternatives');
  };

  const onPause = async () => {
    if (busy) return;
    setBusy('pause');
    const res = await pauseSubscription(pauseMonths, reason, detail.trim());
    if (alive.current) setBusy(null);
    if (alive.current) afterAction('paused', res);
  };

  const onOffer = async () => {
    if (busy) return;
    setBusy('offer');
    const res = await acceptWinBackOffer(reason, detail.trim());
    if (alive.current) setBusy(null);
    if (alive.current) afterAction('offer', res);
  };

  const onResume = async () => {
    if (busy) return;
    setBusy('resume');
    const res = await resumeSubscription();
    if (alive.current) setBusy(null);
    if (alive.current) afterAction('resumed', res);
  };

  const onConfirmCancel = async () => {
    if (!reason) return;
    const res = await scheduleCancellation(reason, detail.trim());
    if (!alive.current) return;
    setConfirmOpen(false);
    afterAction('cancelled', res);
  };

  // ---------- Render ----------

  const Back = (
    <button
      type="button"
      onClick={goBack}
      className="focus-ring mb-4 inline-flex min-h-[44px] items-center gap-1.5 rounded-lg text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
    >
      <ArrowLeft size={15} aria-hidden="true" /> Back to Billing
    </button>
  );

  let body: React.ReactNode;

  if (profileLoading) {
    body = (
      <div role="status" aria-live="polite">
        <span className="sr-only">Loading your subscription…</span>
        <SkeletonCardList count={2} rows={3} />
      </div>
    );
  } else if (!isOwner) {
    body = (
      <div className={`${CARD} text-center`}>
        <Lock size={26} className="mx-auto mb-3 text-text-secondary" aria-hidden="true" />
        <h1 ref={headingRef} tabIndex={-1} className="text-lg font-semibold text-text-primary focus:outline-none">
          Only the account owner can cancel
        </h1>
        <p className="mt-2 text-sm text-text-secondary">Ask the owner of this Vireek account to change the subscription.</p>
      </div>
    );
  } else if (load.kind === 'loading') {
    body = (
      <div role="status" aria-live="polite">
        <span className="sr-only">Loading your subscription…</span>
        <SkeletonCardList count={2} rows={3} />
      </div>
    );
  } else if (load.kind === 'error') {
    body = (
      <EmptyStateError
        icon={WifiOff}
        title="Couldn't load your subscription"
        description={load.message}
        onRetry={() => void loadContext()}
      />
    );
  } else if (load.kind === 'no_subscription') {
    body = (
      <EmptyState
        icon={CheckCircle2}
        title="No paid subscription to cancel"
        description="Your account isn't on a paid plan, so there's nothing to cancel and you won't be charged."
      />
    );
  } else if (load.kind === 'ended') {
    body = (
      <EmptyState
        icon={CheckCircle2}
        title="Your subscription has already ended"
        description="There are no further charges. You can start a new plan any time from Billing."
      />
    );
  } else if (outcome) {
    body = <OutcomeView outcome={outcome} onBilling={goBack} headingRef={headingRef} />;
  } else {
    const ctx = load.ctx;
    const endDate = formatLongDate(ctx.current_period_end);
    const daysLeft = daysUntil(ctx.current_period_end);

    if (ctx.cancel_at_period_end || ctx.paused_until) {
      const cancelling = ctx.cancel_at_period_end;
      body = (
        <div className={CARD}>
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-warning-500/10 text-warning-500">
            {cancelling ? <CalendarClock size={22} aria-hidden="true" /> : <PauseCircle size={22} aria-hidden="true" />}
          </span>
          <h1 ref={headingRef} tabIndex={-1} className="mt-4 text-xl font-bold text-text-primary focus:outline-none">
            {cancelling ? 'Your cancellation is scheduled' : 'Your billing is paused'}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">
            {cancelling
              ? `Your subscription won't renew. You keep full access until ${endDate}.`
              : `You won't be charged until ${formatLongDate(ctx.paused_until)}, when billing resumes automatically.`}
          </p>
          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <Button type="button" onClick={onResume} disabled={busy !== null}>
              {busy === 'resume' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Undo2 size={16} aria-hidden="true" />}
              {cancelling ? 'Keep my subscription' : 'Resume billing now'}
            </Button>
            <Button type="button" variant="ghost" onClick={goBack}>
              Back to Billing
            </Button>
          </div>
        </div>
      );
    } else if (step === 'survey') {
      body = (
        <div className="space-y-5">
          <StepIndicator current="survey" />
          <div className={CARD}>
            <h1 ref={headingRef} tabIndex={-1} className="text-xl font-bold text-text-primary focus:outline-none">
              We’re sorry to see you go
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Your {ctx.plan} plan{formatPrice(ctx.price_cents, ctx.currency) ? ` (${formatPrice(ctx.price_cents, ctx.currency)}/mo)` : ''} stays active until{' '}
              {endDate}
              {daysLeft !== null ? ` — ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left` : ''}.
            </p>

            <fieldset className="mt-5">
              <legend className="mb-2 text-sm font-semibold text-text-primary">
                What’s the main reason you’re leaving?<span className="ml-0.5 text-danger">*</span>
              </legend>
              <div className="space-y-2">
                {CANCEL_REASON_OPTIONS.map((o, i) => (
                  <label
                    key={o.value}
                    className={`flex min-h-[52px] cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-colors ${
                      reason === o.value ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/40'
                    }`}
                  >
                    <input
                      id={i === 0 ? 'cancel-reason-first' : undefined}
                      type="radio"
                      name="cancel-reason"
                      value={o.value}
                      checked={reason === o.value}
                      onChange={() => {
                        setReason(o.value);
                        setReasonError(false);
                      }}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-text-primary">{o.label}</span>
                      <span className="block text-xs text-text-secondary">{o.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
              {reasonError && (
                <p role="alert" className="mt-2 text-xs text-danger">
                  Please pick the closest reason so we can improve.
                </p>
              )}
            </fieldset>

            <div className="mt-5">
              <Textarea
                label="Anything we could have done better?"
                rows={3}
                maxLength={MAX_DETAIL_LENGTH}
                helperText="Optional — read by a real person on our team."
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            <Button type="button" variant="ghost" onClick={goBack}>
              Keep my subscription
            </Button>
            <Button type="button" onClick={() => onContinueFromSurvey(ctx)}>
              Continue
            </Button>
          </div>
        </div>
      );
    } else if (step === 'alternatives') {
      const resume = previewResumeDate(new Date(), pauseMonths);
      body = (
        <div className="space-y-5">
          <StepIndicator current="alternatives" />
          <div>
            <h1 ref={headingRef} tabIndex={-1} className="text-xl font-bold text-text-primary focus:outline-none">
              Before you go — would one of these help?
            </h1>
            <p className="mt-1 text-sm text-text-secondary">Either option is reversible, and neither changes your data.</p>
          </div>

          {ctx.offer && (
            <section aria-label="Special offer" className="rounded-2xl border-2 border-accent/40 bg-accent/5 p-5 sm:p-6">
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent">
                <Gift size={14} aria-hidden="true" /> One-time offer
              </p>
              <h2 className="mt-2 text-lg font-bold text-text-primary">
                Stay and get {ctx.offer.percent_off}% off for {ctx.offer.months} {ctx.offer.months === 1 ? 'month' : 'months'}
              </h2>
              <p className="mt-1 text-sm text-text-secondary">
                Applied to your next {ctx.offer.months === 1 ? 'invoice' : `${ctx.offer.months} invoices`} automatically. After that, your regular price
                returns.
              </p>
              <Button type="button" className="mt-4 w-full sm:w-auto" onClick={onOffer} disabled={busy !== null}>
                {busy === 'offer' && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
                Claim {ctx.offer.percent_off}% off
              </Button>
            </section>
          )}

          <section aria-label="Pause billing" className={CARD}>
            <p className="flex items-center gap-2 text-sm font-semibold text-text-primary">
              <PauseCircle size={16} className="text-accent" aria-hidden="true" /> Pause instead of cancelling
            </p>
            <p className="mt-1 text-sm text-text-secondary">Skip billing for a while. Billing resumes by itself — no action needed.</p>
            <fieldset className="mt-4">
              <legend className="sr-only">How long to pause</legend>
              <div className="grid grid-cols-3 gap-2">
                {PAUSE_MONTH_OPTIONS.map((m) => (
                  <label
                    key={m}
                    className={`flex min-h-[48px] cursor-pointer items-center justify-center rounded-xl border text-sm font-medium transition-colors ${
                      pauseMonths === m ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:border-accent/40'
                    }`}
                  >
                    <input
                      type="radio"
                      name="pause-months"
                      value={m}
                      checked={pauseMonths === m}
                      onChange={() => setPauseMonths(m)}
                      className="sr-only"
                    />
                    {m} {m === 1 ? 'month' : 'months'}
                  </label>
                ))}
              </div>
            </fieldset>
            <p className="mt-3 text-xs text-text-secondary">Billing would resume around {formatLongDate(resume.toISOString())}.</p>
            <Button type="button" variant="secondary" className="mt-4 w-full sm:w-auto" onClick={onPause} disabled={busy !== null}>
              {busy === 'pause' && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
              Pause for {pauseMonths} {pauseMonths === 1 ? 'month' : 'months'}
            </Button>
          </section>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            <Button type="button" variant="ghost" onClick={() => setStep('survey')}>
              Back
            </Button>
            <Button type="button" variant="ghost" onClick={() => setStep('confirm')}>
              No thanks, continue to cancel
            </Button>
          </div>
        </div>
      );
    } else {
      body = (
        <div className="space-y-5">
          <StepIndicator current="confirm" />
          <div className={CARD}>
            <h1 ref={headingRef} tabIndex={-1} className="text-xl font-bold text-text-primary focus:outline-none">
              Review and confirm
            </h1>
            <ul className="mt-4 space-y-2.5 text-sm text-text-secondary">
              <li className="flex items-start gap-2.5">
                <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" aria-hidden="true" />
                <span>
                  You keep full access until <strong className="text-text-primary">{endDate}</strong>.
                </span>
              </li>
              <li className="flex items-start gap-2.5">
                <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" aria-hidden="true" />
                <span>Your plan won’t renew, so there are no further charges after that.</span>
              </li>
              <li className="flex items-start gap-2.5">
                <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" aria-hidden="true" />
                <span>Changed your mind? You can undo this any time before {endDate}.</span>
              </li>
            </ul>
            <div className="mt-5 space-y-4">
              {hasMeaningfulUsage(usage) && <UsageReminder stats={usage} />}
              <ExportPanel />
            </div>
          </div>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="ghost" onClick={goBack}>
                Keep my subscription
              </Button>
              <Button type="button" variant="ghost" onClick={() => setStep(reasonSkipsAlternatives(reason) ? 'survey' : 'alternatives')}>
                Back
              </Button>
            </div>
            <Button
              type="button"
              variant="secondary"
              className="border-danger/40 text-danger hover:bg-danger/10"
              onClick={() => setConfirmOpen(true)}
            >
              <AlertTriangle size={15} aria-hidden="true" /> Cancel subscription
            </Button>
          </div>
        </div>
      );
    }
  }

  return (
    <DashboardLayout activeLabel="Billing">
      <div className="mx-auto w-full max-w-2xl pb-10">
        {Back}
        {body}
      </div>
      <ConfirmDialog
        open={confirmOpen}
        title="Cancel your subscription?"
        description={`Your plan will end on ${
          load.kind === 'ready' ? formatLongDate(load.ctx.current_period_end) : 'the end of your billing period'
        }. This will be recorded in your account's audit log.`}
        confirmPhrase="cancel subscription"
        confirmLabel="Cancel my subscription"
        onConfirm={onConfirmCancel}
        onCancel={() => setConfirmOpen(false)}
      />
    </DashboardLayout>
  );
}

// ============================================================
// OUTCOME
// ============================================================

function OutcomeView({
  outcome,
  onBilling,
  headingRef,
}: {
  outcome: Outcome;
  onBilling: () => void;
  headingRef: React.RefObject<HTMLHeadingElement>;
}) {
  const { kind, ctx } = outcome;
  const copy: Record<Outcome['kind'], { title: string; text: string }> = {
    cancelled: {
      title: 'Your cancellation is scheduled',
      text: `Your subscription won't renew. You keep full access until ${formatLongDate(ctx.current_period_end)}. Changed your mind? You can undo this from this page any time before then.`,
    },
    paused: {
      title: 'Billing is paused',
      text: `You won't be charged until ${formatLongDate(ctx.paused_until)}. Billing resumes automatically.`,
    },
    offer: {
      title: 'Offer applied — thanks for staying!',
      text: ctx.offer
        ? 'Your discount has been applied.'
        : 'Your discount has been applied to your upcoming invoices. Your regular price returns afterwards.',
    },
    resumed: {
      title: 'You’re all set',
      text: 'Your subscription is active again and will renew as normal.',
    },
  };
  const c = copy[kind];
  return (
    <div role="status" className={`${CARD} text-center`}>
      <CheckCircle2 size={36} className="mx-auto text-success" aria-hidden="true" />
      <h1 ref={headingRef} tabIndex={-1} className="mt-3 text-xl font-bold text-text-primary focus:outline-none">
        {c.title}
      </h1>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-text-secondary">{c.text}</p>
      {kind === 'cancelled' && (
        <div className="mx-auto mt-5 max-w-md text-left">
          <ExportPanel />
        </div>
      )}
      <Button type="button" className="mt-6" onClick={onBilling}>
        Back to Billing
      </Button>
    </div>
  );
}
