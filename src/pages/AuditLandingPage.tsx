import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PhoneCall, ShieldCheck } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox';
import { TurnstileWidget } from '@/components/audit/TurnstileWidget';
import { auditCall, AuditApiError } from '@/lib/audit/api';
import type { BusinessHours, Condition, ProposedSlot, PublicConfig } from '@/lib/audit/types';
import { formatDateTime } from '@/lib/format';
import { useSEO } from '@/lib/seo';

type Step = 'form' | 'code' | 'schedule';
const COND_LABEL: Record<Condition, string> = { business_hours: 'During business hours', lunch: 'At lunch time', after_hours: 'After hours' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TRADE_LABEL = (t: string) => t.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function AuditLandingPage() {
  useSEO({
    title: 'Free Missed-Call Audit for Home Service Businesses | Vireek',
    description: 'Find out what happens when customers call your business and nobody picks up. Three short, clearly-labelled AI test calls to your own number, a scored report, and an estimate of the revenue at risk.',
    canonical: 'https://vireek.com/audit',
  });
  const nav = useNavigate();
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [cfgError, setCfgError] = useState(false);
  const [step, setStep] = useState<Step>('form');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt] = useState(() => Date.now());

  const [f, setF] = useState({ phone: '', email: '', business_name: '', trade: 'hvac', consent_otp: false, attest_owner: false, hp: '' });
  const [bot, setBot] = useState<string | null>(null);
  const [verificationId, setVerificationId] = useState('');
  const [maskedPhone, setMaskedPhone] = useState('');
  const [code, setCode] = useState('');
  const [token, setToken] = useState('');
  const [hours, setHours] = useState<BusinessHours>({ days: [1, 2, 3, 4, 5], open: '08:00', close: '17:00' });
  const [slots, setSlots] = useState<ProposedSlot[]>([]);
  const [untestable, setUntestable] = useState<{ condition: Condition; reason: string }[]>([]);
  const [tz, setTz] = useState('');
  const [consentCalls, setConsentCalls] = useState(false);
  const [followup, setFollowup] = useState(false);

  const timezone = useMemo(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago'; } catch { return 'America/Chicago'; } }, []);

  useEffect(() => { auditCall<PublicConfig>('config').then((c) => { setCfg(c); setHours(c.default_hours); }).catch(() => setCfgError(true)); }, []);
  const onBot = useCallback((t: string | null) => setBot(t), []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof AuditApiError ? e.message : 'Something went wrong. Please try again.'); } finally { setBusy(false); }
  };
  const fmt = (iso: string) => formatDateTime(iso, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz || timezone });

  const start = () => run(async () => {
    const r = await auditCall<{ verification_id: string; masked_phone: string }>('start', { ...f, timezone, channel: 'sms', bot_token: bot, elapsed_ms: Date.now() - loadedAt });
    setVerificationId(r.verification_id); setMaskedPhone(r.masked_phone); setStep('code');
  });
  const verify = () => run(async () => {
    const r = await auditCall<{ token: string; timezone: string; proposed: ProposedSlot[]; untestable: { condition: Condition; reason: string }[] }>('verify', { verification_id: verificationId, code: code.trim() });
    setToken(r.token); setTz(r.timezone); setSlots(r.proposed); setUntestable(r.untestable); setStep('schedule');
  });
  const replan = (h: BusinessHours) => run(async () => {
    setHours(h);
    const r = await auditCall<{ proposed: ProposedSlot[]; untestable: { condition: Condition; reason: string }[] }>('plan', { token, business_hours: h });
    setSlots(r.proposed); setUntestable(r.untestable);
  });
  const schedule = () => run(async () => {
    await auditCall('schedule', { token, business_hours: hours, slots: slots.map((s) => ({ condition: s.condition, scheduled_for: s.scheduled_for })), consent_calls: consentCalls, followup_opt_in: followup });
    nav(`/audit/${token}`);
  });

  const canStart = f.consent_otp && f.attest_owner && !!bot && f.phone.length >= 10 && f.email.includes('@') && f.business_name.trim().length >= 2;
  const toggleDay = (d: number) => replan({ ...hours, days: hours.days.includes(d) ? hours.days.filter((x) => x !== d) : [...hours.days, d].sort() });

  return (
    <>
      <Header />
      <main className="min-h-screen bg-bg-primary pt-24">
        <section className="mx-auto max-w-3xl px-6 py-14">
          <p className="text-sm font-semibold uppercase tracking-wide text-accent">Free Missed-Call Audit</p>
          <h1 className="mt-3 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">What really happens when a customer calls you?</h1>
          <p className="mt-5 text-lg leading-8 text-text-secondary">
            We place up to three short test calls to <strong>your own business number</strong> — during hours, at lunch, and after hours — then give you a scored report and an estimate of the revenue you may be losing. Every call is made by an AI assistant that says so up front. Nothing is recorded, and nothing is sold.
          </p>
          <ul className="mt-6 grid gap-3 text-sm text-text-secondary sm:grid-cols-3">
            <li className="rounded-xl border border-border p-4"><PhoneCall className="mb-2 h-5 w-5 text-accent" aria-hidden />Only your verified number is ever called.</li>
            <li className="rounded-xl border border-border p-4"><ShieldCheck className="mb-2 h-5 w-5 text-accent" aria-hidden />You choose the times and can cancel any call.</li>
            <li className="rounded-xl border border-border p-4"><ShieldCheck className="mb-2 h-5 w-5 text-accent" aria-hidden />Delete everything with one click, anytime.</li>
          </ul>

          <div className="mt-10 rounded-2xl border border-border bg-bg-secondary p-6" aria-live="polite">
            {cfgError && <p role="alert" className="text-danger">We couldn't load the audit right now. Please try again in a moment.</p>}
            {!cfg && !cfgError && <p className="text-text-secondary">Loading…</p>}
            {cfg && !cfg.available && <p role="status" className="text-text-primary">The Missed-Call Audit is temporarily unavailable. Please check back soon. If you already have a report, it is still available from your email link.</p>}

            {cfg?.available && step === 'form' && (
              <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (canStart) start(); }} noValidate>
                <Input label="Business name" required value={f.business_name} onChange={(e) => setF({ ...f, business_name: e.target.value })} autoComplete="organization" />
                <div>
                  <label htmlFor="trade" className="mb-1.5 block text-sm font-medium text-text-primary">Trade</label>
                  <select id="trade" className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3" value={f.trade} onChange={(e) => setF({ ...f, trade: e.target.value })}>
                    {cfg.trades.map((t) => <option key={t} value={t}>{TRADE_LABEL(t)}</option>)}
                  </select>
                </div>
                <Input label="Business phone number (the line we will test)" required type="tel" inputMode="tel" autoComplete="tel" placeholder="(512) 555-0123" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} helperText="US or Canadian numbers. We'll text a one-time code to prove it's yours." />
                <Input label="Work email (for your report link)" required type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
                <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px' }}>
                  <label>Leave this empty<input tabIndex={-1} autoComplete="off" value={f.hp} onChange={(e) => setF({ ...f, hp: e.target.value })} /></label>
                </div>
                <Checkbox checked={f.attest_owner} onChange={(e) => setF({ ...f, attest_owner: e.target.checked })} label="I am the owner or an authorized representative of this business and this number." />
                <Checkbox checked={f.consent_otp} onChange={(e) => setF({ ...f, consent_otp: e.target.checked })} label={cfg.consent.otp_message} />
                {cfg.turnstile_site_key && <TurnstileWidget siteKey={cfg.turnstile_site_key} onToken={onBot} />}
                {error && <p role="alert" className="text-sm text-danger">{error}</p>}
                <Button type="submit" loading={busy} disabled={!canStart} disabledReason="Complete the fields and both checkboxes.">Text me a code</Button>
              </form>
            )}

            {cfg?.available && step === 'code' && (
              <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); verify(); }}>
                <p className="text-text-primary">We sent a 6-digit code to <strong>{maskedPhone}</strong>. It expires in 10 minutes.</p>
                <Input label="Verification code" required inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
                {error && <p role="alert" className="text-sm text-danger">{error}</p>}
                <Button type="submit" loading={busy} disabled={code.length !== 6}>Verify my number</Button>
              </form>
            )}

            {cfg?.available && step === 'schedule' && (
              <div className="space-y-5">
                <h2 className="text-xl font-bold text-text-primary">Confirm your test calls</h2>
                <fieldset>
                  <legend className="mb-2 text-sm font-medium text-text-primary">Which days are you open?</legend>
                  <div className="flex flex-wrap gap-2">
                    {DAYS.map((d, i) => (
                      <Button key={d} type="button" size="xs" variant={hours.days.includes(i) ? 'primary' : 'secondary'} selected={hours.days.includes(i)} aria-pressed={hours.days.includes(i)} onClick={() => toggleDay(i)}>{d}</Button>
                    ))}
                  </div>
                  <div className="mt-3 flex gap-3">
                    <Input label="Opens" type="time" value={hours.open} onChange={(e) => setHours({ ...hours, open: e.target.value })} onBlur={() => replan(hours)} />
                    <Input label="Closes" type="time" value={hours.close} onChange={(e) => setHours({ ...hours, close: e.target.value })} onBlur={() => replan(hours)} />
                  </div>
                </fieldset>
                <ol className="space-y-2" aria-label="Proposed test calls">
                  {slots.map((s) => <li key={s.condition} className="rounded-xl border border-border p-3 text-text-primary"><strong>{COND_LABEL[s.condition]}</strong> — {fmt(s.scheduled_for)} <span className="text-text-secondary">({tz || timezone})</span></li>)}
                  {untestable.map((u) => <li key={u.condition} className="rounded-xl border border-dashed border-border p-3 text-text-secondary">{COND_LABEL[u.condition]} — can't be tested with these hours ({u.reason}). It will show as "not tested", never as a failure.</li>)}
                </ol>
                <Checkbox checked={consentCalls} onChange={(e) => setConsentCalls(e.target.checked)} label={cfg.consent.ai_test_calls} />
                <Checkbox checked={followup} onChange={(e) => setFollowup(e.target.checked)} label={`(Optional) ${cfg.consent.email_followup}`} />
                {error && <p role="alert" className="text-sm text-danger">{error}</p>}
                <Button loading={busy} onClick={schedule} disabled={!consentCalls || slots.length === 0} disabledReason={slots.length === 0 ? 'No test call fits these hours.' : 'Tick the call authorization to continue.'}>Schedule my test calls</Button>
              </div>
            )}
          </div>
          <p className="mt-6 text-xs text-text-secondary">Vireek never calls numbers you didn't verify. Reports are private links that expire after 30 days; you can delete yours at any time.</p>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
