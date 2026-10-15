import { useState, type ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  MAX_RING_SECONDS,
  MIN_RING_SECONDS,
  RULE_KIND_META,
  TARGET_KIND_LABELS,
  defaultTarget,
  type CallRoutingConfig,
  type HoursState,
  type RoutingContext,
  type RoutingIssue,
  type RoutingRule,
  type RoutingTarget,
  type TargetKind,
} from '@/lib/callRouting';

const SELECT_CLASS =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary transition-colors focus-visible:border-accent disabled:opacity-50';
const TARGET_KINDS: TargetKind[] = ['ai', 'member', 'department', 'phone', 'voicemail'];

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-text-secondary">
        {label}
      </label>
      {children}
    </div>
  );
}

interface TargetPickerProps {
  idPrefix: string;
  label: string;
  target: RoutingTarget;
  config: CallRoutingConfig;
  ctx: RoutingContext;
  onChange: (t: RoutingTarget) => void;
}

function TargetPicker({ idPrefix, label, target, config, ctx, onChange }: TargetPickerProps) {
  const rings = target.kind === 'member' || target.kind === 'department' || target.kind === 'phone';
  const setKind = (kind: TargetKind) => onChange({ kind, ringSeconds: target.ringSeconds });
  return (
    <fieldset className="space-y-3 rounded-xl border border-border p-3">
      <legend className="px-1 text-xs font-semibold text-text-primary">{label}</legend>
      <Field label="Send the call to" htmlFor={`${idPrefix}-kind`}>
        <select id={`${idPrefix}-kind`} className={SELECT_CLASS} value={target.kind} onChange={(e) => setKind(e.target.value as TargetKind)}>
          {TARGET_KINDS.map((k) => (
            <option key={k} value={k}>
              {k === 'ai' ? `${ctx.assistantName} — ${TARGET_KIND_LABELS.ai}` : TARGET_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </Field>

      {target.kind === 'member' && (
        <Field label="Team member" htmlFor={`${idPrefix}-member`}>
          <select id={`${idPrefix}-member`} className={SELECT_CLASS} value={target.memberId ?? ''} onChange={(e) => onChange({ ...target, memberId: e.target.value })}>
            <option value="">Choose…</option>
            {ctx.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.phone ? '' : ' (no phone)'}
              </option>
            ))}
          </select>
        </Field>
      )}

      {target.kind === 'department' && (
        <Field label="Department" htmlFor={`${idPrefix}-dept`}>
          <select id={`${idPrefix}-dept`} className={SELECT_CLASS} value={target.departmentId ?? ''} onChange={(e) => onChange({ ...target, departmentId: e.target.value })}>
            <option value="">Choose…</option>
            {config.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name || 'Unnamed department'}
              </option>
            ))}
          </select>
        </Field>
      )}

      {target.kind === 'phone' && (
        <Input
          label="Phone number"
          type="tel"
          inputMode="tel"
          placeholder="+15125550123"
          value={target.phone ?? ''}
          onChange={(e) => onChange({ ...target, phone: e.target.value.replace(/[^\d+]/g, '') })}
          helperText="International format, starting with +"
        />
      )}

      {rings && (
        <Input
          label="Ring for (seconds)"
          type="number"
          inputMode="numeric"
          min={MIN_RING_SECONDS}
          max={MAX_RING_SECONDS}
          value={target.ringSeconds}
          onChange={(e) => onChange({ ...target, ringSeconds: Number(e.target.value) })}
        />
      )}
    </fieldset>
  );
}

function IssueList({ issues }: { issues: RoutingIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="space-y-1" aria-label="Problems with this step">
      {issues.map((i, idx) => (
        <li key={idx} className={`text-xs ${i.severity === 'error' ? 'text-danger' : 'text-warning-500'}`}>
          {i.message}
        </li>
      ))}
    </ul>
  );
}

interface RuleEditorProps {
  rule: RoutingRule;
  config: CallRoutingConfig;
  ctx: RoutingContext;
  languageOptions: string[];
  issues: RoutingIssue[];
  onChange: (rule: RoutingRule) => void;
  onDelete: () => void;
}

