/**
 * Regret Minimization Console — /dashboard/regret-console
 *
 * "Which decision hurts least if my prediction is wrong?" — build a
 * small grid of options x scenarios, estimate the dollar impact of
 * each, and see the minimax-regret pick alongside the worst-case
 * floor for each option. See src/lib/regretConsole.ts for the math.
 */

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, Check, ChevronDown, Loader2, Plus, Scale, Trash2, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  blankOption,
  blankScenario,
  buildFromTemplate,
  computeRegret,
  DECISION_TEMPLATES,
  DECISION_TYPE_LABELS,
  deleteDecision,
  fetchDecisions,
  formatDollars,
  PayoffMatrix,
  RegretDecision,
  RegretOption,
  RegretScenario,
  recordChoice,
  recordOutcome,
  Reversibility,
  REVERSIBILITY_COLORS,
  REVERSIBILITY_LABELS,
  saveDecision,
  DecisionType,
} from '@/lib/regretConsole';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60';

// ============================================================
// BUILDER
// ============================================================

function DecisionBuilder({ userId, onSaved }: { userId: string; onSaved: () => void }) {
  const { toast } = useToast();
  const [decisionType, setDecisionType] = useState<DecisionType>('pricing');
  const [title, setTitle] = useState(DECISION_TEMPLATES.pricing.title);
  const [options, setOptions] = useState<RegretOption[]>(() => buildFromTemplate('pricing').options);
  const [scenarios, setScenarios] = useState<RegretScenario[]>(() => buildFromTemplate('pricing').scenarios);
  const [matrix, setMatrix] = useState<PayoffMatrix>({});
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const applyTemplate = (type: DecisionType) => {
    setDecisionType(type);
    if (type === 'custom') {
      setTitle('');
      setOptions([blankOption(), blankOption()]);
      setScenarios([blankScenario(), blankScenario()]);
    } else {
      const t = buildFromTemplate(type);
      setTitle(t.title);
      setOptions(t.options);
      setScenarios(t.scenarios);
    }
    setMatrix({});
  };

  const setPayoff = (optionId: string, scenarioId: string, value: string) => {
    const n = value.trim() === '' ? NaN : Number(value);
    setMatrix((prev) => ({
      ...prev,
      [optionId]: { ...prev[optionId], [scenarioId]: Number.isNaN(n) ? (undefined as unknown as number) : n },
    }));
  };

  const filledOptions = options.filter((o) => o.name.trim());
  const filledScenarios = scenarios.filter((s) => s.name.trim());
  const preview = filledOptions.length >= 2 && filledScenarios.length >= 2
    ? computeRegret(filledOptions, filledScenarios, matrix)
    : null;

  const handleSave = async () => {
    if (!title.trim()) return toast('Give this decision a title', 'error');
    if (filledOptions.length < 2) return toast('Add at least two options', 'error');
    if (filledScenarios.length < 2) return toast('Add at least two scenarios', 'error');
    const missing = filledOptions.some((o) => filledScenarios.some((s) => typeof matrix[o.id]?.[s.id] !== 'number'));
    if (missing) return toast('Estimate a dollar impact for every option x scenario cell', 'error');

    setSaving(true);
    try {
      await saveDecision(
        { decision_type: decisionType, title, options: filledOptions, scenarios: filledScenarios, payoff_matrix: matrix, notes },
        userId
      );
      toast('Decision saved', 'success');
      applyTemplate('pricing');
      setNotes('');
      onSaved();
    } catch {
      toast('Could not save this decision', 'error');
    }
    setSaving(false);
  };

  return (
    <div className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(DECISION_TYPE_LABELS) as DecisionType[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => applyTemplate(t)}
            className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium ${decisionType === t ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
          >
            {DECISION_TYPE_LABELS[t]}
          </button>
        ))}
      </div>

      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What are you deciding?" className={inputClass} />

      {/* Options */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-xs font-medium text-text-secondary">Options you're weighing</label>
          <button type="button" onClick={() => setOptions((p) => [...p, blankOption()])} className="focus-ring flex items-center gap-1 text-xs text-accent">
            <Plus size={12} /> Add option
          </button>
        </div>
        <div className="space-y-1.5">
          {options.map((o, i) => (
            <div key={o.id} className="flex items-center gap-1.5">
              <input
                value={o.name}
                onChange={(e) => setOptions((p) => p.map((x) => (x.id === o.id ? { ...x, name: e.target.value } : x)))}
                placeholder={`Option ${i + 1}`}
                className={inputClass}
              />
              <select
                value={o.reversibility}
                onChange={(e) => setOptions((p) => p.map((x) => (x.id === o.id ? { ...x, reversibility: e.target.value as Reversibility } : x)))}
                className="focus-ring rounded-xl border border-border bg-bg-primary px-2 py-2 text-xs text-text-secondary"
              >
                <option value="easy">Easy to undo</option>
                <option value="moderate">Some cost to undo</option>
                <option value="hard">Hard to undo</option>
              </select>
              {options.length > 2 && (
                <button type="button" onClick={() => setOptions((p) => p.filter((x) => x.id !== o.id))} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:text-danger">
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Scenarios */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-xs font-medium text-text-secondary">Scenarios you're uncertain about</label>
          <button type="button" onClick={() => setScenarios((p) => [...p, blankScenario()])} className="focus-ring flex items-center gap-1 text-xs text-accent">
            <Plus size={12} /> Add scenario
          </button>
        </div>
        <div className="space-y-1.5">
          {scenarios.map((s, i) => (
            <div key={s.id} className="flex items-center gap-1.5">
              <input
                value={s.name}
                onChange={(e) => setScenarios((p) => p.map((x) => (x.id === s.id ? { ...x, name: e.target.value } : x)))}
                placeholder={`Scenario ${i + 1}`}
                className={inputClass}
              />
              {scenarios.length > 2 && (
                <button type="button" onClick={() => setScenarios((p) => p.filter((x) => x.id !== s.id))} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:text-danger">
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-text-secondary/70">Leave odds out — this tool doesn't need them. Fill them in only if you actually want to see an expected-value comparison too.</p>
      </div>

      {/* Matrix */}
      {filledOptions.length >= 2 && filledScenarios.length >= 2 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse text-xs">
            <thead>
              <tr>
                <th className="p-1.5 text-left text-text-secondary">Estimated $ impact</th>
                {filledScenarios.map((s) => (
                  <th key={s.id} className="p-1.5 text-left font-medium text-text-secondary">{s.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filledOptions.map((o) => (
                <tr key={o.id} className="border-t border-border">
                  <td className="p-1.5 font-medium text-text-primary">{o.name}</td>
                  {filledScenarios.map((s) => (
                    <td key={s.id} className="p-1.5">
                      <input
                        type="number"
                        value={matrix[o.id]?.[s.id] ?? ''}
                        onChange={(e) => setPayoff(o.id, s.id, e.target.value)}
                        placeholder="$"
                        className="focus-ring w-24 rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-text-primary"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {preview && (
        <div className="rounded-xl border border-accent/30 bg-accent/5 p-3">
          <p className="mb-2 text-xs font-medium text-text-primary">Live preview</p>
          <div className="space-y-1.5">
            {filledOptions.map((o) => {
              const isRec = preview.recommendedOptionId === o.id;
              return (
                <div key={o.id} className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs ${isRec ? 'bg-success-500/10' : ''}`}>
                  <span className="flex items-center gap-1.5 font-medium text-text-primary">
                    {isRec && <Check size={12} className="text-success-500" />} {o.name}
                  </span>
                  <span className="text-text-secondary">
                    worst regret {formatDollars(preview.maxRegretByOption[o.id] ?? 0)} · floor {formatDollars(preview.worstCaseByOption[o.id] ?? 0)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional context for later-you" rows={2} className={inputClass} />

      <button type="button" onClick={() => void handleSave()} disabled={saving} className="focus-ring flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent px-3 py-2.5 text-sm font-medium text-white disabled:opacity-50">
        {saving ? <Loader2 size={14} className="animate-spin" /> : <Scale size={14} />} Save this decision
      </button>
    </div>
  );
}

// ============================================================
// DECISION CARD
// ============================================================

function DecisionCard({ decision, onChanged }: { decision: RegretDecision; onChanged: () => void }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [resolvingScenario, setResolvingScenario] = useState('');
  const [outcomeNotes, setOutcomeNotes] = useState('');

  const recommended = decision.options.find((o) => o.id === decision.recommended_option_id);
  const chosen = decision.options.find((o) => o.id === decision.chosen_option_id);
  const actual = decision.scenarios.find((s) => s.id === decision.actual_scenario_id);

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <button type="button" onClick={() => setExpanded((v) => !v)} className="flex w-full items-center justify-between text-left">
        <div>
          <p className="text-sm font-semibold text-text-primary">{decision.title}</p>
          <p className="mt-0.5 text-xs text-text-secondary">
            {DECISION_TYPE_LABELS[decision.decision_type]} · recommended: <span className="font-medium text-text-primary">{recommended?.name ?? '—'}</span>
            {chosen && chosen.id !== recommended?.id && <span className="text-warning-500"> · went with {chosen.name} instead</span>}
            {actual && <span> · what happened: {actual.name}</span>}
          </p>
        </div>
        <ChevronDown size={16} className={`text-text-secondary transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          <div className="space-y-1.5">
            {decision.options.map((o) => {
              const isRec = o.id === decision.recommended_option_id;
              const isChosen = o.id === decision.chosen_option_id;
              return (
                <div key={o.id} className={`flex flex-wrap items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-xs ${isRec ? 'bg-success-500/10' : 'bg-bg-tertiary'}`}>
                  <span className="flex items-center gap-1.5 font-medium text-text-primary">
                    {isRec && <Check size={12} className="text-success-500" />} {o.name}
                    {isChosen && <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">chosen</span>}
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${REVERSIBILITY_COLORS[o.reversibility]}`}>{REVERSIBILITY_LABELS[o.reversibility]}</span>
                  </span>
                  <span className="text-text-secondary">
                    worst regret {formatDollars(decision.max_regret_by_option?.[o.id] ?? 0)} · floor {formatDollars(decision.worst_case_by_option?.[o.id] ?? 0)}
                    {decision.expected_value_by_option && ` · expected ${formatDollars(decision.expected_value_by_option[o.id] ?? 0)}`}
                  </span>
                  {!decision.chosen_option_id && (
                    <button
                      type="button"
                      onClick={() => void recordChoice(decision.id, o.id).then(onChanged).then(() => toast('Choice recorded', 'success'))}
                      className="focus-ring rounded-lg border border-border px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary"
                    >
                      Mark as chosen
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {decision.notes && <p className="text-xs text-text-secondary">{decision.notes}</p>}

          {decision.chosen_option_id && !decision.actual_scenario_id && (
            <div className="rounded-xl border border-border bg-bg-primary p-3">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-text-primary">
                <AlertTriangle size={13} className="text-warning-500" /> What actually happened?
              </p>
              <select value={resolvingScenario} onChange={(e) => setResolvingScenario(e.target.value)} className={`${inputClass} mb-2`}>
                <option value="">Choose the closest scenario</option>
                {decision.scenarios.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <textarea value={outcomeNotes} onChange={(e) => setOutcomeNotes(e.target.value)} placeholder="Any notes for next time" rows={2} className={`${inputClass} mb-2`} />
              <button
                type="button"
                disabled={!resolvingScenario}
                onClick={() => void recordOutcome(decision.id, resolvingScenario, outcomeNotes).then(onChanged).then(() => toast('Outcome logged', 'success'))}
                className="focus-ring rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
              >
                Log outcome
              </button>
            </div>
          )}

          {decision.outcome_notes && <p className="rounded-lg bg-bg-primary p-2.5 text-xs text-text-secondary">{decision.outcome_notes}</p>}

          <button type="button" onClick={() => setPendingDelete(true)} className="focus-ring flex items-center gap-1 text-xs text-text-secondary hover:text-danger">
            <Trash2 size={12} /> Delete
          </button>
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete}
        title="Delete this decision?"
        description={`"${decision.title}" will be removed from your decision journal.`}
        confirmLabel="Yes, delete it"
        onConfirm={() => void deleteDecision(decision.id).then(() => { setPendingDelete(false); onChanged(); })}
        onCancel={() => setPendingDelete(false)}
      />
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function RegretConsolePage() {
  const { user } = useAuth();
  const [decisions, setDecisions] = useState<RegretDecision[]>([]);
  const [loading, setLoading] = useState(true);
  const [showBuilder, setShowBuilder] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDecisions(await fetchDecisions());
    } catch {
      /* toast not critical here — empty state covers it */
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <DashboardLayout activeLabel="Regret Console">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <Scale size={18} /> Regret Minimization Console
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Not "what's the best guess" — "which choice hurts least if the guess is wrong." Build a quick grid, see the option with the smallest worst-case regret.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowBuilder((v) => !v)}
            className="focus-ring flex shrink-0 items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-medium text-white"
          >
            {showBuilder ? <X size={13} /> : <Plus size={13} />} {showBuilder ? 'Close' : 'New decision'}
          </button>
        </div>

        {showBuilder && user && (
          <div className="mb-5">
            <DecisionBuilder userId={user.id} onSaved={() => { setShowBuilder(false); void load(); }} />
          </div>
        )}

        {loading ? (
          <div className="space-y-2">
            {[0, 1].map((i) => <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />)}
          </div>
        ) : decisions.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-10 text-center">
            <Scale className="mx-auto mb-2 h-6 w-6 text-text-secondary/50" />
            <p className="mx-auto max-w-sm text-sm text-text-secondary">
              No decisions logged yet. Next time you're stuck between raising prices, discounting a deal, approving overtime, or taking a risky job — run it through here first.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {decisions.map((d) => (
              <motion.div key={d.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
                <DecisionCard decision={d} onChanged={() => void load()} />
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
