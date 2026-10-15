import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Pencil, Plus, Sparkles, Trash2, Workflow } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { Modal } from './Modal';
import {
  MAX_RULES,
  RULE_KIND_LABELS,
  RULE_LIMITS,
  deleteRule,
  fetchRules,
  normalizePrefix,
  saveRule,
  setRuleEnabled,
  validateRule,
  type BlockRule,
  type BlockRuleKind,
} from '@/lib/callBlocklist';

interface Draft {
  id?: string;
  name: string;
  kind: BlockRuleKind;
  enabled: boolean;
  config: BlockRule['config'];
}

const KINDS = Object.keys(RULE_KIND_LABELS) as BlockRuleKind[];

function newDraft(kind: BlockRuleKind): Draft {
  const base: Draft = { name: RULE_KIND_LABELS[kind].label, kind, enabled: true, config: {} };
  if (kind === 'repeat_short_calls') base.config = { minCalls: RULE_LIMITS.minCalls.default, maxSeconds: RULE_LIMITS.maxSeconds.default, windowHours: RULE_LIMITS.windowHours.default };
  if (kind === 'prefix') base.config = { prefix: '+1900' };
  return base;
}

function summary(r: BlockRule): string {
  switch (r.kind) {
    case 'prefix':
      return `Numbers starting with ${r.config.prefix ?? '?'}`;
    case 'anonymous':
      return 'Calls with hidden caller ID';
    case 'neighbor_spoof':
      return 'Callers imitating your area code and exchange';
    case 'repeat_short_calls':
      return `${r.config.minCalls ?? RULE_LIMITS.minCalls.default}+ calls under ${r.config.maxSeconds ?? RULE_LIMITS.maxSeconds.default}s within ${r.config.windowHours ?? RULE_LIMITS.windowHours.default}h`;
  }
}

interface AutoBlockRulesProps {
  ownerId: string;
  userId: string;
  onChanged: () => void;
}

