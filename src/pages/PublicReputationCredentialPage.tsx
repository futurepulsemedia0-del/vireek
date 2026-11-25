import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ShieldCheck, XCircle } from 'lucide-react';
import { fetchPublicCredential, jwksUrl, type PublicCredential } from '@/lib/reputationCredentials/api';
import { REPUTATION_MIN_SAMPLE, SCOPE_LABEL, isCredentialId } from '@/lib/reputationCredentials/core';

const fmtDay = (iso: string) => new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso));
const num = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('en-US') : '—');
const pct = (v: unknown) => (typeof v === 'number' ? `${v}%` : '—');
type Bag = Record<string, unknown>;

/**
 * Public, unauthenticated page behind every reputation badge (/verify/reputation/:id).
 * It re-checks the Ed25519 signature, expiry and revocation on every load and shows only what the person consented to publish.
 */
export function PublicReputationCredentialPage() {
  const { id = '' } = useParams<{ id: string }>();
  const [data, setData] = useState<PublicCredential | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => { document.head.removeChild(meta); };
  }, []);

  useEffect(() => {
    if (!isCredentialId(id)) { setData({ status: 'not_found', kid: null, credential: null, payload: null, signature: null }); return; }
    const ctl = new AbortController();
    setData(null); setFailed(false);
    fetchPublicCredential(id, ctl.signal).then(setData, (e: unknown) => { if ((e as Error)?.name !== 'AbortError') setFailed(true); });
    return () => ctl.abort();
  }, [id]);

  const shell = (children: React.ReactNode) => (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-4 px-4 py-10 text-text-primary">
      <header className="flex items-center gap-2 text-sm font-semibold text-text-secondary"><ShieldCheck size={18} aria-hidden="true" /> Vireek reputation verification</header>
      {children}
      <footer className="mt-4 text-xs text-text-secondary">
        Vireek confirms only what this person or business agreed to publish, from Vireek’s own job records. A badge on a website is not proof by itself — this page is.
        Technical verification: Ed25519 signature, public keys at <a className="underline" href={jwksUrl} rel="noopener nofollow">the key set</a>.
      </footer>
    </main>
  );

  if (failed) return shell(<p role="alert" className="rounded-xl border border-border p-4 text-sm">Verification is temporarily unavailable. Please try again in a few minutes.</p>);
  if (!data) return shell(<p role="status" className="text-sm text-text-secondary">Checking…</p>);

  if (data.status === 'not_found') return shell(<div className="rounded-xl border border-border p-4"><h1 className="text-lg font-semibold">Credential not found</h1><p className="mt-1 text-sm text-text-secondary">This address was never issued by Vireek. If you saw it on a website, treat that badge as unverified.</p></div>);
  if (data.status === 'invalid_signature' || data.status === 'unknown_key' || !data.credential) {
    return shell(<div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 p-4"><h1 className="flex items-center gap-2 text-lg font-semibold"><AlertTriangle size={20} aria-hidden="true" /> Could not be verified</h1><p className="mt-1 text-sm">The cryptographic signature on this credential is not valid. Do not rely on it.</p></div>);
  }

  const c = data.credential;
  const vj = (c.claims.verified_jobs ?? null) as Bag | null;
  const oc = (c.claims.outcomes ?? null) as Bag | null;
  const lc = c.claims.license_checks ?? null;
  const banner = data.status === 'valid'
    ? <p className="flex items-center gap-1.5 text-sm text-success"><CheckCircle2 size={16} aria-hidden="true" /> Valid · issued {fmtDay(c.issuedAt)} · expires {fmtDay(c.expiresAt)}</p>
    : data.status === 'revoked'
      ? <p role="alert" className="flex items-center gap-1.5 text-sm text-danger"><XCircle size={16} aria-hidden="true" /> Revoked{c.revokedAt ? ` on ${fmtDay(c.revokedAt)}` : ''}. Do not rely on this credential.</p>
      : <p role="alert" className="flex items-center gap-1.5 text-sm text-warning"><AlertTriangle size={16} aria-hidden="true" /> Expired on {fmtDay(c.expiresAt)}. The facts below were true when it was issued ({fmtDay(c.issuedAt)}), not necessarily today.</p>;

  return shell(
    <section className="rounded-xl border border-border bg-bg-secondary/40 p-5" aria-labelledby="rc-name">
      <h1 id="rc-name" className="text-xl font-semibold">{c.subject.name}</h1>
      <p className="text-sm text-text-secondary">{c.subject.type === 'technician' ? `Technician at ${c.subject.company}` : 'Business credential'}</p>
      <div className="mt-2">{banner}</div>
      <dl className="mt-4 divide-y divide-border text-sm">
        {c.scopes.includes('verified_jobs') && vj && (<>
          <Row k={`Jobs completed, last ${num(vj.window_days)} days`} v={num(vj.jobs_completed)} />
          <Row k="…of which documented with verified evidence" v={num(vj.verified_jobs)} />
        </>)}
        {c.scopes.includes('outcomes') && oc && (oc.insufficient_sample
          ? <Row k="Outcomes" v={`Not shown — needs at least ${num(oc.min_sample ?? REPUTATION_MIN_SAMPLE)} completed jobs`} />
          : (<>
            <Row k="Fixed on the first visit" v={pct(oc.first_time_fix_rate)} />
            <Row k="Callbacks / rework" v={pct(oc.callback_rate)} />
            {oc.customer_rating_avg !== undefined && <Row k={`Customer rating (${num(oc.rated_jobs)} rated jobs)`} v={`${String(oc.customer_rating_avg)} / 5`} />}
            {oc.response_reliability !== undefined && <Row k="Arrived within 15 min of the promised time" v={pct(oc.response_reliability)} />}
          </>))}
        {c.scopes.includes('license_checks') && Array.isArray(lc) && (lc.length === 0
          ? <Row k="Licenses" v="None listed" />
          : (lc as Bag[]).map((l, i) => (
            <Row key={i} k={`${String(l.type)}${l.name ? ` — ${String(l.name)}` : ''}${l.issuer ? ` (${String(l.issuer)})` : ''}`}
              v={`${l.check === 'issuer_checked' ? `Checked${l.checked_at ? ` ${fmtDay(String(l.checked_at))}` : ''}` : 'Self-reported, not checked by Vireek'}${l.expires_at ? ` · expires ${fmtDay(String(l.expires_at))}` : ''}`} />
          )))}
        {c.scopes.includes('license_checks') && lc && !Array.isArray(lc) && (
          <Row k="Technicians with a checked license" v={`${num((lc as Bag).technicians_with_checked_license)} of ${num((lc as Bag).technicians_total)}`} />
        )}
      </dl>
      <p className="mt-4 text-xs text-text-secondary">Included: {c.scopes.map((s) => SCOPE_LABEL[s]).join(', ')}.</p>
    </section>,
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:justify-between"><dt className="text-text-secondary">{k}</dt><dd className="font-medium sm:text-right">{v}</dd></div>;
}
