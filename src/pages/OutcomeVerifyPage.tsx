/**
 * Public outcome verification - /outcome/:token
 *
 * Token-gated and opt-in per record. A verifier link (insurer, buyer) is read-only; a customer link also
 * lets the customer confirm or dispute the outcome. Shows no names, addresses or amounts.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import {
  BAND_LABEL,
  DISPUTE_REASONS,
  SOURCE_LABEL,
  STATUS_META,
  TONE_CLASS,
  clearingErrorMessage,
  fetchPublicOutcome,
  formatSpec,
  respondPublic,
  shortHash,
  type DisputeReason,
  type PublicOutcome,
} from '@/lib/outcomeClearinghouse';

const inputCls = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

export function OutcomeVerifyPage() {
  const { token = '' } = useParams();
  const [data, setData] = useState<PublicOutcome | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [showDispute, setShowDispute] = useState(false);
  const [reason, setReason] = useState<DisputeReason>('not_fixed');
  const [text, setText] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await fetchPublicOutcome(token));
    } catch {
      setData(null);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const respond = async (action: 'confirm' | 'dispute') => {
    setBusy(true);
    setMsg(null);
    try {
      await respondPublic(token, action, reason, text);
      setMsg({ tone: 'ok', text: action === 'confirm' ? 'Thank you - your confirmation was recorded.' : 'Your report was recorded. The business has been notified and settlement is on hold until it is resolved.' });
      setShowDispute(false);
      setText('');
      await load();
    } catch (e) {
      setMsg({ tone: 'err', text: clearingErrorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const meta = data ? STATUS_META[data.status] : null;
  const ledgerOk = data?.proof.ledger.valid;

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex-1 px-4 py-12">
        <div className="mx-auto w-full max-w-xl space-y-4">
          {data === undefined && <p className="py-20 text-center text-sm text-text-secondary">Loading…</p>}

          {data === null && (
            <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark">
              <AlertCircle size={28} className="mx-auto mb-3 text-text-secondary" />
              <h1 className="text-lg font-semibold text-text-primary">Verification not available</h1>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">This link isn't valid, was replaced, or the business has not enabled verification for this service. Please contact the business directly.</p>
            </div>
          )}

          {data && meta && (
            <>
              <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark">
                <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{data.business_name ?? 'Service provider'}{data.completed_on ? ` · completed ${data.completed_on}` : ''}</p>
                <h1 className="mt-1 text-lg font-semibold text-text-primary">{data.claim_statement}</h1>
                <span className={`mt-3 inline-block rounded-full px-3 py-1 text-xs font-medium ${TONE_CLASS[meta.tone]}`}>{meta.label}</span>
                <p className="mt-4 text-5xl font-semibold text-text-primary">{data.confidence}<span className="text-lg text-text-secondary"> / 100</span></p>
                <p className="mt-1 text-xs text-text-secondary">{BAND_LABEL[data.band]}</p>
                {data.open_dispute && <p className="mt-3 text-xs text-danger">A dispute is open on this outcome.</p>}
              </div>

              <div className="rounded-2xl border border-border bg-bg-secondary p-5">
                <p className="mb-3 text-sm font-semibold text-text-primary">What the score is based on</p>
                <ul className="space-y-2 text-xs">
                  {data.components.map((c) => (
                    <li key={c.key} className="flex items-center justify-between"><span className="text-text-primary">{c.label}</span><span className="text-text-secondary">{c.points} / {c.weight}</span></li>
                  ))}
                </ul>
              </div>

              {data.measurements.length > 0 && (
                <div className="rounded-2xl border border-border bg-bg-secondary p-5">
                  <p className="mb-3 text-sm font-semibold text-text-primary">Measured results</p>
                  <ul className="space-y-2 text-xs">
                    {data.measurements.map((x, i) => (
                      <li key={`${x.label}-${x.phase}-${i}`} className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-text-primary">{x.label} <span className="text-text-secondary">({x.phase})</span></span>
                        <span className="text-text-secondary">{x.value}{x.unit ? ` ${x.unit}` : ''} · expected {formatSpec(x)} · {SOURCE_LABEL[x.source]}</span>
                        {x.within_spec !== null && <span className={x.within_spec ? 'text-success-500' : 'text-danger'}>{x.within_spec ? 'In spec' : 'Out of spec'}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="rounded-2xl border border-border bg-bg-secondary p-5">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary">
                  {ledgerOk ? <ShieldCheck size={16} className="text-success-500" /> : <ShieldAlert size={16} className="text-danger" />}
                  Tamper-evident record
                </div>
                <p className="text-xs text-text-secondary">
                  {ledgerOk ? `The audit ledger (${data.proof.ledger.entries} entries) was re-computed just now and is intact.` : 'The audit ledger failed its integrity check.'}
                </p>
                <p className="mt-2 break-all text-[10px] text-text-secondary">Ledger head {shortHash(data.proof.ledger.head_hash, 24)} · Evidence head {shortHash(data.proof.evidence_head_hash, 24)} ({data.proof.evidence_entries} entries)</p>
              </div>

              {data.role === 'customer' && (
                <div className="rounded-2xl border border-border bg-bg-secondary p-5">
                  <p className="mb-1 text-sm font-semibold text-text-primary">Is the problem solved?</p>
                  <p className="mb-3 text-xs text-text-secondary">Your answer is recorded in the audit trail and affects the business's payment clearance.</p>
                  {msg && <p role="status" className={`mb-3 rounded-xl px-4 py-3 text-sm ${msg.tone === 'ok' ? 'bg-success-500/10 text-success-500' : 'bg-danger/10 text-danger'}`}>{msg.text}</p>}
                  {data.customer_confirmed && <p className="mb-3 text-xs text-success-500">You confirmed this outcome.</p>}
                  <div className="flex flex-wrap gap-2">
                    {data.can_respond && <button className="focus-ring rounded-xl bg-cta px-4 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={busy} onClick={() => void respond('confirm')}>Yes, it's solved</button>}
                    {data.can_dispute && <button className="focus-ring rounded-xl bg-bg-tertiary px-4 py-2 text-sm font-medium text-text-secondary disabled:opacity-50" disabled={busy} onClick={() => setShowDispute((v) => !v)}>No, report a problem</button>}
                  </div>
                  {showDispute && (
                    <div className="mt-4 space-y-2">
                      <select className={inputCls} value={reason} onChange={(e) => setReason(e.target.value as DisputeReason)}>{DISPUTE_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select>
                      <textarea className={inputCls} rows={3} maxLength={2000} placeholder="Tell us what is wrong (at least 5 characters)" value={text} onChange={(e) => setText(e.target.value)} />
                      <button className="focus-ring rounded-xl bg-danger px-4 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={busy || text.trim().length < 5} onClick={() => void respond('dispute')}>Send report</button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
