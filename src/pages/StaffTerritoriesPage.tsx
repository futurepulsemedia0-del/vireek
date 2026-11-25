/**
 * Territory exclusivity admin — /staff/territories (Vireek staff only, wrapped in <StaffRoute>)
 * Create / activate / suspend / end exclusive territories (trade × ZIP or polygon), see conflicts before saving,
 * run the waiting list, and read the append-only audit log. Legal terms: TODO(counsel). Fees / hold times: TODO(owner).
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { FIELD, TerritoryShapeFields, emptyShape, shapeFromDraft, type ShapeDraft } from '@/components/territory/TerritoryShapeFields';
import { activationVerdict, validateTerms, type Conflict } from '@/lib/territoryExclusivity/core';
import {
  friendlyTerritoryError, staffActivateFromWaitlist, staffAudit, staffCheck, staffCreate, staffOverview, staffSetStatus, staffWaitlistOffer,
  type AuditRow, type StaffTerritory, type StaffWait,
} from '@/lib/territoryExclusivity/api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const today = () => new Date().toISOString().slice(0, 10);
const plusYear = () => new Date(Date.now() + 364 * 86_400_000).toISOString().slice(0, 10);
const fmt = (iso: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: iso.length > 10 ? 'short' : undefined }).format(new Date(iso));
const BOX = 'rounded-xl border border-border p-4';

export function StaffTerritoriesPage() {
  const { toast } = useToast();
  const [data, setData] = useState<{ exclusivities: StaffTerritory[]; waitlist: StaffWait[] } | null>(null);
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  const [tab, setTab] = useState<'territories' | 'waitlist' | 'audit'>('territories');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const [accountId, setAccountId] = useState('');
  const [label, setLabel] = useState('');
  const [shape, setShape] = useState<ShapeDraft>(emptyShape());
  const [termStart, setTermStart] = useState(today());
  const [termEnd, setTermEnd] = useState(plusYear());
  const [autoRenew, setAutoRenew] = useState(false);
  const [noticeDays, setNoticeDays] = useState('');
  const [contractRef, setContractRef] = useState('');
  const [feeText, setFeeText] = useState('');
  const [currency, setCurrency] = useState('');
  const [legalRef, setLegalRef] = useState('');
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [ack, setAck] = useState(false);

  const load = useCallback(async () => {
    try { setData(await staffOverview()); setFailed(false); } catch { setFailed(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (tab === 'audit') staffAudit().then(setAudit, () => toast('Could not load the audit log.', 'error')); }, [tab, toast]);

  const run = async (tag: string, fn: () => Promise<string | void>) => {
    setBusy(tag);
    try { const m = await fn(); if (m) toast(m, 'success'); await load(); if (tab === 'audit') setAudit(await staffAudit()); }
    catch (e) { toast(friendlyTerritoryError(e), 'error'); }
    finally { setBusy(null); }
  };
  const needReason = () => { if (reason.trim().length < 5) { toast('Enter a reason (5+ characters). It is written to the audit log.', 'error'); return false; } return true; };

  const termFields = () => {
    const fee = feeText.trim() === '' ? null : Math.round(Number(feeText) * 100);
    return { termStart, termEnd, renewalNoticeDays: noticeDays === '' ? null : Number(noticeDays), feeCents: fee, feeCurrency: currency.trim().toUpperCase() || null };
  };
  const parsed = shapeFromDraft(shape);
  const formError = !UUID.test(accountId.trim()) ? 'Enter the account owner id (profile UUID).' : !label.trim() ? 'Give the territory a short name.' : 'error' in parsed ? parsed.error : validateTerms(termFields());

  const check = () => run('check', async () => {
    if ('error' in parsed) throw Object.assign(new Error(parsed.error), { code: 'P0001' });
    const c = await staffCheck(parsed.shape, { termStart, termEnd });
    setConflicts(c); setAck(false);
    return c.length ? `${c.length} conflict(s) found.` : 'No conflicts — the area is free for this term.';
  });
  const create = (activate: boolean) => run(activate ? 'activate' : 'draft', async () => {
    if (formError || 'error' in parsed || !needReason()) throw Object.assign(new Error(formError ?? 'Enter a reason (5+ characters).'), { code: 'P0001' });
    const t = termFields();
    const r = await staffCreate({
      accountId: accountId.trim(), label: label.trim(), shape: parsed.shape, reason: reason.trim(), activate, acknowledgeUnverifiable: ack,
      terms: { ...t, autoRenew, contractReference: contractRef.trim() || undefined, legalTermsRef: legalRef.trim() || undefined },
    });
    setConflicts(null); setLabel(''); setShape(emptyShape());
    return r.status === 'active' ? 'Territory activated.' : 'Draft saved.';
  });

  const verdict = conflicts ? activationVerdict(conflicts) : null;

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-semibold">Territory exclusivity</h1>
        <p className="mt-1 text-sm text-text-secondary">At most one account holds a trade in an area during a term. Active and suspended grants both block others. Legal terms: <strong>TODO(counsel)</strong> — nothing here is a contract.</p>
      </header>

      <Card className="space-y-4 p-5">
        <h2 className="text-base font-semibold">New territory</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label htmlFor="st-acc" className="mb-1 block text-sm font-medium">Account owner id</label><input id="st-acc" className={FIELD} value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="profile UUID" /></div>
          <div><label htmlFor="st-label" className="mb-1 block text-sm font-medium">Name</label><input id="st-label" maxLength={80} className={FIELD} value={label} onChange={(e) => setLabel(e.target.value)} /></div>
        </div>
        <TerritoryShapeFields idPrefix="st" value={shape} onChange={(v) => { setShape(v); setConflicts(null); }} />
        <div className="grid gap-3 sm:grid-cols-4">
          <div><label htmlFor="st-s" className="mb-1 block text-sm font-medium">Term start</label><input id="st-s" type="date" className={FIELD} value={termStart} onChange={(e) => { setTermStart(e.target.value); setConflicts(null); }} /></div>
          <div><label htmlFor="st-e" className="mb-1 block text-sm font-medium">Term end (inclusive)</label><input id="st-e" type="date" className={FIELD} value={termEnd} onChange={(e) => { setTermEnd(e.target.value); setConflicts(null); }} /></div>
          <div><label htmlFor="st-n" className="mb-1 block text-sm font-medium">Renewal notice (days)</label><input id="st-n" inputMode="numeric" className={FIELD} value={noticeDays} onChange={(e) => setNoticeDays(e.target.value)} /></div>
          <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} /> Auto-renew (recorded only, not executed)</label>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <div><label htmlFor="st-f" className="mb-1 block text-sm font-medium">Fee (TODO(owner))</label><input id="st-f" inputMode="decimal" className={FIELD} value={feeText} onChange={(e) => setFeeText(e.target.value)} /></div>
          <div><label htmlFor="st-c" className="mb-1 block text-sm font-medium">Currency</label><input id="st-c" maxLength={3} className={FIELD} value={currency} onChange={(e) => setCurrency(e.target.value)} placeholder="USD" /></div>
          <div><label htmlFor="st-cr" className="mb-1 block text-sm font-medium">Contract reference</label><input id="st-cr" maxLength={80} className={FIELD} value={contractRef} onChange={(e) => setContractRef(e.target.value)} /></div>
          <div><label htmlFor="st-lr" className="mb-1 block text-sm font-medium">Approved terms ref (TODO(counsel))</label><input id="st-lr" maxLength={80} className={FIELD} value={legalRef} onChange={(e) => setLegalRef(e.target.value)} /></div>
        </div>
        <div><label htmlFor="st-reason" className="mb-1 block text-sm font-medium">Reason — required for every change, written to the audit log</label><input id="st-reason" maxLength={200} className={FIELD} value={reason} onChange={(e) => setReason(e.target.value)} /></div>

        {conflicts && (
          <div role="status" className={`${BOX} text-sm`}>
            {conflicts.length === 0 ? 'No conflicts for this trade, area and term.' : (
              <ul className="space-y-1">
                {conflicts.map((c) => <li key={c.id}>{c.kind === 'unverifiable_mixed' ? 'A ZIP territory and a polygon territory overlap in time and cannot be compared automatically.' : c.kind === 'zip_overlap' ? `Shares ${c.sharedZips.slice(0, 8).join(', ')}${c.sharedZips.length > 8 ? '…' : ''}` : 'Polygon overlaps (touching borders count)'} — account {c.accountId.slice(0, 8)}…</li>)}
              </ul>
            )}
            {verdict?.ok && verdict.needsAcknowledgement && <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I reviewed the unverifiable overlap manually and accept responsibility.</label>}
          </div>
        )}
        {formError && <p className="text-xs text-text-secondary">{formError}</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={!!busy} onClick={() => void check()}>{busy === 'check' ? <Loader2 size={14} className="animate-spin" /> : null}<span>Check conflicts</span></Button>
          <Button variant="secondary" disabled={!!busy || !!formError} onClick={() => void create(false)}>Save as draft</Button>
          <Button disabled={!!busy || !!formError || (verdict ? !verdict.ok || (verdict.needsAcknowledgement && !ack) : false)} onClick={() => void create(true)}>Create &amp; activate</Button>
        </div>
      </Card>

      <div role="tablist" aria-label="Territory views" className="flex gap-2">
        {(['territories', 'waitlist', 'audit'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`rounded-lg px-3 py-1.5 text-sm ${tab === t ? 'bg-bg-secondary font-semibold' : 'text-text-secondary'}`} onClick={() => setTab(t)}>{t === 'territories' ? 'Territories' : t === 'waitlist' ? 'Waiting list' : 'Audit log'}</button>
        ))}
      </div>

      {failed ? <p role="alert" className="text-sm">Could not load territories (staff access required).</p> : !data ? <p role="status" className="text-sm text-text-secondary">Loading…</p> : tab === 'territories' ? (
        data.exclusivities.length === 0 ? <p className="text-sm text-text-secondary">No territories yet.</p> : (
          <ul className="space-y-3">
            {data.exclusivities.map((t) => (
              <li key={t.id} className={BOX}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{t.label} · {t.trade} · {t.account_name}</span>
                  <span className="text-xs font-semibold uppercase">{t.status}</span>
                </div>
                <p className="mt-1 text-xs text-text-secondary">
                  {t.zone_type === 'zip' ? `${t.zip_codes.length} code(s): ${t.zip_codes.slice(0, 10).join(', ')}${t.zip_codes.length > 10 ? '…' : ''}` : `Polygon, ${t.polygon_points} points`} · {fmt(t.term_start)} → {fmt(t.term_end)}
                  {t.status !== 'ended' && t.days_left >= 0 ? ` (${t.days_left} days left)` : ''}{t.auto_renew ? ' · auto-renew flagged (manual)' : ''}{t.contract_reference ? ` · ${t.contract_reference}` : ''}
                  {t.fee_cents != null ? ` · fee ${(t.fee_cents / 100).toFixed(2)} ${t.fee_currency}` : ''}{t.ended_reason ? ` · ended: ${t.ended_reason}` : ''}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {t.status === 'draft' && <Button size="sm" disabled={!!busy} onClick={() => needReason() && void run(`a${t.id}`, async () => { await staffSetStatus(t.id, 'active', reason.trim(), ack); return 'Activated.'; })}>Activate</Button>}
                  {t.status === 'active' && <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => needReason() && void run(`s${t.id}`, async () => { await staffSetStatus(t.id, 'suspended', reason.trim()); return 'Suspended (still reserved).'; })}>Suspend</Button>}
                  {t.status === 'suspended' && <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => needReason() && void run(`r${t.id}`, async () => { await staffSetStatus(t.id, 'active', reason.trim()); return 'Resumed.'; })}>Resume</Button>}
                  {t.status !== 'ended' && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => { if (needReason() && window.confirm('End this territory? It is released immediately and the waiting list is processed.')) void run(`e${t.id}`, async () => { const r = await staffSetStatus(t.id, 'ended', reason.trim()); return r.waitlist_offered.length ? `Ended. ${r.waitlist_offered.length} waiting-list offer(s) sent.` : 'Ended.'; }); }}>End</Button>}
                </div>
              </li>
            ))}
          </ul>
        )
      ) : tab === 'waitlist' ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">{[...new Set(data.waitlist.map((w) => w.trade))].map((tr) => <Button key={tr} size="sm" variant="secondary" disabled={!!busy} onClick={() => void run(`o${tr}`, async () => { const r = await staffWaitlistOffer(tr); return `${r.offered.length} offer(s) sent for ${tr}.`; })}>Process {tr}</Button>)}</div>
          {data.waitlist.length === 0 ? <p className="text-sm text-text-secondary">Nobody is waiting.</p> : (
            <ul className="space-y-3">
              {data.waitlist.map((w, i) => (
                <li key={w.id} className={BOX}>
                  <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">#{i + 1} {w.label} · {w.trade} · {w.account_name}</span><span className="text-xs font-semibold uppercase">{w.status}{w.status === 'waiting' && w.available_now ? ' · available now' : ''}</span></div>
                  <p className="mt-1 text-xs text-text-secondary">Joined {fmt(w.created_at)}{w.offer_expires_at ? ` · offer held until ${fmt(w.offer_expires_at)}` : ''}</p>
                  {w.status === 'accepted' && <Button className="mt-2" size="sm" disabled={!!busy} onClick={() => needReason() && void run(`w${w.id}`, async () => { await staffActivateFromWaitlist(w.id, { termStart, termEnd, autoRenew, contractReference: contractRef.trim() || undefined, legalTermsRef: legalRef.trim() || undefined }, reason.trim()); return 'Territory created from the waiting list.'; })}>Create territory with the term above</Button>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : !audit ? <p role="status" className="text-sm text-text-secondary">Loading…</p> : (
        <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="text-text-secondary"><th className="py-1 pr-3">When</th><th className="pr-3">Who</th><th className="pr-3">Account</th><th className="pr-3">Action</th><th>Reason</th></tr></thead>
          <tbody>{audit.map((a) => <tr key={a.id} className="border-t border-border align-top"><td className="py-1 pr-3 whitespace-nowrap">{fmt(a.occurred_at)}</td><td className="pr-3">{a.actor_email ?? a.actor_kind}</td><td className="pr-3">{a.account_name}</td><td className="pr-3">{a.action}</td><td>{a.reason}</td></tr>)}</tbody></table></div>
      )}
    </main>
  );
}
