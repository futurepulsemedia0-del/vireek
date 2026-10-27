import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Check, Copy, ExternalLink, FileText, Loader2, Mail, MessageSquare, Send, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyStateError } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { formatCents } from '@/lib/quotes';
import {
  fetchEvents,
  fetchInvoice,
  cancelChangeOrder,
  invoiceChangeOrder,
  recordDecision,
  sendChangeOrder,
  updateChangeOrder,
  type InvoiceLite,
  type ParentInfo,
  type ParentOption,
} from '@/lib/changeOrdersApi';
import {
  DEFAULT_EXPIRY_DAYS,
  EVENT_LABEL,
  METHOD_LABEL,
  REASON_LABEL,
  STATUS_LABEL,
  actionsFor,
  changeOrderError,
  changeOrderLink,
  computeImpact,
  daysUntil,
  displayStatus,
  formFromChangeOrder,
  formatDate,
  formatDateTime,
  formatScheduleImpact,
  lineTotalCents,
  toPayload,
  type ApprovalMethod,
  type ChangeOrder,
  type ChangeOrderEvent,
  type FormValues,
} from '@/lib/changeOrders';
import { ChangeOrderForm } from './ChangeOrderForm';
import { Pill, Stat, panelClass, selectClass, statusTone } from './coUi';

interface Props {
  ownerId: string;
  co: ChangeOrder;
  all: ChangeOrder[];
  parent: ParentInfo | undefined;
  onChanged: () => Promise<void>;
  onBack: () => void;
}

type Panel = null | 'send' | 'decision' | 'cancel' | 'invoice';
type Method = Exclude<ApprovalMethod, 'online'>;

