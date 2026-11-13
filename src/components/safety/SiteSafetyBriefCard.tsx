// Recreated: verify against original intent
import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldCheck, TriangleAlert } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DeclineSheet } from '@/components/safety/DeclineSheet';
import {
  EMERGENCY_SERVICES_NOTICE,
  HAZARD_CATEGORIES,
  MAX_FACT_TEXT,
  ackBrief,
  addFact,
  fetchBrief,
  lintFactText,
  type BriefFact,
  type HazardCategory,
  type Precaution,
  type RiskTier,
  type SafetyBrief,
} from '@/lib/siteSafety';

const TIER_STYLE: Record<RiskTier, { label: string; cls: string }> = {
  standard: { label: 'Standard', cls: 'bg-success-500/10 text-success-500' },
  elevated: { label: 'Elevated', cls: 'bg-warning-500/10 text-warning-500' },
  high: { label: 'High', cls: 'bg-danger/10 text-danger' },
};

const PRECAUTION_LABEL: Record<Precaution, string> = {
  customer_present: 'Make sure the customer is present',
  daytime_only: 'Work in daylight hours only',
  two_person_crew: 'Take a second person',
  meet_outside_first: 'Meet the customer outside first',
  remote_video_preassessment: 'Do a remote video pre-assessment first',
};

const CATEGORY_LABEL: Record<HazardCategory, string> = {
  animal: 'Animal',
  lighting: 'Lighting',
  structure: 'Structure',
  aggressive_behavior: 'Aggressive behaviour (reported)',
  intoxication_reported: 'Intoxication (reported)',
  access_hazard: 'Access hazard',
  electrical_hazard: 'Electrical hazard',
  biological_hazard: 'Biological hazard',
  other_event: 'Other event',
};

const LINT_MESSAGE: Record<string, string> = {
  empty: 'Describe what you saw.',
  too_long: `Keep it under ${MAX_FACT_TEXT} characters.`,
  area_profiling: 'Describe the property or the event, not the area.',
};

const SOURCE_LABEL: Record<string, string> = {
  call_volunteered: 'Customer call',
  staff_incident: 'Staff incident',
  equipment_data: 'Equipment data',
  technician_report: 'Technician report',
  customer_self_report: 'Customer',
};

const fmtDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

