import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlignLeft,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Camera,
  CheckCheck,
  CheckSquare,
  Copy,
  Eye,
  GitBranch,
  GripVertical,
  Hash,
  List,
  PenLine,
  Plus,
  RotateCcw,
  ToggleLeft,
  Trash2,
  Type,
  WifiOff,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import { FormRunner } from '@/components/forms/FormRunner';
import { useFormSession } from '@/components/forms/useFormSession';
import {
  FIELD_TYPE_LABEL,
  PALETTE,
  TRADES,
  createField,
  defaultCondition,
  dependentsOf,
  describeFormError,
  duplicateField,
  eligibleSources,
  insertField,
  lintBuilder,
  moveFieldBy,
  moveFieldToGap,
  operatorsFor,
  publishTemplate,
  removeField,
  renameFieldId,
  snapshotOf,
  stateToTemplate,
  uniqueTemplateSlug,
  valueChoices,
} from '@/lib/formBuilder';
import type { BuilderField, BuilderState } from '@/lib/formBuilder';
import { SCHEMA_LIMITS } from '@/lib/offline/formSchema';
import type { ConditionOp, FieldCondition, FieldType } from '@/lib/offline/formSchema';

const TYPE_ICON: Record<FieldType, LucideIcon> = {
  pass_fail: CheckCheck,
  number: Hash,
  photo: Camera,
  signature: PenLine,
  yes_no: ToggleLeft,
  checkbox: CheckSquare,
  select: List,
  text: Type,
  textarea: AlignLeft,
};

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary transition-colors focus-visible:border-accent';
const compact = '!py-2.5 !text-sm';

type View = 'build' | 'edit' | 'preview';
type DragState = { kind: 'type'; type: FieldType } | { kind: 'field'; key: string } | null;

export interface EditorSeed {
  /** null for a brand-new form: the slug is derived from the title on first publish */
  slug: string | null;
  /** 'new' = brand-new form, 'edit' = your own form, 'customize' = a built-in default you are overriding */
  mode: 'new' | 'edit' | 'customize';
  /** version currently live for technicians (0 for a new form) */
  liveVersion: number;
  state: BuilderState;
}

// ============================================================
// Conditional logic editor
// ============================================================

