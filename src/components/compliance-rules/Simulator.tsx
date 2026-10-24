/**
 * "Check a situation" — runs the exact engine the server enforces against the
 * approved rules, entirely client-side, so owners can see what would apply
 * before they call, text or send a quote.
 */

import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Info, ShieldAlert, XCircle } from 'lucide-react';
import {
  CONSENT_TYPE_LABELS, KIND_LABELS, SURFACE_LABELS, US_STATE_OPTIONS, evaluate, formToContext, formatJurisdiction,
  type ComplianceProfile, type ConsentState, type ConsentType, type EvaluationResult, type RuleVersion, type SimulatorForm, type Surface,
} from '@/lib/complianceRules';
import { Input } from '@/components/ui/Input';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary transition-colors focus-visible:border-accent';

const TIMEZONES = [
  ['America/New_York', 'Eastern'], ['America/Chicago', 'Central'], ['America/Denver', 'Mountain'],
  ['America/Phoenix', 'Arizona'], ['America/Los_Angeles', 'Pacific'], ['America/Anchorage', 'Alaska'], ['Pacific/Honolulu', 'Hawaii'],
] as const;

const INITIAL: SimulatorForm = {
  surface: 'call', purpose: 'marketing', customerState: '', localHour: '10:00', timezone: 'America/Chicago', weekdayOffset: 0,
  aiVoice: true, disclosureGiven: false, consent: {}, saleLocation: 'customer_home', totalDollars: '', baselineDollars: '',
  emergencyDeclared: false, emergencyRepair: false, waiverSigned: false, licenseShown: false, noticeIncluded: false,
};

const OUTCOME = {
  allow: { label: 'Allowed', Icon: CheckCircle2, cls: 'border-success-500/40 bg-success-500/10 text-success-500' },
  allow_with_actions: { label: 'Allowed — actions required', Icon: AlertTriangle, cls: 'border-warning-500/40 bg-warning-500/10 text-warning-500' },
  block: { label: 'Blocked', Icon: XCircle, cls: 'border-danger/40 bg-danger/10 text-danger' },
} as const;