export function AutoBlockRules({ ownerId, userId, onChanged }: AutoBlockRulesProps) {
  const { toast } = useToast();
  const [rules, setRules] = useState<BlockRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BlockRule | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      setRules(await fetchRules(ownerId));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [ownerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const afterChange = async () => {
    await load();
    onChanged();
  };

  const handleSave = async () => {
    if (!draft) return;
    const config = draft.kind === 'prefix' ? { prefix: normalizePrefix(draft.config.prefix ?? '') } : draft.config;
    const problems = validateRule({ name: draft.name, kind: draft.kind, config });
    setErrors(problems);
    if (problems.length > 0) return;
    setSaving(true);
    try {
      await saveRule(ownerId, userId, { ...draft, config });
      toast(draft.id ? 'Rule updated.' : 'Rule added.', 'success');
      setDraft(null);
      await afterChange();
    } catch {
      toast('Could not save the rule. Please try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (r: BlockRule) => {
    setRules((prev) => prev.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)));
    try {
      await setRuleEnabled(ownerId, r.id, !r.enabled);
      onChanged();
    } catch {
      toast('Could not change that rule.', 'error');
      void load();
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteRule(ownerId, deleteTarget.id);
      toast('Rule deleted.', 'success');
      setDeleteTarget(null);
      await afterChange();
    } catch {
      toast('Could not delete the rule.', 'error');
    }
  };

  const addRecommended = async () => {
    setSaving(true);
    try {
      for (const kind of ['neighbor_spoof', 'repeat_short_calls'] as BlockRuleKind[]) {
        const d = newDraft(kind);
        await saveRule(ownerId, userId, d);
      }
      toast('Recommended protections added.', 'success');
      await afterChange();
    } catch {
      toast('Could not add the recommended rules.', 'error');
      void load();
    } finally {
      setSaving(false);
    }
  };

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setConfig = (patch: Partial<BlockRule['config']>) => setDraft((d) => (d ? { ...d, config: { ...d.config, ...patch } } : d));
  const num = (v: string) => (v === '' ? NaN : Number(v));

  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <Card key={i} className="space-y-2 p-4 hover:translate-y-0">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-72" />
          </Card>
        ))}
      </div>
    );
  }
  if (error) {
    return <EmptyState icon={AlertTriangle} title="Couldn't load your rules" description="Check your connection and try again." action={{ label: 'Retry', onClick: () => void load() }} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-secondary">Rules run on every new call, after your blocklist. Turning a rule off keeps it for later.</p>
        <Button type="button" size="sm" disabled={rules.length >= MAX_RULES} onClick={() => { setErrors([]); setDraft(newDraft('prefix')); }}>
          <Plus size={14} /> Add rule
        </Button>
      </div>

      {rules.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title="No auto-block rules"
          description="Rules stop whole classes of unwanted calls without listing every number. Start with the recommended protections."
          action={{ label: saving ? 'Adding…' : 'Add recommended protections', onClick: () => void addRecommended() }}
          secondaryAction={{ label: 'Build my own', onClick: () => { setErrors([]); setDraft(newDraft('prefix')); } }}
        />
      ) : (
        <ul className="space-y-3">
          {rules.map((r) => (
            <li key={r.id}>
              <Card className={`flex items-start gap-3 p-4 hover:translate-y-0 ${r.enabled ? '' : 'opacity-60'}`}>
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent"><Sparkles size={16} /></span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-text-primary">{r.name}</p>
                  <p className="text-xs text-text-secondary">{RULE_KIND_LABELS[r.kind].label} · {summary(r)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={r.enabled}
                    aria-label={`${r.enabled ? 'Turn off' : 'Turn on'} ${r.name}`}
                    onClick={() => void handleToggle(r)}
                    className={`focus-ring relative h-5 w-9 rounded-full transition-colors ${r.enabled ? 'bg-success-500' : 'bg-bg-tertiary'}`}
                  >
                    <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${r.enabled ? 'left-[18px]' : 'left-0.5'}`} />
                  </button>
                  <button type="button" className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary" aria-label={`Edit ${r.name}`} onClick={() => { setErrors([]); setDraft({ id: r.id, name: r.name, kind: r.kind, enabled: r.enabled, config: r.config }); }}>
                    <Pencil size={14} />
                  </button>
                  <button type="button" className="focus-ring rounded-lg p-2 text-danger hover:bg-bg-tertiary" aria-label={`Delete ${r.name}`} onClick={() => setDeleteTarget(r)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Modal open={draft !== null} title={draft?.id ? 'Edit rule' : 'New rule'} onClose={() => !saving && setDraft(null)}>
        {draft && (
          <div className="space-y-4">
            {!draft.id && (
              <div role="group" aria-label="Rule type" className="grid gap-2 sm:grid-cols-2">
                {KINDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={draft.kind === k}
                    onClick={() => setDraft(newDraft(k))}
                    className={`focus-ring rounded-xl border p-3 text-left transition-colors ${draft.kind === k ? 'border-accent bg-accent/5' : 'border-border hover:border-text-secondary'}`}
                  >
                    <span className="block text-sm font-semibold text-text-primary">{RULE_KIND_LABELS[k].label}</span>
                    <span className="mt-0.5 block text-xs text-text-secondary">{RULE_KIND_LABELS[k].description}</span>
                  </button>
                ))}
              </div>
            )}
            <Input label="Rule name" maxLength={80} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
            {draft.kind === 'prefix' && (
              <Input label="Prefix" value={draft.config.prefix ?? ''} onChange={(e) => setConfig({ prefix: e.target.value })} onBlur={() => setConfig({ prefix: normalizePrefix(draft.config.prefix ?? '') })} placeholder="+1900" helperText="Country or area code digits, e.g. +1900 or +44." />
            )}
            {draft.kind === 'repeat_short_calls' && (
              <div className="grid gap-3 sm:grid-cols-3">
                <Input label="Calls" type="number" inputMode="numeric" value={draft.config.minCalls ?? ''} onChange={(e) => setConfig({ minCalls: num(e.target.value) })} helperText={`${RULE_LIMITS.minCalls.min}–${RULE_LIMITS.minCalls.max}`} />
                <Input label="Shorter than (sec)" type="number" inputMode="numeric" value={draft.config.maxSeconds ?? ''} onChange={(e) => setConfig({ maxSeconds: num(e.target.value) })} helperText={`${RULE_LIMITS.maxSeconds.min}–${RULE_LIMITS.maxSeconds.max}`} />
                <Input label="Within (hours)" type="number" inputMode="numeric" value={draft.config.windowHours ?? ''} onChange={(e) => setConfig({ windowHours: num(e.target.value) })} helperText={`${RULE_LIMITS.windowHours.min}–${RULE_LIMITS.windowHours.max}`} />
              </div>
            )}
            {draft.kind === 'anonymous' && <p className="rounded-xl bg-warning-500/10 p-3 text-xs text-text-primary">Some real customers call with caller ID hidden. Use this rule only if you are sure you do not need those calls.</p>}
            {errors.length > 0 && (
              <ul className="space-y-0.5" role="alert">
                {errors.map((m) => (
                  <li key={m} className="text-xs text-danger">{m}</li>
                ))}
              </ul>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setDraft(null)} disabled={saving}>Cancel</Button>
              <Button type="button" onClick={() => void handleSave()} disabled={saving}>
                {saving && <Loader2 size={14} className="animate-spin" />} Save rule
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog open={deleteTarget !== null} title="Delete this rule?" description={`"${deleteTarget?.name ?? ''}" will stop blocking calls immediately.`} confirmLabel="Delete rule" onConfirm={handleDelete} onCancel={() => setDeleteTarget(null)} />
    </div>
  );
}
