/** New payment plan — live schedule preview that mirrors the server-side generator. */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import {
  FREQUENCY_LABEL, addDays, buildSchedule, dollarsToCents, formatMoney, lateFeeFor, todayIso, validatePlanInput,
  type LateFeeType, type PlanFrequency,
} from '@/lib/paymentPlans';
import { createPlan, fetchJobsForPlan, sendPlan, type PlanJobOption } from '@/lib/paymentPlansApi';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors focus-visible:border-accent disabled:opacity-60';

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-text-secondary">{label}</span>
      {children}
      {error ? <span role="alert" className="mt-1 block text-xs text-danger">{error}</span> : hint ? <span className="mt-1 block text-[11px] text-text-secondary">{hint}</span> : null}
    </label>
  );
}

export function CreatePlanDialog({ ownerId, onClose, onCreated }: { ownerId: string; onClose: () => void; onCreated: (planId: string) => void }) {
  const { toast } = useToast();
  const ref = useFocusTrap(true);
  useEscapeToClose(true, onClose);

  const [jobs, setJobs] = useState<PlanJobOption[]>([]);
  const [jobId, setJobId] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [total, setTotal] = useState('');
  const [deposit, setDeposit] = useState('');
  const [count, setCount] = useState('3');
  const [frequency, setFrequency] = useState<PlanFrequency>('monthly');
  const [firstDue, setFirstDue] = useState(addDays(todayIso(), 14));
  const [feeType, setFeeType] = useState<LateFeeType>('none');
  const [feeValue, setFeeValue] = useState('');
  const [feeCap, setFeeCap] = useState('');
  const [grace, setGrace] = useState('3');
  const [autoCharge, setAutoCharge] = useState(true);
  const [notes, setNotes] = useState('');
  const [sendNow, setSendNow] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchJobsForPlan(ownerId).then((j) => { if (alive) setJobs(j); }).catch(() => { /* optional convenience — the form works without it */ });
    return () => { alive = false; };
  }, [ownerId]);

  const pickJob = (id: string) => {
    setJobId(id);
    const job = jobs.find((j) => j.id === id);
    if (!job) return;
    setName(job.customer_name);
    if (job.customer_phone) setPhone(job.customer_phone);
    if (job.invoice_amount) setTotal(String(job.invoice_amount));
  };

  const totalCents = dollarsToCents(total);
  const depositCents = deposit.trim() ? dollarsToCents(deposit) : 0;
  const feeCents = feeType === 'flat' ? dollarsToCents(feeValue) : null;
  const feeNumber = feeType === 'flat' ? feeCents ?? 0 : feeType === 'percent' ? Number(feeValue) || 0 : 0;
  const capCents = feeCap.trim() ? dollarsToCents(feeCap) : 0;

  const input = useMemo(() => ({
    customer_name: name, customer_email: email, customer_phone: phone,
    total_cents: totalCents ?? 0, deposit_cents: depositCents ?? -1, installment_count: Number(count),
    frequency, first_due_date: firstDue, late_fee_type: feeType, late_fee_value: feeNumber, late_fee_cap_cents: capCents ?? 0,
    grace_days: Number(grace), auto_charge: autoCharge,
  }), [name, email, phone, totalCents, depositCents, count, frequency, firstDue, feeType, feeNumber, capCents, grace, autoCharge]);

  const errors = useMemo(() => {
    const e = validatePlanInput(input);
    if (total.trim() && totalCents === null) e.total = 'Enter a valid amount, e.g. 1500 or 1500.00.';
    if (deposit.trim() && depositCents === null) e.deposit = 'Enter a valid amount.';
    if (feeType === 'flat' && feeValue.trim() && feeCents === null) e.late_fee = 'Enter a valid amount.';
    if (feeCap.trim() && capCents === null) e.late_fee_cap = 'Enter a valid amount.';
    return e;
  }, [input, total, totalCents, deposit, depositCents, feeType, feeValue, feeCents, feeCap, capCents]);
  const valid = Object.keys(errors).length === 0;
  const show = (k: string) => (submitted ? errors[k] : undefined);

  const schedule = useMemo(() => (valid ? buildSchedule(input) : []), [valid, input]);
  const sampleFee = valid && feeType !== 'none' ? lateFeeFor({ late_fee_type: feeType, late_fee_value: feeNumber, late_fee_cap_cents: capCents ?? 0 }, schedule.find((s) => s.kind === 'installment')?.amount_cents ?? 0) : 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (!valid) return;
    setSaving(true);
    try {
      const id = await createPlan({
        job_id: jobId || null, customer_name: name.trim(), customer_email: email.trim(), customer_phone: phone.trim(),
        total_cents: input.total_cents, deposit_cents: input.deposit_cents, installment_count: input.installment_count, frequency,
        first_due_date: firstDue, late_fee_type: feeType, late_fee_value: feeNumber, late_fee_cap_cents: capCents ?? 0,
        grace_days: input.grace_days, auto_charge: autoCharge, notes: notes.trim() || null,
      });
      if (sendNow) {
        try { await sendPlan(id); toast('Plan created and sent to the customer', 'success'); }
        catch (err) { toast(`Plan saved, but it wasn't sent: ${err instanceof Error ? err.message : 'try again from the plan'}`, 'error'); }
      } else {
        toast('Plan saved', 'success');
      }
      onCreated(id);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the plan.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label="New payment plan" className="flex max-h-[95vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl border border-border bg-bg-primary shadow-2xl sm:rounded-3xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-lg font-semibold text-text-primary">New payment plan</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary"><X className="h-5 w-5" /></button>
        </header>

        <form onSubmit={submit} noValidate className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          {jobs.length > 0 && (
            <Field label="Start from a job (optional)">
              <select value={jobId} onChange={(e) => pickJob(e.target.value)} className={inputClass}>
                <option value="">— none —</option>
                {jobs.map((j) => <option key={j.id} value={j.id}>{j.customer_name}{j.service_type ? ` · ${j.service_type}` : ''} · ${Number(j.invoice_amount).toFixed(2)}</option>)}
              </select>
            </Field>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Customer name" error={show('customer_name')}><input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" /></Field>
            <Field label="Email" error={show('customer_email') ?? show('contact')}><input type="email" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" /></Field>
            <Field label="Phone (SMS)"><input type="tel" className={inputClass} value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="off" /></Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Total ($)" error={show('total')}><input inputMode="decimal" className={inputClass} value={total} onChange={(e) => setTotal(e.target.value)} placeholder="1500.00" /></Field>
            <Field label="Deposit today ($)" error={show('deposit')} hint="Leave empty for none."><input inputMode="decimal" className={inputClass} value={deposit} onChange={(e) => setDeposit(e.target.value)} placeholder="0" /></Field>
            <Field label="Installments" error={show('count')}><input inputMode="numeric" className={inputClass} value={count} onChange={(e) => setCount(e.target.value)} /></Field>
            <Field label="Frequency">
              <select className={inputClass} value={frequency} onChange={(e) => setFrequency(e.target.value as PlanFrequency)}>
                {(Object.keys(FREQUENCY_LABEL) as PlanFrequency[]).map((f) => <option key={f} value={f}>{FREQUENCY_LABEL[f]}</option>)}
              </select>
            </Field>
            <Field label="First installment due" error={show('first_due_date')}><input type="date" min={todayIso()} className={inputClass} value={firstDue} onChange={(e) => setFirstDue(e.target.value)} /></Field>
          </div>

          <fieldset className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-4">
            <legend className="px-1 text-sm font-semibold text-text-primary">Late fees</legend>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Type">
                <select className={inputClass} value={feeType} onChange={(e) => setFeeType(e.target.value as LateFeeType)}>
                  <option value="none">No late fee</option><option value="flat">Flat amount</option><option value="percent">Percent of installment</option>
                </select>
              </Field>
              {feeType !== 'none' && (
                <>
                  <Field label={feeType === 'flat' ? 'Fee ($)' : 'Fee (%)'} error={show('late_fee')}><input inputMode="decimal" className={inputClass} value={feeValue} onChange={(e) => setFeeValue(e.target.value)} /></Field>
                  <Field label="Grace period (days)" error={show('grace_days')}><input inputMode="numeric" className={inputClass} value={grace} onChange={(e) => setGrace(e.target.value)} /></Field>
                  {feeType === 'percent' && <Field label="Cap ($, optional)" error={show('late_fee_cap')}><input inputMode="decimal" className={inputClass} value={feeCap} onChange={(e) => setFeeCap(e.target.value)} /></Field>}
                </>
              )}
            </div>
            {feeType !== 'none' && (
              <p className="text-[11px] text-text-secondary">Charged once per installment, never compounded, and shown to the customer before they approve. Late-fee limits vary by state and country — make sure your rate is legal where you operate.</p>
            )}
          </fieldset>

          <label className="flex items-start gap-3 text-sm text-text-primary">
            <input type="checkbox" checked={autoCharge} onChange={(e) => setAutoCharge(e.target.checked)} className="mt-1 h-4 w-4 accent-[rgb(var(--accent))]" />
            <span><strong>Auto-charge the card on each due date.</strong> <span className="text-text-secondary">The customer authorizes this when they approve. {show('auto_charge') && <span className="text-danger">{errors.auto_charge}</span>}</span></span>
          </label>

          <Field label="Internal notes (optional)"><textarea rows={2} maxLength={2000} className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>

          <section aria-label="Schedule preview" className="rounded-2xl border border-border p-4">
            <h3 className="mb-2 text-sm font-semibold text-text-primary">Schedule preview</h3>
            {schedule.length === 0 ? <p className="text-xs text-text-secondary">Fill in the amounts to see the schedule.</p> : (
              <ul className="divide-y divide-border text-sm">
                {schedule.map((s) => (
                  <li key={s.seq} className="flex justify-between py-1.5">
                    <span className="text-text-secondary">{s.kind === 'deposit' ? 'Deposit (today)' : `Installment ${s.seq} · ${s.due_date}`}</span>
                    <span className="font-medium text-text-primary">{formatMoney(s.amount_cents)}</span>
                  </li>
                ))}
              </ul>
            )}
            {sampleFee > 0 && <p className="mt-2 text-[11px] text-text-secondary">A late installment would add {formatMoney(sampleFee)}.</p>}
          </section>

          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input type="checkbox" checked={sendNow} onChange={(e) => setSendNow(e.target.checked)} className="h-4 w-4 accent-[rgb(var(--accent))]" />
            Send the approval link to the customer now
          </label>
        </form>

        <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="button" size="sm" disabled={saving} onClick={(e) => void submit(e as unknown as React.FormEvent)}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} {sendNow ? 'Create and send' : 'Create plan'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
