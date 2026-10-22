/**
 * Security portal — /trust/security (public)
 *
 * Published penetration-test summaries and sub-processor change notices (with double
 * opt-in email subscription). Reads only what RLS exposes publicly: published pentests and
 * posted notices. Describes what is true — no certification is implied.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BellRing, FileSearch, ShieldCheck } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { BackButton } from '@/components/ui/BackButton';
import { Button } from '@/components/ui/Button';
import { Badge, Card, Field, PanelError, PanelSkeleton, Spinner, fmtDate, inputClass, useLoader } from '@/components/trust-pack/ui';
import { useSEO } from '@/lib/seo';
import { SUBPROCESSOR_CATEGORIES, SUBPROCESSORS_LAST_UPDATED } from '@/lib/subprocessors';
import {
  confirmSubscription, fetchNotices, fetchPentests, requestFullReport, subscribeToNotices, unsubscribeFromNotices,
} from '@/lib/trustPack/api';
import {
  SEVERITIES, changeLabel, criticalRemediationRate, daysUntil, noticePhase, openFindings, totalFindings, type PentestSummary,
} from '@/lib/trustPack/notices';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SEV_STYLE: Record<string, string> = {
  critical: 'text-red-600 dark:text-red-400', high: 'text-orange-600 dark:text-orange-400', medium: 'text-amber-600 dark:text-amber-400',
  low: 'text-text-primary', info: 'text-text-secondary',
};

function PentestCard({ p }: { p: PentestSummary }) {
  const [formOpen, setFormOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [message, setMessage] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const open = openFindings(p.found, p.remediated);
  const rate = criticalRemediationRate(p.found, p.remediated);
  const valid = EMAIL_RE.test(email.trim()) && company.trim().length >= 2;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setState('sending');
    try { await requestFullReport({ pentestId: p.id, email, company, message }); setState('sent'); }
    catch { setState('error'); }
  }

  return (
    <article className="rounded-2xl border border-border bg-bg-secondary p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-text-primary">{p.title}</h3>
          <p className="text-xs text-text-secondary">{p.tester} · {fmtDate(p.performed_on)}</p>
        </div>
        {rate !== null && <Badge tone={rate === 100 ? 'ok' : 'warn'}>{rate}% of critical/high fixed</Badge>}
      </div>
      <p className="mt-3 text-sm leading-relaxed text-text-secondary">{p.summary}</p>
      <dl className="mt-3 grid gap-2 text-xs text-text-secondary sm:grid-cols-2">
        <div><dt className="font-medium text-text-primary">Scope</dt><dd>{p.scope}</dd></div>
        <div><dt className="font-medium text-text-primary">Methodology</dt><dd>{p.methodology}</dd></div>
      </dl>
      <table className="mt-4 w-full text-center text-sm" aria-label={`Findings for ${p.title}`}>
        <thead><tr className="text-xs uppercase tracking-wide text-text-secondary">{SEVERITIES.map((s) => <th key={s} className="pb-1 font-medium">{s}</th>)}</tr></thead>
        <tbody>
          <tr>{SEVERITIES.map((s) => <td key={s} className={`font-semibold tabular-nums ${SEV_STYLE[s]}`}>{p.found[s]}</td>)}</tr>
          <tr className="text-xs text-text-secondary">{SEVERITIES.map((s) => <td key={s}>{open[s]} open</td>)}</tr>
        </tbody>
      </table>
      <p className="mt-2 text-xs text-text-secondary">{totalFindings(p.found)} finding(s) total.</p>

      {p.report_available_on_request && (
        <div className="mt-4">
          {state === 'sent' ? (
            <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">Request received — we’ll follow up by email.</p>
          ) : !formOpen ? (
            <Button size="sm" variant="secondary" onClick={() => setFormOpen(true)}>Request the full report (NDA)</Button>
          ) : (
            <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" noValidate>
              <Field label="Work email"><input className={inputClass} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
              <Field label="Company"><input className={inputClass} autoComplete="organization" value={company} onChange={(e) => setCompany(e.target.value)} required /></Field>
              <div className="sm:col-span-2"><Field label="Message (optional)"><textarea className={inputClass} rows={2} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} /></Field></div>
              <div className="flex items-center gap-3 sm:col-span-2">
                <Button size="sm" type="submit" disabled={!valid || state === 'sending'}>{state === 'sending' ? <Spinner /> : null} Send request</Button>
                {state === 'error' && <span role="alert" className="text-xs text-red-500">Could not send. Check your details and try again.</span>}
              </div>
            </form>
          )}
        </div>
      )}
    </article>
  );
}

function SubscribeBox() {
  const [params, setParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const handled = useRef(false);

  // Links in our emails land here: ?verify=<token> or ?unsubscribe=<token>.
  useEffect(() => {
    if (handled.current) return;
    const verify = params.get('verify');
    const unsub = params.get('unsubscribe');
    if (!verify && !unsub) return;
    handled.current = true;
    const run = verify ? confirmSubscription(verify) : unsubscribeFromNotices(unsub as string);
    run.then(() => setMessage(verify ? 'Subscription confirmed. You’ll get an email before sub-processors change.' : 'You’re unsubscribed from sub-processor notices.'))
      .catch((e: Error) => setMessage(e.message || 'This link is not valid.'))
      .finally(() => setParams({}, { replace: true }));
  }, [params, setParams]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) return;
    setState('sending');
    try { await subscribeToNotices(email.trim()); setState('sent'); }
    catch (err) { setState('error'); setMessage(err instanceof Error ? err.message : 'Could not subscribe right now.'); }
  }

  return (
    <div className="rounded-xl bg-bg-tertiary/60 p-4">
      <p className="text-sm font-medium text-text-primary">Get an email before a sub-processor changes</p>
      {message && <p role="status" className="mt-2 text-sm text-text-secondary">{message}</p>}
      {state === 'sent' ? (
        <p role="status" className="mt-2 text-sm text-emerald-600 dark:text-emerald-400">Check your inbox to confirm your subscription.</p>
      ) : (
        <form onSubmit={submit} className="mt-3 flex flex-col gap-2 sm:flex-row" noValidate>
          <label className="sr-only" htmlFor="notice-email">Email address</label>
          <input id="notice-email" className={inputClass} type="email" autoComplete="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Button size="sm" type="submit" disabled={state === 'sending' || !EMAIL_RE.test(email.trim())}>{state === 'sending' ? <Spinner /> : null} Subscribe</Button>
        </form>
      )}
      {state === 'error' && <p role="alert" className="mt-2 text-xs text-red-500">{message}</p>}
    </div>
  );
}

export function SecurityPortalPage() {
  useSEO({
    title: 'Security Portal | Vireek',
    description: 'Penetration-test summaries and sub-processor change notices from Vireek, published for customer security reviews.',
    canonical: 'https://vireek.com/trust/security',
  });

  const [now] = useState(() => Date.now());
  const pentests = useLoader(fetchPentests);
  const notices = useLoader(fetchNotices);
  const processorCount = SUBPROCESSOR_CATEGORIES.reduce((n, c) => n + c.processors.length, 0);

  // Honour #subprocessor-notices once the (async) content exists.
  useEffect(() => {
    if (notices.status === 'ready' && window.location.hash === '#subprocessor-notices') {
      document.getElementById('subprocessor-notices')?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [notices.status]);

  return (
    <>
      <Header />
      <main className="bg-bg-primary pt-24">
        <section className="py-12 md:py-16">
          <div className="mx-auto max-w-4xl space-y-8 px-6">
            <BackButton />
            <header>
              <p className="text-xs font-semibold uppercase tracking-wide text-accent">Trust</p>
              <h1 className="mt-1 text-3xl font-semibold text-text-primary">Security portal</h1>
              <p className="mt-3 max-w-2xl text-base leading-relaxed text-text-secondary">
                What we test, what we found, and what is changing in our supply chain — published so your security team can review it.
                See also our <a className="text-accent underline" href="/trust">Trust Center</a>, <a className="text-accent underline" href="/dpa">DPA</a>,
                {' '}<a className="text-accent underline" href="/sla">SLA</a> and <a className="text-accent underline" href="/vulnerability-disclosure">vulnerability disclosure</a>.
              </p>
            </header>

            <Card title="Penetration-test summaries" icon={FileSearch}>
              {pentests.status === 'loading' ? <PanelSkeleton /> : pentests.status === 'error' || !pentests.data ? (
                <PanelError message={pentests.error || 'Could not load summaries.'} onRetry={pentests.retry} />
              ) : pentests.data.length === 0 ? (
                <p className="text-sm text-text-secondary">No summaries are published yet. Our commitment is a third-party test at least once a year; the summary will appear here when it is complete.</p>
              ) : (
                <div className="space-y-4">{pentests.data.map((p) => <PentestCard key={p.id} p={p} />)}</div>
              )}
            </Card>

            <div id="subprocessor-notices" className="scroll-mt-28">
              <Card title="Sub-processor change notices" icon={BellRing}>
                <p className="mb-4 text-sm text-text-secondary">
                  We list {processorCount} sub-processors (updated {SUBPROCESSORS_LAST_UPDATED}) on the <a className="text-accent underline" href="/subprocessors">sub-processor page</a>.
                  Non-emergency changes are announced at least 30 days before they take effect, and customers with a DPA may object on reasonable data-protection grounds.
                </p>
                <SubscribeBox />
                {notices.status === 'loading' ? <div className="mt-4"><PanelSkeleton /></div> : notices.status === 'error' || !notices.data ? (
                  <div className="mt-4"><PanelError message={notices.error || 'Could not load notices.'} onRetry={notices.retry} /></div>
                ) : notices.data.length === 0 ? (
                  <p className="mt-4 text-sm text-text-secondary">No sub-processor changes have been announced.</p>
                ) : (
                  <ul className="mt-4 divide-y divide-border">
                    {notices.data.map((n) => {
                      const phase = noticePhase(n, now);
                      return (
                        <li key={n.id} className="py-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-sm font-semibold text-text-primary">{changeLabel(n.change_type)}: {n.processor_name}</h3>
                            <Badge tone={phase === 'objection_open' ? 'warn' : phase === 'withdrawn' ? 'neutral' : 'ok'}>
                              {phase === 'objection_open' ? `Effective in ${daysUntil(n.effective_at, now)} days` : phase === 'withdrawn' ? 'Withdrawn' : 'In effect'}
                            </Badge>
                            {n.emergency && <Badge tone="bad">Emergency</Badge>}
                          </div>
                          <p className="mt-1 text-sm text-text-secondary">{n.summary}</p>
                          <p className="mt-1 text-xs text-text-secondary">
                            {n.purpose} · {n.location} · {n.data_types} · posted {fmtDate(n.posted_at)}, effective {fmtDate(n.effective_at)}
                          </p>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <p className="mt-4 flex items-center gap-2 text-xs text-text-secondary"><ShieldCheck size={14} aria-hidden /> Signed-in account owners can object from Dashboard → Trust Pack.</p>
              </Card>
            </div>
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
