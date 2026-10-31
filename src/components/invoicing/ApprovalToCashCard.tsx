/**
 * Approval-to-Cash panel for the invoice detail page.
 * - Pre-send gate (block / warn) with owner-only reasoned override
 * - Customer PO / work-order link
 * - Customer-side state: sent -> received -> approved | rejected(reason) -> paid (paid is automatic)
 * - Follow-up ladder: a human must approve it per invoice; nothing is emailed before that
 * - Invoice packet PDF (downloaded by a person)
 * - Payment-request DRAFT text: edit + mark reviewed; Vireek has no way to send it
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, FileDown, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { rpcErrorMessage } from '@/lib/invoiceDetail';
import type { Invoice } from '@/lib/invoices';
import * as a2c from '@/lib/approvalToCash';
import { buildInvoicePacket } from '@/lib/approvalToCashPdf';

const card = 'rounded-2xl border border-border bg-bg-secondary p-4 shadow-card sm:p-5 dark:shadow-card-dark';
const input = 'w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';
const STATE_LABEL: Record<a2c.ApState, string> = { sent: 'Sent', received: 'Received', approved: 'Approved', rejected: 'Rejected', paid: 'Paid' };

interface Props { ownerId: string; invoice: Invoice; isOwner: boolean; onChanged: () => void | Promise<void>; }

export function ApprovalToCashCard({ ownerId, invoice, isOwner, onChanged }: Props) {
  const { toast } = useToast();
  const [gate, setGate] = useState<a2c.GateDb | null>(null);
  const [tracking, setTracking] = useState<a2c.ArTracking | null>(null);
  const [wos, setWos] = useState<a2c.WorkOrderOption[]>([]);
  const [settings, setSettings] = useState<a2c.A2cSettings | null>(null);
  const [daysText, setDaysText] = useState('');
  const [draft, setDraft] = useState<a2c.DemandDraft | null>(null);
  const [draftText, setDraftText] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const isDraft = invoice.status === 'draft';
  const isOpen = invoice.status === 'sent' || invoice.status === 'viewed';

  const load = useCallback(async () => {
    try {
      const [g, t, w, s, dr] = await Promise.all([
        a2c.fetchGate(invoice.id), a2c.fetchTracking(invoice.id), a2c.fetchWorkOrderOptions(ownerId),
        a2c.fetchSettings(ownerId), a2c.fetchOpenDraft(invoice.id),
      ]);
      setGate(g); setTracking(t); setWos(w); setSettings(s); setDaysText(s.a2c_followup_days.join(', '));
      setDraft(dr); setDraftText(dr?.body ?? ''); setLoadError(null);
    } catch (e) { setLoadError(rpcErrorMessage(e, 'Could not load approval-to-cash data.')); }
  }, [invoice.id, ownerId]);

  useEffect(() => { void load(); }, [load, invoice.status, invoice.work_order_id, invoice.updated_at]);

  const run = async (key: string, fn: () => Promise<void>, ok: string) => {
    if (busy) return;
    setBusy(key);
    try { await fn(); toast(ok, 'success'); await load(); await onChanged(); }
    catch (e) { toast(rpcErrorMessage(e, 'Something went wrong.'), 'error'); }
    finally { setBusy(null); }
  };

  const today = new Date().toISOString().slice(0, 10);
  const overdue = invoice.due_date ? a2c.daysOverdue(invoice.due_date, today) : null;

  const generateDraft = () => run('draft-gen', async () => {
    const p = await a2c.fetchPacketData(invoice.id);
    const od = p.invoice.due_date ? a2c.daysOverdue(p.invoice.due_date.slice(0, 10), today) : null;
    if (od === null || od < 1 || p.invoice.balance_cents <= 0) throw new Error('This invoice is not past due with a balance.');
    const fmt = (v: string | null) => (v ? new Date(v).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : null);
    const text = a2c.buildDemandLetterDraft({
      businessName: p.business_name || 'Our team', customerName: p.invoice.customer_name, invoiceNumber: p.invoice.number ?? 'this invoice',
      invoiceDate: fmt(p.invoice.sent_at), dueDate: fmt(p.invoice.due_date) ?? '', totalCents: p.invoice.total_cents,
      paidCents: p.invoice.paid_cents, balanceCents: p.invoice.balance_cents, daysOverdue: od,
      poNumber: p.work_order?.po_number ?? null, workOrderNumber: p.work_order?.number ?? null, payByDate: null,
    });
    setDraftText(text);
  }, 'Draft generated. Review and edit it before saving.');

  const downloadPacket = () => run('packet', async () => {
    const p = await a2c.fetchPacketData(invoice.id);
    buildInvoicePacket(p).save(`invoice-packet-${(p.invoice.number ?? invoice.id).replace(/[^\w-]+/g, '_')}.pdf`);
  }, 'Packet downloaded.');

  if (loadError) return <section className={card}><p className="text-sm text-danger">{loadError}</p></section>;
  if (!gate || !settings) return <section className={card}><Loader2 className="h-4 w-4 animate-spin text-text-tertiary" aria-label="Loading" /></section>;

  const blocks = gate.findings.filter((f) => f.severity === 'block');
  const lockedLink = !isDraft && !!invoice.work_order_id;

  return (
    <section className={`${card} space-y-5`} aria-labelledby="a2c-title">
      <h2 id="a2c-title" className="text-sm font-semibold text-text-primary">Approval to cash</h2>

      {/* Customer PO / work order */}
      <div>
        <label className="text-xs font-medium text-text-secondary" htmlFor="a2c-wo">Customer PO / work order</label>
        <select id="a2c-wo" className={input} value={invoice.work_order_id ?? ''} disabled={lockedLink || !!busy}
          onChange={(e) => run('link', () => a2c.linkInvoiceWorkOrder(invoice.id, e.target.value || null), 'Link updated.')}>
          <option value="">None</option>
          {wos.map((w) => (
            <option key={w.id} value={w.id}>
              {(w.work_order_number ?? 'WO')} · {w.title}{w.po_number ? ` · PO ${w.po_number}` : ' · no PO'}{w.not_to_exceed_cents != null ? ` · NTE ${a2c.fmtCents(w.not_to_exceed_cents)}` : ''}
            </option>
          ))}
        </select>
        {lockedLink && <p className="mt-1 text-xs text-text-tertiary">Locked after sending. Void and re-issue to change it.</p>}
      </div>

      {/* Gate */}
      {gate.findings.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-text-secondary"><ShieldCheck className="h-4 w-4 text-success" aria-hidden />No approval issues found.</p>
      ) : (
        <ul className="space-y-1.5" aria-label="Approval checks">
          {gate.findings.map((f) => (
            <li key={f.code} className={`flex gap-2 text-sm ${f.severity === 'block' ? 'text-danger' : 'text-text-secondary'}`}>
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /><span><strong>{f.severity === 'block' ? 'Blocked: ' : 'Warning: '}</strong>{f.message}</span>
            </li>
          ))}
        </ul>
      )}
      {gate.overridden && <p className="text-xs text-text-tertiary">Owner override on record for this amount. Changing the total re-arms the block.</p>}
      {isDraft && blocks.length > 0 && !gate.overridden && (
        isOwner ? (
          <div className="space-y-2">
            <label className="text-xs font-medium text-text-secondary" htmlFor="a2c-ovr">Owner override (reason is recorded in the audit trail)</label>
            <textarea id="a2c-ovr" className={input} rows={2} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="e.g. Customer approved the extra work by phone on…" />
            <Button size="sm" variant="secondary" disabled={!!busy || overrideReason.trim().length < 10}
              onClick={() => run('override', async () => { await a2c.overrideGate(invoice.id, overrideReason); setOverrideReason(''); }, 'Override recorded.')}>Override and allow sending</Button>
          </div>
        ) : <p className="text-xs text-text-tertiary">Only the account owner can override a block.</p>
      )}

      {/* Customer-side state */}
      {isOpen || invoice.status === 'paid' ? tracking && (
        <div className="space-y-2">
          <p className="text-sm text-text-primary">Customer status: <strong>{STATE_LABEL[tracking.ap_state]}</strong>
            {tracking.rejection_reason ? <span className="text-danger"> — {tracking.rejection_reason}</span> : null}</p>
          {isOpen && tracking.ap_state !== 'paid' && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                {a2c.AP_TRANSITIONS[tracking.ap_state].filter((s) => s === 'received' || s === 'approved').map((s) => (
                  <Button key={s} size="sm" variant="secondary" disabled={!!busy} onClick={() => run(`ap-${s}`, () => a2c.setApState(invoice.id, s as 'received' | 'approved'), `Marked ${s}.`)}>Mark {s}</Button>
                ))}
              </div>
              {a2c.canTransitionAp(tracking.ap_state, 'rejected') && (
                <div className="flex flex-wrap items-end gap-2">
                  <input className={`${input} sm:max-w-sm`} aria-label="Rejection reason" placeholder="Rejection reason (required)" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
                  <Button size="sm" variant="secondary" disabled={!!busy || !rejectReason.trim()}
                    onClick={() => run('ap-rej', async () => { await a2c.setApState(invoice.id, 'rejected', rejectReason.trim()); setRejectReason(''); }, 'Marked rejected and added to Recovery.')}>Mark rejected</Button>
                </div>
              )}
            </div>
          )}
        </div>
      ) : null}

      {/* Follow-up ladder */}
      {isOpen && tracking && tracking.ap_state !== 'paid' && (
        <div className="space-y-2">
          <p className="text-sm text-text-primary">Follow-ups ({settings.a2c_followup_days.join(', ')} days after due)</p>
          {tracking.ap_state === 'rejected' ? (
            <p className="text-xs text-text-tertiary">Rejected invoices are not dunned automatically; resolve the rejection first.</p>
          ) : !tracking.followups_approved_at ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" variant="secondary" disabled={!!busy || !invoice.due_date}
                onClick={() => run('fu-approve', () => a2c.approveFollowups(invoice.id), 'Follow-ups approved.')}>Approve automatic follow-up emails</Button>
              <span className="text-xs text-text-tertiary">{invoice.due_date ? 'Nothing is emailed until you approve.' : 'Set a due date first.'}</span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs text-text-secondary">Approved · {tracking.last_ladder_step} sent{tracking.followups_paused ? ' · paused' : ''}</span>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => run('fu-pause', () => a2c.setFollowupsPaused(invoice.id, !tracking.followups_paused), tracking.followups_paused ? 'Resumed.' : 'Paused.')}>{tracking.followups_paused ? 'Resume' : 'Pause'}</Button>
            </div>
          )}
        </div>
      )}

      {/* Packet */}
      <Button size="sm" variant="secondary" disabled={!!busy} onClick={downloadPacket}><FileDown className="h-4 w-4" aria-hidden />Download invoice packet (PDF)</Button>

      {/* Demand-letter draft */}
      {isOpen && overdue !== null && overdue >= 1 && (
        <div className="space-y-2 border-t border-border pt-4">
          <p className="text-sm font-medium text-text-primary">Payment-request draft</p>
          <p className="text-xs text-text-tertiary">A factual draft for you to edit and send yourself. Vireek never sends it and it contains no legal advice. Review it before use.</p>
          {!draftText && <Button size="sm" variant="secondary" disabled={!!busy} onClick={generateDraft}>Generate draft</Button>}
          {draftText && (
            <>
              <textarea className={input} rows={12} aria-label="Payment-request draft" value={draftText} readOnly={draft?.status === 'reviewed'} onChange={(e) => setDraftText(e.target.value)} />
              <div className="flex flex-wrap gap-2">
                {draft?.status !== 'reviewed' && (
                  <Button size="sm" variant="secondary" disabled={!!busy || !draftText.trim()} onClick={() => run('draft-save', async () => { await a2c.saveDemandDraft(invoice.id, draftText); }, 'Draft saved.')}>Save draft</Button>
                )}
                {draft?.status === 'draft' && draft.body === draftText && (
                  <Button size="sm" disabled={!!busy} onClick={() => run('draft-review', () => a2c.reviewDemandDraft(draft.id), 'Marked as reviewed.')}>Mark reviewed</Button>
                )}
                {draft?.status === 'reviewed' && <span className="self-center text-xs text-success">Reviewed {draft.reviewed_at ? new Date(draft.reviewed_at).toLocaleDateString() : ''}</span>}
                <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => { void navigator.clipboard?.writeText(draftText); toast('Copied.', 'success'); }}>Copy</Button>
                {draft && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => run('draft-discard', async () => { await a2c.discardDemandDraft(draft.id); setDraftText(''); }, 'Draft discarded.')}>Discard</Button>}
              </div>
            </>
          )}
        </div>
      )}

      {/* Policy */}
      <details className="border-t border-border pt-3">
        <summary className="cursor-pointer text-xs font-medium text-text-secondary">Approval and follow-up settings</summary>
        <div className="mt-3 space-y-3">
          <label className="flex items-center gap-2 text-sm text-text-primary"><input type="checkbox" checked={settings.a2c_require_po} onChange={(e) => setSettings({ ...settings, a2c_require_po: e.target.checked })} />Block invoices that have no customer PO</label>
          <label className="flex items-center gap-2 text-sm text-text-primary"><input type="checkbox" checked={settings.a2c_require_completion_proof} onChange={(e) => setSettings({ ...settings, a2c_require_completion_proof: e.target.checked })} />Block invoices that have no completion proof</label>
          <div>
            <label htmlFor="a2c-days" className="text-xs font-medium text-text-secondary">Follow-up days after due date (comma separated, ascending)</label>
            <input id="a2c-days" className={input} value={daysText} onChange={(e) => setDaysText(e.target.value)} />
          </div>
          <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => run('settings', async () => {
            const days = daysText.split(',').map((x) => x.trim()).filter(Boolean).map(Number);
            const v = a2c.validateLadder(days);
            if (!v.ok) throw new Error(v.error);
            await a2c.saveSettings({ ...settings, a2c_followup_days: days });
          }, 'Settings saved.')}>Save settings</Button>
        </div>
      </details>
    </section>
  );
}