export function RuleEditor({ rule, config, ctx, languageOptions, issues, onChange, onDelete }: RuleEditorProps) {
  const [customLanguage, setCustomLanguage] = useState('');
  const toggleLanguage = (lang: string) => {
    const has = rule.languages.some((l) => l.toLowerCase() === lang.toLowerCase());
    onChange({ ...rule, languages: has ? rule.languages.filter((l) => l.toLowerCase() !== lang.toLowerCase()) : [...rule.languages, lang] });
  };
  const addCustomLanguage = () => {
    const lang = customLanguage.trim().slice(0, 40);
    if (lang && !rule.languages.some((l) => l.toLowerCase() === lang.toLowerCase())) onChange({ ...rule, languages: [...rule.languages, lang] });
    setCustomLanguage('');
  };
  const allLanguages = Array.from(new Set([...languageOptions, ...rule.languages]));

  return (
    <Card className="space-y-4 p-5 hover:translate-y-0">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">{RULE_KIND_META[rule.kind].label} rule</h2>
          <p className="text-xs text-text-secondary">{RULE_KIND_META[rule.kind].description}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onDelete} aria-label={`Delete ${rule.name || 'rule'}`}>
          <Trash2 size={14} />
        </Button>
      </div>

      <Input label="Rule name" value={rule.name} maxLength={80} onChange={(e) => onChange({ ...rule, name: e.target.value })} />

      {rule.kind === 'hours' && (
        <Field label="Apply this rule when you are" htmlFor="rule-hours-state">
          <select id="rule-hours-state" className={SELECT_CLASS} value={rule.hoursState} onChange={(e) => onChange({ ...rule, hoursState: e.target.value as HoursState })}>
            <option value="closed">Closed (outside hours or on a holiday)</option>
            <option value="open">Open</option>
          </select>
        </Field>
      )}

      {rule.kind === 'department' && (
        <Field label="Department the caller asks for" htmlFor="rule-dept">
          <select id="rule-dept" className={SELECT_CLASS} value={rule.departmentId ?? ''} onChange={(e) => onChange({ ...rule, departmentId: e.target.value || null })}>
            <option value="">Choose…</option>
            {config.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name || 'Unnamed department'}
              </option>
            ))}
          </select>
          {config.departments.length === 0 && <p className="mt-1 text-xs text-text-secondary">Create a department under “Flow settings” first.</p>}
        </Field>
      )}

      {rule.kind === 'language' && (
        <div>
          <p className="mb-1 text-xs font-medium text-text-secondary">Caller speaks</p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Languages">
            {allLanguages.map((lang) => {
              const on = rule.languages.some((l) => l.toLowerCase() === lang.toLowerCase());
              return (
                <button
                  key={lang}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleLanguage(lang)}
                  className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${on ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}
                >
                  {lang}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex items-end gap-2">
            <div className="flex-1">
              <Input label="Add another language" value={customLanguage} maxLength={40} onChange={(e) => setCustomLanguage(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addCustomLanguage())} />
            </div>
            <Button type="button" variant="secondary" size="sm" onClick={addCustomLanguage} disabled={!customLanguage.trim()} aria-label="Add language">
              <Plus size={14} />
            </Button>
          </div>
        </div>
      )}

      <TargetPicker idPrefix={`${rule.id}-main`} label="Then" target={rule.target} config={config} ctx={ctx} onChange={(target) => onChange({ ...rule, target })} />

      <label className="flex items-center gap-2 text-sm text-text-primary">
        <input
          type="checkbox"
          className="focus-ring h-4 w-4 rounded border-border"
          checked={rule.overflow !== null}
          onChange={(e) => onChange({ ...rule, overflow: e.target.checked ? defaultTarget('voicemail') : null })}
        />
        If nobody answers, try another step first
      </label>
      {rule.overflow && (
        <TargetPicker idPrefix={`${rule.id}-overflow`} label="Overflow" target={rule.overflow} config={config} ctx={ctx} onChange={(overflow) => onChange({ ...rule, overflow })} />
      )}

      <IssueList issues={issues} />
    </Card>
  );
}

interface FallbackEditorProps {
  config: CallRoutingConfig;
  ctx: RoutingContext;
  issues: RoutingIssue[];
  onChange: (t: RoutingTarget) => void;
}

export function FallbackEditor({ config, ctx, issues, onChange }: FallbackEditorProps) {
  return (
    <Card className="space-y-4 p-5 hover:translate-y-0">
      <div>
        <h2 className="text-sm font-semibold text-text-primary">Everything else</h2>
        <p className="text-xs text-text-secondary">Used when no rule above matches, and as the last stop before voicemail.</p>
      </div>
      <TargetPicker idPrefix="fallback" label="Then" target={config.fallback} config={config} ctx={ctx} onChange={onChange} />
      <IssueList issues={issues.filter((i) => !i.ruleId && i.message.startsWith('Fallback'))} />
    </Card>
  );
}
