import { useEffect, useMemo, useState } from 'react';
import { ImageOff, Loader2, Plus, Save, Star, Trash2, X } from 'lucide-react';
import { AnnotatableImage } from '@/components/AnnotatableImage';
import type { AnnotationPoint } from '@/lib/expertAssist';
import type { EstimateOption } from '@/lib/estimates';
import {
  SEVERITIES,
  SEVERITY_LABEL,
  SEVERITY_STYLE,
  addOption,
  formatMoney,
  isDecisionable,
  nextFreeTier,
  optionTotalCents,
  prepareOptionsForSave,
  setRecommended,
  tierLabel,
  type FindingItemView,
  type FindingSeverity,
} from '@/lib/findingsPackage';
import type { ItemPatch } from '@/lib/findingsPackageApi';

interface Props {
  item: FindingItemView;
  index: number;
  taxPercent: number;
  locked: boolean;
  onSave: (id: string, patch: ItemPatch) => Promise<void>;
  onDelete: (id: string) => void;
}

const inputCls = 'w-full rounded-md border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary focus-ring disabled:opacity-60';

/** Dollar input that keeps its own text so "12." and "12.5" can be typed; commits integer cents. */
function MoneyInput({ cents, disabled, onChange, label }: { cents: number; disabled: boolean; onChange: (c: number) => void; label: string }) {
  const [text, setText] = useState(cents ? (cents / 100).toString() : '');
  useEffect(() => {
    setText((prev) => (Math.round((parseFloat(prev) || 0) * 100) === cents ? prev : cents ? (cents / 100).toString() : ''));
  }, [cents]);
  return (
    <input
      inputMode="decimal"
      aria-label={label}
      disabled={disabled}
      value={text}
      placeholder="0.00"
      onChange={(e) => {
        const v = e.target.value;
        if (!/^\d{0,7}(\.\d{0,2})?$/.test(v)) return;
        setText(v);
        onChange(Math.round((parseFloat(v) || 0) * 100));
      }}
      className={`${inputCls} text-right`}
    />
  );
}