export function ChangeOrderDetail({ ownerId, co, all, parent, onChanged, onBack }: Props) {
  const { toast } = useToast();
  const [panel, setPanel] = useState<Panel>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<ChangeOrderEvent[] | null>(null);
  const [eventsFailed, setEventsFailed] = useState(false);
  const [invoice, setInvoice] = useState<InvoiceLite | null>(null);

  // panel inputs
  const [expiry, setExpiry] = useState(String(DEFAULT_EXPIRY_DAYS));
  const [decision, setDecision] = useState<'approved' | 'declined'>('approved');
  const [name, setName] = useState(co.customer_name);
  const [method, setMethod] = useState<Method>('in_person');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [due, setDue] = useState('');

  const now = new Date();
  const status = displayStatus(co, now);
  const actions = actionsFor(co, now);
  const siblings = useMemo(() => all.filter((c) => (co.project_id ? c.project_id === co.project_id : c.job_id === co.job_id)), [all, co.project_id, co.job_id]);
  const impact = computeImpact(parent?.originalCents ?? null, siblings, now);
  const link = changeOrderLink(co.approval_token);

  const loadEvents = useCallback(async () => {
    setEventsFailed(false);
    try { setEvents(await fetchEvents(ownerId, co.id)); } catch { setEventsFailed(true); setEvents([]); }
  }, [ownerId, co.id]);

  useEffect(() => { void loadEvents(); }, [loadEvents, co.updated_at]);

  useEffect(() => {
    let live = true;
    setInvoice(null);
    if (co.invoice_id) fetchInvoice(ownerId, co.invoice_id).then((i) => { if (live) setInvoice(i); }).catch(() => undefined);
    return () => { live = false; };
  }, [ownerId, co.invoice_id]);

  const run = async (fn: () => Promise<unknown>, success: string, fallback: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      toast(success, 'success');
      setPanel(null);
      await onChanged();
    } catch (e) {
      toast(changeOrderError(e, fallback), 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (v: FormValues, _p: ParentOption | null) => {
    void _p;
    setBusy(true);
    try {
      await updateChangeOrder(co.id, toPayload(v));
      toast('Draft saved.', 'success');
      setEditing(false);
      await onChanged();
    } catch (e) {
      toast(changeOrderError(e, 'Could not save the change order.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast('Approval link copied.', 'success');
    } catch {
      toast(`Copy this link: ${link}`, 'info');
    }
  };

  const shareText = `Hi ${co.customer_name}, please review and approve change order ${co.co_number ?? ''} (${co.title}): ${link}`;
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  if (editing) {
    return (
      <div className="space-y-4">
        <button type="button" onClick={() => setEditing(false)} className="focus-ring inline-flex items-center gap-1.5 rounded-lg text-sm text-text-secondary hover:text-text-primary">
          <ArrowLeft size={16} aria-hidden="true" /> Back to {co.co_number}
        </button>
        <h1 className="text-xl font-bold text-text-primary">Edit {co.co_number}</h1>
        <ChangeOrderForm mode="edit" ownerId={ownerId} initial={formFromChangeOrder(co)} submitting={busy} onSubmit={saveEdit} onCancel={() => setEditing(false)} />
      </div>
    );
  }

  const expiresIn = daysUntil(co.expires_at, now);

  return (
    <div className="space-y-6">
      <button type="button" onClick={onBack} className="focus-ring inline-flex items-center gap-1.5 rounded-lg text-sm text-text-secondary hover:text-text-primary">
        <ArrowLeft size={16} aria-hidden="true" /> All change orders
      </button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-secondary">{co.co_number}</p>
          <h1 className="break-words text-xl font-bold text-text-primary sm:text-2xl">{co.title}</h1>
          <p className="mt-1 text-sm text-text-secondary">
            {co.customer_name} · {REASON_LABEL[co.reason]}
            {parent && <> · <Link to={parent.href} className="focus-ring rounded text-accent hover:underline">{parent.label}</Link></>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={statusTone[status]}>{STATUS_LABEL[status]}</Pill>
          {status === 'sent' && expiresIn !== null && <span className="text-xs text-text-secondary">{expiresIn <= 0 ? 'Expires today' : `Expires in ${expiresIn} day${expiresIn === 1 ? '' : 's'}`}</span>}
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Change order actions">
        {actions.canEdit && <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit draft</Button>}
        {(actions.canSend || actions.canResend) && (
          <Button size="sm" onClick={() => setPanel(panel === 'send' ? null : 'send')}>
            <Send size={16} aria-hidden="true" /> {actions.canResend ? 'Send again' : 'Send for approval'}
          </Button>
        )}
        {actions.canRecordDecision && <Button size="sm" variant="secondary" onClick={() => setPanel(panel === 'decision' ? null : 'decision')}>Record customer decision</Button>}
        {actions.canInvoice && <Button size="sm" onClick={() => setPanel(panel === 'invoice' ? null : 'invoice')}><FileText size={16} aria-hidden="true" /> Create invoice</Button>}
        {actions.canCancel && <Button size="sm" variant="ghost" onClick={() => setPanel(panel === 'cancel' ? null : 'cancel')}>Cancel change order</Button>}
      </div>

      {actions.canSend === false && co.status === 'draft' && (
        <p className="text-sm text-warning-500" role="status">Add at least one priced line before sending.</p>
      )}

      {/* Inline action panels */}
      {panel === 'send' && (
        <section className={`${panelClass} space-y-3`} aria-label="Send for approval">
          <h2 className="text-base font-semibold text-text-primary">Send for approval</h2>
          <p className="text-sm text-text-secondary">The content locks when you send. The customer gets a private link to review and sign; you can copy it, email it or text it next.</p>
          <div className="max-w-xs"><Input label="Link valid for (days)" inputMode="numeric" value={expiry} onChange={(e) => setExpiry(e.target.value)} helperText="1–90 days" /></div>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => {
              const n = Number(expiry);
              if (!Number.isInteger(n) || n < 1 || n > 90) { toast('Choose between 1 and 90 days.', 'error'); return; }
              void run(() => sendChangeOrder(co.id, n), 'Ready to share with the customer.', 'Could not send the change order.');
            }}>{busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />} Confirm</Button>
            <Button size="sm" variant="ghost" onClick={() => setPanel(null)}>Close</Button>
          </div>
        </section>
      )}

      {panel === 'decision' && (
        <section className={`${panelClass} space-y-3`} aria-label="Record customer decision">
          <h2 className="text-base font-semibold text-text-primary">Record a decision the customer gave you directly</h2>
          <div role="group" aria-label="Decision" className="flex gap-2">
            {(['approved', 'declined'] as const).map((d) => (
              <button key={d} type="button" aria-pressed={decision === d} onClick={() => setDecision(d)} className={`focus-ring rounded-full px-3 py-1.5 text-xs font-semibold ${decision === d ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary'}`}>
                {d === 'approved' ? 'Approved' : 'Declined'}
              </button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label={decision === 'approved' ? 'Name of person who approved' : 'Name (optional)'} value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
            <div>
              <label htmlFor="co-method" className="mb-1.5 block text-sm font-medium text-text-primary">How did they respond?</label>
              <select id="co-method" className={selectClass} value={method} onChange={(e) => setMethod(e.target.value as Method)}>
                {(['in_person', 'phone', 'email', 'other'] as Method[]).map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
              </select>
            </div>
          </div>
          <Textarea label="Note (optional)" rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void run(() => recordDecision(co.id, decision, name.trim(), method, note.trim()), decision === 'approved' ? 'Approval recorded.' : 'Decline recorded.', 'Could not record the decision.')}>
              {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />} Save decision
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPanel(null)}>Close</Button>
          </div>
        </section>
      )}

      {panel === 'invoice' && (
        <section className={`${panelClass} space-y-3`} aria-label="Create invoice">
          <h2 className="text-base font-semibold text-text-primary">Create an invoice for {formatCents(co.total_cents)}</h2>
          <p className="text-sm text-text-secondary">A separate draft invoice is created with this change order’s lines. Your existing invoices are not touched.</p>
          <div className="max-w-xs"><Input label="Due date (optional)" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></div>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void run(() => invoiceChangeOrder(co.id, due || null), 'Invoice created.', 'Could not create the invoice.')}>
              {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />} Create invoice
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPanel(null)}>Close</Button>
          </div>
        </section>
      )}

      {panel === 'cancel' && (
        <section className={`${panelClass} space-y-3`} aria-label="Cancel change order">
          <h2 className="text-base font-semibold text-text-primary">Cancel this change order?</h2>
          <p className="text-sm text-text-secondary">This can’t be undone. {co.status !== 'draft' ? 'The customer’s link stops working.' : ''}</p>
          <Textarea label={actions.needsCancelReason ? 'Reason (required)' : 'Reason (optional)'} rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => {
              if (actions.needsCancelReason && !reason.trim()) { toast('Please give a short reason.', 'error'); return; }
              void run(() => cancelChangeOrder(co.id, reason.trim()), 'Change order cancelled.', 'Could not cancel the change order.');
            }}>{busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />} Yes, cancel it</Button>
            <Button size="sm" variant="ghost" onClick={() => setPanel(null)}>Keep it</Button>
          </div>
        </section>
      )}

      {/* Share link */}
      {co.status === 'sent' && (
        <section className={`${panelClass} space-y-3`} aria-label="Customer approval link">
          <h2 className="text-base font-semibold text-text-primary">Customer approval link</h2>
          <p className="break-all rounded-xl border border-border bg-bg-primary p-3 text-sm text-text-secondary" data-testid="approval-link">{link}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => void copyLink()}><Copy size={16} aria-hidden="true" /> Copy link</Button>
            <a className="focus-ring inline-flex min-h-[40px] items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary hover:border-accent/40" href={`mailto:${encodeURIComponent(co.customer_email ?? '')}?subject=${encodeURIComponent(`Change order ${co.co_number ?? ''}: ${co.title}`)}&body=${encodeURIComponent(shareText)}`}>
              <Mail size={16} aria-hidden="true" /> Email
            </a>
            <a className="focus-ring inline-flex min-h-[40px] items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary hover:border-accent/40" href={`sms:${co.customer_phone ?? ''}?&body=${encodeURIComponent(shareText)}`}>
              <MessageSquare size={16} aria-hidden="true" /> Text
            </a>
            {canNativeShare && (
              <Button size="sm" variant="secondary" onClick={() => void navigator.share({ title: `Change order ${co.co_number ?? ''}`, text: shareText, url: link }).catch(() => undefined)}>
                <Share2 size={16} aria-hidden="true" /> Share
              </Button>
            )}
            <a className="focus-ring inline-flex min-h-[40px] items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary" href={link} target="_blank" rel="noreferrer">
              <ExternalLink size={16} aria-hidden="true" /> Preview
            </a>
          </div>
        </section>
      )}

      {actions.isCredit && (
        <p className={`${panelClass} text-sm text-text-secondary`} role="note">
          This approved credit lowers the revised contract value by {formatCents(Math.abs(co.total_cents))}. Credits aren’t invoiced — apply it on the final invoice.
        </p>
      )}

      {co.invoice_id && (
        <p className={`${panelClass} flex flex-wrap items-center justify-between gap-2 text-sm`}>
          <span className="text-text-secondary">Invoice <span className="font-semibold text-text-primary">{invoice?.invoice_number ?? '…'}</span>{invoice && <> · <span className="capitalize">{invoice.status}</span></>}</span>
          <Link to={`/dashboard/invoicing/${co.invoice_id}`} className="focus-ring rounded text-accent hover:underline">Open invoice</Link>
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <section className={panelClass} aria-label="Scope and pricing">
            {co.description && <p className="mb-4 whitespace-pre-wrap text-sm text-text-primary">{co.description}</p>}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[26rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-secondary">
                    <th className="py-2 pr-3 font-medium">Item</th><th className="px-3 py-2 text-right font-medium">Qty</th><th className="px-3 py-2 text-right font-medium">Price</th><th className="py-2 pl-3 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {co.line_items.map((l, i) => (
                    <tr key={i} className="border-b border-border/60 last:border-0">
                      <td className="py-2.5 pr-3 text-text-primary">{l.description}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-text-secondary">{l.quantity}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-text-secondary">{formatCents(l.unit_price_cents)}</td>
                      <td className="py-2.5 pl-3 text-right tabular-nums text-text-primary">{formatCents(lineTotalCents(l))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="ml-auto mt-4 w-full space-y-1.5 text-sm sm:w-64">
              <div className="flex justify-between"><dt className="text-text-secondary">Subtotal</dt><dd className="tabular-nums">{formatCents(co.subtotal_cents)}</dd></div>
              <div className="flex justify-between"><dt className="text-text-secondary">Tax ({co.tax_percent}%)</dt><dd className="tabular-nums">{formatCents(co.tax_cents)}</dd></div>
              <div className="flex justify-between border-t border-border pt-1.5 text-base font-bold"><dt>Total</dt><dd className="tabular-nums" data-testid="detail-total">{formatCents(co.total_cents)}</dd></div>
            </dl>
          </section>

          <section className={panelClass} aria-label="Activity">
            <h2 className="mb-3 text-base font-semibold text-text-primary">Activity</h2>
            {events === null ? (
              <div aria-busy="true" aria-label="Loading activity" className="space-y-2"><Skeleton className="h-4 w-48" /><Skeleton className="h-4 w-40" /></div>
            ) : eventsFailed ? (
              <EmptyStateError icon={FileText} title="Couldn’t load activity" onRetry={() => void loadEvents()} />
            ) : (
              <ol className="space-y-3">
                {events.map((ev) => (
                  <li key={ev.id} className="flex gap-3 text-sm">
                    <span className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bg-tertiary text-text-secondary"><Check size={12} aria-hidden="true" /></span>
                    <div className="min-w-0">
                      <p className="text-text-primary">{EVENT_LABEL[ev.event_type] ?? ev.event_type}{ev.actor_name ? <span className="text-text-secondary"> · {ev.actor_name}</span> : null}</p>
                      <p className="text-xs text-text-secondary">{formatDateTime(ev.created_at)}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
            <Stat label="Change total" value={formatCents(co.total_cents)} tone={co.total_cents < 0 ? 'success' : undefined} hint={formatScheduleImpact(co.schedule_impact_days)} />
            {impact.revisedCents !== null ? (
              <Stat label="Revised contract" value={formatCents(impact.revisedCents)} hint={`Original ${formatCents(impact.originalCents ?? 0)} · ${impact.approvedCount} approved`} />
            ) : (
              <Stat label="Approved changes" value={formatCents(impact.approvedCents)} hint={`${impact.approvedCount} approved · original value not set`} />
            )}
            {impact.pendingCount > 0 && <Stat label="Awaiting approval" value={formatCents(impact.pendingCents)} hint={`${impact.pendingCount} change order${impact.pendingCount === 1 ? '' : 's'}`} tone="warning" />}
            {impact.toInvoiceCents > 0 && <Stat label="Approved, not invoiced" value={formatCents(impact.toInvoiceCents)} tone="warning" />}
          </div>

          <section className={panelClass} aria-label="Details">
            <h2 className="mb-2 text-base font-semibold text-text-primary">Details</h2>
            <dl className="space-y-2 text-sm">
              {([
                ['Customer', co.customer_name],
                ['Email', co.customer_email ?? '—'],
                ['Phone', co.customer_phone ?? '—'],
                ['Site', co.site_address ?? '—'],
                ['Sent', formatDate(co.sent_at)],
                ['Opened', formatDate(co.viewed_at)],
              ] as const).map(([k, val]) => (
                <div key={k} className="flex justify-between gap-3"><dt className="text-text-secondary">{k}</dt><dd className="min-w-0 break-words text-right text-text-primary">{val}</dd></div>
              ))}
            </dl>
            {co.internal_notes && <p className="mt-3 whitespace-pre-wrap rounded-xl bg-bg-primary p-3 text-xs text-text-secondary"><span className="font-semibold">Internal: </span>{co.internal_notes}</p>}
          </section>

          {co.responded_at && (
            <section className={panelClass} aria-label="Customer decision">
              <h2 className="mb-2 text-base font-semibold text-text-primary">{co.status === 'declined' ? 'Declined' : 'Approval record'}</h2>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between gap-3"><dt className="text-text-secondary">By</dt><dd className="text-right text-text-primary">{co.approver_name}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-text-secondary">Method</dt><dd className="text-right text-text-primary">{co.approval_method ? METHOD_LABEL[co.approval_method] : '—'}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-text-secondary">When</dt><dd className="text-right text-text-primary">{formatDateTime(co.responded_at)}</dd></div>
                {co.content_hash && <div><dt className="text-text-secondary">Content fingerprint</dt><dd className="mt-0.5 break-all font-mono text-[11px] text-text-secondary">{co.content_hash}</dd></div>}
              </dl>
              {co.response_note && <p className="mt-3 whitespace-pre-wrap rounded-xl bg-bg-primary p-3 text-sm text-text-primary">“{co.response_note}”</p>}
            </section>
          )}
          {co.status === 'cancelled' && co.cancel_reason && (
            <section className={panelClass} aria-label="Cancellation"><p className="text-sm text-text-secondary"><span className="font-semibold text-text-primary">Cancelled: </span>{co.cancel_reason}</p></section>
          )}
        </aside>
      </div>
    </div>
  );
}
