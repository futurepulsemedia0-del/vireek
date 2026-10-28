import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Lock,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  Zap,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { BackButton } from '@/components/ui/BackButton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  DATADOG_SITES,
  EMPTY_FORM,
  MAX_DESTINATIONS,
  PROVIDER_META,
  SEVERITY_OPTIONS,
  deleteDestination,
  deliverNow,
  describeStatus,
  destinationTarget,
  fetchDeliveryLog,
  fetchDestinations,
  formFromDestination,
  formatRelativeTime,
  isSiemEligible,
  saveDestination,
  setDestinationEnabled,
  testDestination,
  validateForm,
  type DestinationForm,
  type FormErrors,
  type SiemDeliveryLogRow,
  type SiemDestination,
  type SiemProvider,
  type StatusTone,
  type TestResult,
} from '@/lib/siemStreaming';

const FIELD_CLASS =
  'w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60';
const BTN_BASE =
  'focus-ring inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60';
const BTN_PRIMARY = `${BTN_BASE} bg-accent text-white hover:bg-accent/90`;
const BTN_SECONDARY = `${BTN_BASE} border border-border bg-bg-primary text-text-primary hover:bg-bg-tertiary`;

const TONE_CLASS: Record<StatusTone, string> = {
  success: 'bg-success/10 text-success-500',
  warning: 'bg-warning-500/10 text-warning-500',
  danger: 'bg-danger-500/10 text-danger-500',
  neutral: 'bg-bg-tertiary text-text-secondary',
};

function Centered({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-16 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">{icon}</span>
      <h3 className="mt-4 text-lg font-semibold text-text-primary">{title}</h3>
      <div className="mt-1.5 max-w-md text-sm leading-relaxed text-text-secondary">{children}</div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      {[0, 1].map((i) => (
        <div key={i} className="h-36 animate-pulse rounded-2xl bg-bg-tertiary/60" />
      ))}
    </div>
  );
}

