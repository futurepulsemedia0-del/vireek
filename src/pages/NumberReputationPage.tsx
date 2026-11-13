// Recreated: verify against original intent
// /dashboard/phone-numbers/reputation
//
// Caller-ID and messaging readiness for the numbers you own: what name callers should see (CNAM), and the
// registration checklist that keeps numbers from being labelled "Spam Likely" or having texts filtered.
// TODO(vireek): no carrier reputation / spam-label data source exists in this repository, so this page does NOT
// show a per-number "reputation score" and never implies one. It shows the numbers you own and the steps that
// protect them. The checklist ticks are stored only in this browser (per signed-in user), not on the server.
// NOT LEGAL ADVICE: carrier and registry rules change; verify with your carrier and counsel.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { useAuth } from '@/contexts/AuthContext';
import { fetchPhoneNumbers, type PhoneNumber } from '@/lib/phoneNumbers';
import { A2P_CHECKLIST, CNAM_MAX, checklistProgress, suggestCnam, validateCnam } from '@/lib/telephonyBrand';

const card = 'rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5';
const storageKey = (userId: string) => `vireek:number-readiness:${userId}`;

function readTicks(userId: string): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const out: Record<string, boolean> = {};
    if (parsed && typeof parsed === 'object') for (const item of A2P_CHECKLIST) if ((parsed as Record<string, unknown>)[item.id] === true) out[item.id] = true;
    return out;
  } catch {
    return {}; // storage blocked or corrupt: start empty
  }
}

export function NumberReputationPage() {
  const { user, profile } = useAuth();
  const userId: string | null = user?.id ?? null;
  const [numbers, setNumbers] = useState<PhoneNumber[] | null>(null);
  const [error, setError] = useState(false);
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [cnamInput, setCnamInput] = useState('');
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(false);
    try {
      const n = await fetchPhoneNumbers();
      if (mine === seq.current) setNumbers(n);
    } catch {
      if (mine === seq.current) setError(true);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => { seq.current++; };
  }, [load]);

  useEffect(() => {
    if (userId) setTicks(readTicks(userId));
  }, [userId]);

  useEffect(() => {
    if (!cnamInput && profile?.company_name) setCnamInput(profile.company_name);
  }, [profile?.company_name, cnamInput]);

  const toggle = (id: string) => {
    setTicks((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      if (!next[id]) delete next[id];
      if (userId) {
        try { window.localStorage.setItem(storageKey(userId), JSON.stringify(next)); } catch { /* not persisted; still works this session */ }
      }
      return next;
    });
  };

  const progress = useMemo(() => checklistProgress(ticks), [ticks]);
  const cnam = useMemo(() => validateCnam(cnamInput), [cnamInput]);
  const active = (numbers ?? []).filter((n) => n.status === 'active');

  return (
    <DashboardLayout activeLabel="Number Reputation">
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><ShieldCheck size={22} aria-hidden="true" /> Number reputation</h1>
        <p className="mt-1 text-sm text-text-secondary">Help callers recognise you and keep your texts from being filtered. This page shows the steps that protect your numbers; it does not read carrier spam labels.</p>
      </div>

      <section className={card} aria-labelledby="nr-numbers">
        <h2 id="nr-numbers" className="text-base font-semibold text-text-primary">Your numbers</h2>
        {error && <p role="alert" className="mt-3 text-sm text-danger">Could not load your numbers. <button type="button" onClick={() => void load()} className="focus-ring font-semibold underline">Try again</button></p>}
        {!numbers && !error && <p role="status" className="mt-3 text-sm text-text-secondary">Loading…</p>}
        {numbers && numbers.length === 0 && <p className="mt-3 text-sm text-text-secondary">You have no numbers yet. <Link to="/dashboard/phone-numbers" className="focus-ring font-semibold text-accent underline">Get a number</Link></p>}
        {numbers && numbers.length > 0 && (
          <>
            <ul className="mt-3 divide-y divide-border rounded-xl border border-border text-sm">
              {numbers.map((n) => (
                <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span className="min-w-0"><span className="block font-medium text-text-primary">{n.friendly_name || n.phone_number}</span><span className="text-xs text-text-secondary">{n.phone_number} · {n.number_type.replace(/_/g, ' ')}</span></span>
                  <span className="text-xs text-text-secondary">{n.status}{n.sms_enabled ? ' · texting on' : ''}{n.is_primary ? ' · primary' : ''}</span>
                </li>
              ))}
            </ul>
            {active.some((n) => n.sms_enabled) && progress.legalPending.length > 0 && (
              <p role="status" className="mt-3 rounded-lg bg-warning-500/10 px-3 py-2 text-xs text-warning-500">Texting is on for at least one number, and {progress.legalPending.length} registration step{progress.legalPending.length === 1 ? '' : 's'} that may need legal review {progress.legalPending.length === 1 ? 'is' : 'are'} not ticked off yet.</p>
            )}
          </>
        )}
      </section>

      <section className={`${card} mt-4`} aria-labelledby="nr-cnam">
        <h2 id="nr-cnam" className="text-base font-semibold text-text-primary">Caller-ID name</h2>
        <p className="mt-0.5 text-xs text-text-secondary">Caller-ID names are at most {CNAM_MAX} letters and numbers. Display is not guaranteed on every network.</p>
        <label htmlFor="nr-cnam-in" className="mb-1 mt-3 block text-xs font-semibold text-text-secondary">Business name</label>
        <input id="nr-cnam-in" value={cnamInput} maxLength={80} onChange={(e) => setCnamInput(e.target.value)} className="focus-ring min-h-[44px] w-full rounded-lg border border-border bg-bg-primary px-3 text-sm text-text-primary" />
        <p className="mt-2 text-sm text-text-primary">Suggested: <span className="font-mono font-semibold">{suggestCnam(cnamInput) || '—'}</span></p>
        {cnam.issues.length > 0 && <ul role="status" className="mt-1 list-disc ps-5 text-xs text-warning-500">{cnam.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
      </section>

      <section className={`${card} mt-4`} aria-labelledby="nr-check">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="nr-check" className="text-base font-semibold text-text-primary">Registration checklist</h2>
          <p className="text-xs text-text-secondary" role="status">{progress.done} of {progress.total} done</p>
        </div>
        <ul className="mt-3 space-y-2">
          {A2P_CHECKLIST.map((item) => (
            <li key={item.id}>
              <label className="flex items-start gap-3 rounded-xl border border-border p-3 text-sm">
                <input type="checkbox" className="mt-1" checked={!!ticks[item.id]} onChange={() => toggle(item.id)} />
                <span>
                  <span className="block font-medium text-text-primary">{item.title}{item.needsLegal && <span className="ms-2 text-[11px] font-semibold text-warning-500">May need legal review</span>}</span>
                  <span className="block text-xs text-text-secondary">{item.detail}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] text-text-secondary">Your ticks are saved in this browser only. Carrier and registry rules change; verify with your carrier and counsel.</p>
      </section>
    </DashboardLayout>
  );
}
