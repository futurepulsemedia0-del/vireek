import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, FlaskConical, Loader2, Shuffle } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  applyWeightSuggestion,
  DEFAULT_SETTINGS,
  fetchCausalReport,
  fetchExplorationSettings,
  fetchRecentExplorationPicks,
  saveExplorationSettings,
  setProvenance,
  SETTING_LIMITS,
  type CausalReport,
  type ExplorationPick,
  type ExplorationSettings,
} from '@/lib/causalDispatchApi';
import { OUTCOME_META, type WeightSuggestion } from '@/lib/causalDispatch';

interface Props {
  ownerId: string;
  /** Only owners/managers can change settings or apply suggestions (the database enforces it too). */
  canManage: boolean;
}

const pct = (v: number | null, digits = 1) => (v === null ? '—' : `${(v * 100).toFixed(digits)} pp`);

/** Exploration picks with the reason, so a dispatcher can see why someone other than the top-ranked technician got a job. */
export function ExplorationPicks({ picks }: { picks: ExplorationPick[] }) {
  if (picks.length === 0) return <p className="text-xs text-text-secondary">No exploration picks in the last 14 days.</p>;
  return (
    <ul className="space-y-1.5">
      {picks.map((p) => (
        <li key={p.decisionId} className="rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs">
          <p className="flex flex-wrap items-center gap-x-2 text-text-primary">
            <span className="inline-flex items-center gap-1 rounded-full border border-accent/40 px-1.5 py-px text-[10px] font-medium text-accent">
              <Shuffle size={10} aria-hidden="true" /> Exploration pick
            </span>
            <span className="font-medium">{p.jobLabel}</span>
            <span className="text-text-secondary">→ {p.chosenName}</span>
            {p.overridden && <span className="text-warning">(overridden by a dispatcher)</span>}
          </p>
          <p className="mt-0.5 text-text-secondary">
            Why: {p.chosenName} was drawn at random from {p.setSize} technicians the rules score within {p.delta ?? 'a few'} points of each other
            {p.topName && p.topName !== p.chosenName ? ` (top-ranked was ${p.topName})` : ''}
            {p.propensity !== null ? `; chance of this pick ${Math.round(p.propensity * 100)}%` : ''}. Randomizing here is how Vireek learns who is really best.
          </p>
        </li>
      ))}
    </ul>
  );
}

