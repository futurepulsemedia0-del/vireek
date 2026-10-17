/** Payment plan detail sheet — schedule, per-installment actions, terms and timeline. */

import { useCallback, useEffect, useState } from 'react';
import { Copy, CreditCard, Loader2, Send, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyStateError } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import {
  EVENT_LABELS, INSTALLMENT_STATUS_META, OPEN_STATUSES, PLAN_STATUS_META, TONE_CLASS, dueLabel, formatMoney, installmentDue, planProgress,
  type InstallmentRow, type PlanEventRow, type PlanRow,
} from '@/lib/paymentPlans';
import { chargeInstallmentNow, fetchPlanEvents, recordOfflinePayment, sendPlan, setPlanStatus, waiveLateFee } from '@/lib/paymentPlansApi';

type Confirm = { kind: 'cancel' } | { kind: 'charge' | 'offline' | 'waive'; item: InstallmentRow } | null;

export function PlanDetailPanel({ plan, ownerId, onClose, onChanged }: { plan: PlanRow; ownerId: string; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast();
  const ref = useFocusTrap(true);
  useEscapeToClose(true, onClose);

  const [events, setEvents] = useState<PlanEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const items = plan.payment_plan_installments ?? [];
  const progress = planProgress(items);
  const status = PLAN_STATUS_META[plan.status];
  const canCharge = plan.status === 'active' && !!plan.stripe_payment_method_id;
  const awaiting = plan.status === 'draft' || plan.status === 'pending_authorization';

  const load = useCallback(async () => {
    setLoading(true); setFailed(false);
    try { setEvents(await fetchPlanEvents(ownerId, plan.id)); } catch { setFailed(true); } finally { setLoading(false); }
  }, [ownerId, plan.id]);
  useEffect(() => { void load(); }, [load]);

  const run = async (key: string, fn: () => Promise<string | void>, okMessage: string) => {
    setBusy(key);
    try {
      const detail = await fn();
      toast(typeof detail === 'string' && detail ? detail : okMessage, 'success');
      onChanged();
      void load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong.', 'error');
    } finally {
      setBusy(null); setConfirm(null);
    }
  };

  const copyLink = async () => {
    if (!plan.authorization_url) return;
    try { await navigator.clipboard.writeText(plan.authorization_url); toast('Approval link copied', 'success'); } catch { toast('Could not copy the link.', 'error'); }
  };

  const chargeMessage = (outcome?: string, error?: string | null) =>
    outcome === 'paid' ? 'Payment collected' : outcome === 'requires_action' ? 'The bank needs the customer to confirm — we sent them a link.' : `Charge failed${error ? `: ${error}` : ''}. We notified the customer.`;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={`Payment plan for ${plan.customer_name}`} className="flex h-full w-full flex-col overflow-hidden bg-bg-primary shadow-2xl sm:max-w-2xl sm:border-l sm:border-border">
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-semibold text-text-primary">{plan.customer_name}</h2>
              <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TONE_CLASS[status.tone]}`}>{status.label}</span>
            </div>
            <p className="mt-1 truncate text-sm text-text-secondary">{formatMoney(plan.total_cents, plan.currency)} total · {plan.auto_charge ? 'auto-charge' : 'manual payments'}{plan.customer_email ? ` · ${plan.customer_email}` : ''}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring -mr-1 rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary"><X className="h-5 w-5" /></button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto px-4 py-5 sm:px-6">
          <section aria-label="Progress">
            <div className="flex items-center justify-between text-xs"><span className="font-semibold text-text-primary">{formatMoney(progress.paidCents, plan.currency)} of {formatMoney(progress.totalCents, plan.currency)} paid</span><span className="text-text-secondary">{progress.pct}%</span></div>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-bg-tertiary" role="progressbar" aria-valuenow={progress.pct} aria-valuemin={0} aria-valuemax={100}><div className="h-full rounded-full bg-success transition-all" style={{ width: `${progress.pct}%` }} /></div>
          </section>

          {awaiting && (
            <section className="space-y-3 rounded-2xl border border-warning-500/30 bg-warning-500/10 p-4 text-sm">
              <p className="text-text-primary">{plan.status === 'draft' ? 'This plan has not been sent yet.' : 'Waiting for the customer to approve.'} Nothing is charged until they do.</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy !== null} onClick={() => void run('send', async () => { await sendPlan(plan.id); }, 'Approval link sent')}>
                  {busy === 'send' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {plan.status === 'draft' ? 'Send to customer' : 'Resend link'}
                </Button>
                {plan.authorization_url && <Button size="sm" variant="secondary" onClick={() => void copyLink()}><Copy className="h-4 w-4" /> Copy link</Button>}
              </div>
            </section>
          )}

          <section aria-label="Installments" className="space-y-2">
            <h3 className="text-sm font-semibold text-text-primary">Schedule</h3>
            <ul className="space-y-2">
              {items.map((i) => {
                const due = dueLabel(i);
                const meta = INSTALLMENT_STATUS_META[i.status];
                const open = OPEN_STATUSES.includes(i.status);
                return (
                  <li key={i.id} className="rounded-xl border border-border bg-bg-secondary p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-text-primary">{i.kind === 'deposit' ? 'Deposit' : `Installment ${i.seq}`} · {formatMoney(installmentDue(i), plan.currency)}</p>
                        <p className="text-xs text-text-secondary">{i.kind === 'deposit' ? 'Due at approval' : i.due_date}{i.late_fee_cents > 0 && <span className="text-warning-500"> · incl. {formatMoney(i.late_fee_cents, plan.currency)} late fee</span>}</p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${TONE_CLASS[i.status === 'paid' ? 'success' : meta.tone === 'neutral' ? due.tone : meta.tone]}`}>{i.status === 'scheduled' || i.status === 'paid' ? due.label : meta.label}</span>
                        {i.payment_method === 'offline' && <span className="text-[10px] text-text-secondary">recorded offline</span>}
                      </div>
                    </div>
                    {i.last_error && open && <p className="mt-1.5 text-xs text-danger">{i.last_error}{i.attempt_count > 0 ? ` (attempt ${i.attempt_count}/${plan.max_charge_attempts})` : ''}</p>}
                    {open && i.status !== 'processing' && !awaiting && plan.status !== 'canceled' && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {canCharge && i.kind === 'installment' && <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => setConfirm({ kind: 'charge', item: i })}><CreditCard className="h-4 w-4" /> Charge now</Button>}
                        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirm({ kind: 'offline', item: i })}>Mark paid (cash/check)</Button>
                        {i.late_fee_cents > 0 && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirm({ kind: 'waive', item: i })}>Waive late fee</Button>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          {plan.terms_text && (
            <section aria-label="Terms the customer saw" className="rounded-2xl border border-border bg-bg-secondary p-4">
              <h3 className="mb-1 text-sm font-semibold text-text-primary">Terms shown to the customer</h3>
              <p className="text-xs leading-relaxed text-text-secondary">{plan.terms_text}</p>
              <p className="mt-2 text-[11px] text-text-secondary">{plan.terms_accepted_at ? `Approved ${new Date(plan.terms_accepted_at).toLocaleString()}` : 'Not approved yet'}</p>
            </section>
          )}

          <section aria-label="Timeline">
            <h3 className="mb-2 text-sm font-semibold text-text-primary">Timeline</h3>
            {loading ? <div aria-busy="true" className="space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
              : failed ? <EmptyStateError title="Could not load the timeline" onRetry={load} />
              : events.length === 0 ? <p className="text-xs text-text-secondary">No activity yet.</p> : (
                <ol className="space-y-2 border-l border-border pl-4">
                  {events.map((ev) => (
                    <li key={ev.id} className="text-xs">
                      <p className="font-medium text-text-primary">{EVENT_LABELS[ev.type] ?? ev.type.replace(/_/g, ' ')}{typeof ev.detail?.cents === 'number' ? ` · ${formatMoney(ev.detail.cents, plan.currency)}` : ''}</p>
                      <p className="text-text-secondary">{new Date(ev.created_at).toLocaleString()}</p>
                    </li>
                  ))}
                </ol>
              )}
          </section>
        </div>

        {(plan.status === 'active' || plan.status === 'paused' || awaiting) && (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3 sm:px-6">
            {plan.status === 'active' && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void run('pause', () => setPlanStatus(plan.id, 'pause'), 'Plan paused — no charges or reminders')}>Pause</Button>}
            {plan.status === 'paused' && <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('resume', () => setPlanStatus(plan.id, 'resume'), 'Plan resumed')}>Resume</Button>}
            <Button size="sm" variant="ghost" className="text-danger" disabled={busy !== null} onClick={() => setConfirm({ kind: 'cancel' })}>Cancel plan</Button>
          </footer>
        )}
      </div>

      <ConfirmDialog open={confirm?.kind === 'cancel'} title="Cancel this payment plan?" description="All unpaid installments are canceled and nothing more is charged. Payments already collected are not refunded."
        confirmPhrase="cancel plan" confirmLabel="Cancel plan" onConfirm={() => run('cancel', () => setPlanStatus(plan.id, 'cancel'), 'Plan canceled')} onCancel={() => setConfirm(null)} />
      <ConfirmDialog open={confirm?.kind === 'charge'} title="Charge the saved card now?"
        description={confirm?.kind === 'charge' ? `${formatMoney(installmentDue(confirm.item), plan.currency)} will be charged to ${plan.customer_name}'s saved card immediately.` : ''}
        confirmLabel="Charge now" onConfirm={() => confirm?.kind === 'charge' ? run('charge', async () => { const r = await chargeInstallmentNow(confirm.item.id); return chargeMessage(r.outcome, r.error); }, '') : undefined} onCancel={() => setConfirm(null)} />
      <ConfirmDialog open={confirm?.kind === 'offline'} title="Record a cash or check payment?"
        description={confirm?.kind === 'offline' ? `Marks ${formatMoney(installmentDue(confirm.item), plan.currency)} as paid outside Stripe. No card is charged.` : ''}
        confirmLabel="Mark as paid" onConfirm={() => confirm?.kind === 'offline' ? run('offline', () => recordOfflinePayment(confirm.item.id, ''), 'Payment recorded') : undefined} onCancel={() => setConfirm(null)} />
      <ConfirmDialog open={confirm?.kind === 'waive'} title="Waive this late fee?" description="The installment returns to its original amount. This is recorded in the timeline."
        confirmLabel="Waive fee" onConfirm={() => confirm?.kind === 'waive' ? run('waive', () => waiveLateFee(confirm.item.id), 'Late fee waived') : undefined} onCancel={() => setConfirm(null)} />
    </div>
  );
}
