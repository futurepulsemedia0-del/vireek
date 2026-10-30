import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileDown,
  Loader2,
  ShieldCheck,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import {
  CATEGORY_LABELS,
  CERT_TYPE_LABELS,
  REFRIGERANT_CODES,
  certTypeFromCredential,
  fetchEquipmentLog,
  type CredentialLike,
} from '@/lib/refrigerantCompliance';
import {
  CLOSE_REASON_LABELS,
  LEGAL_NOTICE,
  METHOD_LABELS,
  NEXT_ACTION_LABELS,
  TEST_KIND_LABELS,
  approveRetrofitPlan,
  checkTestSigner,
  completeInspection,
  completeRetrofitPlan,
  fetchLeakCaseDetail,
  fetchUnitAld,
  followUpTestDueOn,
  isLive,
  saveRetrofitPlan,
  setAldFlag,
  signVerificationTest,
  utcDay,
  validateTest,
  voidLeakCase,
  type LeakCase,
  type LeakCaseDetail as Detail,
  type LeakInspection,
  type PlanOption,
  type TestMethod,
  type TestResult,
  type UnitAld,
  type VerificationKind,
} from '@/lib/leakRepair';
import {
  StatusBadge,
  UrgencyBadge,
  btnDanger,
  btnGhost,
  btnPrimary,
  fmtDateTime,
  fmtDay,
  inputClass,
  unitTitle,
} from '@/components/leak/leakUi';

export interface TechOption {
  id: string;
  member_name: string | null;
  member_email: string | null;
}

interface Props {
  c: LeakCase;
  allCases: LeakCase[];
  techs: TechOption[];
  creds: CredentialLike[];
  /** team_members.id of the signed-in technician, if they are one (they can only sign for themselves). */
  selfTechId: string | null;
  canManage: boolean;
  isOwner: boolean;
  businessName: string | null;
  onChanged: () => void;
  onClose: () => void;
}

const toLocalInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

const STEPS: { key: string; label: string }[] = [
  { key: 'open', label: 'Repair + first test' },
  { key: 'initial_verified', label: 'Follow-up test' },
  { key: 'followup_scheduled', label: 'Inspections' },
  { key: 'closed', label: 'Closed' },
];

function stepIndex(c: LeakCase): number {
  switch (c.status) {
    case 'open':
      return 0;
    case 'initial_verified':
      return 1;
    case 'verified':
    case 'followup_scheduled':
      return 2;
    case 'closed':
      return 3;
    default:
      return -1;
  }
}