function StatusBadge({ destination }: { destination: SiemDestination }) {
  const s = describeStatus(destination);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${TONE_CLASS[s.tone]}`}>
      {s.tone === 'success' ? <CheckCircle2 size={13} aria-hidden="true" /> : s.tone === 'danger' || s.tone === 'warning' ? <AlertCircle size={13} aria-hidden="true" /> : null}
      {s.label}
    </span>
  );
}

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1.5 text-xs text-danger-500">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-text-secondary">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, errors: FormErrors, key: keyof FormErrors, hasHint: boolean): string | undefined {
  if (errors[key]) return `${id}-error`;
  return hasHint ? `${id}-hint` : undefined;
}

/* ------------------------------------------------------------------ */
/*  Delivery log                                                        */
/* ------------------------------------------------------------------ */

function DeliveryLog({ destinationId, refreshKey }: { destinationId: string; refreshKey: number }) {
  const [rows, setRows] = useState<SiemDeliveryLogRow[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    setRows(null);
    try {
      setRows(await fetchDeliveryLog(destinationId));
    } catch {
      setError(true);
    }
  }, [destinationId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (error) {
    return (
      <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-danger-500/30 bg-danger-500/5 px-3 py-2.5 text-sm text-danger-500">
        <span>Couldn’t load the delivery log.</span>
        <button type="button" onClick={() => void load()} className="focus-ring inline-flex items-center gap-1 rounded-lg px-2 py-1 font-medium underline">
          <RefreshCw size={13} aria-hidden="true" /> Retry
        </button>
      </div>
    );
  }
  if (rows === null) {
    return (
      <div className="space-y-2" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-9 animate-pulse rounded-lg bg-bg-tertiary/60" />
        ))}
      </div>
    );
  }
  if (rows.length === 0) return <p className="text-sm text-text-secondary">No deliveries yet. Entries appear here after the first events are sent or after a test.</p>;

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[520px] text-left text-xs">
        <thead className="bg-bg-tertiary/50 text-text-secondary">
          <tr>
            <th className="px-3 py-2 font-medium">When</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Result</th>
            <th className="px-3 py-2 font-medium">Events</th>
            <th className="px-3 py-2 font-medium">Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-border align-top">
              <td className="whitespace-nowrap px-3 py-2 text-text-secondary" title={new Date(r.created_at).toLocaleString()}>
                {formatRelativeTime(r.created_at)}
              </td>
              <td className="px-3 py-2 text-text-primary">{r.kind === 'test' ? 'Test' : 'Delivery'}</td>
              <td className={`px-3 py-2 font-medium ${r.status === 'ok' ? 'text-success-500' : 'text-danger-500'}`}>{r.status === 'ok' ? 'Delivered' : 'Failed'}</td>
              <td className="px-3 py-2 text-text-primary">
                {r.event_count.toLocaleString()}
                {r.dropped_count > 0 ? ` (+${r.dropped_count} rejected)` : ''}
              </td>
              <td className="px-3 py-2 text-text-secondary">{r.error ?? (r.http_status ? `HTTP ${r.http_status}` : '—')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Destination card                                                    */
/* ------------------------------------------------------------------ */

interface CardProps {
  destination: SiemDestination;
  busy: string | null;
  testResult: TestResult | undefined;
  logVersion: number;
  onTest: () => void;
  onSendNow: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function DestinationCard({ destination: d, busy, testResult, logVersion, onTest, onSendNow, onToggle, onEdit, onDelete }: CardProps) {
  const [showLog, setShowLog] = useState(false);
  const status = describeStatus(d);
  const severity = SEVERITY_OPTIONS.find((s) => s.value === d.min_severity)?.label ?? d.min_severity;
  const disabled = busy !== null;

  return (
    <li className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-semibold text-text-primary">{d.name}</h3>
            <StatusBadge destination={d} />
          </div>
          <p className="mt-1 break-all text-xs text-text-secondary">
            {PROVIDER_META[d.provider].label} · {destinationTarget(d)}
            {d.splunk_index ? ` · index ${d.splunk_index}` : ''}
          </p>
          <p className="mt-1.5 text-sm text-text-secondary">{status.hint}</p>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-text-secondary">Events sent</dt>
          <dd className="font-semibold text-text-primary">{Number(d.events_sent_total).toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-secondary">Rejected</dt>
          <dd className="font-semibold text-text-primary">{Number(d.events_dropped_total).toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-secondary">Last delivery</dt>
          <dd className="font-semibold text-text-primary">{formatRelativeTime(d.last_success_at)}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-secondary">Sends</dt>
          <dd className="font-semibold text-text-primary">{severity}</dd>
        </div>
      </dl>

      {d.last_error && d.status !== 'active' && (
        <div role="alert" className="mt-4 rounded-xl border border-danger-500/30 bg-danger-500/5 px-3 py-2.5 text-sm text-danger-500">
          <p className="font-medium">Last error {formatRelativeTime(d.last_error_at)}</p>
          <p className="mt-0.5 break-words text-xs">{d.last_error}</p>
        </div>
      )}

      {testResult && (
        <div
          role="status"
          className={`mt-4 rounded-xl border px-3 py-2.5 text-sm ${testResult.ok ? 'border-success-500/30 bg-success/5 text-success-500' : 'border-danger-500/30 bg-danger-500/5 text-danger-500'}`}
        >
          {testResult.ok
            ? `Test event delivered${testResult.duration_ms ? ` in ${testResult.duration_ms} ms` : ''}. Search for action "siem_test_event" in your SIEM.`
            : `Test failed: ${testResult.error ?? 'unknown error'}`}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className={BTN_SECONDARY} onClick={onTest} disabled={disabled} aria-label={`Send test event to ${d.name}`}>
          {busy === 'test' ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Send size={15} aria-hidden="true" />} Send test
        </button>
        <button
          type="button"
          className={BTN_SECONDARY}
          onClick={onSendNow}
          disabled={disabled || !d.enabled}
          aria-label={`Send now to ${d.name}`}
        >
          {busy === 'send' ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Zap size={15} aria-hidden="true" />} Send now
        </button>
        <button type="button" className={BTN_SECONDARY} onClick={onToggle} disabled={disabled} aria-label={`${d.enabled ? 'Pause' : 'Resume'} streaming to ${d.name}`}>
          {busy === 'toggle' ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : d.enabled ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
          {d.enabled ? 'Pause' : 'Resume'}
        </button>
        <button type="button" className={BTN_SECONDARY} onClick={onEdit} disabled={disabled} aria-label={`Edit ${d.name}`}>
          <Pencil size={15} aria-hidden="true" /> Edit
        </button>
        <button type="button" className={`${BTN_SECONDARY} text-danger-500`} onClick={onDelete} disabled={disabled} aria-label={`Delete ${d.name}`}>
          <Trash2 size={15} aria-hidden="true" /> Delete
        </button>
      </div>

      <button
        type="button"
        onClick={() => setShowLog((v) => !v)}
        aria-expanded={showLog}
        className="focus-ring mt-4 inline-flex items-center gap-1.5 rounded-lg text-sm font-medium text-accent"
      >
        <ChevronDown size={16} className={`transition-transform ${showLog ? 'rotate-180' : ''}`} aria-hidden="true" />
        {showLog ? 'Hide delivery log' : 'Show delivery log'}
      </button>
      {showLog && (
        <div className="mt-3">
          <DeliveryLog destinationId={d.id} refreshKey={logVersion} />
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/*  Form                                                                */
/* ------------------------------------------------------------------ */

interface FormPanelProps {
  editing: SiemDestination | null;
  onSaved: () => void;
  onCancel: () => void;
}

function FormPanel({ editing, onSaved, onCancel }: FormPanelProps) {
  const { toast } = useToast();
  const [form, setForm] = useState<DestinationForm>(() => (editing ? formFromDestination(editing) : EMPTY_FORM));
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const isEdit = Boolean(editing);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const set = <K extends keyof DestinationForm>(key: K, value: DestinationForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const found = validateForm(form, isEdit);
    setErrors(found);
    setServerError(null);
    if (Object.values(found).some(Boolean)) return;
    setSubmitting(true);
    try {
      await saveDestination(form, editing?.id);
      toast(isEdit ? 'Destination updated.' : 'Destination added. Send a test event to verify it.', 'success');
      onSaved();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const meta = PROVIDER_META[form.provider];

  return (
    <form onSubmit={submit} noValidate aria-label={isEdit ? 'Edit destination' : 'Add destination'} className="rounded-2xl border border-accent/30 bg-bg-secondary p-4 shadow-card dark:shadow-card-dark sm:p-6">
      <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold text-text-primary focus:outline-none">
        {isEdit ? `Edit ${editing?.name}` : 'Add a destination'}
      </h2>

      <fieldset className="mt-4" disabled={isEdit || submitting}>
        <legend className="mb-1.5 text-sm font-medium text-text-primary">Provider</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(Object.keys(PROVIDER_META) as SiemProvider[]).map((p) => (
            <label
              key={p}
              className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 text-sm ${form.provider === p ? 'border-accent bg-accent/5' : 'border-border bg-bg-primary'} ${isEdit ? 'cursor-not-allowed opacity-70' : ''}`}
            >
              <input type="radio" name="siem-provider" value={p} checked={form.provider === p} onChange={() => set('provider', p)} className="mt-0.5" />
              <span>
                <span className="block font-medium text-text-primary">{PROVIDER_META[p].label}</span>
                <span className="block text-xs text-text-secondary">{PROVIDER_META[p].description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field id="siem-name" label="Name" error={errors.name} hint="Shown in this list and in your audit log.">
          <input
            id="siem-name"
            className={FIELD_CLASS}
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            maxLength={80}
            placeholder="Production SIEM"
            aria-invalid={Boolean(errors.name)}
            aria-describedby={describedBy('siem-name', errors, 'name', true)}
            disabled={submitting}
          />
        </Field>

        <Field id="siem-severity" label="Events to send" hint={SEVERITY_OPTIONS.find((s) => s.value === form.minSeverity)?.hint}>
          <select id="siem-severity" className={FIELD_CLASS} value={form.minSeverity} onChange={(e) => set('minSeverity', e.target.value as DestinationForm['minSeverity'])} disabled={submitting} aria-describedby="siem-severity-hint">
            {SEVERITY_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>

        {form.provider === 'splunk_hec' ? (
          <>
            <div className="sm:col-span-2">
              <Field id="siem-url" label="HEC URL" error={errors.url} hint="e.g. https://http-inputs-acme.splunkcloud.com:443 — the /services/collector/event path is added for you.">
                <input
                  id="siem-url"
                  className={FIELD_CLASS}
                  value={form.url}
                  onChange={(e) => set('url', e.target.value)}
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://splunk.example.com:8088"
                  aria-invalid={Boolean(errors.url)}
                  aria-describedby={describedBy('siem-url', errors, 'url', true)}
                  disabled={submitting}
                />
              </Field>
            </div>
            <Field id="siem-index" label="Index (optional)" error={errors.index} hint="Leave empty to use the token’s default index.">
              <input id="siem-index" className={FIELD_CLASS} value={form.index} onChange={(e) => set('index', e.target.value)} autoComplete="off" spellCheck={false} aria-invalid={Boolean(errors.index)} aria-describedby={describedBy('siem-index', errors, 'index', true)} disabled={submitting} />
            </Field>
            <Field id="siem-sourcetype" label="Sourcetype (optional)" error={errors.sourcetype} hint="Defaults to vireek:audit.">
              <input id="siem-sourcetype" className={FIELD_CLASS} value={form.sourcetype} onChange={(e) => set('sourcetype', e.target.value)} autoComplete="off" spellCheck={false} aria-invalid={Boolean(errors.sourcetype)} aria-describedby={describedBy('siem-sourcetype', errors, 'sourcetype', true)} disabled={submitting} />
            </Field>
          </>
        ) : (
          <div className="sm:col-span-2">
            <Field id="siem-site" label="Datadog site" error={errors.site} hint="Choose the site shown in your Datadog URL.">
              <select id="siem-site" className={FIELD_CLASS} value={form.site} onChange={(e) => set('site', e.target.value)} aria-invalid={Boolean(errors.site)} aria-describedby={describedBy('siem-site', errors, 'site', true)} disabled={submitting}>
                {DATADOG_SITES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}

        <div className="sm:col-span-2">
          <Field
            id="siem-secret"
            label={meta.tokenLabel}
            error={errors.secret}
            hint={isEdit ? 'Leave blank to keep the current one. Stored encrypted; it can never be viewed again.' : 'Stored encrypted; it can never be viewed again.'}
          >
            <input
              id="siem-secret"
              type="password"
              className={FIELD_CLASS}
              value={form.secret}
              onChange={(e) => set('secret', e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={isEdit ? '••••••••••••' : ''}
              aria-invalid={Boolean(errors.secret)}
              aria-describedby={describedBy('siem-secret', errors, 'secret', true)}
              disabled={submitting}
            />
          </Field>
        </div>
      </div>

      {serverError && (
        <div role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-danger-500/30 bg-danger-500/5 px-3 py-2.5 text-sm text-danger-500">
          <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{serverError}</span>
        </div>
      )}

      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" className={BTN_SECONDARY} onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" className={BTN_PRIMARY} disabled={submitting}>
          {submitting && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
          {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Add destination'}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                                */
/* ------------------------------------------------------------------ */

export function SiemStreamingPage() {
  const { isOwner, profile } = useAuth();
  const { toast } = useToast();
  const eligible = isSiemEligible(profile?.plan, isOwner);

  const [destinations, setDestinations] = useState<SiemDestination[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState<null | 'new' | string>(null);
  const [busy, setBusy] = useState<{ id: string; action: string } | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [deleteTarget, setDeleteTarget] = useState<SiemDestination | null>(null);
  const [logVersion, setLogVersion] = useState(0);
  const ticket = useRef(0);

  const load = useCallback(async () => {
    const mine = ++ticket.current;
    setError(null);
    try {
      const rows = await fetchDestinations();
      if (mine === ticket.current) setDestinations(rows);
    } catch {
      if (mine === ticket.current) setError('We couldn’t load your destinations.');
    } finally {
      if (mine === ticket.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOwner || !eligible) {
      setLoading(false);
      return;
    }
    void load();
  }, [isOwner, eligible, load]);

  const run = async (id: string, action: string, fn: () => Promise<void>) => {
    setBusy({ id, action });
    try {
      await fn();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Something went wrong. Please try again.', 'error');
    } finally {
      setBusy(null);
      setLogVersion((v) => v + 1);
    }
  };

  if (!isOwner) {
    return (
      <DashboardLayout activeLabel="Settings">
        <Centered icon={<ShieldCheck size={26} />} title="Owner access only">
          SIEM streaming sends sensitive security events to external systems, so only the account owner can configure it.
        </Centered>
      </DashboardLayout>
    );
  }

  if (!eligible) {
    return (
      <DashboardLayout activeLabel="Settings">
        <BackButton fallback="/dashboard/settings" />
        <Centered icon={<Lock size={26} />} title="Available on Business and Enterprise">
          <p>Stream your audit and security events to Splunk or Datadog in near real time.</p>
          <Link to="/dashboard/billing/plans" className={`${BTN_PRIMARY} mt-5`}>
            Compare plans
          </Link>
        </Centered>
      </DashboardLayout>
    );
  }

  const editing = formOpen && formOpen !== 'new' ? destinations.find((d) => d.id === formOpen) ?? null : null;
  const atLimit = destinations.length >= MAX_DESTINATIONS;

  return (
    <DashboardLayout activeLabel="Settings">
      <div className="mx-auto max-w-4xl">
        <BackButton fallback="/dashboard/settings" />
        <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">SIEM log streaming</h1>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">
              Send your audit and security events to Splunk or Datadog within about a minute. Secrets are redacted before leaving Vireek, and nothing is lost if your SIEM is down — delivery
              resumes from where it stopped.
            </p>
          </div>
          {!loading && !error && formOpen === null && (
            <button type="button" className={BTN_PRIMARY} onClick={() => setFormOpen('new')} disabled={atLimit} title={atLimit ? `Up to ${MAX_DESTINATIONS} destinations` : undefined}>
              <Plus size={16} aria-hidden="true" /> Add destination
            </button>
          )}
        </div>

        <div className="mt-6 space-y-4">
          {formOpen !== null && (
            <FormPanel
              key={formOpen}
              editing={editing}
              onCancel={() => setFormOpen(null)}
              onSaved={() => {
                setFormOpen(null);
                setLoading(true);
                void load();
              }}
            />
          )}

          {loading ? (
            <Skeleton />
          ) : error ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-danger-500/30 bg-danger-500/5 px-4 py-4 text-sm text-danger-500">
              <span className="flex items-center gap-2">
                <AlertCircle size={16} aria-hidden="true" /> {error}
              </span>
              <button
                type="button"
                className={BTN_SECONDARY}
                onClick={() => {
                  setLoading(true);
                  void load();
                }}
              >
                <RefreshCw size={15} aria-hidden="true" /> Try again
              </button>
            </div>
          ) : destinations.length === 0 ? (
            formOpen === null && (
              <Centered icon={<Send size={26} />} title="No destinations yet">
                <p>Connect your SIEM to keep a tamper-resistant copy of sign-ins, role changes, exports and other security events.</p>
                <button type="button" className={`${BTN_PRIMARY} mt-5`} onClick={() => setFormOpen('new')}>
                  <Plus size={16} aria-hidden="true" /> Add your first destination
                </button>
              </Centered>
            )
          ) : (
            <ul className="space-y-4" aria-label="SIEM destinations">
              {destinations.map((d) => (
                <DestinationCard
                  key={d.id}
                  destination={d}
                  busy={busy?.id === d.id ? busy.action : busy ? 'other' : null}
                  testResult={testResults[d.id]}
                  logVersion={logVersion}
                  onEdit={() => setFormOpen(d.id)}
                  onDelete={() => setDeleteTarget(d)}
                  onTest={() =>
                    void run(d.id, 'test', async () => {
                      const res = await testDestination(d.id);
                      setTestResults((r) => ({ ...r, [d.id]: res }));
                    })
                  }
                  onSendNow={() =>
                    void run(d.id, 'send', async () => {
                      const res = await deliverNow(d.id);
                      if (res.ok) toast(res.sent ? `Sent ${res.sent.toLocaleString()} events.` : 'Everything is already up to date.', 'success');
                      else toast(res.error ?? 'Delivery failed.', 'error');
                      await load();
                    })
                  }
                  onToggle={() =>
                    void run(d.id, 'toggle', async () => {
                      await setDestinationEnabled(d.id, !d.enabled);
                      toast(d.enabled ? 'Streaming paused.' : 'Streaming resumed.', 'success');
                      await load();
                    })
                  }
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this destination?"
        description={`Events will stop streaming to “${deleteTarget?.name ?? ''}”. Its stored token and delivery log are removed. Your audit log is not affected.`}
        confirmPhrase="delete this destination"
        confirmLabel="Delete destination"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (!target) return;
          await run(target.id, 'delete', async () => {
            await deleteDestination(target.id);
            toast('Destination deleted.', 'success');
            await load();
          });
        }}
      />
    </DashboardLayout>
  );
}
