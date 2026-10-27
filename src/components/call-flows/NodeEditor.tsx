import type { ReactNode } from 'react';
import { Flag, Plus, Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { NODE_ICONS } from '@/components/call-flows/FlowCanvas';
import {
  DEFAULT_RING_SECONDS,
  MAX_GREETING_LENGTH,
  MAX_MENU_OPTIONS,
  MAX_MENU_RETRIES,
  MAX_MENU_TIMEOUT,
  MAX_PROMPT_LENGTH,
  MAX_RING_SECONDS,
  MENU_KEYS,
  MIN_MENU_TIMEOUT,
  MIN_RING_SECONDS,
  NODE_KIND_META,
  TARGET_KIND_LABELS,
  addMenuOption,
  targetRings,
  type FlowContext,
  type FlowIssue,
  type FlowNode,
  type MenuKey,
  type MenuNode,
  type RoutingTarget,
  type TargetKind,
} from '@/lib/callFlows';

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

function IssueList({ issues }: { issues: FlowIssue[] }) {
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

function TargetPicker({ target, ctx, onChange }: { target: RoutingTarget; ctx: FlowContext; onChange: (t: RoutingTarget) => void }) {
  const setKind = (kind: TargetKind) => onChange({ kind, ringSeconds: target.ringSeconds });
  return (
    <fieldset className="space-y-3 rounded-xl border border-border p-3">
      <legend className="px-1 text-xs font-semibold text-text-primary">Send the call to</legend>
      <Field label="Destination" htmlFor="flow-target-kind">
        <select id="flow-target-kind" className={SELECT_CLASS} value={target.kind} onChange={(e) => setKind(e.target.value as TargetKind)}>
          {TARGET_KINDS.map((k) => (
            <option key={k} value={k}>
              {k === 'ai' ? `${ctx.assistantName} — ${TARGET_KIND_LABELS.ai}` : TARGET_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </Field>

      {target.kind === 'member' && (
        <Field label="Team member" htmlFor="flow-target-member">
          <select id="flow-target-member" className={SELECT_CLASS} value={target.memberId ?? ''} onChange={(e) => onChange({ ...target, memberId: e.target.value })}>
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
        <Field label="Department" htmlFor="flow-target-dept">
          <select id="flow-target-dept" className={SELECT_CLASS} value={target.departmentId ?? ''} onChange={(e) => onChange({ ...target, departmentId: e.target.value })}>
            <option value="">Choose…</option>
            {ctx.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name || 'Unnamed department'}
              </option>
            ))}
          </select>
          {ctx.departments.length === 0 && <p className="mt-1 text-xs text-text-secondary">Departments are created on the Call Routing page.</p>}
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

      {targetRings(target) && (
        <Input
          label="Ring for (seconds)"
          type="number"
          inputMode="numeric"
          min={MIN_RING_SECONDS}
          max={MAX_RING_SECONDS}
          value={target.ringSeconds}
          onChange={(e) => {
            const n = Math.round(Number(e.target.value));
            onChange({ ...target, ringSeconds: Number.isFinite(n) && e.target.value !== '' ? n : DEFAULT_RING_SECONDS });
          }}
        />
      )}
    </fieldset>
  );
}

function MenuFields({ node, onChange }: { node: MenuNode; onChange: (n: FlowNode) => void }) {
  const setOption = (index: number, patch: Partial<MenuNode['options'][number]>) =>
    onChange({ ...node, options: node.options.map((o, i) => (i === index ? { ...o, ...patch } : o)) });
  const usedKeys = new Set(node.options.map((o) => o.key));

  return (
    <>
      <Textarea
        label="What the caller hears"
        rows={3}
        maxLength={MAX_PROMPT_LENGTH}
        value={node.prompt}
        placeholder="Thank you for calling. For service, press 1…"
        helperText={`${node.prompt.length}/${MAX_PROMPT_LENGTH} · read aloud with text-to-speech`}
        onChange={(e) => onChange({ ...node, prompt: e.target.value })}
      />

      <fieldset className="space-y-2 rounded-xl border border-border p-3">
        <legend className="px-1 text-xs font-semibold text-text-primary">Key options</legend>
        {node.options.length === 0 && <p className="text-xs text-text-secondary">Add the keys callers can press.</p>}
        {node.options.map((o, i) => (
          <div key={i} className="flex items-end gap-2">
            <div className="w-20 shrink-0">
              <Field label="Key" htmlFor={`flow-opt-key-${i}`}>
                <select id={`flow-opt-key-${i}`} className={SELECT_CLASS} value={o.key} onChange={(e) => setOption(i, { key: e.target.value as MenuKey })}>
                  {MENU_KEYS.filter((k) => k === o.key || !usedKeys.has(k)).map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="min-w-0 flex-1">
              <Input label="Label" value={o.label} maxLength={60} placeholder="e.g. Service" onChange={(e) => setOption(i, { label: e.target.value })} />
            </div>
            <Button type="button" variant="ghost" size="sm" aria-label={`Remove key ${o.key}`} onClick={() => onChange({ ...node, options: node.options.filter((_, idx) => idx !== i) })}>
              <Trash2 size={14} />
            </Button>
          </div>
        ))}
        <Button type="button" variant="secondary" size="sm" disabled={node.options.length >= MAX_MENU_OPTIONS} onClick={() => onChange(addMenuOption(node))}>
          <Plus size={14} /> Add key
        </Button>
        <p className="text-xs text-text-secondary">Choose where each key goes in the flow on the left.</p>
      </fieldset>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Wait for a key (seconds)" htmlFor="flow-menu-timeout">
          <select id="flow-menu-timeout" className={SELECT_CLASS} value={node.timeoutSeconds} onChange={(e) => onChange({ ...node, timeoutSeconds: Number(e.target.value) })}>
            {Array.from({ length: MAX_MENU_TIMEOUT - MIN_MENU_TIMEOUT + 1 }, (_, i) => MIN_MENU_TIMEOUT + i).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Repeat the menu" htmlFor="flow-menu-retries">
          <select id="flow-menu-retries" className={SELECT_CLASS} value={node.maxRetries} onChange={(e) => onChange({ ...node, maxRetries: Number(e.target.value) })}>
            {Array.from({ length: MAX_MENU_RETRIES + 1 }, (_, i) => i).map((r) => (
              <option key={r} value={r}>
                {r === 0 ? 'Never' : r === 1 ? 'Once' : `${r} times`}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </>
  );
}

interface NodeEditorProps {
  node: FlowNode;
  ctx: FlowContext;
  issues: FlowIssue[];
  isEntry: boolean;
  onChange: (node: FlowNode) => void;
  onMakeEntry: () => void;
  onDelete: () => void;
}

export function NodeEditor({ node, ctx, issues, isEntry, onChange, onMakeEntry, onDelete }: NodeEditorProps) {
  const Icon = NODE_ICONS[node.kind];
  return (
    <Card className="space-y-4 p-5 hover:translate-y-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Icon size={16} />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text-primary">{NODE_KIND_META[node.kind].label} step</h2>
            <p className="text-xs text-text-secondary">{NODE_KIND_META[node.kind].description}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!isEntry && (
            <Button type="button" variant="ghost" size="sm" onClick={onMakeEntry} aria-label={`Start the flow at ${node.name || 'this step'}`} title="Start the flow here">
              <Flag size={14} />
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={onDelete} disabled={isEntry} aria-label={`Delete ${node.name || 'step'}`} title={isEntry ? 'Start the flow at another step first' : undefined}>
            <Trash2 size={14} />
          </Button>
        </div>
      </div>

      <IssueList issues={issues} />

      <Input label="Step name" value={node.name} maxLength={80} onChange={(e) => onChange({ ...node, name: e.target.value })} />

      {node.kind === 'menu' && <MenuFields node={node} onChange={onChange} />}

      {node.kind === 'hours' && (
        <p className="rounded-xl bg-bg-tertiary p-3 text-xs leading-relaxed text-text-secondary">
          Uses the business hours and holidays from your business profile ({ctx.holidays.length} holiday{ctx.holidays.length === 1 ? '' : 's'} set). Choose where each
          outcome goes in the flow on the left. If you leave Holiday empty, holidays follow the Closed path.
        </p>
      )}

      {node.kind === 'route' && <TargetPicker target={node.target} ctx={ctx} onChange={(target) => onChange({ ...node, target })} />}

      {node.kind === 'message' && (
        <Textarea
          label="What the caller hears"
          rows={3}
          maxLength={MAX_PROMPT_LENGTH}
          value={node.text}
          helperText={`${node.text.length}/${MAX_PROMPT_LENGTH} · after it plays, the call continues or hangs up`}
          onChange={(e) => onChange({ ...node, text: e.target.value })}
        />
      )}

      {node.kind === 'voicemail' && (
        <>
          <Textarea
            label="Voicemail greeting"
            rows={3}
            maxLength={MAX_GREETING_LENGTH}
            value={node.greeting}
            helperText={`${node.greeting.length}/${MAX_GREETING_LENGTH}`}
            onChange={(e) => onChange({ ...node, greeting: e.target.value })}
          />
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input type="checkbox" className="focus-ring h-4 w-4 rounded border-border" checked={node.transcribe} onChange={(e) => onChange({ ...node, transcribe: e.target.checked })} />
            Transcribe voicemails to text
          </label>
        </>
      )}
    </Card>
  );
}