export function LeakCaseDetail({
  c,
  allCases,
  techs,
  creds,
  selfTechId,
  canManage,
  isOwner,
  businessName,
  onChanged,
  onClose,
}: Props) {
  const { toast } = useToast();
  const dialogRef = useFocusTrap(true);
  useEscapeToClose(true, onClose);

  const [detail, setDetail] = useState<Detail | null>(null);
  const [ald, setAld] = useState<UnitAld | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmVoid, setConfirmVoid] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [confirmFail, setConfirmFail] = useState<null | (() => Promise<void>)>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(null);
    try {
      const [d, a] = await Promise.all([
        fetchLeakCaseDetail(c.id),
        c.equipment_id ? fetchUnitAld(c.equipment_id) : Promise.resolve(null),
      ]);
      setDetail(d);
      setAld(a);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'Could not load this case.');
    } finally {
      setLoading(false);
    }
  }, [c.id, c.equipment_id]);

  useEffect(() => {
    void load();
  }, [load, c.status]);

  const run = async (key: string, fn: () => Promise<void>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast(ok, 'success');
      onChanged();
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That did not work.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const live = isLive(c.status);
  const idx = stepIndex(c);
  const testKind: VerificationKind | null =
    c.status === 'open' ? 'initial' : c.status === 'initial_verified' ? 'followup' : null;

  const downloadPdf = async () => {
    setBusy('pdf');
    try {
      const sameUnit = c.equipment_id
        ? allCases.filter((x) => x.equipment_id === c.equipment_id)
        : [c];
      const [pdf, details, ledger] = await Promise.all([
        import('@/lib/leakReportPdf'),
        Promise.all(
          sameUnit.map((x) =>
            x.id === c.id && detail ? Promise.resolve(detail) : fetchLeakCaseDetail(x.id),
          ),
        ),
        c.equipment_id ? fetchEquipmentLog([c.equipment_id]) : Promise.resolve([]),
      ]);
      const blob = await pdf.generateLeakReportPdf({
        businessName,
        unit: {
          label: c.equipment_label,
          serial: c.equipment_serial,
          site: c.site_address,
          customer: c.customer_name,
          refrigerant: c.refrigerant_type,
          chargeLbs: c.charge_lbs,
          category: CATEGORY_LABELS[c.appliance_category],
        },
        cases: sameUnit.map((x, i) => ({ case: x, detail: details[i] })),
        ledger,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = pdf.leakReportFilename(c.equipment_serial ?? c.equipment_label);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast('Report downloaded.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not build the report.', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={dialogRef as React.RefObject<HTMLDivElement>}
        role="dialog"
        aria-modal="true"
        aria-label={`Leak case for ${unitTitle(c)}`}
        className="flex h-full w-full flex-col overflow-hidden bg-bg-primary shadow-2xl sm:max-w-xl"
      >
        <header className="flex items-start gap-3 border-b border-border p-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-bold text-text-primary">{unitTitle(c)}</h2>
            <p className="truncate text-xs text-text-secondary">
              {[c.customer_name, c.site_address].filter(Boolean).join(' · ') || '—'}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusBadge status={c.status} />
              <UrgencyBadge c={c} />
              {c.chronic_flagged_at && (
                <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger">
                  <AlertTriangle size={11} aria-hidden="true" /> Chronic leaker
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-text-secondary hover:bg-bg-tertiary"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {/* Facts */}
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Fact label="Leak rate" value={`${c.rate_pct}% (limit ${c.threshold_pct}%)`} />
            <Fact label="Full charge" value={`${c.charge_lbs} lb ${c.refrigerant_type ?? ''}`} />
            <Fact label="Category" value={CATEGORY_LABELS[c.appliance_category]} />
            <Fact label="Repair due" value={fmtDay(c.repair_due_at)} />
            <Fact label="Detected" value={fmtDateTime(c.detected_at)} />
            <Fact label="Records kept until" value={fmtDay(c.retain_until)} />
          </dl>

          {/* Next action */}
          {live && c.next_action && c.next_action_due_at && (
            <div className="rounded-xl border border-border bg-bg-secondary p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
                Next action
              </p>
              <p className="mt-0.5 text-sm font-medium text-text-primary">
                {NEXT_ACTION_LABELS[c.next_action]}
              </p>
              <p className="text-xs text-text-secondary">Due {fmtDay(c.next_action_due_at)}</p>
            </div>
          )}
          {c.status === 'closed' && c.close_reason && (
            <p className="flex items-center gap-2 rounded-xl bg-success-500/10 p-3 text-sm text-success-500">
              <CheckCircle2 size={16} aria-hidden="true" /> Closed {fmtDay(c.closed_at)} —{' '}
              {CLOSE_REASON_LABELS[c.close_reason]}
            </p>
          )}
          {c.status === 'voided' && (
            <p className="rounded-xl bg-bg-tertiary p-3 text-sm text-text-secondary">
              Voided {fmtDay(c.voided_at)}: {c.void_reason}
            </p>
          )}

          {/* Stepper */}
          {idx >= 0 && (
            <ol className="grid grid-cols-4 gap-1" aria-label="Case progress">
              {STEPS.map((s, i) => (
                <li key={s.key} className="min-w-0" aria-current={i === idx ? 'step' : undefined}>
                  <div
                    className={`h-1.5 rounded-full ${i <= idx ? 'bg-accent' : 'bg-bg-tertiary'}`}
                  />
                  <p
                    className={`mt-1 truncate text-[11px] ${i === idx ? 'font-semibold text-text-primary' : 'text-text-secondary'}`}
                  >
                    {s.label}
                  </p>
                </li>
              ))}
            </ol>
          )}

          {loading ? (
            <div className="space-y-3" aria-busy="true">
              <div className="h-24 animate-pulse rounded-xl bg-bg-tertiary" />
              <div className="h-24 animate-pulse rounded-xl bg-bg-tertiary" />
            </div>
          ) : failed ? (
            <div
              role="alert"
              className="rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger"
            >
              {failed}{' '}
              <button type="button" className="font-semibold underline" onClick={() => void load()}>
                Try again
              </button>
            </div>
          ) : (
            detail && (
              <>
                {testKind && (
                  <SignTestForm
                    c={c}
                    kind={testKind}
                    techs={techs}
                    creds={creds}
                    selfTechId={selfTechId}
                    busy={busy === 'sign'}
                    onSubmit={(form) => {
                      const go = () =>
                        run(
                          'sign',
                          () => signVerificationTest(c.id, form),
                          form.result === 'fail'
                            ? 'Failed test recorded — retrofit plan drafted.'
                            : 'Test signed.',
                        );
                      if (form.result === 'fail') setConfirmFail(() => go);
                      else void go();
                    }}
                  />
                )}

                <Section
                  title="Signed verification tests"
                  empty="No tests signed yet."
                  isEmpty={detail.tests.length === 0}
                >
                  {detail.tests.map((t) => (
                    <li
                      key={t.id}
                      className="rounded-xl border border-border bg-bg-secondary p-3 text-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium text-text-primary">
                          {TEST_KIND_LABELS[t.kind]}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${t.result === 'pass' ? 'bg-success-500/10 text-success-500' : 'bg-danger/10 text-danger'}`}
                        >
                          {t.result === 'pass' ? 'PASS' : 'FAIL'}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-text-secondary">
                        {fmtDateTime(t.performed_at)} · {METHOD_LABELS[t.method]} ·{' '}
                        {t.on_time ? 'on time' : 'LATE'}
                      </p>
                      <p className="text-xs text-text-secondary">
                        <ShieldCheck size={12} className="mr-1 inline" aria-hidden="true" />
                        {t.technician_name ?? 'Technician'} ·{' '}
                        {CERT_TYPE_LABELS[certTypeFromCredential(t.cert_type) ?? 'unspecified']}
                        {t.cert_number ? ` #${t.cert_number}` : ''}
                      </p>
                      {t.notes && <p className="mt-1 text-xs text-text-secondary">{t.notes}</p>}
                    </li>
                  ))}
                </Section>

                {(detail.inspections.length > 0 || c.status === 'followup_scheduled') && (
                  <Section title="Follow-up inspections" empty="" isEmpty={false}>
                    {detail.inspections.map((i) => (
                      <InspectionRow
                        key={i.id}
                        i={i}
                        techs={techs}
                        selfTechId={selfTechId}
                        caseLive={c.status === 'followup_scheduled'}
                        busy={busy === `insp-${i.id}`}
                        onResult={(result, techId, notes) => {
                          const go = () =>
                            run(
                              `insp-${i.id}`,
                              () => completeInspection(i.id, result, techId, notes),
                              result === 'fail'
                                ? 'Failed inspection recorded — retrofit plan drafted.'
                                : 'Inspection recorded.',
                            );
                          if (result === 'fail') setConfirmFail(() => go);
                          else void go();
                        }}
                      />
                    ))}
                  </Section>
                )}

                {detail.plan && (
                  <RetrofitPanel
                    plan={detail.plan}
                    canManage={canManage}
                    busy={busy}
                    onSave={(opt, ref, notes) =>
                      run('plan-save', () => saveRetrofitPlan(c.id, opt, ref, notes), 'Plan saved.')
                    }
                    onApprove={() =>
                      run('plan-approve', () => approveRetrofitPlan(c.id), 'Plan approved.')
                    }
                    onComplete={(on, notes) =>
                      run(
                        'plan-complete',
                        () => completeRetrofitPlan(c.id, on, notes),
                        'Case closed.',
                      )
                    }
                  />
                )}

                {canManage && c.equipment_id && live && (
                  <AldPanel
                    ald={ald}
                    busy={busy === 'ald'}
                    onSave={(on, date) =>
                      run(
                        'ald',
                        () => setAldFlag(c.equipment_id as string, on, date),
                        on ? 'ALD flag set.' : 'ALD flag cleared.',
                      )
                    }
                  />
                )}

                <Section
                  title="Timeline"
                  empty="No events yet."
                  isEmpty={detail.events.length === 0}
                >
                  {detail.events.map((e) => (
                    <li key={e.id} className="border-l-2 border-border pl-3 text-sm">
                      <p className="font-medium capitalize text-text-primary">
                        {e.event_type.replace(/_/g, ' ')}
                      </p>
                      <p className="text-xs text-text-secondary">{fmtDateTime(e.created_at)}</p>
                      {e.detail && <p className="text-xs text-text-secondary">{e.detail}</p>}
                    </li>
                  ))}
                </Section>
              </>
            )
          )}

          <p className="text-[11px] leading-relaxed text-text-secondary">{LEGAL_NOTICE}</p>
        </div>

        <footer className="flex flex-wrap gap-2 border-t border-border p-3">
          <button
            type="button"
            className={btnGhost}
            onClick={() => void downloadPdf()}
            disabled={busy === 'pdf'}
          >
            {busy === 'pdf' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <FileDown size={14} />
            )}{' '}
            Owner report (PDF)
          </button>
          {isOwner && live && !confirmVoid && (
            <button
              type="button"
              className={`${btnDanger} ml-auto`}
              onClick={() => setConfirmVoid(true)}
            >
              Void case
            </button>
          )}
          {isOwner && live && confirmVoid && (
            <div className="flex w-full flex-col gap-2 rounded-xl border border-danger/30 bg-danger/5 p-3">
              <p className="text-xs text-text-secondary">
                Use only when the case was opened from wrong data. It stays in the record with your
                reason; pending inspections and plans are cancelled.
              </p>
              <input
                className={inputClass}
                value={voidReason}
                maxLength={300}
                placeholder="Reason for voiding (5+ characters)"
                aria-label="Reason for voiding"
                onChange={(e) => setVoidReason(e.target.value)}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  className={btnDanger}
                  disabled={voidReason.trim().length < 5 || busy === 'void'}
                  onClick={async () => {
                    await run('void', () => voidLeakCase(c.id, voidReason), 'Case voided.');
                    setConfirmVoid(false);
                    onClose();
                  }}
                >
                  {busy === 'void' && <Loader2 size={14} className="animate-spin" />} Confirm void
                </button>
                <button type="button" className={btnGhost} onClick={() => setConfirmVoid(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </footer>
      </div>

      <ConfirmDialog
        open={confirmFail !== null}
        title="Record a failed result?"
        description="A failed test or inspection means the repair did not hold. The case moves to “repair failed” and a retrofit / retire plan draft is created, due in 30 days."
        confirmLabel="Record failure"
        onCancel={() => setConfirmFail(null)}
        onConfirm={async () => {
          const go = confirmFail;
          setConfirmFail(null);
          if (go) await go();
        }}
      />
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-text-secondary">{label}</dt>
      <dd className="truncate font-medium text-text-primary">{value}</dd>
    </div>
  );
}

function Section({
  title,
  empty,
  isEmpty,
  children,
}: {
  title: string;
  empty: string;
  isEmpty: boolean;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title}>
      <h3 className="mb-2 text-sm font-semibold text-text-primary">{title}</h3>
      {isEmpty ? (
        <p className="rounded-xl border border-dashed border-border p-3 text-sm text-text-secondary">
          {empty}
        </p>
      ) : (
        <ul className="space-y-2">{children}</ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function SignTestForm({
  c,
  kind,
  techs,
  creds,
  selfTechId,
  busy,
  onSubmit,
}: {
  c: LeakCase;
  kind: VerificationKind;
  techs: TechOption[];
  creds: CredentialLike[];
  selfTechId: string | null;
  busy: boolean;
  onSubmit: (t: {
    kind: VerificationKind;
    result: TestResult;
    performedAt: string;
    technicianId: string;
    method: TestMethod;
    notes: string;
    normalOperationOn: string | null;
  }) => void;
}) {
  const [techId, setTechId] = useState(selfTechId ?? '');
  const [when, setWhen] = useState(() => toLocalInput(new Date()));
  const [method, setMethod] = useState<TestMethod | ''>('');
  const [result, setResult] = useState<TestResult>('pass');
  const [notes, setNotes] = useState('');
  const [normalOn, setNormalOn] = useState('');

  const performedAt = useMemo(() => (when ? new Date(when) : new Date(NaN)), [when]);
  const validDate = !Number.isNaN(performedAt.getTime());
  const cert = useMemo(
    () => (validDate ? checkTestSigner(creds, techId || null, performedAt, c.charge_lbs) : null),
    [creds, techId, performedAt, validDate, c.charge_lbs],
  );
  const errors = validateTest(
    {
      kind,
      result,
      technicianId: techId,
      method,
      performedAt: validDate ? performedAt.toISOString() : '',
      normalOperationOn: normalOn || null,
    },
    c,
  );
  const dueFollow =
    kind === 'initial' && validDate
      ? followUpTestDueOn(utcDay(performedAt), normalOn || null)
      : null;
  const canSubmit = errors.length === 0 && cert?.ok === true && !busy;
  const available = selfTechId ? techs.filter((t) => t.id === selfTechId) : techs;

  return (
    <form
      className="space-y-3 rounded-xl border border-accent/30 bg-accent/5 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit || !method) return;
        onSubmit({
          kind,
          result,
          performedAt: performedAt.toISOString(),
          technicianId: techId,
          method,
          notes,
          normalOperationOn: normalOn || null,
        });
      }}
    >
      <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <Wrench size={14} aria-hidden="true" /> Sign: {TEST_KIND_LABELS[kind]}
      </h3>
      <p className="text-xs text-text-secondary">
        {kind === 'initial'
          ? `Must be done inside the repair window (by ${fmtDay(c.repair_due_at)}).`
          : `Due ${fmtDay(c.followup_test_due_on)} — within 10 days of the first test or of return to normal operation.`}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-text-secondary">
          Technician (signs)
          <select
            className={`${inputClass} mt-1`}
            value={techId}
            onChange={(e) => setTechId(e.target.value)}
          >
            <option value="">Choose…</option>
            {available.map((t) => (
              <option key={t.id} value={t.id}>
                {t.member_name ?? t.member_email}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-text-secondary">
          Date and time of test
          <input
            type="datetime-local"
            className={`${inputClass} mt-1`}
            value={when}
            max={toLocalInput(new Date())}
            onChange={(e) => setWhen(e.target.value)}
          />
        </label>
        <label className="text-xs text-text-secondary">
          Method
          <select
            className={`${inputClass} mt-1`}
            value={method}
            onChange={(e) => setMethod(e.target.value as TestMethod)}
          >
            <option value="">Choose…</option>
            {(Object.keys(METHOD_LABELS) as TestMethod[]).map((m) => (
              <option key={m} value={m}>
                {METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="text-xs text-text-secondary">
          <legend>Result</legend>
          <div className="mt-1 flex gap-2">
            {(['pass', 'fail'] as const).map((r) => (
              <label
                key={r}
                className={`flex min-h-[40px] flex-1 cursor-pointer items-center justify-center gap-1 rounded-lg border px-3 text-sm font-medium ${result === r ? (r === 'pass' ? 'border-success-500 bg-success-500/10 text-success-500' : 'border-danger bg-danger/10 text-danger') : 'border-border text-text-secondary'}`}
              >
                <input
                  type="radio"
                  name="result"
                  className="sr-only"
                  checked={result === r}
                  onChange={() => setResult(r)}
                />
                {r === 'pass' ? (
                  <CheckCircle2 size={14} aria-hidden="true" />
                ) : (
                  <XCircle size={14} aria-hidden="true" />
                )}{' '}
                {r === 'pass' ? 'Pass' : 'Fail'}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      {kind === 'initial' && (
        <label className="block text-xs text-text-secondary">
          System back to normal operation on (only if it was shut down)
          <input
            type="date"
            className={`${inputClass} mt-1`}
            value={normalOn}
            onChange={(e) => setNormalOn(e.target.value)}
          />
        </label>
      )}
      {dueFollow && result === 'pass' && (
        <p className="text-xs text-text-secondary">
          Follow-up test will be due {fmtDay(dueFollow)}.
        </p>
      )}
      <label className="block text-xs text-text-secondary">
        Notes (optional)
        <textarea
          className={`${inputClass} mt-1`}
          rows={2}
          maxLength={2000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>

      {techId && cert && !cert.ok && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-danger/10 p-2 text-xs text-danger"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" /> {cert.reason}{' '}
          The server will refuse this signature.
        </p>
      )}
      {cert?.ok &&
        cert.warnings.map((w) => (
          <p key={w} className="text-xs text-warning-500">
            {w}
          </p>
        ))}
      {errors.length > 0 && method !== '' && techId !== '' && (
        <ul className="text-xs text-danger">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <button type="submit" className={btnPrimary} disabled={!canSubmit || !method}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />} Sign
        test
      </button>
    </form>
  );
}

function InspectionRow({
  i,
  techs,
  selfTechId,
  caseLive,
  busy,
  onResult,
}: {
  i: LeakInspection;
  techs: TechOption[];
  selfTechId: string | null;
  caseLive: boolean;
  busy: boolean;
  onResult: (r: TestResult, techId: string | null, notes: string) => void;
}) {
  const [techId, setTechId] = useState(selfTechId ?? '');
  const [notes, setNotes] = useState('');
  const [open, setOpen] = useState(false);
  const tone =
    i.status === 'completed'
      ? 'text-success-500'
      : i.status === 'failed'
        ? 'text-danger'
        : i.status === 'scheduled'
          ? 'text-text-primary'
          : 'text-text-secondary';
  return (
    <li className="rounded-xl border border-border bg-bg-secondary p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-text-primary">
          #{i.period_index} · {i.cadence} · due {fmtDay(i.due_date)}
        </span>
        <span className={`text-xs font-semibold uppercase ${tone}`}>{i.status}</span>
      </div>
      {i.status === 'scheduled' && (
        <p className="text-xs text-text-secondary">
          {i.job_id
            ? 'Job created on the schedule.'
            : 'Job is created automatically 30 days before the due date.'}
        </p>
      )}
      {i.waived_reason && <p className="text-xs text-text-secondary">{i.waived_reason}</p>}
      {i.completed_at && (
        <p className="text-xs text-text-secondary">
          {fmtDateTime(i.completed_at)} · {i.technician_name ?? '—'} {i.notes ? `· ${i.notes}` : ''}
        </p>
      )}
      {caseLive && i.status === 'scheduled' && (
        <div className="mt-2">
          {!open ? (
            <button type="button" className={btnGhost} onClick={() => setOpen(true)}>
              Record result
            </button>
          ) : (
            <div className="space-y-2">
              <select
                className={inputClass}
                value={techId}
                onChange={(e) => setTechId(e.target.value)}
                aria-label="Technician"
              >
                <option value="">Technician (optional)…</option>
                {(selfTechId ? techs.filter((t) => t.id === selfTechId) : techs).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.member_name ?? t.member_email}
                  </option>
                ))}
              </select>
              <input
                className={inputClass}
                placeholder="Notes (optional)"
                maxLength={2000}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  className={btnPrimary}
                  disabled={busy}
                  onClick={() => onResult('pass', techId || null, notes)}
                >
                  {busy ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <CheckCircle2 size={14} />
                  )}{' '}
                  No leak found
                </button>
                <button
                  type="button"
                  className={btnDanger}
                  disabled={busy}
                  onClick={() => onResult('fail', techId || null, notes)}
                >
                  <XCircle size={14} /> Leak found
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function RetrofitPanel({
  plan,
  canManage,
  busy,
  onSave,
  onApprove,
  onComplete,
}: {
  plan: NonNullable<Detail['plan']>;
  canManage: boolean;
  busy: string | null;
  onSave: (opt: PlanOption | null, refrigerant: string, notes: string) => void;
  onApprove: () => void;
  onComplete: (on: string, notes: string) => void;
}) {
  const [option, setOption] = useState<PlanOption | ''>(plan.option ?? '');
  const [ref, setRef] = useState(plan.proposed_refrigerant ?? '');
  const [notes, setNotes] = useState(plan.notes ?? '');
  const [doneOn, setDoneOn] = useState(utcDay(new Date()));
  const draft = plan.status === 'draft';
  return (
    <section
      aria-label="Retrofit or retire plan"
      className="space-y-3 rounded-xl border border-danger/30 bg-danger/5 p-3"
    >
      <h3 className="text-sm font-semibold text-text-primary">
        Retrofit / retire plan — {plan.status}
      </h3>
      <p className="text-xs text-text-secondary">
        Draft due {fmtDay(plan.plan_due_on)}. The retrofit or retirement must be completed by{' '}
        {fmtDay(plan.complete_by)}.
      </p>
      {canManage && draft ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-text-secondary">
              Plan
              <select
                className={`${inputClass} mt-1`}
                value={option}
                onChange={(e) => setOption(e.target.value as PlanOption | '')}
              >
                <option value="">Choose…</option>
                <option value="retrofit">Retrofit (new refrigerant / components)</option>
                <option value="retire">Retire the appliance</option>
              </select>
            </label>
            {option === 'retrofit' && (
              <label className="text-xs text-text-secondary">
                Proposed refrigerant
                <input
                  className={`${inputClass} mt-1`}
                  list="leak-refrigerants"
                  value={ref}
                  maxLength={40}
                  onChange={(e) => setRef(e.target.value)}
                />
                <datalist id="leak-refrigerants">
                  {REFRIGERANT_CODES.map((r) => (
                    <option key={r} value={r} />
                  ))}
                </datalist>
              </label>
            )}
          </div>
          <label className="block text-xs text-text-secondary">
            Notes
            <textarea
              className={`${inputClass} mt-1`}
              rows={2}
              maxLength={2000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={btnGhost}
              disabled={busy === 'plan-save'}
              onClick={() => onSave(option || null, ref, notes)}
            >
              {busy === 'plan-save' && <Loader2 size={14} className="animate-spin" />} Save draft
            </button>
            <button
              type="button"
              className={btnPrimary}
              disabled={!option || busy === 'plan-approve'}
              onClick={() => onApprove()}
            >
              {busy === 'plan-approve' && <Loader2 size={14} className="animate-spin" />} Approve
              plan
            </button>
          </div>
        </>
      ) : (
        <p className="text-sm text-text-primary">
          {plan.option
            ? plan.option === 'retire'
              ? 'Retire the appliance'
              : `Retrofit${plan.proposed_refrigerant ? ` to ${plan.proposed_refrigerant}` : ''}`
            : 'No option chosen yet'}
          {plan.notes ? ` — ${plan.notes}` : ''}
        </p>
      )}
      {!canManage && draft && (
        <p className="text-xs text-text-secondary">
          Only the owner or an admin can edit and approve the plan.
        </p>
      )}
      {canManage && plan.status === 'approved' && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-text-secondary">
            Completed on
            <input
              type="date"
              className={`${inputClass} mt-1`}
              value={doneOn}
              max={utcDay(new Date())}
              onChange={(e) => setDoneOn(e.target.value)}
            />
          </label>
          <button
            type="button"
            className={btnPrimary}
            disabled={busy === 'plan-complete'}
            onClick={() => onComplete(doneOn, notes)}
          >
            {busy === 'plan-complete' && <Loader2 size={14} className="animate-spin" />} Mark
            completed &amp; close case
          </button>
        </div>
      )}
    </section>
  );
}

function AldPanel({
  ald,
  busy,
  onSave,
}: {
  ald: UnitAld | null;
  busy: boolean;
  onSave: (on: boolean, date: string | null) => void;
}) {
  const [on, setOn] = useState(ald?.ald_calibrated ?? false);
  const [date, setDate] = useState(ald?.ald_calibrated_on ?? '');
  useEffect(() => {
    setOn(ald?.ald_calibrated ?? false);
    setDate(ald?.ald_calibrated_on ?? '');
  }, [ald?.ald_calibrated, ald?.ald_calibrated_on]);
  return (
    <section
      aria-label="Automatic leak detection"
      className="space-y-2 rounded-xl border border-border bg-bg-secondary p-3"
    >
      <h3 className="text-sm font-semibold text-text-primary">
        Automatic leak detector (ALD) flag
      </h3>
      <p className="text-xs text-text-secondary">
        Follow-up inspections are waived only when a calibrated ALD is on file (calibrated within a
        year of the verification). This is a flag only — Vireek does not read ALD hardware.
      </p>
      <label className="flex items-center gap-2 text-sm text-text-primary">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> Unit has a
        calibrated ALD
      </label>
      {on && (
        <label className="block text-xs text-text-secondary">
          Last calibrated on
          <input
            type="date"
            className={`${inputClass} mt-1`}
            value={date}
            max={utcDay(new Date())}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
      )}
      <button
        type="button"
        className={btnGhost}
        disabled={busy || (on && !date)}
        onClick={() => onSave(on, on ? date : null)}
      >
        {busy && <Loader2 size={14} className="animate-spin" />} Save ALD flag
      </button>
    </section>
  );
}