function NumberField({ id, label, value, onChange, limits, suffix, disabled }: {
  id: string; label: string; value: number; onChange: (v: number) => void;
  limits: { min: number; max: number; step: number }; suffix: string; disabled: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-[11px] text-text-secondary">{label}</label>
      <div className="mt-0.5 flex items-center gap-1.5">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          disabled={disabled}
          min={limits.min}
          max={limits.max}
          step={limits.step}
          value={Number.isFinite(value) ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
          className="focus-ring w-20 rounded-lg border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary disabled:opacity-60"
        />
        <span className="text-[11px] text-text-secondary">{suffix}</span>
      </div>
    </div>
  );
}

export function CausalDispatchCard({ ownerId, canManage }: Props) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<ExplorationSettings | null>(null);
  const [draft, setDraft] = useState<ExplorationSettings>(DEFAULT_SETTINGS);
  const [picks, setPicks] = useState<ExplorationPick[]>([]);
  const [report, setReport] = useState<CausalReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [analysing, setAnalysing] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [applying, setApplying] = useState<WeightSuggestion | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, p] = await Promise.all([fetchExplorationSettings(ownerId), fetchRecentExplorationPicks(ownerId).catch(() => [])]);
      setSettings(s);
      setDraft(s);
      setPicks(p);
      setUnavailable(false);
    } catch {
      setUnavailable(true); // migration not applied yet — the card simply stays quiet
    } finally {
      setLoading(false);
    }
  }, [ownerId]);

  useEffect(() => {
    if (open && !settings && !unavailable) void load();
  }, [open, settings, unavailable, load]);

  const dirty = settings !== null && JSON.stringify(settings) !== JSON.stringify(draft);
  const status = !settings ? null : settings.killSwitch ? 'Kill switch on' : settings.autoDisabledAt ? 'Switched off automatically' : settings.enabled ? 'On' : 'Off';

  const save = async () => {
    setSaving(true);
    try {
      await saveExplorationSettings(ownerId, draft);
      toast('Exploration settings saved.', 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save settings', 'error');
    } finally {
      setSaving(false);
    }
  };

  const analyse = async () => {
    setAnalysing(true);
    try {
      const r = await fetchCausalReport(ownerId);
      setReport(r);
      setProvenance(r.analysis.factors); // badges on factor explanations everywhere on the board
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not run the analysis', 'error');
    } finally {
      setAnalysing(false);
    }
  };

  const confirmApply = async () => {
    if (!applying) return;
    try {
      await applyWeightSuggestion(ownerId, applying);
      toast(`Updated the ${applying.ruleType.replace(/_/g, ' ')} weight to ${applying.suggestedWeight}.`, 'success');
      setApplying(null);
      setReport((r) => (r ? { ...r, suggestions: r.suggestions.filter((s) => s.ruleType !== applying.ruleType) } : r));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update the rule', 'error');
      setApplying(null);
    }
  };

  const ftfEffects = report?.analysis.effects.ftf.filter((e) => e.n >= 1) ?? [];
  const strong = ftfEffects.filter((e) => e.grade !== 'C').sort((a, b) => Math.abs(b.est) - Math.abs(a.est)).slice(0, 8);
  const diag = report?.analysis.diagnostics;

  return (
    <section className="mt-4 rounded-xl border border-border/70 bg-bg-primary" aria-label="Causal dispatch loop">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="focus-ring flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-text-secondary"
      >
        <FlaskConical size={13} className="text-accent" aria-hidden="true" />
        <span className="flex-1">
          Learn who is really best (randomized dispatch)
          {status && <span className="ml-2 rounded-full border border-border px-1.5 py-px text-[10px]">{status}</span>}
        </span>
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {open && (
        <div className="space-y-4 px-3 pb-3">
          {loading && <p className="flex items-center gap-1.5 text-xs text-text-secondary"><Loader2 size={12} className="animate-spin" /> Loading…</p>}
          {unavailable && <p className="text-xs text-text-secondary">This feature is not set up for your account yet.</p>}

          {settings && (
            <>
              <p className="text-xs text-text-secondary">
                Today, the best technicians get the hardest jobs, so their results can’t tell us who is really better. When several eligible
                technicians are practically tied, Vireek can pick one of them at random for a small share of jobs. Emergencies, VIP and SLA jobs,
                jobs the First-Time-Fix Autopilot flags, and anyone who breaks a required rule are never randomized. Dispatchers can always override.
              </p>

              {settings.autoDisabledAt && (
                <p role="alert" className="flex items-start gap-1.5 rounded-lg border border-danger/30 bg-danger/5 p-2 text-xs text-text-primary">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
                  <span>{settings.autoDisabledReason ?? 'Exploration was switched off automatically by a safety check.'} Turn it on again below once you have looked into it.</span>
                </p>
              )}

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <label className="col-span-2 flex items-center gap-2 text-xs text-text-primary sm:col-span-3">
                  <input type="checkbox" disabled={!canManage} checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
                  Allow randomization among near-equal technicians
                </label>
                <NumberField id="cdl-budget" label="Max share of jobs" suffix="%" value={draft.budgetPct} limits={SETTING_LIMITS.budgetPct} disabled={!canManage} onChange={(v) => setDraft({ ...draft, budgetPct: v })} />
                <NumberField id="cdl-delta" label="“Practically tied” means within" suffix="points" value={draft.delta} limits={SETTING_LIMITS.delta} disabled={!canManage} onChange={(v) => setDraft({ ...draft, delta: v })} />
                <NumberField id="cdl-regret" label="Max first-time-fix loss per job" suffix="pp" value={draft.maxRegretPct} limits={SETTING_LIMITS.maxRegretPct} disabled={!canManage} onChange={(v) => setDraft({ ...draft, maxRegretPct: v })} />
                <NumberField id="cdl-cap" label="Max exploration jobs per technician per week" suffix="jobs" value={draft.perTechWeeklyCap} limits={SETTING_LIMITS.perTechWeeklyCap} disabled={!canManage} onChange={(v) => setDraft({ ...draft, perTechWeeklyCap: v })} />
                <NumberField id="cdl-tol" label="Switch off automatically if first-time fix drops by" suffix="pp" value={draft.guardrailTolerancePct} limits={SETTING_LIMITS.guardrailTolerancePct} disabled={!canManage} onChange={(v) => setDraft({ ...draft, guardrailTolerancePct: v })} />
                <label className="col-span-2 flex items-center gap-2 text-xs text-text-primary sm:col-span-3">
                  <input type="checkbox" disabled={!canManage} checked={draft.killSwitch} onChange={(e) => setDraft({ ...draft, killSwitch: e.target.checked })} />
                  Kill switch — stop all randomization immediately
                </label>
              </div>
              {canManage ? (
                <div className="flex justify-end">
                  <button type="button" disabled={!dirty || saving} onClick={() => void save()} className="focus-ring rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent disabled:opacity-50">
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              ) : (
                <p className="text-[11px] text-text-secondary">Only owners and managers can change these settings.</p>
              )}

              <div>
                <h3 className="mb-1.5 text-xs font-semibold text-text-primary">Recent exploration picks</h3>
                <ExplorationPicks picks={picks} />
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold text-text-primary">What the randomized jobs show</h3>
                  <button type="button" disabled={analysing} onClick={() => void analyse()} className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-50">
                    {analysing && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
                    {report ? 'Re-run analysis' : 'Run analysis'}
                  </button>
                </div>

                {!report && <p className="text-xs text-text-secondary">Only jobs whose follow-up window has fully passed are counted, so results arrive about a month after the first randomized jobs.</p>}

                {report && diag && (
                  <div className="space-y-3">
                    <p className="text-[11px] text-text-secondary">
                      {diag.used} usable decisions of {diag.considered} (skipped: {diag.droppedReassigned} reassigned or duplicated, {diag.droppedNotRandomized} not randomized, {diag.droppedMalformed} incomplete).
                    </p>

                    <div>
                      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">Do your scoring factors really help?</h4>
                      {Object.keys(report.analysis.factors).length === 0 ? (
                        <p className="mt-1 text-xs text-text-secondary">Not enough randomized decisions yet.</p>
                      ) : (
                        <ul className="mt-1 space-y-1">
                          {Object.values(report.analysis.factors).map((f) => (
                            <li key={f.factor} className="text-xs text-text-secondary">
                              <span className="font-medium text-text-primary">{f.factor.replace(/_/g, ' ')}:</span>{' '}
                              {f.provenance === 'validated_by_randomization' ? 'validated' : f.provenance === 'contradicted' ? 'contradicted' : 'observational only'} (evidence {f.grade}) — {f.note}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    {report.suggestions.length > 0 && (
                      <div>
                        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">Suggested weight changes (nothing is applied automatically)</h4>
                        <ul className="mt-1 space-y-2">
                          {report.suggestions.map((s) => (
                            <li key={s.ruleType} className="rounded-lg border border-warning/30 bg-warning/10 p-2 text-xs">
                              <p className="text-text-primary">
                                <span className="font-medium">{s.ruleType.replace(/_/g, ' ')}:</span> weight {s.currentWeight} → {s.suggestedWeight}
                              </p>
                              <p className="mt-0.5 text-text-secondary">{s.reason}</p>
                              {canManage && (
                                <button type="button" onClick={() => setApplying(s)} className="focus-ring mt-1.5 rounded-lg border border-border px-2 py-1 text-[11px] text-text-primary hover:border-accent/50">
                                  Review and apply…
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {strong.length > 0 && (
                      <div>
                        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">Technician × job type ({OUTCOME_META.ftf.label}, vs. their near-equal peers)</h4>
                        <ul className="mt-1 space-y-1">
                          {strong.map((e) => (
                            <li key={`${e.technicianId}-${e.jobType}`} className="flex flex-wrap justify-between gap-2 text-xs text-text-secondary">
                              <span>{e.technicianId.slice(0, 8)} · {e.jobType}</span>
                              <span className="tabular-nums">{e.est >= 0 ? '+' : ''}{pct(e.est)} (95% CI {pct(e.ciLow)} to {pct(e.ciHigh)}) · n={e.n} · evidence {e.grade}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      <ConfirmDialog
        open={!!applying}
        title={applying ? `Change the ${applying.ruleType.replace(/_/g, ' ')} weight to ${applying.suggestedWeight}?` : ''}
        description={applying ? `${applying.reason} This updates your dispatch rule right away; you can change it back any time on the Assignment Rules page.` : ''}
        confirmLabel="Apply change"
        onConfirm={confirmApply}
        onCancel={() => setApplying(null)}
      />
    </section>
  );
}
