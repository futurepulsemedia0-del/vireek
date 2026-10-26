import { useEffect, useMemo, useState } from 'react';
import { X, FileDown, ShieldCheck, Send, CheckCircle2, Ban, Undo2, Landmark } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import {
  approvePacket, confirmRecovery, dismissFinding, markPacketSent, reopenFinding, savePacket, loadBankDeposits,
  type AuditData, type FindingRecord,
} from '@/lib/supplierAudit/api';
import { formatMoney, todayInZone } from '@/lib/supplierAudit/money';
import { buildDraftMessage, canApprove, canMarkSent, missingItems, type PacketFinding } from '@/lib/supplierAudit/packet';
import { buildClaimPacketPdf, packetFileName } from '@/lib/supplierAudit/packetPdf';
import { suggestDepositMatches, type BankTxnLite } from '@/lib/supplierAudit/reconcile';
import { LIKELY_OWED_WORDING } from '@/lib/supplierAudit/engine';
import { BandPill, RiskPill, STATUS_LABELS, TYPE_LABELS, btnGhost, btnPrimary, inputClass, Pill } from './shared';

interface Props { finding: FindingRecord; data: AuditData; businessName: string; timeZone: string; onClose: () => void; onChanged: () => Promise<void> | void }

export function FindingDrawer({ finding: f, data, businessName, timeZone, onClose, onChanged }: Props) {
  const { toast } = useToast();
  const vendor = data.vendors.find((v) => v.id === f.vendor_id)?.name ?? 'Supplier';
  const program = useMemo(() => data.programs.find((p) => p.id === f.program_id) ?? null, [data.programs, f.program_id]);
  const packet = useMemo(() => data.packets.filter((p) => p.finding_id === f.id && p.status !== 'cancelled').sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null, [data.packets, f.id]);
  const today = todayInZone(new Date(), timeZone);
  const pf: PacketFinding = useMemo(() => ({ id: f.id, title: f.title, summary: f.summary, type: f.finding_type, currency: f.currency, low_cents: f.low_cents, likely_cents: f.likely_cents, high_cents: f.high_cents, confidence: f.confidence, deadline: f.deadline, evidence: f.evidence, warnings: f.warnings, how_calculated: f.how_calculated }), [f]);
  const checklist = useMemo(() => missingItems(pf, program, today), [pf, program, today]);
  const [message, setMessage] = useState(packet?.draft_message || buildDraftMessage(pf, vendor, businessName, program));
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [sentNote, setSentNote] = useState('');
  const [deposits, setDeposits] = useState<BankTxnLite[] | null>(null);
  const money = (c: number) => formatMoney(c, f.currency);
  const closed = ['dismissed', 'superseded', 'recovered'].includes(f.status);
  const active = !closed && !f.is_opportunity;
  const used = useMemo(() => new Set(data.recoveries.map((r) => r.evidence_label ?? '')), [data.recoveries]);

  useEffect(() => { setMessage(packet?.draft_message || buildDraftMessage(pf, vendor, businessName, program)); }, [f.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (active) void loadBankDeposits().then(setDeposits); }, [f.id, active]);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);

  const suggestions = useMemo(() => (deposits && active
    ? suggestDepositMatches({ vendorName: vendor, lowCents: f.low_cents, likelyCents: f.likely_cents, highCents: f.high_cents, firstSeenDate: f.first_seen_at.slice(0, 10) }, deposits, new Set()) : []), [deposits, active, vendor, f]);

  const run = async (key: string, fn: () => Promise<void>, ok: string) => {
    setBusy(key);
    try { await fn(); toast(ok, 'success'); await onChanged(); } catch (e) { toast(e instanceof Error ? e.message : 'Something went wrong', 'error'); } finally { setBusy(null); }
  };
  const snapshot = () => ({ finding: pf, program: program ? { id: program.id, name: program.name, sourceUrl: program.sourceUrl, lastVerifiedAt: program.lastVerifiedAt } : null, generatedAt: new Date().toISOString() });
  const downloadPdf = () => {
    const doc = buildClaimPacketPdf({ businessName, vendorName: vendor, generatedAt: new Date().toISOString(), finding: pf, program, checklist, draftMessage: message, status: packet?.status ?? 'draft' });
    doc.save(packetFileName(vendor, f.id, new Date().toISOString()));
  };
  const memoEvidence = f.evidence.filter((e) => e.kind === 'credit_memo').map((e) => ({ e, memo: data.memos.find((m) => m.id === e.id) })).filter((x) => x.memo && ['applied', 'partially_applied'].includes(x.memo.applied_status));
  const warrantyReady = f.warranty_claim_id && data.input.warrantyClaims.find((c) => c.id === f.warranty_claim_id)?.status === 'credit_received';
  void used;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Finding details">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <aside className="relative flex h-full w-full flex-col overflow-y-auto bg-bg-primary shadow-2xl sm:max-w-xl">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-bg-primary p-4">
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap gap-2"><Pill cls="bg-accent/10 text-accent">{TYPE_LABELS[f.finding_type]}</Pill><Pill cls="bg-bg-tertiary text-text-secondary">{STATUS_LABELS[f.status]}</Pill><Pill cls="bg-warning-500/10 text-warning-500">Estimate</Pill></div>
            <h2 className="text-base font-bold text-text-primary">{f.title}</h2>
          </div>
          <button type="button" onClick={onClose} className={btnGhost} aria-label="Close"><X size={16} /></button>
        </header>

        <div className="space-y-5 p-4">
          <section>
            <p className="text-sm text-text-secondary">{f.summary}</p>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              {([['Low', f.low_cents], ['Likely', f.likely_cents], ['High', f.high_cents]] as const).map(([l, v]) => (
                <div key={l} className="rounded-xl border border-border bg-bg-secondary p-3"><p className="text-xs text-text-secondary">{l}</p><p className="text-base font-bold text-text-primary">{money(v)}</p></div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2"><BandPill band={f.confidence_band} value={f.confidence} /><RiskPill risk={f.deadline_risk} />{f.deadline && <span className="text-xs text-text-secondary">Deadline {f.deadline}</span>}</div>
            {f.recovered_cents > 0 && <p className="mt-3 rounded-xl bg-success-500/10 p-3 text-sm font-medium text-success-500">Confirmed recovered: {money(f.recovered_cents)} (measured from receipts)</p>}
            <p className="mt-3 text-xs text-text-secondary">{LIKELY_OWED_WORDING}. Not legal or financial advice.</p>
          </section>

          <section><h3 className="mb-2 text-sm font-semibold text-text-primary">How this was calculated</h3>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-text-secondary">{f.how_calculated.map((s, i) => <li key={i}>{s}</li>)}</ol>
            {f.warnings.length > 0 && <ul className="mt-3 space-y-1 rounded-xl border border-warning-500/30 bg-warning-500/5 p-3 text-xs text-text-primary">{f.warnings.map((w, i) => <li key={i}>• {w}</li>)}</ul>}
          </section>

          <section><h3 className="mb-2 text-sm font-semibold text-text-primary">Evidence</h3>
            {f.evidence.length === 0 ? <p className="text-sm text-text-secondary">No evidence attached.</p> : (
              <ul className="space-y-1 text-sm">{f.evidence.map((e, i) => <li key={`${e.id}-${i}`} className="flex justify-between gap-3 rounded-lg bg-bg-secondary px-3 py-2"><span className="min-w-0 break-words text-text-primary">{e.label}{e.detail ? <span className="text-text-secondary"> — {e.detail}</span> : null}</span>{e.amountCents !== undefined && <span className="shrink-0 font-medium text-text-primary">{money(e.amountCents)}</span>}</li>)}</ul>)}
          </section>

          {program && (
            <section><h3 className="mb-2 text-sm font-semibold text-text-primary">Program rule</h3>
              <p className="text-sm text-text-secondary">{program.name} · last verified {program.lastVerifiedAt ?? 'never'}{program.sourceUrl ? <> · <a className="text-accent underline" href={program.sourceUrl} target="_blank" rel="noopener noreferrer">source</a></> : ' · no source URL'}</p></section>
          )}

          {active && (
            <section className="space-y-3"><h3 className="text-sm font-semibold text-text-primary">Claim packet</h3>
              <ul className="space-y-1 text-sm">{checklist.map((c, i) => <li key={i} className={c.ok ? 'text-text-secondary' : c.blocking ? 'font-medium text-danger' : 'text-warning-500'}>{c.ok ? '✓' : c.blocking ? '✗ Missing:' : '!'} {c.label}{c.note ? ` — ${c.note}` : ''}</li>)}</ul>
              <label className="block text-xs font-medium text-text-secondary">Draft message to your rep (never sent automatically)
                <textarea className={`${inputClass} mt-1`} rows={8} value={message} onChange={(e) => setMessage(e.target.value)} disabled={packet?.status === 'approved' || packet?.status === 'marked_sent'} /></label>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={btnGhost} disabled={busy !== null || packet?.status === 'approved' || packet?.status === 'marked_sent'} onClick={() => run('save', async () => { await savePacket(f.id, message, checklist, snapshot()); }, 'Draft saved')}>Save draft</button>
                <button type="button" className={btnGhost} onClick={downloadPdf}><FileDown size={16} /> Download PDF</button>
                {packet && canApprove(packet) && <button type="button" className={btnPrimary} disabled={busy !== null} onClick={() => run('approve', async () => { await approvePacket(packet.id); }, 'Packet approved')}><ShieldCheck size={16} /> Approve packet</button>}
              </div>
              {packet?.status === 'approved' && canMarkSent(packet) && (
                <div className="space-y-2 rounded-xl border border-border p-3"><p className="text-xs text-text-secondary">Approved. Send it yourself (email or portal) — Vireek never submits claims. Then record it here.</p>
                  <input className={inputClass} placeholder="Optional note (who you sent it to)" value={sentNote} onChange={(e) => setSentNote(e.target.value)} maxLength={500} />
                  <button type="button" className={btnPrimary} disabled={busy !== null} onClick={() => run('sent', async () => { await markPacketSent(packet.id, sentNote); }, 'Marked as sent')}><Send size={16} /> I sent it — mark as sent</button></div>)}
              {packet?.status === 'marked_sent' && <p className="text-sm text-success-500">Marked as sent {packet.sent_marked_at?.slice(0, 10)}.</p>}
              {!packet && <p className="text-xs text-text-secondary">Save the draft first, then approve it. Nothing is sent without your approval.</p>}
            </section>
          )}

          {active && (
            <section className="space-y-3"><h3 className="text-sm font-semibold text-text-primary">Confirm a receipt (this is what makes it “recovered”)</h3>
              {warrantyReady && <button type="button" className={btnPrimary} disabled={busy !== null} onClick={() => run('w', async () => { await confirmRecovery(f.id, 'warranty_credit', f.warranty_claim_id as string); }, 'Warranty credit confirmed')}><CheckCircle2 size={16} /> Confirm warranty credit received</button>}
              {memoEvidence.map(({ e, memo }) => <button key={e.id} type="button" className={btnGhost} disabled={busy !== null} onClick={() => run(`m${e.id}`, async () => { await confirmRecovery(f.id, 'credit_applied', e.id); }, 'Applied credit confirmed')}><CheckCircle2 size={16} /> Credit memo {memo?.memo_no ?? ''} was applied — confirm</button>)}
              {deposits === null ? <p className="text-xs text-text-secondary">Looking for matching bank deposits…</p> : suggestions.length === 0 ? <p className="text-xs text-text-secondary">No matching bank deposit yet. Deposits are matched on vendor name and amount, only after this finding appeared.</p> : (
                <ul className="space-y-2">{suggestions.map((s) => (
                  <li key={s.txn.id} className="flex items-center justify-between gap-3 rounded-xl border border-border p-3 text-sm"><span className="min-w-0"><span className="flex items-center gap-1 font-medium text-text-primary"><Landmark size={14} />{money(s.txn.amountCents)} · {s.txn.postedDate}</span><span className="block truncate text-xs text-text-secondary">{s.txn.description} — {s.reasons.join(', ')}</span></span>
                    <button type="button" className={btnPrimary} disabled={busy !== null} onClick={() => run(`b${s.txn.id}`, async () => { await confirmRecovery(f.id, 'bank_deposit', s.txn.id); }, 'Deposit confirmed')}>Confirm</button></li>))}</ul>)}
            </section>
          )}

          {!closed || f.status === 'dismissed' ? (
            <section className="space-y-2 border-t border-border pt-4">
              {f.status === 'dismissed' ? (<><p className="text-sm text-text-secondary">Dismissed: {f.dismiss_reason}</p><button type="button" className={btnGhost} disabled={busy !== null} onClick={() => run('reopen', async () => { await reopenFinding(f.id); }, 'Finding reopened')}><Undo2 size={16} /> Reopen</button></>) : (
                <><label className="block text-xs font-medium text-text-secondary">Dismiss this finding (reason required)<input className={`${inputClass} mt-1`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Already settled by phone" maxLength={500} /></label>
                  <button type="button" className={btnGhost} disabled={busy !== null || reason.trim().length < 3 || f.recovered_cents > 0} onClick={() => run('dismiss', async () => { await dismissFinding(f.id, reason.trim()); onClose(); }, 'Finding dismissed')}><Ban size={16} /> Dismiss</button></>)}
            </section>) : null}
        </div>
      </aside>
    </div>
  );
}