function ConditionRow({
  condition,
  sources,
  onChange,
  onRemove,
}: {
  condition: FieldCondition;
  sources: BuilderField[];
  onChange: (c: FieldCondition) => void;
  onRemove: () => void;
}) {
  const source = sources.find((s) => s.id === condition.field);
  const ops = source ? operatorsFor(source.type) : [];
  const needsValue = condition.op === 'equals' || condition.op === 'not_equals' || condition.op === 'greater_than' || condition.op === 'less_than';
  const choices = source ? valueChoices(source) : null;

  return (
    <div className="space-y-2 rounded-xl border border-border bg-bg-primary p-2.5">
      <div className="flex items-center gap-2">
        <select
          aria-label="When this field"
          value={condition.field}
          onChange={(e) => {
            const next = sources.find((s) => s.id === e.target.value);
            if (next) onChange(defaultCondition(next));
          }}
          className={selectClass}
        >
          {!source && <option value={condition.field}>Missing field</option>}
          {sources.map((s) => (
            <option key={s.key} value={s.id}>
              {s.label.trim() || s.id}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove condition"
          className="focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-danger"
        >
          <Trash2 size={15} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <select
          aria-label="Operator"
          value={condition.op}
          onChange={(e) => onChange({ ...condition, op: e.target.value as ConditionOp })}
          className={selectClass}
        >
          {ops.map((o) => (
            <option key={o.op} value={o.op}>
              {o.label}
            </option>
          ))}
        </select>
        {needsValue &&
          (choices ? (
            <select
              aria-label="Value"
              value={String(condition.value ?? '')}
              onChange={(e) => onChange({ ...condition, value: e.target.value })}
              className={selectClass}
            >
              <option value="">Choose…</option>
              {choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          ) : (
            <Input
              aria-label="Value"
              type={source?.type === 'number' ? 'number' : 'text'}
              inputMode={source?.type === 'number' ? 'decimal' : undefined}
              step={source?.type === 'number' ? 'any' : undefined}
              value={String(condition.value ?? '')}
              onChange={(e) => onChange({ ...condition, value: e.target.value })}
              placeholder="Value"
              className={compact}
            />
          ))}
      </div>
    </div>
  );
}

function LogicEditor({
  field,
  sources,
  onChange,
}: {
  field: BuilderField;
  sources: BuilderField[];
  onChange: (showIf: BuilderField['showIf']) => void;
}) {
  const logic = field.showIf;
  const canEnable = sources.length > 0;

  return (
    <section className="space-y-3 rounded-xl border border-border p-3">
      <label className={`flex items-start gap-3 text-sm ${canEnable ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-accent"
          checked={!!logic}
          disabled={!canEnable && !logic}
          onChange={(e) =>
            onChange(e.target.checked ? { match: 'all', conditions: [defaultCondition(sources[sources.length - 1])] } : null)
          }
        />
        <span>
          <span className="flex items-center gap-1.5 font-medium text-text-primary">
            <GitBranch size={14} className="text-accent" /> Show only when…
          </span>
          <span className="block text-xs text-text-secondary">
            {canEnable
              ? 'Hide this field unless earlier answers match.'
              : 'Place a question above this field first — conditions can only look at earlier fields.'}
          </span>
        </span>
      </label>

      {logic && (
        <div className="space-y-2.5">
          {logic.conditions.length > 1 && (
            <select
              aria-label="Match mode"
              value={logic.match}
              onChange={(e) => onChange({ ...logic, match: e.target.value === 'any' ? 'any' : 'all' })}
              className={selectClass}
            >
              <option value="all">All of these are true</option>
              <option value="any">Any of these is true</option>
            </select>
          )}
          {logic.conditions.map((c, i) => (
            <ConditionRow
              key={i}
              condition={c}
              sources={sources}
              onChange={(next) => onChange({ ...logic, conditions: logic.conditions.map((x, j) => (j === i ? next : x)) })}
              onRemove={() => {
                const rest = logic.conditions.filter((_, j) => j !== i);
                onChange(rest.length > 0 ? { ...logic, conditions: rest } : null);
              }}
            />
          ))}
          {logic.conditions.length < SCHEMA_LIMITS.maxConditions && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange({ ...logic, conditions: [...logic.conditions, defaultCondition(sources[sources.length - 1])] })}
            >
              <Plus size={14} /> Add condition
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

// ============================================================
// Inspector
// ============================================================

function Inspector({
  field,
  fields,
  issues,
  onPatch,
  onRenameId,
  onSetLogic,
}: {
  field: BuilderField;
  fields: BuilderField[];
  issues: string[];
  onPatch: (patch: Partial<BuilderField>) => void;
  onRenameId: (id: string) => void;
  onSetLogic: (showIf: BuilderField['showIf']) => void;
}) {
  const Icon = TYPE_ICON[field.type];
  const sources = eligibleSources(fields, field.key);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <Icon size={16} />
        </span>
        {FIELD_TYPE_LABEL[field.type]}
      </div>

      {issues.length > 0 && (
        <ul role="alert" className="space-y-1 rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
          {issues.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}

      <Input
        label="Label"
        type="text"
        value={field.label}
        maxLength={SCHEMA_LIMITS.labelLength}
        onChange={(e) => onPatch({ label: e.target.value })}
        className={compact}
      />
      <Textarea
        label="Help text (optional)"
        rows={2}
        value={field.help}
        maxLength={SCHEMA_LIMITS.helpLength}
        onChange={(e) => onPatch({ help: e.target.value })}
        className={compact}
      />

      <label className="flex min-h-[40px] cursor-pointer items-center gap-3 text-sm text-text-primary">
        <input type="checkbox" className="h-4 w-4 accent-accent" checked={field.required} onChange={(e) => onPatch({ required: e.target.checked })} />
        Required
      </label>

      {field.type === 'select' && (
        <Textarea
          label="Options (one per line)"
          rows={5}
          value={field.optionsText}
          onChange={(e) => onPatch({ optionsText: e.target.value })}
          className={compact}
        />
      )}

      {field.type === 'number' && (
        <div className="grid grid-cols-3 gap-2">
          <Input label="Min" type="text" inputMode="decimal" value={field.min} onChange={(e) => onPatch({ min: e.target.value })} className={compact} />
          <Input label="Max" type="text" inputMode="decimal" value={field.max} onChange={(e) => onPatch({ max: e.target.value })} className={compact} />
          <Input label="Unit" type="text" value={field.unit} maxLength={SCHEMA_LIMITS.unitLength} onChange={(e) => onPatch({ unit: e.target.value })} placeholder="psi" className={compact} />
          <p className="col-span-3 text-xs text-text-secondary">
            Readings outside the range are flagged for the office but never block the technician.
          </p>
        </div>
      )}

      {field.type === 'photo' && (
        <div className="grid grid-cols-2 gap-2">
          <Input label="Min photos" type="text" inputMode="numeric" value={field.minPhotos} onChange={(e) => onPatch({ minPhotos: e.target.value })} placeholder={field.required ? '1' : '0'} className={compact} />
          <Input label="Max photos" type="text" inputMode="numeric" value={field.maxPhotos} onChange={(e) => onPatch({ maxPhotos: e.target.value })} placeholder={String(SCHEMA_LIMITS.defaultMaxPhotos)} className={compact} />
        </div>
      )}

      {field.type === 'pass_fail' && (
        <div className="space-y-1">
          <label className="flex min-h-[40px] cursor-pointer items-center gap-3 text-sm text-text-primary">
            <input type="checkbox" className="h-4 w-4 accent-accent" checked={field.allowNa} onChange={(e) => onPatch({ allowNa: e.target.checked })} />
            Allow "N/A"
          </label>
          <label className="flex min-h-[40px] cursor-pointer items-center gap-3 text-sm text-text-primary">
            <input type="checkbox" className="h-4 w-4 accent-accent" checked={field.noteOnFail} onChange={(e) => onPatch({ noteOnFail: e.target.checked })} />
            Require a note when it fails
          </label>
        </div>
      )}

      <LogicEditor field={field} sources={sources} onChange={onSetLogic} />

      <details className="rounded-xl border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium text-text-primary">Advanced</summary>
        <div className="mt-3">
          <Input
            label="Field id"
            type="text"
            value={field.id}
            maxLength={SCHEMA_LIMITS.idLength}
            onChange={(e) => onRenameId(e.target.value.toLowerCase().replace(/\s+/g, '_'))}
            helperText="Appears in reports. Changing it updates conditions that use this field."
            className={compact}
          />
        </div>
      </details>
    </div>
  );
}

// ============================================================
// Preview
// ============================================================

function PreviewPane({ state, slug, version }: { state: BuilderState; slug: string; version: number }) {
  const template = useMemo(() => stateToTemplate(state, slug, version), [state, slug, version]);
  const session = useFormSession(template, null);
  const [report, setReport] = useState<string | null>(null);

  const check = () => {
    const ok = session.validate();
    if (!ok) {
      setReport('Some required answers are missing — they are highlighted above.');
      return;
    }
    const built = session.build();
    const s = built?.data.summary;
    setReport(
      s
        ? `Looks good. ${s.answered} of ${s.visible_fields} visible fields answered` +
            (s.passed || s.failed ? ` · ${s.passed} passed, ${s.failed} failed` : '') +
            (s.out_of_range ? ` · ${s.out_of_range} out of range` : '') +
            (s.photos ? ` · ${s.photos} photo${s.photos === 1 ? '' : 's'}` : '') +
            '.'
        : 'Looks good.'
    );
  };

  return (
    <div className="mx-auto w-full max-w-xl space-y-5">
      <p className="flex items-start gap-2 rounded-xl border border-border bg-bg-secondary px-3.5 py-3 text-xs text-text-secondary">
        <WifiOff size={14} className="mt-0.5 shrink-0 text-accent" />
        This is exactly what technicians see. It runs entirely on this device — conditions, photos and signatures work with no signal — and nothing is submitted.
      </p>
      <div className="rounded-2xl border border-border bg-bg-secondary p-4">
        <h3 className="text-base font-semibold text-text-primary">{template.title}</h3>
        {template.description && <p className="mt-1 text-xs text-text-secondary">{template.description}</p>}
        <div className="mt-4">
          {template.fields.length === 0 ? (
            <p className="text-sm text-text-secondary">Add fields to see them here.</p>
          ) : (
            <FormRunner template={template} session={session} idPrefix="preview" />
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" onClick={check} disabled={template.fields.length === 0}>
          Check answers
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            session.reset();
            setReport(null);
          }}
        >
          <RotateCcw size={14} /> Reset
        </Button>
      </div>
      {report && (
        <p role="status" className="rounded-xl border border-border bg-bg-secondary px-3.5 py-3 text-sm text-text-primary">
          {report}
        </p>
      )}
    </div>
  );
}

// ============================================================
// Editor
// ============================================================

export function FormBuilderEditor({
  seed,
  takenSlugs,
  onExit,
  onPublished,
}: {
  seed: EditorSeed;
  /** every slug already visible to the account (own + built-in), to keep new slugs unique */
  takenSlugs: Set<string>;
  onExit: () => void;
  onPublished: () => void;
}) {
  const { toast } = useToast();
  const [slug, setSlug] = useState<string | null>(seed.slug);
  const [state, setState] = useState<BuilderState>(seed.state);
  const [selectedKey, setSelectedKey] = useState<string | null>(seed.state.fields[0]?.key ?? null);
  const [view, setView] = useState<View>('build');
  const [liveVersion, setLiveVersion] = useState(seed.liveVersion);
  const [saving, setSaving] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<BuilderField | null>(null);
  const [dropGap, setDropGap] = useState<number | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const dragRef = useRef<DragState>(null);
  const baselineRef = useRef(snapshotOf(seed.state));
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const dirty = snapshotOf(state) !== baselineRef.current;
  const lint = useMemo(() => lintBuilder(state), [state]);
  const selected = state.fields.find((f) => f.key === selectedKey) ?? null;
  const nextVersion = liveVersion + 1;
  const canPublish = !saving && lint.count === 0 && (dirty || liveVersion === 0);

  // Warn before the tab/window is closed with unpublished edits.
  useEffect(() => {
    if (!dirty) return undefined;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const patchState = useCallback((patch: Partial<BuilderState>) => setState((s) => ({ ...s, ...patch })), []);
  const updateField = useCallback((key: string, patch: Partial<BuilderField>) => {
    setState((s) => ({ ...s, fields: s.fields.map((f) => (f.key === key ? { ...f, ...patch } : f)) }));
  }, []);

  const select = (key: string) => {
    setSelectedKey(key);
    // Desktop shows the inspector next to the canvas; phones switch to the "Edit field" tab.
    const desktop = typeof window !== 'undefined' && !!window.matchMedia?.('(min-width: 1024px)').matches;
    setView(desktop ? 'build' : 'edit');
  };

  const scrollTo = (key: string) => {
    window.setTimeout(() => cardRefs.current.get(key)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 0);
  };

  const addField = (type: FieldType, gap?: number) => {
    const field = createField(type, state.fields);
    const index = gap ?? (selected ? state.fields.findIndex((f) => f.key === selected.key) + 1 : state.fields.length);
    setState((s) => ({ ...s, fields: insertField(s.fields, field, index) }));
    setSelectedKey(field.key);
    setAnnouncement(`${FIELD_TYPE_LABEL[type]} added at position ${index + 1}`);
    scrollTo(field.key);
  };

  const moveBy = (field: BuilderField, delta: -1 | 1) => {
    const next = moveFieldBy(state.fields, field.key, delta);
    if (next === state.fields) return;
    setState((s) => ({ ...s, fields: next }));
    setAnnouncement(`${field.label || field.id} moved to position ${next.findIndex((f) => f.key === field.key) + 1} of ${next.length}`);
  };

  const doRemove = (field: BuilderField) => {
    const idx = state.fields.findIndex((f) => f.key === field.key);
    const { fields, affected } = removeField(state.fields, field.key);
    setState((s) => ({ ...s, fields }));
    setSelectedKey(fields[Math.min(idx, fields.length - 1)]?.key ?? null);
    setAnnouncement(`${field.label || field.id} removed${affected ? `; ${affected} condition${affected === 1 ? '' : 's'} updated` : ''}`);
    if (fields.length === 0) setView('build');
  };

  const requestRemove = (field: BuilderField) => {
    if (dependentsOf(state.fields, field.key) > 0) setPendingDelete(field);
    else doRemove(field);
  };

  // ---------- drag and drop (mouse / pen; touch uses the move buttons) ----------
  const endDrag = () => {
    dragRef.current = null;
    setDragKey(null);
    setDropGap(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const drag = dragRef.current;
    const gap = dropGap ?? state.fields.length;
    endDrag();
    if (!drag) return;
    if (drag.kind === 'type') addField(drag.type, gap);
    else {
      const next = moveFieldToGap(state.fields, drag.key, gap);
      if (next !== state.fields) {
        setState((s) => ({ ...s, fields: next }));
        setAnnouncement(`Field moved to position ${next.findIndex((f) => f.key === drag.key) + 1} of ${next.length}`);
      }
    }
  };

  const onCardDragOver = (e: React.DragEvent, index: number) => {
    if (!dragRef.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = dragRef.current.kind === 'type' ? 'copy' : 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    setDropGap(index + (e.clientY > rect.top + rect.height / 2 ? 1 : 0));
  };

  const publish = async () => {
    if (!canPublish) return;
    setSaving(true);
    try {
      const result = await publishTemplate({ slug: slug ?? uniqueTemplateSlug(state.title, takenSlugs), state });
      setSlug(result.slug);
      baselineRef.current = snapshotOf(state);
      setLiveVersion(result.version);
      toast(`Published version ${result.version}. Technicians get it on their next sync.`, 'success');
      onPublished();
    } catch (err) {
      toast(describeFormError(err, 'Could not publish the form.'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const showBuild = view !== 'preview';
  const tabClass = (active: boolean) =>
    `focus-ring whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${active ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`;

  const gapLine = <div className="h-1 rounded-full bg-accent" aria-hidden="true" />;

  return (
    <div className="space-y-4">
      {/* Top bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => (dirty ? setConfirmExit(true) : onExit())}
            aria-label="Back to all forms"
            className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border text-text-secondary hover:text-text-primary"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold text-text-primary">{state.title.trim() || 'Untitled form'}</h1>
            <p className="text-xs text-text-secondary">
              {seed.mode === 'customize' ? 'Customizing a default form · ' : ''}
              {dirty ? 'Unpublished changes' : liveVersion > 0 ? `Live: version ${liveVersion}` : 'Not published yet'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {lint.count > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger">
              <AlertCircle size={13} /> {lint.count} to fix
            </span>
          )}
          <Button type="button" size="sm" onClick={() => void publish()} disabled={!canPublish}>
            {saving ? 'Publishing…' : liveVersion === 0 ? 'Publish' : `Publish v${nextVersion}`}
          </Button>
        </div>
      </div>

      {/* View switch */}
      <div role="tablist" aria-label="Editor view" className="inline-flex gap-1 rounded-xl border border-border bg-bg-secondary p-1">
        <button type="button" role="tab" aria-selected={view === 'build'} onClick={() => setView('build')} className={tabClass(view === 'build')}>
          Build
        </button>
        <button type="button" role="tab" aria-selected={view === 'edit'} onClick={() => setView('edit')} disabled={!selected} className={`${tabClass(view === 'edit')} lg:hidden disabled:opacity-40`}>
          Edit field
        </button>
        <button type="button" role="tab" aria-selected={view === 'preview'} onClick={() => setView('preview')} className={tabClass(view === 'preview')}>
          <span className="inline-flex items-center gap-1.5">
            <Eye size={13} /> Preview
          </span>
        </button>
      </div>

      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <div className={`grid gap-4 ${showBuild ? 'lg:grid-cols-[15rem_minmax(0,1fr)_21rem]' : ''}`}>
        {/* Palette */}
        <aside className={`${view === 'build' ? '' : 'hidden'} ${showBuild ? 'lg:block' : 'lg:hidden'}`} aria-label="Field types">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Add a field</p>
          <div className="grid grid-cols-3 gap-2 lg:grid-cols-1">
            {PALETTE.map((p) => {
              const Icon = TYPE_ICON[p.type];
              return (
                <button
                  key={p.type}
                  type="button"
                  draggable
                  onDragStart={(e) => {
                    dragRef.current = { kind: 'type', type: p.type };
                    e.dataTransfer.effectAllowed = 'copy';
                    e.dataTransfer.setData('text/plain', p.type);
                  }}
                  onDragEnd={endDrag}
                  onClick={() => addField(p.type)}
                  className="focus-ring flex min-h-[48px] flex-col items-center gap-1 rounded-xl border border-border bg-bg-secondary px-2 py-2.5 text-center text-xs font-medium text-text-primary transition-colors hover:border-accent/40 lg:flex-row lg:gap-3 lg:px-3 lg:text-left lg:text-sm"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                    <Icon size={16} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate">{p.label}</span>
                    <span className="hidden text-xs font-normal text-text-secondary lg:block">{p.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-3 hidden text-xs text-text-secondary lg:block">Drag onto the form, or click to add after the selected field.</p>
        </aside>

        {/* Canvas */}
        <section className={`${view === 'build' ? '' : 'hidden'} ${showBuild ? 'lg:block' : 'lg:hidden'} min-w-0 space-y-4`} aria-label="Form">
          <div className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-4">
            <Input label="Form name" type="text" value={state.title} maxLength={120} onChange={(e) => patchState({ title: e.target.value })} placeholder="e.g. Rooftop unit inspection" className={compact} />
            <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
              <Textarea label="Description (optional)" rows={2} value={state.description} maxLength={500} onChange={(e) => patchState({ description: e.target.value })} className={compact} />
              <div>
                <label htmlFor="fb-trade" className="mb-1.5 block text-sm font-medium text-text-primary">
                  Trade
                </label>
                <select id="fb-trade" value={state.trade} onChange={(e) => patchState({ trade: e.target.value })} className={selectClass}>
                  {TRADES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-xs text-text-secondary">Technicians see matching forms first.</p>
              </div>
            </div>
            {lint.form.length > 0 && (
              <ul role="alert" className="space-y-1 text-xs text-danger">
                {lint.form.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            )}
          </div>

          <div
            onDragOver={(e) => {
              if (!dragRef.current) return;
              e.preventDefault();
              if (e.target === e.currentTarget) setDropGap(state.fields.length);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropGap(null);
            }}
            onDrop={handleDrop}
            className="min-h-[8rem] space-y-2"
          >
            {state.fields.length === 0 ? (
              <div className={`flex flex-col items-center rounded-2xl border-2 border-dashed px-6 py-12 text-center ${dropGap !== null ? 'border-accent bg-accent/5' : 'border-border'}`}>
                <p className="text-sm font-semibold text-text-primary">Start building your form</p>
                <p className="mt-1 max-w-xs text-xs text-text-secondary">Drag a field type here, or tap one to add it. Pass / Fail, photos and signatures all work offline.</p>
              </div>
            ) : (
              state.fields.map((f, i) => {
                const Icon = TYPE_ICON[f.type];
                const problems = lint.fields[f.key]?.length ?? 0;
                const isSelected = f.key === selectedKey;
                return (
                  <div key={f.key}>
                    {dropGap === i && gapLine}
                    <div
                      ref={(el) => {
                        if (el) cardRefs.current.set(f.key, el);
                        else cardRefs.current.delete(f.key);
                      }}
                      onDragOver={(e) => onCardDragOver(e, i)}
                      className={`rounded-2xl border bg-bg-secondary transition-colors ${dragKey === f.key ? 'opacity-40' : ''} ${isSelected ? 'border-accent' : problems > 0 ? 'border-danger/50' : 'border-border'}`}
                    >
                      <div className="flex items-center gap-1 p-2">
                        <span
                          draggable
                          onDragStart={(e) => {
                            dragRef.current = { kind: 'field', key: f.key };
                            setDragKey(f.key);
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/plain', f.key);
                            const card = cardRefs.current.get(f.key);
                            if (card) e.dataTransfer.setDragImage(card, 24, 24);
                          }}
                          onDragEnd={endDrag}
                          className="hidden h-10 w-8 shrink-0 cursor-grab items-center justify-center text-text-secondary active:cursor-grabbing lg:flex"
                          title="Drag to reorder"
                          aria-hidden="true"
                        >
                          <GripVertical size={16} />
                        </span>
                        <button type="button" onClick={() => select(f.key)} aria-pressed={isSelected} className="focus-ring flex min-h-[48px] min-w-0 flex-1 items-center gap-3 rounded-xl px-2 text-left">
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                            <Icon size={16} />
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-text-primary">
                              {f.label.trim() || 'Untitled field'}
                              {f.required && <span className="ml-0.5 text-danger">*</span>}
                            </span>
                            <span className="flex flex-wrap items-center gap-x-2 text-xs text-text-secondary">
                              {FIELD_TYPE_LABEL[f.type]}
                              {f.showIf && (
                                <span className="inline-flex items-center gap-1 text-accent">
                                  <GitBranch size={11} /> conditional
                                </span>
                              )}
                              {problems > 0 && (
                                <span className="inline-flex items-center gap-1 text-danger">
                                  <AlertCircle size={11} /> {problems} to fix
                                </span>
                              )}
                            </span>
                          </span>
                        </button>
                        <div className="flex shrink-0 items-center">
                          <button type="button" onClick={() => moveBy(f, -1)} disabled={i === 0} aria-label={`Move ${f.label || 'field'} up`} className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-30">
                            <ArrowUp size={15} />
                          </button>
                          <button type="button" onClick={() => moveBy(f, 1)} disabled={i === state.fields.length - 1} aria-label={`Move ${f.label || 'field'} down`} className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-30">
                            <ArrowDown size={15} />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const next = duplicateField(state.fields, f.key);
                              setState((s) => ({ ...s, fields: next }));
                              setSelectedKey(next[i + 1]?.key ?? f.key);
                              setAnnouncement(`${f.label || 'Field'} duplicated`);
                            }}
                            disabled={state.fields.length >= SCHEMA_LIMITS.maxFields}
                            aria-label={`Duplicate ${f.label || 'field'}`}
                            className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-30"
                          >
                            <Copy size={15} />
                          </button>
                          <button type="button" onClick={() => requestRemove(f)} aria-label={`Delete ${f.label || 'field'}`} className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-danger">
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
            {dropGap === state.fields.length && state.fields.length > 0 && gapLine}
          </div>

          {lint.count > 0 && state.fields.length > 0 && (
            <div className="rounded-2xl border border-danger/30 bg-danger/5 p-3.5">
              <p className="mb-2 text-sm font-semibold text-danger">Fix before publishing</p>
              <ul className="space-y-1.5 text-xs">
                {state.fields
                  .filter((f) => lint.fields[f.key])
                  .map((f) => (
                    <li key={f.key}>
                      <button
                        type="button"
                        onClick={() => {
                          select(f.key);
                          scrollTo(f.key);
                        }}
                        className="focus-ring text-left text-text-primary underline-offset-2 hover:underline"
                      >
                        <span className="font-medium">{f.label.trim() || 'Untitled field'}</span>: {lint.fields[f.key][0]}
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          <p className="text-xs text-text-secondary">
            Publishing creates version {nextVersion}. Technicians receive it the next time their device syncs; forms they already filled in stay on the version they used.
          </p>
        </section>

        {/* Inspector */}
        <aside className={`${view === 'edit' ? '' : 'hidden'} ${showBuild ? 'lg:block' : 'lg:hidden'} min-w-0 rounded-2xl border border-border bg-bg-secondary p-4 lg:self-start`} aria-label="Field settings">
          {selected ? (
            <Inspector
              key={selected.key}
              field={selected}
              fields={state.fields}
              issues={lint.fields[selected.key] ?? []}
              onPatch={(patch) => updateField(selected.key, patch)}
              onRenameId={(id) => setState((s) => ({ ...s, fields: renameFieldId(s.fields, selected.key, id) }))}
              onSetLogic={(showIf) => updateField(selected.key, { showIf })}
            />
          ) : (
            <p className="py-8 text-center text-sm text-text-secondary">Select a field to edit its settings.</p>
          )}
        </aside>

        {/* Preview */}
        <section className={view === 'preview' ? '' : 'hidden'} aria-label="Preview">
          {view === 'preview' && <PreviewPane state={state} slug={slug ?? 'preview'} version={Math.max(1, nextVersion)} />}
        </section>
      </div>

      <ConfirmDialog
        open={confirmExit}
        title="Discard unpublished changes?"
        description="Your edits to this form have not been published. If you leave now they will be lost."
        confirmLabel="Discard changes"
        onConfirm={() => {
          setConfirmExit(false);
          onExit();
        }}
        onCancel={() => setConfirmExit(false)}
      />
      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete this field?"
        description={`Other fields only show when "${pendingDelete?.label ?? ''}" has a certain answer. Deleting it removes those conditions, so they will always be shown.`}
        confirmLabel="Delete field"
        onConfirm={() => {
          if (pendingDelete) doRemove(pendingDelete);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
