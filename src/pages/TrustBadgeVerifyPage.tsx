import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ShieldCheck, XCircle } from 'lucide-react';
import { fetchPublicVerification, type PublicVerification } from '@/lib/trustBadge/api';

const fmtMonth = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, (m || 1) - 1, 1)));
};
const fmtDay = (iso: string) => new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso));
const fmtSeconds = (ms: number) => (ms < 1000 ? 'under 1 second' : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} seconds`);

/**
 * Public, unauthenticated page behind the "Answered by Vireek" badge (/verify/:orgSlug).
 * It shows only what the business approved, from live data, and says plainly when something is not shared or
 * not available. It never infers.
 */
export function TrustBadgeVerifyPage() {
  const { orgSlug = '' } = useParams<{ orgSlug: string }>();
  const [params] = useSearchParams();
  const token = params.get('t');
  const [data, setData] = useState<PublicVerification | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => { document.head.removeChild(meta); };
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    setData(null);
    setFailed(false);
    fetchPublicVerification(orgSlug, token, ctl.signal).then(setData, (e: unknown) => { if ((e as Error)?.name !== 'AbortError') setFailed(true); });
    return () => ctl.abort();
  }, [orgSlug, token]);

  const shell = (children: React.ReactNode) => (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-4 px-4 py-10 text-text-primary">
      <header className="flex items-center gap-2 text-sm font-semibold text-text-secondary"><ShieldCheck size={18} aria-hidden="true" /> Vireek verification</header>
      {children}
      <footer className="mt-4 text-xs text-text-secondary">
        Vireek only confirms facts the business chose to share. A badge on a website is not proof by itself — this page is.{' '}
        <a className="underline" href="https://vireek.com/?utm_source=trust_badge&utm_medium=verify_page&utm_campaign=learn_more" rel="noopener nofollow">About Vireek</a>
      </footer>
    </main>
  );

  if (failed) return shell(<p role="alert" className="rounded-xl border border-border p-4 text-sm">Verification is temporarily unavailable. Please try again in a few minutes.</p>);
  if (!data) return shell(<p role="status" className="text-sm text-text-secondary">Checking…</p>);
  if (!data.found) return shell(<div className="rounded-xl border border-border p-4"><h1 className="text-lg font-semibold">Badge not found</h1><p className="mt-1 text-sm text-text-secondary">This address was never issued by Vireek. If you saw it on a website, treat that badge as unverified.</p></div>);

  const t = data.token;
  const tokenBanner = !t ? null : t.valid ? (
    t.hostVerified ? (
      <p className="flex items-start gap-2 rounded-xl border border-success/30 bg-success-500/10 p-3 text-sm"><CheckCircle2 size={18} className="mt-0.5 shrink-0 text-success" aria-hidden="true" /><span>This badge was issued for <strong>{t.host}</strong> on {fmtDay(t.issuedAt)}, a website this business has verified. Check that the address of the site you came from matches.</span></p>
    ) : (
      <p role="alert" className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm"><AlertTriangle size={18} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" /><span>This badge was issued for <strong>{t.host}</strong>, which this business has <strong>not</strong> verified as its own. Be careful.</span></p>
    )
  ) : (
    <p role="alert" className="flex items-start gap-2 rounded-xl border border-warning-500/30 bg-warning-500/10 p-3 text-sm"><AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" /><span>{t.reason === 'expired' ? 'The badge link has expired. Reload the website you came from to get a fresh one.' : 'The badge link could not be authenticated, so we cannot say where it came from.'}</span></p>
  );

  if (!data.active) {
    return shell(<>{tokenBanner}<div className="rounded-xl border border-border p-4"><h1 className="flex items-center gap-2 text-lg font-semibold"><XCircle size={20} aria-hidden="true" /> Not currently active</h1><p className="mt-1 text-sm text-text-secondary">This business is not an active Vireek customer right now, so no claims are made.</p></div></>);
  }

  const f = data.facts ?? {};
  const rows: { label: string; value: string }[] = [];
  if (f.activeSince) rows.push({ label: 'Using Vireek since', value: fmtMonth(f.activeSince) });
  if (f.planCategory) rows.push({ label: 'Plan category', value: f.planCategory === 'business' ? 'Business' : 'Standard' });
  if (f.windowDays) {
    rows.push({ label: `Calls answered, last ${f.windowDays} days`, value: f.callsAnswered ? `${f.callsAnswered.count.toLocaleString('en-US')} (as of ${fmtDay(f.callsAnswered.asOf)})` : `Not shown — needs at least ${f.minSample} recent calls` });
    rows.push({ label: `Average answer time, last ${f.windowDays} days`, value: f.avgAnswerMs ? `${fmtSeconds(f.avgAnswerMs.value)} (as of ${fmtDay(f.avgAnswerMs.asOf)})` : 'Not available yet' });
  }

  return shell(<>
    {tokenBanner}
    <section className="rounded-xl border border-border bg-bg-secondary/40 p-5" aria-labelledby="tb-name">
      <h1 id="tb-name" className="text-xl font-semibold">{data.displayName}</h1>
      <p className="mt-1 flex items-center gap-1.5 text-sm text-success"><CheckCircle2 size={16} aria-hidden="true" /> Active Vireek customer{data.accountInGoodStanding === false ? ' (account needs attention)' : ''}</p>
      {rows.length > 0 ? (
        <dl className="mt-4 divide-y divide-border text-sm">
          {rows.map((r) => (<div key={r.label} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:justify-between"><dt className="text-text-secondary">{r.label}</dt><dd className="font-medium sm:text-right">{r.value}</dd></div>))}
        </dl>
      ) : <p className="mt-4 text-sm text-text-secondary">This business has not chosen to share additional details.</p>}
    </section>
    {data.domains && data.domains.length > 0 && (
      <section aria-labelledby="tb-domains" className="text-sm"><h2 id="tb-domains" className="font-semibold">Websites verified by this business</h2><ul className="mt-1 list-disc pl-5 text-text-secondary">{data.domains.map((d) => <li key={d}>{d}</li>)}</ul></section>
    )}
  </>);
}
