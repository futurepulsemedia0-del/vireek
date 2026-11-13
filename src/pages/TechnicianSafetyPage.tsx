// Recreated: verify against original intent
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { IncidentReportForm } from '@/components/safety/IncidentReportForm';
import { EMERGENCY_SERVICES_NOTICE, fetchTransparency, setConsent, setMyPrefs, type Transparency } from '@/lib/siteSafety';

const PHONE_RE = /^\+?[0-9 ()-]{6,20}$/;

/** Technician's own safety page: what is monitored and why, consent, private preferences, and incident reports. */
export function TechnicianSafetyPage() {
  const { toast } = useToast();
  const { user, isOwner, teamMember } = useAuth();
  const ownerId: string | null = isOwner ? user?.id ?? null : teamMember?.account_owner_id ?? null;
  const [info, setInfo] = useState<Transparency | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [duress, setDuress] = useState('');
  const lock = useRef(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(false);
    try {
      const t = await fetchTransparency();
      if (mine === seq.current) setInfo(t);
    } catch {
      if (mine === seq.current) setError(true);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => { seq.current++; };
  }, [load]);

  const run = async (name: string, fn: () => Promise<void>, ok?: string) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(name);
    try {
      await fn();
      if (ok) toast(ok, 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : 'Could not save. Try again.', 'error');
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  const phoneOk = contactPhone.trim() === '' || PHONE_RE.test(contactPhone.trim());

  return (
    <div className="min-h-screen bg-bg-primary pb-24">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-bg-primary/95 px-4 py-4 backdrop-blur">
        <Link to="/tech/today" aria-label="Back to today" className="focus-ring rounded-lg p-1"><ArrowLeft className="h-5 w-5" aria-hidden="true" /></Link>
        <h1 className="font-semibold text-text-primary">Safety</h1>
      </header>

      <main className="mx-auto max-w-xl space-y-4 p-4">
        <p className="rounded-xl border border-border bg-bg-secondary p-3 text-xs text-text-secondary">{EMERGENCY_SERVICES_NOTICE}</p>

        {error && (
          <div role="alert" className="rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
            Could not load your safety settings. <button type="button" onClick={() => void load()} className="focus-ring font-semibold underline">Try again</button>
          </div>
        )}
        {!info && !error && <p role="status" className="py-6 text-center text-sm text-text-secondary">Loading…</p>}

        {info && !info.enabled && <p className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-text-secondary">Lone-worker safety is not turned on for your company. You can still report an incident below.</p>}

        {info && info.enabled && (
          <>
            <section aria-labelledby="ts-how" className="rounded-xl border border-border bg-bg-secondary p-4">
              <h2 id="ts-how" className="text-sm font-semibold text-text-primary">How it works</h2>
              <ul className="mt-2 list-disc space-y-1 ps-5 text-sm text-text-secondary">
                <li>You check in every {info.checkin_interval_minutes} minutes while a job check-in is running.</li>
                <li>If you do not, your team is alerted in this order: {info.chain_steps.length ? info.chain_steps.map((s) => s.replace(/_/g, ' ')).join(', then ') : 'dispatcher'}.</li>
                <li>
                  {info.location_sharing_enabled
                    ? `Location is only stored during a check-in, only if you opt in below, and is deleted after ${info.location_retention_days} days. It is visible ${info.location_visibility === 'on_escalation' ? 'only when an alert is raised' : 'to your dispatcher during the job'}.`
                    : 'Your location is not collected.'}
                </li>
                <li>Declining or rescheduling unsafe work has no penalty.</li>
              </ul>
              <p className="mt-2 text-[11px] text-text-secondary">Notice version {info.notice_version}.</p>
            </section>

            {info.is_member && (
              <section aria-labelledby="ts-consent" className="rounded-xl border border-border bg-bg-secondary p-4">
                <h2 id="ts-consent" className="text-sm font-semibold text-text-primary">Monitoring consent</h2>
                <p className="mt-1 text-sm text-text-secondary">
                  {info.consent_current ? 'You agreed to the current notice.' : info.consent_action === 'revoked' ? 'You withdrew your consent. Check-ins and location are off.' : info.monitoring_consent_required ? 'Please agree to the notice above to use check-ins.' : 'Consent is not required by your company.'}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {!info.consent_current && (
                    <button type="button" disabled={busy !== null} onClick={() => void run('grant', () => setConsent('granted').then(() => undefined), 'Thank you. Consent recorded.')} className="focus-ring min-h-[44px] rounded-lg bg-accent px-4 text-sm font-semibold text-white disabled:opacity-60">I agree</button>
                  )}
                  {info.consent_action === 'granted' && (
                    <button type="button" disabled={busy !== null} onClick={() => void run('revoke', () => setConsent('revoked').then(() => undefined), 'Consent withdrawn. Stored location points were deleted.')} className="focus-ring min-h-[44px] rounded-lg border border-border px-4 text-sm font-semibold text-text-primary disabled:opacity-60">Withdraw consent</button>
                  )}
                </div>
              </section>
            )}

            {info.is_member && (
              <section aria-labelledby="ts-prefs" className="space-y-4 rounded-xl border border-border bg-bg-secondary p-4">
                <h2 id="ts-prefs" className="text-sm font-semibold text-text-primary">Your private settings</h2>

                {info.location_sharing_enabled && (
                  <label className="flex items-start gap-2 text-sm text-text-primary">
                    <input type="checkbox" className="mt-1" checked={info.location_opt_in} disabled={busy !== null || !info.consent_current} onChange={(e) => void run('loc', () => setMyPrefs({ locationOptIn: e.target.checked }).then(() => undefined), e.target.checked ? 'Location sharing on during check-ins.' : 'Location sharing off. Stored points deleted.')} />
                    <span>Share my location during a check-in{!info.consent_current && <span className="block text-xs text-text-secondary">Needs your consent first.</span>}<span className="block text-xs text-text-secondary">{info.stored_location_points} stored points.</span></span>
                  </label>
                )}

                <div>
                  <h3 className="text-xs font-semibold text-text-secondary">Emergency contact</h3>
                  <p className="text-xs text-text-secondary">{info.has_emergency_contact ? `Saved: ${info.emergency_contact_name ?? 'contact'}.` : 'None saved.'}</p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <div>
                      <label htmlFor="ec-name" className="mb-1 block text-xs font-semibold text-text-secondary">Name</label>
                      <input id="ec-name" value={contactName} maxLength={80} onChange={(e) => setContactName(e.target.value)} className="focus-ring min-h-[44px] w-full rounded-lg border border-border bg-bg-primary px-3 text-sm text-text-primary" />
                    </div>
                    <div>
                      <label htmlFor="ec-phone" className="mb-1 block text-xs font-semibold text-text-secondary">Phone</label>
                      <input id="ec-phone" inputMode="tel" value={contactPhone} maxLength={20} onChange={(e) => setContactPhone(e.target.value)} aria-invalid={!phoneOk || undefined} className="focus-ring min-h-[44px] w-full rounded-lg border border-border bg-bg-primary px-3 text-sm text-text-primary" />
                    </div>
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button type="button" disabled={busy !== null || !contactName.trim() || !contactPhone.trim() || !phoneOk} onClick={() => void run('contact', () => setMyPrefs({ contactName: contactName.trim(), contactPhone: contactPhone.trim() }).then(() => { setContactName(''); setContactPhone(''); }), 'Emergency contact saved.')} className="focus-ring min-h-[44px] rounded-lg bg-accent px-4 text-sm font-semibold text-white disabled:opacity-50">Save contact</button>
                    {info.has_emergency_contact && <button type="button" disabled={busy !== null} onClick={() => void run('contact-clear', () => setMyPrefs({ clearContact: true }).then(() => undefined), 'Emergency contact removed.')} className="focus-ring min-h-[44px] rounded-lg border border-border px-4 text-sm font-semibold text-text-primary disabled:opacity-60">Remove</button>}
                  </div>
                </div>

                {info.duress_word_enabled && (
                  <div>
                    <h3 className="text-xs font-semibold text-text-secondary">Duress word</h3>
                    <p className="text-xs text-text-secondary">A word you can type or say in a check-in that quietly raises an alert. {info.has_duress_word ? 'One is saved (it is never shown).' : 'None saved.'}</p>
                    <div className="mt-2 flex flex-wrap items-end gap-2">
                      <div className="min-w-[160px] flex-1">
                        <label htmlFor="duress-word" className="mb-1 block text-xs font-semibold text-text-secondary">New word</label>
                        <input id="duress-word" value={duress} maxLength={40} autoComplete="off" onChange={(e) => setDuress(e.target.value)} className="focus-ring min-h-[44px] w-full rounded-lg border border-border bg-bg-primary px-3 text-sm text-text-primary" />
                      </div>
                      <button type="button" disabled={busy !== null || duress.trim().length < 3} onClick={() => void run('duress', () => setMyPrefs({ duressWord: duress.trim() }).then(() => setDuress('')), 'Duress word saved.')} className="focus-ring min-h-[44px] rounded-lg bg-accent px-4 text-sm font-semibold text-white disabled:opacity-50">Save</button>
                      {info.has_duress_word && <button type="button" disabled={busy !== null} onClick={() => void run('duress-clear', () => setMyPrefs({ clearDuress: true }).then(() => undefined), 'Duress word removed.')} className="focus-ring min-h-[44px] rounded-lg border border-border px-4 text-sm font-semibold text-text-primary disabled:opacity-60">Remove</button>}
                    </div>
                  </div>
                )}
              </section>
            )}
          </>
        )}

        {ownerId ? <IncidentReportForm ownerId={ownerId} /> : null}
      </main>
    </div>
  );
}
