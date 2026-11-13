// Recreated: verify against original intent
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BadgeCheck, Home } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { useToast } from '@/contexts/ToastContext';
import { claimPassport, listPassports, normalizeCode, passportErrorMessage, type PassportListItem } from '@/lib/homePassportNetwork';

const CODE_RE = /^[A-Z0-9-]{4,24}$/;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

/** Every Home Passport this company is linked to, plus a way to verify a new one with the code printed at the home. */
export function HomePassportsPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [rows, setRows] = useState<PassportListItem[] | null>(null);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const lock = useRef(false);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError('');
    try {
      const r = await listPassports();
      if (mine === seq.current) setRows(Array.isArray(r) ? r : []);
    } catch (e) {
      if (mine === seq.current) setError(passportErrorMessage(e, 'Could not load Home Passports.'));
    }
  }, []);
  useEffect(() => {
    void load();
    return () => { seq.current++; };
  }, [load]);

  const normalized = normalizeCode(code);
  const codeOk = CODE_RE.test(normalized);

  const verify = async () => {
    if (lock.current || !codeOk) return;
    lock.current = true;
    setBusy(true);
    try {
      await claimPassport(normalized);
      toast('Verified. You now have access to this passport.', 'success');
      setCode('');
      navigate(`/dashboard/home-passports/${encodeURIComponent(normalized)}`);
    } catch (e) {
      toast(passportErrorMessage(e, 'Could not verify that code.'), 'error');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  return (
    <DashboardLayout activeLabel="Home Passports">
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><Home size={22} aria-hidden="true" /> Home Passports</h1>
        <p className="mt-1 text-sm text-text-secondary">A shared, tamper-evident service record for each home. You see only the parts the home’s verified access allows.</p>
      </div>

      <section aria-labelledby="hp-verify" className="mb-6 rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
        <h2 id="hp-verify" className="text-base font-semibold text-text-primary">Verify a passport with its code</h2>
        <p className="mt-0.5 text-xs text-text-secondary">Enter the code printed or scanned at the property to prove you have physical access.</p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-[200px] flex-1">
            <label htmlFor="hp-code" className="mb-1 block text-xs font-semibold text-text-secondary">Passport code</label>
            <input id="hp-code" value={code} maxLength={30} autoComplete="off" autoCapitalize="characters" onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void verify(); }} aria-invalid={code.trim() !== '' && !codeOk || undefined} className="focus-ring min-h-[44px] w-full rounded-lg border border-border bg-bg-primary px-3 text-sm uppercase text-text-primary" />
          </div>
          <button type="button" onClick={() => void verify()} disabled={!codeOk || busy} className="focus-ring min-h-[44px] rounded-lg bg-accent px-4 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Verifying…' : 'Verify'}</button>
        </div>
      </section>

      {error && <p role="alert" className="mb-4 rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm text-danger">{error} <button type="button" onClick={() => void load()} className="focus-ring font-semibold underline">Try again</button></p>}
      {!rows && !error && <p role="status" className="py-6 text-sm text-text-secondary">Loading…</p>}
      {rows && rows.length === 0 && <p className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-12 text-center text-sm text-text-secondary">No Home Passports yet. Issue one from a site, or verify one with a code above.</p>}

      {rows && rows.length > 0 && (
        <ul className="grid gap-3 md:grid-cols-2">
          {rows.map((p) => {
            const title = p.address_line ?? p.site_name ?? 'Home';
            const place = [p.city, p.region].filter(Boolean).join(', ');
            const body = (
              <>
                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text-primary">
                  <span className="break-words">{title}</span>
                  {p.verified ? <span className="inline-flex items-center gap-1 rounded-full bg-success-500/10 px-2 py-0.5 text-[11px] font-semibold text-success-500"><BadgeCheck size={11} aria-hidden="true" /> Verified</span> : <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-semibold text-text-secondary">Not verified</span>}
                </p>
                <p className="mt-0.5 text-xs text-text-secondary">{[place, p.customer_name, p.property_type].filter(Boolean).join(' · ') || '—'}</p>
                <p className="mt-2 text-xs text-text-secondary">
                  {p.verified ? `${p.event_count ?? 0} record${p.event_count === 1 ? '' : 's'} · last service ${day(p.last_service_at)}` : 'Verify with the code at the property to see the history.'}
                </p>
              </>
            );
            return (
              <li key={p.passport_id}>
                {p.verified && p.code ? (
                  <Link to={`/dashboard/home-passports/${encodeURIComponent(p.code)}`} className="focus-ring block rounded-2xl border border-border bg-bg-secondary p-4 hover:bg-bg-tertiary">{body}</Link>
                ) : (
                  <div className="rounded-2xl border border-border bg-bg-secondary p-4">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </DashboardLayout>
  );
}
