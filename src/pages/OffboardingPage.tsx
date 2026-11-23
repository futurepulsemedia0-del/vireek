/**
 * /dashboard/billing/offboarding (wrapped in <ProtectedRoute>)
 * The guided "what happens now" page after a cancellation: access-end date, data export,
 * deletion timeline (existing deletion_requests pipeline) and the optional win-back opt-in.
 * Everything shown comes from offboarding_my_case(); nothing here is a promise the backend does not keep.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, CheckCircle2, Download, Loader2, Mail, ShieldAlert, Trash2 } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { FullExportButton } from '@/components/FullExportButton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { useOffboardingT } from '@/i18n/offboardingNamespace';
import { exportAccountData, type ExportKind } from '@/lib/cancellation';
import {
  CONSENT_VERSION,
  DELETION_GRACE_DAYS,
  buildTimeline,
  cancelAccountDeletion,
  daysFromNow,
  fetchMyCase,
  recordExportStarted,
  requestAccountDeletion,
  setWinbackConsent,
  type OffboardingCase,
  type TimelineStep,
} from '@/lib/offboarding';

type Load = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; data: OffboardingCase | null };

const CSV_KINDS: { kind: ExportKind; key: string }[] = [
  { kind: 'customers', key: 'export.csvCustomers' },
  { kind: 'jobs', key: 'export.csvJobs' },
  { kind: 'calls', key: 'export.csvCalls' },
];

const STATE_STYLE: Record<TimelineStep['state'], string> = {
  done: 'border-success/40 bg-success/10 text-success',
  current: 'border-accent bg-accent/10 text-accent',
  upcoming: 'border-border bg-bg-secondary text-text-secondary',
  attention: 'border-warning/50 bg-warning/10 text-warning',
};

function Timeline({ data }: { data: OffboardingCase }) {
  const { t, language } = useOffboardingT();
  const dateOf = (iso: string | null) =>
    iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleDateString(language, { dateStyle: 'long' }) : '';
  const steps = buildTimeline(data);
  return (
    <section aria-labelledby="ob-timeline" className="rounded-2xl border border-border bg-bg-secondary p-5 sm:p-6">
      <h2 id="ob-timeline" className="text-base font-semibold text-text-primary">{t('timeline.heading')}</h2>
      <ol className="mt-4 space-y-4">
        {steps.map((s, i) => {
          const base = `timeline.${s.key}.${s.variant}`;
          const days = s.key === 'accessEnd' ? Math.max(0, daysFromNow(data.accessEndsAt) ?? 0) : undefined;
          return (
            <li key={s.key} className="flex gap-3">
              <span
                aria-hidden="true"
                className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${STATE_STYLE[s.state]}`}
              >
                {s.state === 'done' ? <CheckCircle2 size={15} /> : i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-text-primary">
                  {t(`${base}.title`, { date: dateOf(s.date) })}
                  {s.state === 'attention' && <span className="sr-only"> ({t('timeline.heading')})</span>}
                </p>
                <p className="mt-0.5 text-sm leading-relaxed text-text-secondary">
                  {t(`${base}.text`, { date: dateOf(s.date), days: days ?? DELETION_GRACE_DAYS })}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function ExportSection({ onStarted }: { onStarted: () => void }) {
  const { t } = useOffboardingT();
  const { toast } = useToast();
  const [busy, setBusy] = useState<ExportKind | null>(null);

  const runCsv = async (kind: ExportKind) => {
    if (busy) return;
    setBusy(kind);
    try {
      const rows = await exportAccountData(kind);
      if (rows === 0) {
        toast(t('export.csvEmpty'), 'info');
      } else {
        toast(t('export.csvDone', { count: rows }), 'success');
        void recordExportStarted().then(onStarted);
      }
    } catch {
      toast(t('export.csvError'), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="ob-export" className="space-y-3">
      <div className="rounded-2xl border border-border bg-bg-secondary p-5 sm:p-6">
        <h2 id="ob-export" className="flex items-center gap-2 text-base font-semibold text-text-primary">
          <Download size={16} className="text-accent" aria-hidden="true" /> {t('export.heading')}
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-text-secondary">{t('export.intro')}</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          {CSV_KINDS.map((c) => (
            <Button key={c.kind} type="button" variant="secondary" size="sm" disabled={busy !== null} onClick={() => void runCsv(c.kind)}>
              {busy === c.kind ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
              {t(c.key)}
            </Button>
          ))}
        </div>
        <p className="mt-3 text-xs text-text-secondary">{t('export.note')}</p>
      </div>
      <FullExportButton onDownloaded={() => void recordExportStarted().then(onStarted)} />
    </section>
  );
}

function DeletionSection({ data, onChanged }: { data: OffboardingCase; onChanged: () => void }) {
  const { t } = useOffboardingT();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const d = data.deletion;

  const run = async (fn: () => Promise<void>, okKey: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      toast(t(okKey), 'success');
      setConfirming(false);
      onChanged();
    } catch {
      toast(t('deletion.error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="ob-delete" className="rounded-2xl border border-border bg-bg-secondary p-5 sm:p-6">
      <h2 id="ob-delete" className="flex items-center gap-2 text-base font-semibold text-text-primary">
        <Trash2 size={16} className="text-danger" aria-hidden="true" /> {t('deletion.heading')}
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-text-secondary">{t('deletion.intro', { days: DELETION_GRACE_DAYS })}</p>

      {!d && !confirming && (
        <Button type="button" variant="secondary" className="mt-3 border-danger/40 text-danger hover:bg-danger/10" onClick={() => setConfirming(true)}>
          {t('deletion.request')}
        </Button>
      )}

      {!d && confirming && (
        <div role="alertdialog" aria-labelledby="ob-del-title" aria-describedby="ob-del-desc" className="mt-3 rounded-xl border border-danger/40 bg-danger/5 p-4">
          <p id="ob-del-title" className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <ShieldAlert size={15} className="text-danger" aria-hidden="true" /> {t('deletion.confirmTitle')}
          </p>
          <p id="ob-del-desc" className="mt-1 text-sm text-text-secondary">{t('deletion.confirmText')}</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Button type="button" variant="danger" loading={busy} onClick={() => void run(requestAccountDeletion, 'deletion.requested')}>
              {t('deletion.confirm')}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>{t('deletion.keep')}</Button>
          </div>
        </div>
      )}

      {d?.status === 'grace_period' && (
        <Button type="button" variant="secondary" className="mt-3" loading={busy} onClick={() => void run(() => cancelAccountDeletion(d.id), 'deletion.cancelled')}>
          {t('deletion.cancel')}
        </Button>
      )}
    </section>
  );
}

function WinbackSection({ data, onChanged }: { data: OffboardingCase; onChanged: (c: OffboardingCase | null) => void }) {
  const { t } = useOffboardingT();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  if (!data.winbackAvailable && !data.winbackOptedIn) return null;

  const toggle = async (optIn: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await setWinbackConsent(optIn);
      onChanged(next);
      toast(t(optIn ? 'winback.optedIn' : 'winback.optedOut'), 'success');
    } catch {
      toast(t('winback.error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="ob-winback" className="rounded-2xl border border-border bg-bg-secondary p-5 sm:p-6">
      <h2 id="ob-winback" className="flex items-center gap-2 text-base font-semibold text-text-primary">
        <Mail size={16} className="text-accent" aria-hidden="true" /> {t('winback.heading')}
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-text-secondary">{t('winback.intro')}</p>
      <div className="mt-3">
        <Checkbox
          label={t('winback.label')}
          helperText={t('winback.helper')}
          checked={data.winbackOptedIn}
          disabled={busy}
          onChange={(e) => void toggle(e.target.checked)}
        />
      </div>
      <p className="mt-2 text-[11px] text-text-secondary">{t('winback.consentFootnote', { version: CONSENT_VERSION })}</p>
    </section>
  );
}

export function OffboardingPage() {
  const { t } = useOffboardingT();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  const refresh = useCallback(async (initial = false) => {
    if (initial) setLoad({ kind: 'loading' });
    try {
      setLoad({ kind: 'ready', data: await fetchMyCase() });
    } catch {
      setLoad((prev) => (prev.kind === 'ready' ? prev : { kind: 'error' }));
    }
  }, []);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  useEffect(() => {
    if (load.kind === 'ready') headingRef.current?.focus();
  }, [load.kind]);

  let body: React.ReactNode;
  if (load.kind === 'loading') {
    body = (
      <div className="space-y-3" aria-busy="true" aria-live="polite">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  } else if (load.kind === 'error') {
    body = (
      <Card className="space-y-3 p-6 text-center hover:translate-y-0" role="alert">
        <p className="text-sm text-text-secondary">{t('page.loadError')}</p>
        <div><Button type="button" onClick={() => void refresh(true)}>{t('page.retry')}</Button></div>
      </Card>
    );
  } else if (!load.data) {
    body = (
      <Card className="space-y-2 p-6 text-center hover:translate-y-0">
        <h1 ref={headingRef} tabIndex={-1} className="text-xl font-bold text-text-primary focus:outline-none">{t('page.noCaseTitle')}</h1>
        <p className="text-sm text-text-secondary">{t('page.noCaseText')}</p>
        <div><Link to="/dashboard/billing" className="focus-ring inline-block rounded-lg px-3 py-2 text-sm font-medium text-accent">{t('page.back')}</Link></div>
      </Card>
    );
  } else if (load.data.status === 'reactivated' || load.data.status === 'withdrawn') {
    const reactivated = load.data.status === 'reactivated';
    body = (
      <Card className="space-y-2 p-6 text-center hover:translate-y-0" role="status">
        <CheckCircle2 size={32} className="mx-auto text-success" aria-hidden="true" />
        <h1 ref={headingRef} tabIndex={-1} className="text-xl font-bold text-text-primary focus:outline-none">
          {t(reactivated ? 'page.reactivatedTitle' : 'page.withdrawnTitle')}
        </h1>
        <p className="text-sm text-text-secondary">{t(reactivated ? 'page.reactivatedText' : 'page.withdrawnText')}</p>
      </Card>
    );
  } else {
    const data = load.data;
    body = (
      <div className="space-y-4">
        <div>
          <h1 ref={headingRef} tabIndex={-1} className="flex items-center gap-2 text-2xl font-bold text-text-primary focus:outline-none">
            <CalendarClock size={22} className="text-accent" aria-hidden="true" /> {t('page.title')}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">{t('page.subtitle')}</p>
        </div>
        <Timeline data={data} />
        <ExportSection onStarted={() => void refresh()} />
        <DeletionSection data={data} onChanged={() => void refresh()} />
        <WinbackSection data={data} onChanged={(c) => setLoad({ kind: 'ready', data: c ?? data })} />
      </div>
    );
  }

  return (
    <DashboardLayout activeLabel="Billing">
      <div className="mx-auto w-full max-w-2xl pb-10">
        <Link to="/dashboard/billing" className="focus-ring mb-4 inline-block rounded-lg py-1 text-sm font-medium text-text-secondary hover:text-text-primary">
          <span aria-hidden="true" className="inline-block rtl:rotate-180">←</span> {t('page.back')}
        </Link>
        {body}
      </div>
    </DashboardLayout>
  );
}
