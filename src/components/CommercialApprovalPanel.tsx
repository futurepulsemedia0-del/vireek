import { useCallback, useEffect, useState } from 'react';
import { FileText, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { formatCents, type Invoice } from '@/lib/invoices';
import {
  enableCommercialBilling, fetchApprovalsFor, fetchCommercialState, isCommercialCustomer, linkInvoiceApproval,
  logPacketGenerated, overrideBlock, precheckInvoice, recordApproval, reviewDraft, setCommercialStage,
  type CommercialApproval, type CommercialEvent, type CommercialTracking, type DemandDraft, type PrecheckResult,
} from '@/lib/commercialCash';
import {
  REASON_LABELS, STAGE_LABELS, manualStageOptions, type Stage,
} from '../../supabase/functions/_shared/commercialCash/logic';
import { buildCommercialPacketPdf } from '@/lib/commercialPacketPdf';
import type { InvoicePdfInput } from '@/lib/invoicePdf';

type Load = 'loading' | 'error' | 'ready';
const card = 'rounded-2xl border border-border bg-surface p-5';
const input = 'w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary';

interface Props {
  invoice: Invoice;
  ownerId: string;
  isOwner: boolean;
  /** Same object the invoice PDF button uses, so the packet's first pages are identical. */
  pdfInput: InvoicePdfInput;
  onChanged?: () => void;
}

export function CommercialApprovalPanel({ invoice, ownerId, isOwner, pdfInput, onChanged }: Props) {
  const { toast } = useToast();
  const [load, setLoad] = useState<Load>('loading');
  const [enabled, setEnabled] = useState(false);
  const [check, setCheck] = useState<PrecheckResult | null>(null);
  const [tracking, setTracking] = useState<CommercialTracking | null>(null);
  const [events, setEvents] = useState<CommercialEvent[]>([]);
  const [draft, setDraft] = useState<DemandDraft | null>(null);
  const [approvals, setApprovals] = useState<CommercialApproval[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ po: '', wo: '', amount: '', by: '', at: new Date().toISOString().slice(0, 10), ref: '', source: 'purchase_order' as const, file: null as File | null });

  const refresh = useCallback(async () => {
    if (!invoice.customer_id) { setEnabled(false); setLoad('ready'); return; }
    try {
      const on = await isCommercialCustomer(invoice.customer_id);
      setEnabled(on);
      if (on) {
        const [c, s, a] = await Promise.all([
          precheckInvoice(invoice.id),
          fetchCommercialState(invoice.id),
          fetchApprovalsFor({ customerId: invoice.customer_id, jobId: invoice.job_id, quoteId: invoice.quote_id }),
        ]);
        setCheck(c); setTracking(s.tracking); setEvents(s.events); setDraft(s.draft); setApprovals(a);
      }
      setLoad('ready');
    } catch {
      setLoad('error');
    }
  }, [invoice.id, invoice.customer_id, invoice.job_id, invoice.quote_id]);

  useEffect(() => { void refresh(); }, [refresh, invoice.status, invoice.updated_at]);

  const run = async (key: string, fn: () => Promise<void>, ok?: string) => {
    setBusy(key);
    try { await fn(); if (ok) toast(ok, 'success'); await refresh(); onChanged?.(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Something went wrong.', 'error'); }
    finally { setBusy(null); }
  };

  if (load === 'loading') return <section className={card}><Loader2 size={16} className="animate-spin text-text-secondary" aria-label="Loading" /></section>;
  if (load === 'error') {
    return (
      <section className={card}>
        <h2 className="text-sm font-semibold text-text-primary">Commercial approval</h2>
        <p className="mt-2 text-sm text-text-secondary">Couldn&apos;t load approval details.</p>
        <Button size="sm" variant="secondary" className="mt-3" onClick={() => { setLoad('loading'); void refresh(); }}>Retry</Button>
      </section>
    );
  }
  if (!invoice.customer_id) return null;
  if (!enabled) {
    return (
      <section className={card}>
        <h2 className="text-sm font-semibold text-text-primary">Commercial approval</h2>
        <p className="mt-2 text-sm text-text-secondary">Track PO / work-order approvals, block over-limit invoices and run a follow-up ladder for this customer.</p>
        <Button size="sm" variant="secondary" className="mt-3" disabled={!!busy}
          onClick={() => void run('enable', () => enableCommercialBilling(invoice.customer_id as string), 'Commercial billing enabled for this customer.')}>
          Enable for this customer
        </Button>
      </section>
    );
  }

  const stage = (tracking?.stage ?? 'draft') as Stage;
  const reasons = check?.reasons ?? [];
  const warnings = check?.warnings ?? [];
  const submit = async () => {
    const cents = Math.round(Number(form.amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) { toast('Enter the approved amount.', 'error'); return; }
    if (!form.po.trim() && !form.wo.trim()) { toast('Enter a PO or work-order number.', 'error'); return; }
    if (!form.file && !form.ref.trim()) { toast('Attach the approval file or enter an email / reference.', 'error'); return; }
    if (form.by.trim().length < 2) { toast('Enter who approved it.', 'error'); return; }
    await run('approval', async () => {
      await recordApproval({
        ownerId, customerId: invoice.customer_id, jobId: invoice.job_id, quoteId: invoice.quote_id,
        poNumber: form.po, workOrderNumber: form.wo, approvedAmountCents: cents, source: form.source,
        evidenceRef: form.ref, approvedByName: form.by, approvedAt: new Date(form.at).toISOString(), file: form.file,
      });
      setShowForm(false);
    }, 'Approval recorded.');
  };

  const packet = async () => {
    await run('packet', async () => {
      const approval = approvals.find((a) => a.id === (tracking?.approval_id ?? check?.approval_id)) ?? null;
      const { doc, notes } = await buildCommercialPacketPdf({ ...pdfInput, approval, jobId: invoice.job_id });
      doc.save(`${invoice.invoice_number.replace(/[^A-Za-z0-9_-]+/g, '_')}-packet.pdf`);
      await logPacketGenerated(invoice.id);
      if (notes.length) toast(notes.join(' '), 'info');
    });
  };

  return (
    <section className={card} aria-labelledby="cc-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="cc-title" className="text-sm font-semibold text-text-primary">Commercial approval</h2>
        <span className="rounded-full bg-bg px-2.5 py-0.5 text-[11px] font-semibold uppercase text-text-secondary">{STAGE_LABELS[stage]}</span>
      </div>

      {reasons.length > 0 && (
        <div role="alert" className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          <p className="flex items-center gap-1.5 font-semibold"><ShieldAlert size={14} /> Blocked - sending is disabled until this is fixed</p>
          <ul className="mt-1 list-disc pl-5">
            {reasons.map((r) => (
              <li key={r.code}>{REASON_LABELS[r.code] ?? r.message}{r.excess_cents ? ` (${formatCents(r.excess_cents)} over)` : ''}</li>
            ))}
          </ul>
          {isOwner && (
            <Button size="sm" variant="secondary" className="mt-2" disabled={!!busy} onClick={() => {
              const reason = window.prompt('Why is it OK to send anyway? (10+ characters, recorded in the audit log)');
              if (reason) void run('override', async () => { await overrideBlock(invoice.id, reason); }, 'Override recorded.');
            }}>Override (owner)</Button>
          )}
        </div>
      )}
      {reasons.length === 0 && warnings.length > 0 && (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{warnings.map((w) => REASON_LABELS[w.code] ?? w.message).join(' - ')}</p>
      )}
      {reasons.length === 0 && warnings.length === 0 && (stage === 'draft' || stage === 'blocked_needs_approval') && (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-text-secondary"><ShieldCheck size={14} /> Ready to send: PO, amount and completion proof check out.</p>
      )}

      <div className="mt-4">
        <h3 className="text-xs font-semibold uppercase text-text-secondary">Approvals on file</h3>
        {approvals.length === 0 ? <p className="mt-1 text-sm text-text-secondary">None yet.</p> : (
          <ul className="mt-1 divide-y divide-border text-sm">
            {approvals.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className={a.status === 'void' ? 'text-text-secondary line-through' : 'text-text-primary'}>
                  {a.po_number ?? a.work_order_number} - {formatCents(a.approved_amount_cents)} - {a.approved_by_name}
                </span>
                {a.status === 'active' && tracking?.approval_id !== a.id && stage !== 'paid' && (
                  <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run('link', async () => { await linkInvoiceApproval(invoice.id, a.id); }, 'Linked to this invoice.')}>Use for this invoice</Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <Button size="sm" variant="secondary" className="mt-2" onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : 'Record approval / PO'}</Button>
      </div>

      {showForm && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <input className={input} placeholder="PO number" value={form.po} onChange={(e) => setForm({ ...form, po: e.target.value })} aria-label="PO number" />
          <input className={input} placeholder="Work-order number" value={form.wo} onChange={(e) => setForm({ ...form, wo: e.target.value })} aria-label="Work-order number" />
          <input className={input} placeholder="Approved amount (NTE), e.g. 1500" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} aria-label="Approved amount" />
          <input className={input} placeholder="Approved by (name)" value={form.by} onChange={(e) => setForm({ ...form, by: e.target.value })} aria-label="Approved by" />
          <input className={input} type="date" value={form.at} onChange={(e) => setForm({ ...form, at: e.target.value })} aria-label="Approval date" />
          <input className={input} placeholder="Email / ticket reference (if no file)" value={form.ref} onChange={(e) => setForm({ ...form, ref: e.target.value })} aria-label="Evidence reference" />
          <input className={`${input} sm:col-span-2`} type="file" accept="application/pdf,image/png,image/jpeg,image/webp,text/plain,message/rfc822,.eml"
            onChange={(e) => setForm({ ...form, file: e.target.files?.[0] ?? null })} aria-label="Approval evidence file" />
          <Button size="sm" className="sm:col-span-2" disabled={!!busy} onClick={() => void submit()}>
            {busy === 'approval' ? <Loader2 size={14} className="animate-spin" /> : null} Save approval
          </Button>
        </div>
      )}

      {stage !== 'draft' && stage !== 'blocked_needs_approval' && stage !== 'paid' && stage !== 'void' && (
        <div className="mt-4 flex flex-wrap gap-2">
          {manualStageOptions(stage).map((to) => (
            <Button key={to} size="sm" variant="secondary" disabled={!!busy} onClick={() => {
              let reason: string | undefined;
              if (to === 'rejected') { reason = window.prompt('Why did the customer reject it?') ?? undefined; if (!reason) return; }
              void run(`stage-${to}`, () => setCommercialStage(invoice.id, to as 'received' | 'approved' | 'rejected' | 'sent', reason));
            }}>Mark {STAGE_LABELS[to].toLowerCase()}</Button>
          ))}
        </div>
      )}
      {tracking?.rejection_reason && stage === 'rejected' && <p className="mt-2 text-sm text-red-700">Rejected: {tracking.rejection_reason}</p>}

      <div className="mt-4">
        <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void packet()}>
          {busy === 'packet' ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />} Invoice packet (PDF)
        </Button>
      </div>

      {draft && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="text-xs font-semibold uppercase text-amber-900">{draft.status === 'pending_review' ? 'Draft - review required' : `Draft ${draft.status}`} - never sent automatically</p>
          <p className="mt-1 text-xs text-amber-900">{draft.disclaimer}</p>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-sm text-text-primary">{draft.body}</pre>
          {draft.status === 'pending_review' && (
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void run('draft-r', () => reviewDraft(draft.id, { status: 'reviewed' }), 'Marked reviewed. Send it yourself, outside Vireek.')}>Mark reviewed</Button>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run('draft-d', () => reviewDraft(draft.id, { status: 'dismissed' }))}>Dismiss</Button>
            </div>
          )}
        </div>
      )}

      {events.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs font-semibold uppercase text-text-secondary">Event log ({events.length})</summary>
          <ul className="mt-2 space-y-1 text-xs text-text-secondary">
            {events.map((e) => (
              <li key={e.id}>{new Date(e.created_at).toLocaleString()} - {e.event_type.replace(/_/g, ' ')}{e.to_stage ? ` -> ${e.to_stage}` : ''}{e.reason ? ` - ${e.reason}` : ''}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
