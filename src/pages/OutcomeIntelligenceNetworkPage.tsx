import { useCallback, useEffect, useMemo, useState } from 'react';
import { Brain, CheckCircle2, ClipboardCheck, Lock, Network, RefreshCw, Search, ShieldCheck, Users } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { OutcomeChain } from '@/components/OutcomeChain';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';
import {
  CLIMATE_OPTIONS,
  LEVEL_SCOPE,
  MATURITY_DAYS,
  MIN_CASES,
  MIN_CONTRIBUTORS,
  buildChain,
  climateBandFromLatitude,
  computeCalibration,
  confidenceTier,
  formatMinutes,
  formatMoney,
  formatPct,
  friendlyOinError,
  labelFor,
  labelMap,
  suggestFromText,
  type ClimateBand,
  type Confidence,
  type OinCase,
  type OinOverview,
  type OinRecommendResult,
  type OinTrade,
  type TaxonomyItem,
} from '@/lib/outcomeNetwork';
import {
  fetchCapturableJobs,
  fetchEquipmentOptions,
  fetchMyCases,
  fetchOverview,
  fetchTaxonomy,
  fetchTrade,
  matureMyCases,
  recommend,
  recordCase,
  setContribution,
  type CapturableJob,
  type EquipmentOption,
} from '@/lib/outcomeNetworkApi';

type Tab = 'intelligence' | 'capture' | 'network';

const CONFIDENCE_STYLE: Record<Confidence, string> = {
  high: 'bg-success-500/10 text-success-500',
  medium: 'bg-warning-500/10 text-warning-500',
  low: 'bg-bg-tertiary text-text-secondary',
};

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`focus-ring rounded-full border px-3 py-1.5 text-sm transition-colors ${
        active ? 'border-accent bg-accent/15 text-accent' : 'border-border bg-bg-primary text-text-secondary hover:border-accent/40'
      }`}
    >
      {children}
    </button>
  );
}

function toggle(list: string[], key: string, max: number): string[] {
  if (list.includes(key)) return list.filter((k) => k !== key);
  return list.length >= max ? list : [...list, key];
}

function SelectField({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="w-full">
      <label className="mb-1.5 block text-sm font-medium text-text-primary">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary focus-visible:border-accent"
      >
        {children}
      </select>
    </div>
  );
}

// ============================================================
// Consent
// ============================================================

