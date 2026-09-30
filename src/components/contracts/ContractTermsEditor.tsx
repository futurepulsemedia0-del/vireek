import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, FileText, PenLine, ShieldCheck, Sparkles, Upload, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import {
  emptyTerms,
  exclusionsToText,
  normalizeEvidence,
  normalizeTerms,
  splitCsv,
  splitLines,
  textToExclusions,
  type ContractTerms,
  type EngineContract,
  type EvidenceItem,
} from '@/lib/contractIntelligence';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary transition-colors';
const labelClass = 'mb-1.5 block text-sm font-medium text-text-primary';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_PDF_BYTES = 8 * 1024 * 1024;

export interface StoredProfile {
  id: string;
  contract_id: string;
  terms: unknown;
  evidence: unknown;
  missing_fields: string[] | null;
  source_kind: 'manual' | 'pasted_text' | 'pdf';
  extraction_confidence: number | null;
  extraction_model: string | null;
  review_status: 'draft' | 'verified';
  verified_at: string | null;
}

interface Meta {
  source_kind: 'manual' | 'pasted_text' | 'pdf';
  source_text?: string;
  model: string | null;
  confidence: number | null;
  evidence: EvidenceItem[];
  missing: string[];
}

interface Props {
  contract: EngineContract & { customer_name?: string };
  profile: StoredProfile | null;
  onClose: () => void;
  onSaved: () => void;
}

// ---- small field helpers (module-level so inputs never remount) -----------

function Num({ label, value, onChange, scale = 1, hint }: { label: string; value: number | null; onChange: (v: number | null) => void; scale?: number; hint?: string }) {
  return (
    <Input
      label={label}
      helperText={hint}
      type="number"
      min={0}
      step="any"
      value={value === null ? '' : value / scale}
      onChange={(e) => onChange(e.target.value === '' ? null : Math.round(Number(e.target.value) * scale * 100) / 100)}
    />
  );
}

