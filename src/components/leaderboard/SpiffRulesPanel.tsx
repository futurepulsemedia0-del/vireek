import { useState } from 'react';
import { Gift, Pencil, Plus, Settings2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { Dialog, LoadError, SelectField, StatusPill, useLoader } from '@/components/commissions/shared';
import {
  createSpiffRule,
  deleteSpiffRule,
  fetchLeaderboardSettings,
  fetchSpiffRules,
  leaderboardErrorMessage,
  saveLeaderboardSettings,
  updateSpiffRule,
} from '@/lib/technicianLeaderboardApi';
import {
  DEFAULT_WEIGHTS,
  KPI_LABEL,
  MAX_RANK_PLACES,
  RANKABLE_KPIS,
  SPIFF_KPIS,
  describeRule,
  emptyRuleDraft,
  ordinal,
  sanitizeWeights,
  thresholdToInput,
  validateRuleDraft,
  type LeaderboardSettingsRow,
  type RankableKpi,
  type RuleDraft,
  type SpiffKpi,
  type SpiffRule,
} from '@/lib/technicianLeaderboard';

const DEFAULT_SETTINGS: Omit<LeaderboardSettingsRow, 'user_id'> = {
  enabled: true,
  enabled_kpis: ['first_time_fix_rate', 'upsell_rate', 'csat_avg', 'revenue_cents'],
  kpi_weights: DEFAULT_WEIGHTS,
  min_jobs_to_rank: 3,
  min_csat_responses: 3,
  payout_delay_days: 7,
  auto_approve_payouts: true,
  show_names_to_technicians: true,
};

function Toggle({ label, help, checked, onChange }: { label: string; help?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="focus-ring mt-1 h-4 w-4 rounded border-border accent-accent" />
      <span>
        <span className="block text-sm font-medium text-text-primary">{label}</span>
        {help && <span className="block text-xs text-text-secondary">{help}</span>}
      </span>
    </label>
  );
}

function SettingsCard({ ownerId }: { ownerId: string }) {
  const { toast } = useToast();
  const { data, loading, error, reload } = useLoader(() => fetchLeaderboardSettings(ownerId), [ownerId]);
  const [draft, setDraft] = useState<Omit<LeaderboardSettingsRow, 'user_id'> | null>(null);
  const [saving, setSaving] = useState(false);

  if (loading) return <SkeletonCardList count={1} rows={4} />;
  if (error) return <LoadError message={error} onRetry={reload} />;
  const s = draft ?? (data ? { ...data } : DEFAULT_SETTINGS);
  const set = (patch: Partial<typeof s>) => setDraft({ ...s, ...patch });

  const toggleKpi = (k: RankableKpi) => {
    const has = s.enabled_kpis.includes(k);
    set({ enabled_kpis: has ? s.enabled_kpis.filter((x) => x !== k) : [...s.enabled_kpis, k] });
  };

  const save = async () => {
    const weights = sanitizeWeights(s.enabled_kpis, s.kpi_weights);
    if (s.enabled_kpis.length === 0) return toast('Turn on at least one KPI.', 'error');
    if (!weights) return toast('Give at least one enabled KPI a weight above 0.', 'error');
    setSaving(true);
    try {
      await saveLeaderboardSettings(ownerId, { ...s, kpi_weights: weights });
      toast('Leaderboard settings saved.', 'success');
      setDraft(null);
      reload();
    } catch (e) {
      toast(leaderboardErrorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const num = (v: string, min: number, max: number, fallback: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  return (
    <Card className="space-y-5 !p-5 hover:!translate-y-0">
      <h2 className="flex items-center gap-2 text-base font-semibold text-text-primary"><Settings2 className="h-4 w-4 text-accent" aria-hidden="true" /> Leaderboard settings</h2>
      <Toggle label="Leaderboards on" help="Turn off to hide boards from technicians. Bonus rules stay saved." checked={s.enabled} onChange={(v) => set({ enabled: v })} />

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-text-primary">KPIs on the board and their weight in the overall score</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {RANKABLE_KPIS.map((k) => (
            <div key={k} className="flex items-center justify-between gap-3 rounded-xl border border-border p-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
                <input type="checkbox" checked={s.enabled_kpis.includes(k)} onChange={() => toggleKpi(k)} className="focus-ring h-4 w-4 rounded border-border" />
                {KPI_LABEL[k]}
              </label>
              <label className="flex items-center gap-1 text-xs text-text-secondary">
                <span className="sr-only">{KPI_LABEL[k]} weight</span>
                <input
                  type="number" min={0} max={100} inputMode="numeric"
                  value={s.kpi_weights[k] ?? 0}
                  disabled={!s.enabled_kpis.includes(k)}
                  onChange={(e) => set({ kpi_weights: { ...s.kpi_weights, [k]: num(e.target.value, 0, 100, 0) } })}
                  className="focus-ring w-16 rounded-lg border border-border bg-bg-primary px-2 py-1 text-right text-sm tabular-nums text-text-primary disabled:opacity-50"
                />
                pts
              </label>
            </div>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <Input label="Jobs needed to be ranked" type="number" inputMode="numeric" min={0} max={100} value={String(s.min_jobs_to_rank)} onChange={(e) => set({ min_jobs_to_rank: num(e.target.value, 0, 100, 3) })} />
        <Input label="Reviews needed to show a rating" type="number" inputMode="numeric" min={1} max={50} value={String(s.min_csat_responses)} onChange={(e) => set({ min_csat_responses: num(e.target.value, 1, 50, 3) })} />
        <Input label="Days before a period pays out" type="number" inputMode="numeric" min={0} max={60} value={String(s.payout_delay_days)} helperText="Gives callbacks and reviews time to arrive." onChange={(e) => set({ payout_delay_days: num(e.target.value, 0, 60, 7) })} />
      </div>

      <div className="space-y-3">
        <Toggle label="Auto-approve bonuses" help="Approved bonuses flow into the next pay run automatically. You still review the draft pay run before posting it. Turn off to approve each bonus yourself." checked={s.auto_approve_payouts} onChange={(v) => set({ auto_approve_payouts: v })} />
        <Toggle label="Show technician names and revenue to technicians" help="When off, technicians see only their own name and numbers." checked={s.show_names_to_technicians} onChange={(v) => set({ show_names_to_technicians: v })} />
      </div>

      <div className="flex justify-end gap-2">
        {draft && <Button variant="ghost" size="sm" onClick={() => setDraft(null)} disabled={saving}>Discard</Button>}
        <Button size="sm" onClick={save} disabled={saving || !draft}>{saving ? 'Saving…' : 'Save settings'}</Button>
      </div>
    </Card>
  );
}

function RuleDialog({ open, editing, onClose, onSave, saving }: {
  open: boolean; editing: SpiffRule | null; onClose: () => void; saving: boolean;
  onSave: (draft: RuleDraft) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState<RuleDraft>(() => toDraft(editing));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [lastKey, setLastKey] = useState<string | null | undefined>(undefined);
  const key = open ? (editing?.id ?? 'new') : null;
  if (key !== lastKey) {
    setLastKey(key);
    if (open) { setDraft(toDraft(editing)); setErrors({}); }
  }
  const set = (patch: Partial<RuleDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const unit = draft.kpi === 'revenue_cents' ? 'in dollars' : draft.kpi === 'csat_avg' ? 'in stars (1–5)' : draft.kpi === 'jobs_completed' ? 'in jobs' : draft.kpi === 'overall' ? 'score (0–100)' : 'in %';

  const submit = async () => {
    const msg = await onSave(draft);
    if (msg) setErrors({ form: msg });
  };

  return (
    <Dialog
      open={open}
      title={editing ? 'Edit bonus rule' : 'New bonus rule'}
      description="Changes apply to periods settled from now on. Bonuses already generated are never altered."
      onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button><Button onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Save rule'}</Button></>}
    >
      <Input label="Rule name" value={draft.name} maxLength={80} error={errors.name} placeholder="Weekly first-time-fix bonus" onChange={(e) => set({ name: e.target.value })} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="KPI" value={draft.kpi} onChange={(v) => set({ kpi: v as SpiffKpi })}>
          {SPIFF_KPIS.map((k) => <option key={k} value={k}>{KPI_LABEL[k]}</option>)}
        </SelectField>
        <SelectField label="Period" value={draft.period} onChange={(v) => set({ period: v as RuleDraft['period'] })}>
          <option value="weekly">Weekly</option><option value="monthly">Monthly</option>
        </SelectField>
      </div>
      <SelectField label="How it pays" value={draft.rule_type} onChange={(v) => set({ rule_type: v as RuleDraft['rule_type'] })}
        helperText={draft.rule_type === 'threshold' ? 'Everyone who reaches the target earns the bonus.' : 'The best performers earn a ladder of bonuses. Needs at least 2 ranked technicians; ties share the places they occupy.'}>
        <option value="threshold">Hit a target</option><option value="rank">Finish in the top places</option>
      </SelectField>

      {draft.rule_type === 'threshold' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label={`Target ${unit}`} inputMode="decimal" value={draft.threshold} error={errors.threshold} onChange={(e) => set({ threshold: e.target.value })} />
          <Input label="Bonus per technician ($)" inputMode="decimal" value={draft.payout} error={errors.payout} onChange={(e) => set({ payout: e.target.value })} />
        </div>
      ) : (
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-text-primary">Bonus per place ($)</legend>
          <div className="grid grid-cols-3 gap-2">
            {draft.rankPayouts.map((v, i) => (
              <Input key={i} label={ordinal(i + 1)} inputMode="decimal" value={v} onChange={(e) => set({ rankPayouts: draft.rankPayouts.map((x, j) => (j === i ? e.target.value : x)) })} />
            ))}
          </div>
          {draft.rankPayouts.length < MAX_RANK_PLACES && (
            <button type="button" className="focus-ring mt-2 rounded-lg text-xs font-semibold text-accent" onClick={() => set({ rankPayouts: [...draft.rankPayouts, ''] })}>+ Add a place</button>
          )}
          {errors.rankPayouts && <p role="alert" className="mt-1.5 text-xs text-danger">{errors.rankPayouts}</p>}
        </fieldset>
      )}

      <Input label="Minimum jobs to qualify" type="number" inputMode="numeric" value={draft.min_jobs} error={errors.min_jobs} helperText="Never lower than the board’s own minimum." onChange={(e) => set({ min_jobs: e.target.value })} />
      {errors.form && <p role="alert" className="text-sm text-danger">{errors.form}</p>}
    </Dialog>
  );
}

function toDraft(r: SpiffRule | null): RuleDraft {
  if (!r) return emptyRuleDraft();
  return {
    name: r.name, kpi: r.kpi, period: r.period, rule_type: r.rule_type,
    threshold: thresholdToInput(r.kpi, r.threshold),
    payout: r.payout_cents === null ? '' : String(r.payout_cents / 100),
    rankPayouts: r.rank_payouts_cents ? r.rank_payouts_cents.map((c) => String(c / 100)) : ['', '', ''],
    min_jobs: String(r.min_jobs),
  };
}

export function SpiffRulesPanel({ ownerId }: { ownerId: string }) {
  const { toast } = useToast();
  const rules = useLoader(() => fetchSpiffRules(ownerId), [ownerId]);
  const [dialog, setDialog] = useState<{ open: boolean; editing: SpiffRule | null }>({ open: false, editing: null });
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<SpiffRule | null>(null);

  const save = async (draft: RuleDraft): Promise<string | null> => {
    const v = validateRuleDraft(draft);
    if (!v.ok) return Object.values(v.errors)[0] ?? 'Check the highlighted fields.';
    setSaving(true);
    try {
      if (dialog.editing) await updateSpiffRule(ownerId, dialog.editing.id, v.payload);
      else await createSpiffRule(ownerId, v.payload);
      toast('Bonus rule saved.', 'success');
      setDialog({ open: false, editing: null });
      rules.reload();
      return null;
    } catch (e) {
      return leaderboardErrorMessage(e);
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (r: SpiffRule) => {
    try { await updateSpiffRule(ownerId, r.id, { active: !r.active }); rules.reload(); }
    catch (e) { toast(leaderboardErrorMessage(e), 'error'); }
  };

  const remove = async () => {
    if (!confirmDelete) return;
    try { await deleteSpiffRule(ownerId, confirmDelete.id); toast('Rule deleted.', 'success'); setConfirmDelete(null); rules.reload(); }
    catch (e) { toast(leaderboardErrorMessage(e), 'error'); setConfirmDelete(null); }
  };

  return (
    <div className="space-y-5">
      <SettingsCard ownerId={ownerId} />

      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-base font-semibold text-text-primary"><Gift className="h-4 w-4 text-accent" aria-hidden="true" /> Bonus rules</h2>
        <Button size="sm" onClick={() => setDialog({ open: true, editing: null })}><Plus className="h-4 w-4" aria-hidden="true" /> New rule</Button>
      </div>

      {rules.loading ? <SkeletonCardList count={2} rows={2} />
        : rules.error ? <LoadError message={rules.error} onRetry={rules.reload} />
        : (rules.data ?? []).length === 0 ? (
          <EmptyState icon={Gift} title="No bonus rules yet" description="Reward first-time fixes, upsells, great reviews or revenue. Earned bonuses land in payroll automatically."
            action={{ label: 'Create your first rule', onClick: () => setDialog({ open: true, editing: null }) }} />
        ) : (
          <ul className="space-y-2">
            {(rules.data ?? []).map((r) => (
              <li key={r.id}>
                <Card className="flex flex-col gap-3 !p-4 hover:!translate-y-0 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text-primary">{r.name}<StatusPill tone={r.active ? 'success' : 'neutral'}>{r.active ? 'Active' : 'Paused'}</StatusPill></p>
                    <p className="mt-0.5 text-sm text-text-secondary">{describeRule(r)}</p>
                    {r.min_jobs > 0 && <p className="text-xs text-text-secondary">Minimum {r.min_jobs} jobs</p>}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="sm" onClick={() => toggleActive(r)}>{r.active ? 'Pause' : 'Resume'}</Button>
                    <Button variant="ghost" size="sm" onClick={() => setDialog({ open: true, editing: r })} aria-label={`Edit ${r.name}`}><Pencil className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(r)} aria-label={`Delete ${r.name}`}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}

      <RuleDialog open={dialog.open} editing={dialog.editing} saving={saving} onClose={() => setDialog({ open: false, editing: null })} onSave={save} />
      <Dialog open={!!confirmDelete} danger title="Delete this rule?" description="Rules that already produced bonuses can’t be deleted — pause them instead." onClose={() => setConfirmDelete(null)}
        footer={<><Button variant="ghost" onClick={() => setConfirmDelete(null)}>Keep it</Button><Button onClick={remove}>Delete rule</Button></>}>
        <p className="text-sm text-text-primary">{confirmDelete?.name}</p>
      </Dialog>
    </div>
  );
}