function ConsentCard({ contributing, busy, onChange }: { contributing: boolean; busy: boolean; onChange: (v: boolean) => void }) {
  return (
    <Card className="!p-6">
      <div className="flex items-start gap-4">
        <ShieldCheck className="mt-0.5 h-6 w-6 shrink-0 text-accent" aria-hidden="true" />
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-text-primary">Network data-sharing is {contributing ? 'on' : 'off'}</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Share anonymized outcomes, get the network&apos;s intelligence back. Only contributing businesses can read it.
          </p>
          <div className="mt-4 grid gap-4 text-sm md:grid-cols-2">
            <div>
              <p className="font-medium text-text-primary">What is shared</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-text-secondary">
                <li>Equipment type, make and model</li>
                <li>Symptom, diagnosis, action and part categories</li>
                <li>A coarse climate band (never coordinates)</li>
                <li>Whether it worked, callback, and rounded cost/time</li>
              </ul>
            </div>
            <div>
              <p className="font-medium text-text-primary">What is never shared</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-text-secondary">
                <li>Customer names, phones, addresses or notes</li>
                <li>Technician identities or your business name</li>
                <li>Exact prices, dates, jobs or any free text</li>
                <li>Anything from a group of fewer than {MIN_CONTRIBUTORS} businesses</li>
              </ul>
            </div>
          </div>
          <p className="mt-3 text-xs text-text-secondary">
            Outcomes count only after {MATURITY_DAYS} days. Switching this off removes your data from the published statistics at the next nightly refresh.
          </p>
          <div className="mt-4">
            <Button variant={contributing ? 'secondary' : 'primary'} size="sm" disabled={busy} onClick={() => onChange(!contributing)}>
              {busy ? 'Saving…' : contributing ? 'Stop sharing' : 'Turn on data-sharing'}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ============================================================
// Tab 1 — Network intelligence
// ============================================================

function IntelligenceTab({
  trade,
  taxonomy,
  contributing,
  onGoNetwork,
}: {
  trade: OinTrade;
  taxonomy: TaxonomyItem[];
  contributing: boolean;
  onGoNetwork: () => void;
}) {
  const { toast } = useToast();
  const [equipment, setEquipment] = useState<EquipmentOption[]>([]);
  const [eqType, setEqType] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [climate, setClimate] = useState<ClimateBand>('unknown');
  const [symptoms, setSymptoms] = useState<string[]>([]);
  const [failureMode, setFailureMode] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OinRecommendResult | null>(null);

  const labels = useMemo(() => labelMap(taxonomy), [taxonomy]);
  const symptomItems = useMemo(() => taxonomy.filter((t) => t.kind === 'symptom'), [taxonomy]);
  const failureItems = useMemo(() => taxonomy.filter((t) => t.kind === 'failure_mode'), [taxonomy]);

  useEffect(() => {
    fetchEquipmentOptions().then(setEquipment).catch(() => undefined);
  }, []);

  const types = useMemo(() => [...new Set(equipment.map((e) => e.equipment_type).filter(Boolean))].sort(), [equipment]);
  const makes = useMemo(() => [...new Set(equipment.map((e) => e.make).filter((m): m is string => !!m))].sort(), [equipment]);

  const ask = useCallback(async () => {
    setBusy(true);
    try {
      setResult(
        await recommend({ trade, equipmentType: eqType, make, model, climate, symptoms, failureMode: failureMode || null }),
      );
    } catch (e) {
      toast(friendlyOinError(e, 'Could not reach the network. Please try again.'), 'error');
    } finally {
      setBusy(false);
    }
  }, [trade, eqType, make, model, climate, symptoms, failureMode, toast]);

  if (!contributing) {
    return (
      <Card className="!p-8 text-center">
        <Lock className="mx-auto h-8 w-8 text-text-secondary" aria-hidden="true" />
        <h2 className="mt-3 text-lg font-semibold text-text-primary">Network intelligence unlocks when you contribute</h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-text-secondary">
          Every business that shares anonymized outcomes gets what works across the whole network — for its equipment, symptoms and climate.
        </p>
        <div className="mt-4">
          <Button onClick={onGoNetwork}>Review data-sharing</Button>
        </div>
      </Card>
    );
  }

  const canAsk = eqType.trim().length > 0 && symptoms.length > 0;

  return (
    <div className="space-y-6">
      <Card className="!p-6">
        <h2 className="text-lg font-semibold text-text-primary">What actually works for this problem?</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <Input label="Equipment type" list="oin-types" value={eqType} onChange={(e) => setEqType(e.target.value)} placeholder="e.g. Furnace" />
          <Input label="Make" list="oin-makes" value={make} onChange={(e) => setMake(e.target.value)} placeholder="e.g. Carrier" />
          <Input label="Model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. 59TP6A" />
        </div>
        <datalist id="oin-types">{types.map((t) => <option key={t} value={t} />)}</datalist>
        <datalist id="oin-makes">{makes.map((m) => <option key={m} value={m} />)}</datalist>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <SelectField label="Climate" value={climate} onChange={(v) => setClimate(v as ClimateBand)}>
            {CLIMATE_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </SelectField>
          <SelectField label="Diagnosis (optional)" value={failureMode} onChange={setFailureMode}>
            <option value="">Not diagnosed yet</option>
            {failureItems.map((f) => (
              <option key={f.key} value={f.key}>{f.label}</option>
            ))}
          </SelectField>
        </div>

        <p className="mb-2 mt-4 text-sm font-medium text-text-primary">Symptoms (up to 8)</p>
        <div className="flex flex-wrap gap-2">
          {symptomItems.map((s) => (
            <Chip key={s.key} active={symptoms.includes(s.key)} onClick={() => setSymptoms((cur) => toggle(cur, s.key, 8))}>
              {s.label}
            </Chip>
          ))}
        </div>

        <div className="mt-5">
          <Button onClick={ask} disabled={!canAsk || busy}>
            <Search className="h-4 w-4" aria-hidden="true" />
            {busy ? 'Asking the network…' : 'Ask the network'}
          </Button>
        </div>
      </Card>

      {result && result.recommendations.length === 0 && (
        <EmptyState
          icon={Network}
          title="The network is still learning this combination"
          description={`Results appear once at least ${MIN_CONTRIBUTORS} businesses and ${MIN_CASES} matured outcomes cover it. Try a broader make/climate, or remove the diagnosis.`}
        />
      )}

      {result && result.recommendations.length > 0 && (
        <FadeIn>
          <div className="space-y-3">
            {result.recommendations.map((r, idx) => {
              const tier = confidenceTier(r);
              return (
                <Card key={r.action_key} className="!p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">#{idx + 1} · {LEVEL_SCOPE[r.level] ?? 'Network'}</p>
                      <h3 className="mt-0.5 text-lg font-semibold text-text-primary">{r.action_label}</h3>
                    </div>
                    <div className="text-right">
                      <p className="text-2xl font-bold text-text-primary">{formatPct(r.success_rate)}</p>
                      <p className="text-xs text-text-secondary">success · range {formatPct(r.wilson_low)}–{formatPct(r.wilson_high)}</p>
                    </div>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-bg-tertiary" role="img" aria-label={`Lower bound ${formatPct(r.wilson_low)}, estimate ${formatPct(r.success_rate)}`}>
                    <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(r.success_rate * 100)}%` }} />
                  </div>
                  <dl className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
                    <div><dt className="text-text-secondary">First-visit fix</dt><dd className="font-semibold text-text-primary">{formatPct(r.first_visit_rate)}</dd></div>
                    <div><dt className="text-text-secondary">Callback rate</dt><dd className="font-semibold text-text-primary">{formatPct(r.callback_rate)}</dd></div>
                    <div><dt className="text-text-secondary">Typical price</dt><dd className="font-semibold text-text-primary">{formatMoney(r.median_cost_cents)}</dd></div>
                    <div><dt className="text-text-secondary">Typical time</dt><dd className="font-semibold text-text-primary">{formatMinutes(r.median_duration_minutes)}</dd></div>
                    <div><dt className="text-text-secondary">Evidence</dt><dd className="font-semibold text-text-primary">{r.case_count} jobs · {r.contributor_count} businesses</dd></div>
                  </dl>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                    <span className={`rounded-full px-2.5 py-1 font-medium ${CONFIDENCE_STYLE[tier]}`}>{tier} confidence</span>
                    {r.top_parts.map((p) => (
                      <span key={p.part} className="rounded-full bg-bg-tertiary px-2.5 py-1 text-text-secondary">
                        {labelFor(labels, 'part', p.part)} · {formatPct(p.share)}
                      </span>
                    ))}
                  </div>
                </Card>
              );
            })}
          </div>
        </FadeIn>
      )}
    </div>
  );
}

// ============================================================
// Tab 2 — Capture outcomes
// ============================================================

function CaptureForm({ job, trade, taxonomy, onSaved }: { job: CapturableJob; trade: OinTrade; taxonomy: TaxonomyItem[]; onSaved: (c: OinCase) => void }) {
  const { toast } = useToast();
  const items = (kind: TaxonomyItem['kind']) => taxonomy.filter((t) => t.kind === kind);
  const [symptoms, setSymptoms] = useState<string[]>(() => suggestFromText(job.notes ?? job.service_type ?? '', items('symptom')));
  const [failureMode, setFailureMode] = useState('');
  const [action, setAction] = useState('');
  const [parts, setParts] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      // Best-effort: record what the network predicted for the chosen action, to measure calibration later.
      let predicted: number | null = null;
      if (job.equipment) {
        try {
          const r = await recommend({
            trade,
            equipmentType: job.equipment.equipment_type,
            make: job.equipment.make ?? '',
            model: job.equipment.model ?? '',
            climate: climateBandFromLatitude(job.latitude),
            symptoms,
            failureMode,
          });
          predicted = r.recommendations.find((x) => x.action_key === action)?.success_rate ?? null;
        } catch {
          predicted = null;
        }
      }
      const saved = await recordCase({
        jobId: job.id,
        symptoms,
        failureMode,
        action,
        parts,
        equipmentId: job.equipment?.id ?? null,
        predictedSuccess: predicted,
        predictedAction: predicted != null ? action : null,
      });
      toast('Outcome captured. It joins the network after the 30-day check.', 'success');
      onSaved(saved);
    } catch (e) {
      toast(friendlyOinError(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 space-y-4 border-t border-border pt-4">
      <div>
        <p className="mb-2 text-sm font-medium text-text-primary">Symptoms</p>
        <div className="flex flex-wrap gap-2">
          {items('symptom').map((s) => (
            <Chip key={s.key} active={symptoms.includes(s.key)} onClick={() => setSymptoms((c) => toggle(c, s.key, 8))}>{s.label}</Chip>
          ))}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <SelectField label="Diagnosis" value={failureMode} onChange={setFailureMode}>
          <option value="">Select…</option>
          {items('failure_mode').map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </SelectField>
        <SelectField label="Action taken" value={action} onChange={setAction}>
          <option value="">Select…</option>
          {items('action').map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
        </SelectField>
      </div>
      <div>
        <p className="mb-2 text-sm font-medium text-text-primary">Parts used (optional)</p>
        <div className="flex flex-wrap gap-2">
          {items('part').map((p) => (
            <Chip key={p.key} active={parts.includes(p.key)} onClick={() => setParts((c) => toggle(c, p.key, 8))}>{p.label}</Chip>
          ))}
        </div>
      </div>
      <Button size="sm" onClick={save} disabled={saving || symptoms.length === 0 || !failureMode || !action}>
        {saving ? 'Saving…' : 'Capture outcome'}
      </Button>
    </div>
  );
}

function CaptureTab({ trade, taxonomy, onCaptured }: { trade: OinTrade; taxonomy: TaxonomyItem[]; onCaptured: () => void }) {
  const [jobs, setJobs] = useState<CapturableJob[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const { toast } = useToast();

  const load = useCallback(() => {
    fetchCapturableJobs()
      .then(setJobs)
      .catch((e) => {
        toast(friendlyOinError(e, 'Could not load completed jobs.'), 'error');
        setJobs([]);
      });
  }, [toast]);

  useEffect(load, [load]);

  if (jobs === null) return <SkeletonCardList count={3} />;
  if (jobs.length === 0) {
    return (
      <EmptyState
        icon={ClipboardCheck}
        title="Every completed job is captured"
        description="New completed jobs appear here so you can record symptom, diagnosis and action in under a minute."
      />
    );
  }

  return (
    <div className="space-y-3">
      {jobs.map((job) => (
        <Card key={job.id} className="!p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-semibold text-text-primary">{job.customer_name}</p>
              <p className="text-sm text-text-secondary">
                {[job.service_type, job.equipment ? [job.equipment.make, job.equipment.equipment_type, job.equipment.model].filter(Boolean).join(' ') : 'No equipment linked']
                  .filter(Boolean)
                  .join(' · ')}
                {job.completed_at ? ` · ${new Date(job.completed_at).toLocaleDateString()}` : ''}
              </p>
            </div>
            <Button size="sm" variant={openId === job.id ? 'ghost' : 'secondary'} onClick={() => setOpenId(openId === job.id ? null : job.id)}>
              {openId === job.id ? 'Close' : 'Capture'}
            </Button>
          </div>
          {!job.equipment && openId !== job.id && (
            <p className="mt-2 text-xs text-text-secondary">Link equipment to this job so it can contribute to network statistics.</p>
          )}
          {openId === job.id && (
            <CaptureForm
              job={job}
              trade={trade}
              taxonomy={taxonomy}
              onSaved={() => {
                setOpenId(null);
                setJobs((cur) => (cur ?? []).filter((j) => j.id !== job.id));
                onCaptured();
              }}
            />
          )}
        </Card>
      ))}
    </div>
  );
}

// ============================================================
// Tab 3 — My network
// ============================================================

function NetworkTab({
  overview,
  taxonomy,
  cases,
  busy,
  onToggle,
  onMature,
}: {
  overview: OinOverview;
  taxonomy: TaxonomyItem[];
  cases: OinCase[];
  busy: boolean;
  onToggle: (v: boolean) => void;
  onMature: () => void;
}) {
  const labels = useMemo(() => labelMap(taxonomy), [taxonomy]);
  const calibration = useMemo(() => computeCalibration(cases), [cases]);
  const stats = [
    { icon: Users, label: 'Businesses contributing', value: overview.contributors },
    { icon: Brain, label: 'Matured network outcomes', value: overview.network_cases },
    { icon: Network, label: 'Published insights', value: overview.published_cells },
    { icon: CheckCircle2, label: 'Your matured / open', value: `${overview.my_matured} / ${overview.my_open}` },
  ];

  return (
    <div className="space-y-6">
      <ConsentCard contributing={overview.contributing} busy={busy} onChange={onToggle} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} className="!p-4">
            <s.icon className="h-5 w-5 text-accent" aria-hidden="true" />
            <p className="mt-2 text-2xl font-bold text-text-primary">{s.value}</p>
            <p className="text-xs text-text-secondary">{s.label}</p>
          </Card>
        ))}
      </div>

      {calibration && (
        <Card className="!p-6">
          <h2 className="text-lg font-semibold text-text-primary">How accurate was the network for your jobs?</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Brier score {calibration.brier.toFixed(3)} over {calibration.sample} jobs (lower is better; 0.25 is a coin flip).
          </p>
          <div className="mt-3 space-y-2">
            {calibration.bins.map((b) => (
              <div key={b.label} className="flex items-center justify-between text-sm">
                <span className="text-text-secondary">Predicted {b.label} ({b.count} jobs)</span>
                <span className="font-semibold text-text-primary">expected {formatPct(b.predicted)} · actual {formatPct(b.actual)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">Your outcome chains</h2>
          <Button size="sm" variant="secondary" onClick={onMature}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Check maturity
          </Button>
        </div>
        {cases.length === 0 ? (
          <EmptyState
            icon={ClipboardCheck}
            title="No outcomes captured yet"
            description="Capture a completed job and watch it travel from problem to customer result."
          />
        ) : (
          <div className="space-y-3">
            {cases.slice(0, 10).map((c) => (
              <Card key={c.id} className="!p-4">
                <OutcomeChain steps={buildChain(c, labels)} />
                {c.status === 'open' && (
                  <p className="mt-2 text-xs text-text-secondary">The final outcome is sealed {MATURITY_DAYS} days after the job, once callbacks and disputes are visible.</p>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Page
// ============================================================

export function OutcomeIntelligenceNetworkPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('intelligence');
  const [loading, setLoading] = useState(true);
  const [trade, setTrade] = useState<OinTrade | 'other'>('other');
  const [taxonomy, setTaxonomy] = useState<TaxonomyItem[]>([]);
  const [overview, setOverview] = useState<OinOverview | null>(null);
  const [cases, setCases] = useState<OinCase[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [ov, cs] = await Promise.all([fetchOverview(), fetchMyCases(100)]);
    setOverview(ov);
    setCases(cs);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const t = await fetchTrade();
        if (!alive) return;
        setTrade(t);
        if (t !== 'other') setTaxonomy(await fetchTaxonomy(t));
        await refresh();
      } catch (e) {
        if (alive) toast(friendlyOinError(e, 'Could not load the Outcome Intelligence Network.'), 'error');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [refresh, toast]);

  const onToggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      await setContribution(enabled);
      await refresh();
      toast(enabled ? 'Data-sharing is on. Thank you for strengthening the network.' : 'Data-sharing is off.', 'success');
    } catch (e) {
      toast(friendlyOinError(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const onMature = async () => {
    try {
      const n = await matureMyCases();
      await refresh();
      toast(n > 0 ? `${n} outcome${n === 1 ? '' : 's'} reached the 30-day mark.` : 'Nothing has reached the 30-day mark yet.', 'success');
    } catch (e) {
      toast(friendlyOinError(e), 'error');
    }
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'intelligence', label: 'Network intelligence' },
    { id: 'capture', label: 'Capture outcomes' },
    { id: 'network', label: 'My network' },
  ];

  return (
    <DashboardLayout activeLabel="Outcome Intelligence Network">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">Outcome Intelligence Network</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Every job becomes a problem-to-outcome chain. Anonymized across the network, it shows what truly resolves a problem — and improves with every new business.
        </p>
      </div>

      {loading || !overview ? (
        <SkeletonCardList count={3} />
      ) : trade === 'other' ? (
        <EmptyState
          icon={Network}
          title="Your trade isn't supported yet"
          description="The network currently covers HVAC, Plumbing and Electrical. Set your primary industry in the business profile to join."
        />
      ) : (
        <>
          <div role="tablist" aria-label="Outcome Intelligence Network sections" className="mb-5 flex flex-wrap gap-2">
            {tabs.map((t) => (
              <Button key={t.id} role="tab" aria-selected={tab === t.id} size="sm" variant={tab === t.id ? 'primary' : 'secondary'} onClick={() => setTab(t.id)}>
                {t.label}
              </Button>
            ))}
          </div>
          {tab === 'intelligence' && (
            <IntelligenceTab trade={trade} taxonomy={taxonomy} contributing={overview.contributing} onGoNetwork={() => setTab('network')} />
          )}
          {tab === 'capture' && <CaptureTab trade={trade} taxonomy={taxonomy} onCaptured={() => void refresh()} />}
          {tab === 'network' && (
            <NetworkTab overview={overview} taxonomy={taxonomy} cases={cases} busy={busy} onToggle={onToggle} onMature={onMature} />
          )}
        </>
      )}
    </DashboardLayout>
  );
}