export function FindingEditor({ item, index, taxPercent, locked, onSave, onDelete }: Props) {
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description ?? '');
  const [severity, setSeverity] = useState<FindingSeverity>(item.severity);
  const [annotations, setAnnotations] = useState<AnnotationPoint[]>(item.annotations);
  const [options, setOptions] = useState<EstimateOption[]>(item.options);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync when the server copy changes (after save / reload).
  useEffect(() => {
    setTitle(item.title);
    setDescription(item.description ?? '');
    setSeverity(item.severity);
    setAnnotations(item.annotations);
    setOptions(item.options);
  }, [item]);

  const dirty = useMemo(
    () =>
      title !== item.title ||
      description !== (item.description ?? '') ||
      severity !== item.severity ||
      JSON.stringify(annotations) !== JSON.stringify(item.annotations) ||
      JSON.stringify(options) !== JSON.stringify(item.options),
    [title, description, severity, annotations, options, item],
  );

  const priced = isDecisionable({ severity });

  function updateOption(id: string, patch: Partial<EstimateOption>) {
    setOptions((prev) => prev.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  }

  async function save() {
    if (!title.trim()) {
      setError('Give the finding a short title the customer will understand.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const prepared = priced ? prepareOptionsForSave(options) : { options: [] as EstimateOption[], recommendedId: null };
      await onSave(item.id, {
        title: title.trim(),
        description: description.trim() || null,
        severity,
        annotations,
        options: prepared.options,
        recommended_option_id: prepared.recommendedId,
      });
    } catch {
      setError('Could not save. The package may already be sent — reopen it to edit.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5" aria-label={`Finding ${index + 1}`}>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {/* PHOTO + PINS */}
        <div className="space-y-2">
          {item.photo_url ? (
            <AnnotatableImage
              imageUrl={item.photo_url}
              existingAnnotations={annotations}
              editable={!locked}
              onAddPoint={(p) => setAnnotations((prev) => (prev.length >= 50 ? prev : [...prev, p]))}
            />
          ) : (
            <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-border text-text-secondary">
              <ImageOff size={20} aria-hidden /> <span className="ml-2 text-xs">Photo unavailable</span>
            </div>
          )}
          {annotations.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label="Pins on this photo">
              {annotations.map((a, i) => (
                <li key={i} className="inline-flex items-center gap-1 rounded-full border border-border bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary">
                  {a.label || `Pin ${i + 1}`}
                  {!locked && (
                    <button type="button" aria-label={`Remove pin ${i + 1}`} onClick={() => setAnnotations((prev) => prev.filter((_, j) => j !== i))} className="focus-ring rounded-full hover:text-danger">
                      <X size={12} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* DETAILS + OPTIONS */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-start gap-2">
            <input value={title} disabled={locked} onChange={(e) => setTitle(e.target.value)} maxLength={160} aria-label="Finding title" placeholder="e.g. Cracked heat exchanger" className={`${inputCls} min-w-0 flex-1 font-medium`} />
            <select value={severity} disabled={locked} onChange={(e) => setSeverity(e.target.value as FindingSeverity)} aria-label="Severity" className={`rounded-md border px-2 py-1.5 text-xs font-medium ${SEVERITY_STYLE[severity]}`}>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>
              ))}
            </select>
            {!locked && (
              <button type="button" onClick={() => onDelete(item.id)} aria-label="Remove finding" className="focus-ring rounded-md p-2 text-text-secondary hover:text-danger">
                <Trash2 size={16} />
              </button>
            )}
          </div>
          <textarea value={description} disabled={locked} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={2} aria-label="What the customer should know" placeholder="What you found and why it matters — plain language, no jargon." className={inputCls} />

          {priced ? (
            <div className="space-y-2">
              {options.map((option) => {
                const total = optionTotalCents(option, taxPercent);
                return (
                  <div key={option.id} className="rounded-xl border border-border p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{tierLabel(option.tier)}</span>
                      <input value={option.name} disabled={locked} onChange={(e) => updateOption(option.id, { name: e.target.value })} maxLength={80} aria-label={`${tierLabel(option.tier)} option name`} className={`${inputCls} flex-1`} />
                      <button type="button" disabled={locked} onClick={() => setOptions((prev) => setRecommended(prev, option.recommended ? null : option.id))} aria-pressed={option.recommended} aria-label="Mark as recommended" className={`focus-ring rounded-md p-1.5 ${option.recommended ? 'text-warning-500' : 'text-text-secondary hover:text-text-primary'}`}>
                        <Star size={16} fill={option.recommended ? 'currentColor' : 'none'} />
                      </button>
                      {!locked && (
                        <button type="button" onClick={() => setOptions((prev) => prev.filter((o) => o.id !== option.id))} aria-label="Remove option" className="focus-ring rounded-md p-1.5 text-text-secondary hover:text-danger">
                          <X size={16} />
                        </button>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      {option.line_items.map((li, i) => (
                        <div key={i} className="grid grid-cols-[1fr_3.5rem_6rem_auto] items-center gap-1.5">
                          <input value={li.description} disabled={locked} onChange={(e) => updateOption(option.id, { line_items: option.line_items.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })} maxLength={160} aria-label="Line item" placeholder="Part or labour" className={inputCls} />
                          <input type="number" min={1} max={999} value={li.quantity} disabled={locked} onChange={(e) => updateOption(option.id, { line_items: option.line_items.map((x, j) => (j === i ? { ...x, quantity: Math.max(1, Math.min(999, Math.round(Number(e.target.value) || 1))) } : x)) })} aria-label="Quantity" className={`${inputCls} text-center`} />
                          <MoneyInput label="Unit price in dollars" cents={li.unit_price_cents} disabled={locked} onChange={(c) => updateOption(option.id, { line_items: option.line_items.map((x, j) => (j === i ? { ...x, unit_price_cents: c } : x)) })} />
                          <button type="button" disabled={locked || option.line_items.length === 1} onClick={() => updateOption(option.id, { line_items: option.line_items.filter((_, j) => j !== i) })} aria-label="Remove line" className="focus-ring rounded p-1 text-text-secondary hover:text-danger disabled:opacity-30">
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      {!locked && (
                        <button type="button" onClick={() => updateOption(option.id, { line_items: [...option.line_items, { description: '', quantity: 1, unit_price_cents: 0 }] })} className="focus-ring inline-flex items-center gap-1 rounded text-xs font-medium text-accent">
                          <Plus size={12} /> Add line
                        </button>
                      )}
                      <span className="ml-auto text-sm font-semibold text-text-primary">{formatMoney(total)}{taxPercent > 0 && <span className="ml-1 text-xs font-normal text-text-secondary">incl. tax</span>}</span>
                    </div>
                  </div>
                );
              })}
              {!locked && nextFreeTier(options) && (
                <button type="button" onClick={() => setOptions((prev) => addOption(prev))} className="focus-ring inline-flex items-center gap-1 rounded-md border border-dashed border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary">
                  <Plus size={12} /> Add {tierLabel(nextFreeTier(options)!)} option
                </button>
              )}
            </div>
          ) : (
            <p className="rounded-lg bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">Shown to the customer for awareness only — no price, nothing to approve.</p>
          )}

          {error && <p role="alert" className="text-xs text-danger">{error}</p>}
          {!locked && (
            <div className="flex justify-end">
              <button type="button" onClick={save} disabled={!dirty || saving} className="focus-ring inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} {dirty ? 'Save finding' : 'Saved'}
              </button>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