function Sel({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  const id = `sel-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div>
      <label htmlFor={id} className={labelClass}>{label}</label>
      <select id={id} className={selectClass} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </select>
    </div>
  );
}

function Chk({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-text-primary">
      <input type="checkbox" className="h-4 w-4 rounded border-border accent-accent" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-xl border border-border p-4">
      <legend className="px-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">{title}</legend>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

async function fnErrorMessage(err: unknown): Promise<string> {
  const ctx = (err as { context?: Response } | null)?.context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      const body = await ctx.json();
      if (body && typeof body.error === 'string') return body.error;
    } catch {
      // fall through to the generic message
    }
  }
  return err instanceof Error ? err.message : 'Analysis failed. Please try again.';
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('Could not read the file.'));
    r.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------

export function ContractTermsEditor({ contract, profile, onClose, onSaved }: Props) {
  const { user } = useAuth();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<'source' | 'review'>(profile ? 'review' : 'source');
  const [text, setText] = useState('');
  const [pdf, setPdf] = useState<{ name: string; b64: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  const [terms, setTerms] = useState<ContractTerms>(() => normalizeTerms(profile?.terms));
  const [eqText, setEqText] = useState(() => terms.coverage.equipment_types.join(', '));
  const [svcText, setSvcText] = useState(() => terms.coverage.service_types.join(', '));
  const [exclText, setExclText] = useState(() => exclusionsToText(terms.coverage.exclusions));
  const [compText, setCompText] = useState(() => terms.compliance.requirements.join('\n'));
  const [meta, setMeta] = useState<Meta>(() => ({
    source_kind: profile?.source_kind ?? 'manual',
    model: profile?.extraction_model ?? null,
    confidence: profile?.extraction_confidence ?? null,
    evidence: normalizeEvidence(profile?.evidence),
    missing: profile?.missing_fields ?? [],
  }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && !saving && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, saving, onClose]);

  const up = (fn: (t: ContractTerms) => void) =>
    setTerms((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });

  const loadTermsIntoForm = (t: ContractTerms) => {
    setTerms(t);
    setEqText(t.coverage.equipment_types.join(', '));
    setSvcText(t.coverage.service_types.join(', '));
    setExclText(exclusionsToText(t.coverage.exclusions));
    setCompText(t.compliance.requirements.join('\n'));
  };

  const startManual = () => {
    const t = emptyTerms();
    t.sla.response_standard_minutes = contract.sla_response_minutes_standard;
    t.sla.response_emergency_minutes = contract.sla_response_minutes_critical;
    t.sla.resolution_hours = contract.sla_resolution_hours;
    t.renewal.auto_renew = contract.auto_renew;
    t.renewal.notice_days = contract.renewal_notice_days;
    loadTermsIntoForm(t);
    setMeta({ source_kind: 'manual', model: null, confidence: null, evidence: [], missing: [] });
    setStep('review');
  };

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.type !== 'application/pdf') return toast('Please choose a PDF file.', 'error');
    if (file.size > MAX_PDF_BYTES) return toast('PDF is too large (max 8 MB).', 'error');
    try {
      setPdf({ name: file.name, b64: await readBase64(file) });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not read the file.', 'error');
    }
  };

  const analyse = async () => {
    if (!text.trim() && !pdf) return toast('Paste the contract text or upload a PDF first.', 'error');
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('contract-intelligence-extract', {
        body: { contractId: contract.id, text: text.trim() || undefined, pdfBase64: pdf?.b64 },
      });
      if (error) throw new Error(await fnErrorMessage(error));
      const r = (data as { result?: Record<string, unknown>; model?: string } | null)?.result;
      if (!r || typeof r !== 'object') throw new Error('The AI returned no result. Try again.');
      const t = normalizeTerms(r.terms);
      loadTermsIntoForm(t);
      const conf = typeof r.confidence === 'number' && r.confidence >= 0 && r.confidence <= 1 ? Math.round(r.confidence * 1000) / 1000 : null;
      setMeta({
        source_kind: pdf ? 'pdf' : 'pasted_text',
        source_text: text.trim() || undefined,
        model: (data as { model?: string }).model ?? null,
        confidence: conf,
        evidence: normalizeEvidence(r.evidence),
        missing: Array.isArray(r.missing_fields) ? (r.missing_fields as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 40) : [],
      });
      setStep('review');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Analysis failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const save = async (verify: boolean) => {
    if (!user) return;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: terms.sla.timezone });
    } catch {
      return toast('Timezone is not valid (example: America/Chicago).', 'error');
    }
    if (terms.sla.clock === 'business' && terms.sla.business_end <= terms.sla.business_start) {
      return toast('Business hours must end after they start.', 'error');
    }
    const clean = normalizeTerms(
      {
        ...terms,
        coverage: { ...terms.coverage, equipment_types: splitCsv(eqText), service_types: splitCsv(svcText), exclusions: textToExclusions(exclText) },
        compliance: { requirements: splitLines(compText) },
      },
      terms.sla.timezone
    );
    setSaving(true);
    const payload: Record<string, unknown> = {
      contract_id: contract.id,
      user_id: user.id,
      terms: clean,
      evidence: meta.evidence,
      missing_fields: meta.missing,
      source_kind: meta.source_kind,
      extraction_model: meta.model,
      extraction_confidence: meta.confidence,
      review_status: verify ? 'verified' : 'draft',
      verified_at: verify ? new Date().toISOString() : null,
    };
    if (meta.source_text !== undefined) payload.source_text = meta.source_text;
    const { error } = await supabase.from('contract_intelligence_profiles').upsert(payload, { onConflict: 'contract_id' });
    setSaving(false);
    if (error) return toast('Could not save contract terms.', 'error');
    toast(verify ? 'Terms verified — jobs will now be evaluated against them.' : 'Draft saved.', 'success');
    onSaved();
  };

  const toggleDay = (d: number) =>
    up((t) => {
      const has = t.sla.business_days.includes(d);
      const next = has ? t.sla.business_days.filter((x) => x !== d) : [...t.sla.business_days, d].sort();
      if (next.length > 0) t.sla.business_days = next;
    });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8" role="dialog" aria-modal="true" aria-labelledby="cte-title">
      <div className="w-full max-w-3xl rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark">
        <div className="flex items-start justify-between gap-3 border-b border-border p-5">
          <div>
            <h2 id="cte-title" className="text-lg font-bold text-text-primary">Contract terms</h2>
            <p className="text-sm text-text-secondary">
              {contract.contract_name}
              {contract.customer_name ? ` · ${contract.customer_name}` : ''}
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy || saving} aria-label="Close" className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary">
            <X size={18} />
          </button>
        </div>

        {step === 'source' ? (
          <div className="space-y-4 p-5">
            <p className="text-sm text-text-secondary">
              Paste the agreement or upload the PDF. Vireek reads it, extracts the SLA, coverage, exclusions, responsibilities and more — with the exact clause behind each term — and you verify before anything is acted on.
            </p>
            <Textarea label="Contract text" rows={9} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the full agreement text here…" helperText="Up to ~120,000 characters. Text is used only to analyse this contract." />
            <div className="flex flex-wrap items-center gap-3">
              <input ref={fileRef} type="file" accept="application/pdf" className="sr-only" onChange={(e) => onPickFile(e.target.files?.[0])} />
              <Button type="button" variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
                <Upload size={15} /> {pdf ? 'Replace PDF' : 'Upload PDF'}
              </Button>
              {pdf && (
                <span className="inline-flex items-center gap-1.5 text-sm text-text-secondary">
                  <FileText size={14} /> {pdf.name}
                  <button type="button" onClick={() => setPdf(null)} aria-label="Remove PDF" className="focus-ring rounded p-0.5 hover:text-text-primary"><X size={13} /></button>
                </span>
              )}
            </div>
            <div className="flex flex-wrap justify-between gap-3 border-t border-border pt-4">
              <Button type="button" variant="ghost" size="sm" onClick={startManual} disabled={busy}>
                <PenLine size={15} /> Enter terms manually
              </Button>
              <Button type="button" size="sm" onClick={analyse} disabled={busy}>
                <Sparkles size={15} /> {busy ? 'Reading contract…' : 'Analyse contract'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 p-5">
            {(meta.confidence !== null || meta.missing.length > 0) && (
              <div className="rounded-xl border border-warning-500/30 bg-warning-500/10 p-3 text-sm text-text-primary">
                <p className="flex items-center gap-2 font-medium">
                  <AlertTriangle size={15} className="text-warning-500" />
                  {meta.confidence !== null ? `AI confidence ${Math.round(meta.confidence * 100)}%` : 'Review needed'} — check every value against the contract before verifying.
                </p>
                {meta.missing.length > 0 && <p className="mt-1 text-xs text-text-secondary">Not found in the document: {meta.missing.join(', ')}</p>}
              </div>
            )}

            <Section title="SLA & response clock">
              <Sel label="Clock" value={terms.sla.clock} onChange={(v) => up((t) => (t.sla.clock = v as ContractTerms['sla']['clock']))} options={[['calendar', '24/7 (calendar time)'], ['business', 'Business hours only']]} />
              <Input label="Timezone" value={terms.sla.timezone} onChange={(e) => up((t) => (t.sla.timezone = e.target.value))} placeholder="America/Chicago" />
              {terms.sla.clock === 'business' && (
                <>
                  <Input label="Opens" type="time" value={terms.sla.business_start} onChange={(e) => up((t) => (t.sla.business_start = e.target.value || t.sla.business_start))} />
                  <Input label="Closes" type="time" value={terms.sla.business_end} onChange={(e) => up((t) => (t.sla.business_end = e.target.value || t.sla.business_end))} />
                  <div className="sm:col-span-2">
                    <span className={labelClass}>Business days</span>
                    <div className="flex flex-wrap gap-3">
                      {DAYS.map((d, i) => (
                        <Chk key={d} label={d} checked={terms.sla.business_days.includes(i)} onChange={() => toggleDay(i)} />
                      ))}
                    </div>
                  </div>
                </>
              )}
              <Num label="Emergency response (min)" value={terms.sla.response_emergency_minutes} onChange={(v) => up((t) => (t.sla.response_emergency_minutes = v))} />
              <Num label="Urgent response (min)" value={terms.sla.response_urgent_minutes} onChange={(v) => up((t) => (t.sla.response_urgent_minutes = v))} />
              <Num label="Standard response (min)" value={terms.sla.response_standard_minutes} onChange={(v) => up((t) => (t.sla.response_standard_minutes = v))} />
              <Num label="Resolution target (hours)" value={terms.sla.resolution_hours} onChange={(v) => up((t) => (t.sla.resolution_hours = v))} />
              <Sel
                label="Penalty type"
                value={terms.sla.penalty_type}
                onChange={(v) => up((t) => (t.sla.penalty_type = v as ContractTerms['sla']['penalty_type']))}
                options={[['none', 'No penalty'], ['percent_of_invoice', '% of job invoice'], ['percent_of_monthly_fee', '% of monthly fee'], ['flat_cents', 'Flat amount ($)']]}
              />
              {terms.sla.penalty_type !== 'none' && (
                <>
                  <Num label={terms.sla.penalty_type === 'flat_cents' ? 'Penalty amount ($)' : 'Penalty (%)'} scale={terms.sla.penalty_type === 'flat_cents' ? 100 : 1} value={terms.sla.penalty_amount} onChange={(v) => up((t) => (t.sla.penalty_amount = v))} />
                  <Num label="Repeats every (min late)" value={terms.sla.penalty_interval_minutes} onChange={(v) => up((t) => (t.sla.penalty_interval_minutes = v))} hint="Leave empty for a one-time penalty." />
                </>
              )}
            </Section>

            <Section title="Coverage & exclusions">
              <div className="sm:col-span-2 flex flex-wrap gap-5">
                <Chk label="Covers all customer equipment" checked={terms.coverage.all_assets} onChange={(v) => up((t) => (t.coverage.all_assets = v))} />
                <Chk label="After-hours calls covered" checked={terms.coverage.after_hours_covered} onChange={(v) => up((t) => (t.coverage.after_hours_covered = v))} />
              </div>
              <Input label="Covered equipment types" value={eqText} onChange={(e) => setEqText(e.target.value)} placeholder="rooftop unit, chiller" helperText="Comma-separated. Used when not covering all equipment." />
              <Input label="Covered service types" value={svcText} onChange={(e) => setSvcText(e.target.value)} placeholder="repair, maintenance" helperText="Comma-separated. Empty = every service type." />
              <div className="sm:col-span-2">
                <Textarea label="Exclusions" rows={3} value={exclText} onChange={(e) => setExclText(e.target.value)} placeholder={'vandalism\nservice_type: installation\nequipment_type: generator'} helperText="One per line. Prefix with service_type: or equipment_type: to match those fields; plain lines match keywords." />
              </div>
            </Section>

            <Section title="Who pays">
              <Sel label="Labor" value={terms.responsibility.labor} onChange={(v) => up((t) => (t.responsibility.labor = v as ContractTerms['responsibility']['labor']))} options={[['contractor', 'Covered (service company absorbs)'], ['customer', 'Billable to customer'], ['shared', 'Shared / capped']]} />
              <Sel label="Parts" value={terms.responsibility.parts} onChange={(v) => up((t) => (t.responsibility.parts = v as ContractTerms['responsibility']['parts']))} options={[['contractor', 'Covered (service company absorbs)'], ['customer', 'Billable to customer'], ['shared', 'Shared / capped'], ['warranty_only', 'Only while under manufacturer warranty']]} />
              <Num label="Per-visit cap ($)" scale={100} value={terms.responsibility.per_visit_cap_cents} onChange={(v) => up((t) => (t.responsibility.per_visit_cap_cents = v))} />
              <Num label="Labor warranty (months)" value={terms.warranty.labor_months} onChange={(v) => up((t) => (t.warranty.labor_months = v))} />
              <Num label="Parts warranty (months)" value={terms.warranty.parts_months} onChange={(v) => up((t) => (t.warranty.parts_months = v))} />
              <Input label="Warranty notes" value={terms.warranty.notes} onChange={(e) => up((t) => (t.warranty.notes = e.target.value))} />
            </Section>

            <Section title="Renewal & pricing">
              <Sel label="Auto-renew" value={terms.renewal.auto_renew === null ? '' : terms.renewal.auto_renew ? 'yes' : 'no'} onChange={(v) => up((t) => (t.renewal.auto_renew = v === '' ? null : v === 'yes'))} options={[['', 'Not stated'], ['yes', 'Yes'], ['no', 'No']]} />
              <Num label="Renewal notice (days)" value={terms.renewal.notice_days} onChange={(v) => up((t) => (t.renewal.notice_days = v))} />
              <Num label="Term (months)" value={terms.renewal.term_months} onChange={(v) => up((t) => (t.renewal.term_months = v))} />
              <Sel label="Price escalation" value={terms.pricing.escalation_type} onChange={(v) => up((t) => (t.pricing.escalation_type = v as ContractTerms['pricing']['escalation_type']))} options={[['none', 'None'], ['fixed_percent', 'Fixed %'], ['cpi', 'CPI-linked']]} />
              {terms.pricing.escalation_type !== 'none' && (
                <>
                  <Num label="Escalation (%)" value={terms.pricing.escalation_percent} onChange={(v) => up((t) => (t.pricing.escalation_percent = v))} />
                  <Num label="Escalation cap (%)" value={terms.pricing.escalation_cap_percent} onChange={(v) => up((t) => (t.pricing.escalation_cap_percent = v))} />
                  <Input label="Next escalation date" type="date" value={terms.pricing.next_escalation_date ?? ''} onChange={(e) => up((t) => (t.pricing.next_escalation_date = e.target.value || null))} />
                </>
              )}
            </Section>

            <Section title="Compliance">
              <div className="sm:col-span-2">
                <Textarea label="Requirements" rows={3} value={compText} onChange={(e) => setCompText(e.target.value)} placeholder={'EPA 608 certified technicians\n$2M general liability certificate on file'} helperText="One per line — certifications, licenses, insurance, background checks, reporting." />
              </div>
            </Section>

            {meta.evidence.length > 0 && (
              <details className="rounded-xl border border-border p-4">
                <summary className="cursor-pointer text-sm font-medium text-text-primary">Contract evidence ({meta.evidence.length})</summary>
                <ul className="mt-3 space-y-2">
                  {meta.evidence.map((e, i) => (
                    <li key={`${e.field}-${i}`} className="text-xs">
                      <span className="font-mono text-accent">{e.field}</span>
                      <p className="mt-0.5 text-text-secondary">“{e.quote}”</p>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              <Button type="button" variant="ghost" size="sm" onClick={() => setStep('source')} disabled={saving}>
                <Sparkles size={15} /> Re-analyse
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={() => save(false)} disabled={saving}>Save draft</Button>
                <Button type="button" size="sm" onClick={() => save(true)} disabled={saving}>
                  <ShieldCheck size={15} /> {saving ? 'Saving…' : 'Verify & save'}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
