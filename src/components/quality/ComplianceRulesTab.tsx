import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { cleanPatterns, type AppliesWhen, type QualityRule, type RuleInput, type RuleType, type Severity } from '@/lib/callQuality';
import { SeverityBadge, btnGhost, btnPrimary, inputCls } from './qualityUi';

const WHEN: Record<AppliesWhen, string> = { always: 'Every call', emergency: 'Emergency calls', booking: 'When booking is discussed', pricing: 'When prices are discussed' };
const EMPTY: RuleInput = { label: '', rule_type: 'required', patterns: [], applies_when: 'always', severity: 'medium', script_instruction: '', enabled: true };

interface Props {
  rules: QualityRule[];
  onSave: (id: string | null, input: RuleInput) => Promise<void>;
  onToggle: (rule: QualityRule) => void;
  onDelete: (rule: QualityRule) => Promise<void>;
}

export function ComplianceRulesTab({ rules, onSave, onToggle, onDelete }: Props) {
  const [editing, setEditing] = useState<{ id: string | null; draft: RuleInput; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<QualityRule | null>(null);

  const start = (r: QualityRule | null) => {
    setError(null);
    setEditing(r ? { id: r.id, draft: { ...r, script_instruction: r.script_instruction ?? '' }, text: r.patterns.join('\n') } : { id: null, draft: EMPTY, text: '' });
  };

  const save = async () => {
    if (!editing) return;
    const patterns = cleanPatterns(editing.text.split('\n'));
    if (editing.draft.label.trim().length < 2) { setError('Give the rule a name.'); return; }
    if (patterns.length === 0) { setError('Add at least one phrase (3+ characters), one per line.'); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave(editing.id, { ...editing.draft, patterns });
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the rule.');
    } finally {
      setSaving(false);
    }
  };

  const set = <K extends keyof RuleInput>(k: K, v: RuleInput[K]) => setEditing((cur) => (cur ? { ...cur, draft: { ...cur.draft, [k]: v } } : cur));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-text-secondary">Phrases the assistant must say (or never say). Checks run on every reviewed call and only look at what the <strong>assistant</strong> said. Wording is matched as whole phrases, ignoring case and punctuation. These are your own rules, not legal advice.</p>
        <button onClick={() => start(null)} className={btnPrimary}><Plus size={16} />Add rule</button>
      </div>

      {rules.length === 0 && <div className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-12 text-center text-sm text-text-secondary">No rules yet. Add one, for example a required recording notice.</div>}

      <ul className="space-y-2">
        {rules.map((r) => (
          <li key={r.id} className={`rounded-xl border border-border bg-bg-secondary p-4 ${r.enabled ? '' : 'opacity-60'}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-text-primary">{r.label}</h3>
                  <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">{r.rule_type === 'required' ? 'Must say' : 'Must not say'}</span>
                  <SeverityBadge severity={r.severity} />
                </div>
                <p className="mt-1 text-xs text-text-secondary">{WHEN[r.applies_when]} · {r.patterns.slice(0, 3).map((p) => `“${p}”`).join(', ')}{r.patterns.length > 3 ? ` +${r.patterns.length - 3}` : ''}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <label className="flex cursor-pointer items-center gap-2 text-xs text-text-secondary">
                  <input type="checkbox" checked={r.enabled} onChange={() => onToggle(r)} className="h-4 w-4 accent-[rgb(var(--accent-primary))]" />On
                </label>
                <button aria-label={`Edit ${r.label}`} onClick={() => start(r)} className={`${btnGhost} px-2`}><Pencil size={14} /></button>
                <button aria-label={`Delete ${r.label}`} onClick={() => setRemoving(r)} className={`${btnGhost} px-2`}><Trash2 size={14} /></button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {editing && (
        <div role="dialog" aria-modal="true" aria-label={editing.id ? 'Edit rule' : 'Add rule'} className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center">
          <div className="max-h-[90vh] w-full max-w-lg space-y-3 overflow-y-auto rounded-2xl border border-border bg-bg-secondary p-5 shadow-card">
            <h3 className="text-lg font-semibold text-text-primary">{editing.id ? 'Edit rule' : 'Add rule'}</h3>
            <label className="block text-xs font-medium text-text-secondary">Name
              <input value={editing.draft.label} maxLength={80} onChange={(e) => set('label', e.target.value)} className={`${inputCls} mt-1`} />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs font-medium text-text-secondary">Type
                <select value={editing.draft.rule_type} onChange={(e) => set('rule_type', e.target.value as RuleType)} className={`${inputCls} mt-1`}>
                  <option value="required">Assistant must say one of these</option><option value="forbidden">Assistant must never say</option>
                </select>
              </label>
              <label className="block text-xs font-medium text-text-secondary">Severity
                <select value={editing.draft.severity} onChange={(e) => set('severity', e.target.value as Severity)} className={`${inputCls} mt-1`}>
                  <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option>
                </select>
              </label>
            </div>
            <label className="block text-xs font-medium text-text-secondary">Applies to
              <select value={editing.draft.applies_when} onChange={(e) => set('applies_when', e.target.value as AppliesWhen)} className={`${inputCls} mt-1`}>
                {(Object.keys(WHEN) as AppliesWhen[]).map((k) => <option key={k} value={k}>{WHEN[k]}</option>)}
              </select>
            </label>
            <label className="block text-xs font-medium text-text-secondary">Phrases (one per line, up to 12)
              <textarea value={editing.text} onChange={(e) => setEditing((c) => (c ? { ...c, text: e.target.value } : c))} rows={4} className={`${inputCls} mt-1`} placeholder={'may be recorded\nrecorded for quality'} />
            </label>
            <label className="block text-xs font-medium text-text-secondary">Script instruction used by the one-click fix (optional)
              <textarea value={editing.draft.script_instruction ?? ''} maxLength={400} onChange={(e) => set('script_instruction', e.target.value)} rows={2} className={`${inputCls} mt-1`} placeholder="Early in every call, say that the call may be recorded." />
            </label>
            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setEditing(null)} className={btnGhost}>Cancel</button>
              <button onClick={save} disabled={saving} className={btnPrimary}>{saving ? 'Saving…' : 'Save rule'}</button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!removing}
        title="Delete this rule?"
        description={`“${removing?.label ?? ''}” will no longer be checked on new reviews. Past scorecards keep their results.`}
        confirmLabel="Delete rule"
        onCancel={() => setRemoving(null)}
        onConfirm={async () => { if (removing) await onDelete(removing); setRemoving(null); }}
      />
    </div>
  );
}