function Toggle({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
      <input id={id} type="checkbox" className="h-4 w-4 accent-accent" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Simulator({ catalog, profile }: { catalog: RuleVersion[]; profile: ComplianceProfile | null }) {
  const [f, setF] = useState<SimulatorForm>(INITIAL);
  const set = <K extends keyof SimulatorForm>(k: K, v: SimulatorForm[K]) => setF((s) => ({ ...s, [k]: v }));
  const setConsent = (t: ConsentType, v: ConsentState) => setF((s) => ({ ...s, consent: { ...s.consent, [t]: v } }));

  const result: EvaluationResult | null = useMemo(() => {
    try { return evaluate(formToContext(f, profile), catalog); } catch { return null; }
  }, [f, profile, catalog]);

  const isDoc = f.surface === 'quote' || f.surface === 'contract';
  const isMsg = f.surface === 'sms' || f.surface === 'email';
  const consentTypes: ConsentType[] =
    f.surface === 'call' ? ['call_recording', 'ai_voice', 'marketing_call']
    : f.surface === 'sms' ? ['marketing_sms'] : f.surface === 'email' ? ['marketing_email'] : [];

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,22rem)_1fr]">
      <form className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-4" onSubmit={(e) => e.preventDefault()} aria-label="Situation">
        <div>
          <label htmlFor="sim-surface" className="mb-1 block text-xs font-medium text-text-secondary">What are you doing?</label>
          <select id="sim-surface" className={selectClass} value={f.surface} onChange={(e) => set('surface', e.target.value as Surface)}>
            {(Object.keys(SURFACE_LABELS) as Surface[]).map((s) => <option key={s} value={s}>{SURFACE_LABELS[s].replace(/s$/, '')}</option>)}
          </select>
        </div>
        {!isDoc && (
          <div>
            <label htmlFor="sim-purpose" className="mb-1 block text-xs font-medium text-text-secondary">Purpose</label>
            <select id="sim-purpose" className={selectClass} value={f.purpose} onChange={(e) => set('purpose', e.target.value as SimulatorForm['purpose'])}>
              <option value="marketing">Marketing / promotion</option>
              <option value="service">Service (reminders, updates)</option>
              <option value="emergency">Emergency dispatch</option>
            </select>
          </div>
        )}
        <div>
          <label htmlFor="sim-state" className="mb-1 block text-xs font-medium text-text-secondary">Customer's state</label>
          <select id="sim-state" className={selectClass} value={f.customerState} onChange={(e) => set('customerState', e.target.value)}>
            <option value="">Unknown</option>
            {US_STATE_OPTIONS.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
        </div>
        {!isDoc && (
          <div className="grid grid-cols-2 gap-2">
            <Input label="Customer's local time" type="time" value={f.localHour} onChange={(e) => set('localHour', e.target.value)} />
            <div>
              <label htmlFor="sim-tz" className="mb-1.5 block text-sm font-medium text-text-primary">Time zone</label>
              <select id="sim-tz" className={selectClass} value={f.timezone} onChange={(e) => set('timezone', e.target.value)}>
                {TIMEZONES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <label htmlFor="sim-day" className="mb-1 block text-xs font-medium text-text-secondary">Day</label>
              <select id="sim-day" className={selectClass} value={f.weekdayOffset} onChange={(e) => set('weekdayOffset', Number(e.target.value))}>
                {[0, 1, 2, 3, 4, 5, 6].map((d) => {
                  const dt = new Date(Date.now() + d * 86_400_000);
                  return <option key={d} value={d}>{d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : dt.toLocaleDateString(undefined, { weekday: 'long' })}</option>;
                })}
              </select>
            </div>
          </div>
        )}
        {f.surface === 'call' && (
          <div className="space-y-2">
            <Toggle id="sim-ai" label="Placed or answered by the AI assistant" checked={f.aiVoice} onChange={(v) => set('aiVoice', v)} />
            <Toggle id="sim-disc" label="AI disclosure already given" checked={f.disclosureGiven} onChange={(v) => set('disclosureGiven', v)} />
          </div>
        )}
        {consentTypes.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs font-medium text-text-secondary">Consent on file</legend>
            {consentTypes.map((t) => (
              <div key={t} className="flex items-center justify-between gap-2">
                <label htmlFor={`sim-c-${t}`} className="text-sm text-text-primary">{CONSENT_TYPE_LABELS[t]}</label>
                <select id={`sim-c-${t}`} className="focus-ring rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-sm" value={f.consent[t] ?? 'none'} onChange={(e) => setConsent(t, e.target.value as ConsentState)}>
                  <option value="none">None</option><option value="granted">Granted</option><option value="revoked">Revoked</option>
                </select>
              </div>
            ))}
          </fieldset>
        )}
        {isMsg && f.surface === 'sms' && <Toggle id="sim-optout" label="Message explains how to opt out" checked={f.noticeIncluded} onChange={(v) => set('noticeIncluded', v)} />}
        {isDoc && (
          <div className="space-y-3">
            <div>
              <label htmlFor="sim-loc" className="mb-1 block text-xs font-medium text-text-secondary">Where is it being sold / signed?</label>
              <select id="sim-loc" className={selectClass} value={f.saleLocation} onChange={(e) => set('saleLocation', e.target.value as SimulatorForm['saleLocation'])}>
                <option value="customer_home">At the customer's home</option><option value="business_premises">At your business</option>
                <option value="phone">Over the phone</option><option value="online">Online</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input label="Total ($)" inputMode="decimal" value={f.totalDollars} onChange={(e) => set('totalDollars', e.target.value)} />
              <Input label="Price before emergency ($)" inputMode="decimal" value={f.baselineDollars} onChange={(e) => set('baselineDollars', e.target.value)} />
            </div>
            <Toggle id="sim-emerg" label="Emergency / disaster declared for this area" checked={f.emergencyDeclared} onChange={(v) => set('emergencyDeclared', v)} />
            <Toggle id="sim-repair" label="Emergency repair" checked={f.emergencyRepair} onChange={(v) => set('emergencyRepair', v)} />
            {f.emergencyRepair && <Toggle id="sim-waiver" label="Customer signed the emergency waiver" checked={f.waiverSigned} onChange={(v) => set('waiverSigned', v)} />}
            <Toggle id="sim-lic" label="License number is shown on the document" checked={f.licenseShown} onChange={(v) => set('licenseShown', v)} />
            <Toggle id="sim-notice" label="Cancellation notice is included" checked={f.noticeIncluded} onChange={(v) => set('noticeIncluded', v)} />
          </div>
        )}
      </form>

      <div aria-live="polite" className="min-w-0 space-y-4">
        {!result ? (
          <p className="text-sm text-text-secondary">Couldn't evaluate this situation.</p>
        ) : (
          <>
            {(() => {
              const o = OUTCOME[result.outcome];
              return (
                <div className={`flex items-center gap-3 rounded-2xl border p-4 ${o.cls}`}>
                  <o.Icon className="h-6 w-6 shrink-0" aria-hidden />
                  <div>
                    <p className="text-base font-semibold">{o.label}</p>
                    <p className="text-xs opacity-80">Based on {result.appliedVersionIds.length} approved rule{result.appliedVersionIds.length === 1 ? '' : 's'} in force on {result.effectiveDate}</p>
                  </div>
                </div>
              );
            })()}

            {result.actions.length > 0 && (
              <section aria-label="Required actions" className="rounded-2xl border border-border bg-bg-secondary p-4">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><ShieldAlert className="h-4 w-4" aria-hidden /> What to do</h3>
                <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-text-primary">
                  {result.actions.map((a, i) => <li key={i}>{a.type === 'say_script' || a.type === 'disclose' ? <>Say: <q>{a.text}</q></> : a.text}</li>)}
                </ol>
              </section>
            )}

            {result.rescissionDeadline && (
              <p className="flex items-center gap-2 rounded-xl border border-border bg-bg-secondary p-3 text-sm text-text-primary">
                <Clock className="h-4 w-4 shrink-0" aria-hidden /> The customer can cancel until the end of <strong>{result.rescissionDeadline}</strong>.
              </p>
            )}

            <section aria-label="Findings">
              <h3 className="mb-2 text-sm font-semibold text-text-primary">Rules that applied ({result.findings.length})</h3>
              {result.findings.length === 0 ? (
                <p className="text-sm text-text-secondary">No approved rule applies to this situation. That does not mean no law does — see the legal notice above.</p>
              ) : (
                <ul className="space-y-2">
                  {result.findings.map((fd) => (
                    <li key={fd.versionId} className="rounded-xl border border-border bg-bg-secondary p-3">
                      <div className="flex items-start gap-2">
                        {fd.status === 'pass' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success-500" aria-label="Passed" />
                          : fd.status === 'info' ? <Info className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" aria-label="Info" />
                          : fd.status === 'fail' ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-label="Failed" />
                          : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-500" aria-label="Action needed" />}
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-text-primary">{fd.title}</p>
                          <p className="text-sm text-text-secondary">{fd.message}</p>
                          <p className="mt-1 text-xs text-text-secondary">
                            {formatJurisdiction(fd.jurisdiction)} · {KIND_LABELS[fd.kind]} · {fd.sourceRefs.map((s) => s.citation).join('; ')}
                          </p>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {result.assumptions.length > 0 && (
              <section aria-label="Assumptions" className="rounded-xl border border-border bg-bg-primary p-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Assumptions made</h3>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-text-secondary">{result.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