function FactRow({ f }: { f: BriefFact }) {
  return (
    <li className="px-3 py-2 text-sm">
      <p className="flex flex-wrap items-center gap-2 font-medium text-text-primary">
        {CATEGORY_LABEL[f.category] ?? f.category}
        {f.status === 'unreviewed' && <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-semibold text-text-secondary">Not yet confirmed</span>}
      </p>
      <p className="break-words text-text-secondary">{f.text}</p>
      <p className="text-[11px] text-text-secondary">{SOURCE_LABEL[f.source] ?? f.source} · {fmtDay(f.occurred_on)} · expires {fmtDay(f.expires_on)}</p>
    </li>
  );
}

/** Pre-job safety brief: risk tier, precautions and dated facts for this exact address. Hidden when the module is off. */
export function SiteSafetyBriefCard({ jobId }: { jobId: string }) {
  const { toast } = useToast();
  const [brief, setBrief] = useState<SafetyBrief | null>(null);
  const [error, setError] = useState(false);
  const [acking, setAcking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [category, setCategory] = useState<HazardCategory>('animal');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);
  const lock = useRef(false);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(false);
    try {
      const b = await fetchBrief(jobId);
      if (mine === seq.current) setBrief(b);
    } catch {
      if (mine === seq.current) setError(true);
    }
  }, [jobId]);

  useEffect(() => {
    setBrief(null);
    void load();
    return () => { seq.current++; };
  }, [load]);

  if (error) {
    return (
      <div role="alert" className="rounded-xl border border-border bg-bg-secondary p-3 text-xs text-text-secondary">
        Could not load the safety brief. <button type="button" onClick={() => void load()} className="focus-ring font-semibold text-accent underline">Try again</button>
      </div>
    );
  }
  if (!brief || !brief.enabled) return null;

  const tier = brief.tier ?? 'standard';
  const style = TIER_STYLE[tier];
  const lint = text.trim() ? lintFactText(text) : { ok: false, codes: [] as string[] };
  const lintMsg = lint.codes.map((c) => LINT_MESSAGE[c] ?? 'This wording cannot be saved. Describe the event or the property only.').filter((m, i, a) => a.indexOf(m) === i);

  const ack = async () => {
    if (acking) return;
    setAcking(true);
    try {
      await ackBrief(jobId);
      setBrief((b) => (b ? { ...b, acknowledged: true } : b));
    } catch {
      toast('Could not record that you read the brief.', 'error');
    } finally {
      setAcking(false);
    }
  };

  const submitFact = async () => {
    if (lock.current || !lint.ok) return;
    lock.current = true;
    setSaving(true);
    try {
      const res = await addFact({ jobId, category, text: text.trim(), source: 'technician_report' });
      if (res.ok) {
        toast('Saved. A manager will confirm it.', 'success');
        setText('');
        setAdding(false);
        await load();
      } else {
        toast(res.codes?.length ? 'That wording cannot be saved. Describe the event or the property only.' : 'Could not save this note.', 'error');
      }
    } catch {
      toast('Could not save this note. Try again.', 'error');
    } finally {
      lock.current = false;
      setSaving(false);
    }
  };

  const facts = brief.facts ?? [];

  return (
    <section aria-labelledby={`ssb-${jobId}`} className="rounded-xl border border-border bg-bg-secondary p-4">
      <div className="flex items-start justify-between gap-3">
        <h2 id={`ssb-${jobId}`} className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <ShieldCheck size={16} aria-hidden="true" /> Site safety brief
        </h2>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${style.cls}`}>{style.label} risk</span>
      </div>

      {brief.capped_pending_review && (
        <p className="mt-2 text-xs text-text-secondary">Some information from calls is waiting for a manager to confirm it, so this level may change.</p>
      )}
      {brief.outside_daytime && (
        <p className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-warning-500"><TriangleAlert size={13} aria-hidden="true" /> This visit is outside daylight hours.</p>
      )}
      {brief.job_flag && (
        <p className="mt-2 rounded-lg bg-warning-500/10 px-3 py-2 text-xs text-warning-500">Flagged for this job{brief.job_flag.note ? `: ${brief.job_flag.note}` : '.'}</p>
      )}

      {(brief.precautions?.length ?? 0) > 0 && (
        <div className="mt-3">
          <h3 className="text-xs font-semibold text-text-secondary">Precautions</h3>
          <ul className="mt-1 list-disc space-y-0.5 ps-5 text-sm text-text-primary">
            {brief.precautions!.map((p) => <li key={p}>{PRECAUTION_LABEL[p] ?? p}</li>)}
          </ul>
        </div>
      )}

      <div className="mt-3">
        <h3 className="text-xs font-semibold text-text-secondary">Known at this address</h3>
        {facts.length === 0 ? (
          <p className="mt-1 text-xs text-text-secondary">{brief.site_known ? 'Nothing current is recorded.' : 'No history for this exact address.'}</p>
        ) : (
          <ul className="mt-1 divide-y divide-border rounded-lg border border-border">
            {facts.map((f) => <FactRow key={f.id} f={f} />)}
          </ul>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {!brief.acknowledged && (
          <button type="button" onClick={() => void ack()} disabled={acking} className="focus-ring min-h-[44px] rounded-lg bg-accent px-4 text-sm font-semibold text-white disabled:opacity-60">
            {acking ? 'Saving…' : 'I have read this'}
          </button>
        )}
        <button type="button" onClick={() => setAdding((v) => !v)} aria-expanded={adding} className="focus-ring min-h-[44px] rounded-lg border border-border px-4 text-sm font-semibold text-text-primary">Report a hazard</button>
        <button type="button" onClick={() => setDeclining((v) => !v)} aria-expanded={declining} className="focus-ring min-h-[44px] rounded-lg border border-border px-4 text-sm font-semibold text-text-primary">Decline or reschedule</button>
      </div>

      {adding && (
        <div className="mt-3 space-y-2 rounded-lg border border-border bg-bg-primary p-3">
          <label htmlFor={`ssb-cat-${jobId}`} className="block text-xs font-semibold text-text-secondary">What kind of hazard?</label>
          <select id={`ssb-cat-${jobId}`} value={category} onChange={(e) => setCategory(e.target.value as HazardCategory)} className="focus-ring min-h-[44px] w-full rounded-lg border border-border bg-bg-secondary px-3 text-sm text-text-primary">
            {HAZARD_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
          </select>
          <label htmlFor={`ssb-text-${jobId}`} className="block text-xs font-semibold text-text-secondary">What did you see? (this address only)</label>
          <textarea id={`ssb-text-${jobId}`} value={text} maxLength={MAX_FACT_TEXT} rows={3} onChange={(e) => setText(e.target.value)} className="focus-ring w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary" aria-invalid={text.trim() !== '' && !lint.ok || undefined} />
          {lintMsg.length > 0 && <p role="alert" className="text-xs text-danger">{lintMsg.join(' ')}</p>}
          <p className="text-[11px] text-text-secondary">Describe events and the property, never people’s traits or the neighbourhood.</p>
          <div className="flex justify-end">
            <button type="button" onClick={() => void submitFact()} disabled={!lint.ok || saving} className="focus-ring min-h-[44px] rounded-lg bg-accent px-4 text-sm font-semibold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save note'}</button>
          </div>
        </div>
      )}

      {declining && <div className="mt-3"><DeclineSheet jobId={jobId} onClose={() => setDeclining(false)} onDone={() => void load()} /></div>}

      <p className="mt-3 text-[11px] text-text-secondary">{EMERGENCY_SERVICES_NOTICE}</p>
    </section>
  );
}
