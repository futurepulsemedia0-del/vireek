// Recreated: verify against original intent
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheck, Home } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { getPassportForSite, issuePassport, passportErrorMessage, type SitePassportState } from '@/lib/homePassportNetwork';

/** Small status chip for a site: no passport yet (offer to issue one), linked but unverified, or verified with a link. */
export function HomePassportChip({ siteId }: { siteId: string }) {
  const { toast } = useToast();
  const [state, setState] = useState<SitePassportState | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const lock = useRef(false);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setFailed(false);
    try {
      const s = await getPassportForSite(siteId);
      if (mine === seq.current) setState(s);
    } catch {
      if (mine === seq.current) setFailed(true);
    }
  }, [siteId]);

  useEffect(() => {
    setState(null);
    void load();
    return () => { seq.current++; };
  }, [load]);

  const issue = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      setState(await issuePassport(siteId));
      toast('Home Passport issued.', 'success');
    } catch (e) {
      toast(passportErrorMessage(e, 'Could not issue the passport.'), 'error');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  const base = 'inline-flex min-h-[32px] items-center gap-1.5 rounded-full border px-3 text-xs font-semibold';

  if (failed) return <button type="button" onClick={() => void load()} className={`${base} focus-ring border-border text-text-secondary`}><Home size={13} aria-hidden="true" /> Passport unavailable. Retry</button>;
  if (!state) return <span role="status" className={`${base} border-border text-text-secondary`}><Home size={13} aria-hidden="true" /> Checking passport…</span>;

  if (!state.has_passport) {
    return (
      <button type="button" onClick={() => void issue()} disabled={busy} className={`${base} focus-ring border-accent text-accent disabled:opacity-60`}>
        <Home size={13} aria-hidden="true" /> {busy ? 'Issuing…' : 'Issue Home Passport'}
      </button>
    );
  }

  if (state.verified && state.code) {
    const n = state.event_count ?? 0;
    return (
      <Link to={`/dashboard/home-passports/${encodeURIComponent(state.code)}`} className={`${base} focus-ring border-success-500/40 bg-success-500/10 text-success-500`}>
        <BadgeCheck size={13} aria-hidden="true" /> Home Passport · {n} record{n === 1 ? '' : 's'}
      </Link>
    );
  }

  return <Link to="/dashboard/home-passports" className={`${base} focus-ring border-border text-text-secondary`}><Home size={13} aria-hidden="true" /> Passport linked, not verified</Link>;
}
