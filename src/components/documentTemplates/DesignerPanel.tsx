import { useEffect, useId, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Eye, EyeOff } from 'lucide-react';
import { Input, Textarea } from '@/components/ui/Input';
import {
  ACCENT_BARS,
  ACCENT_BAR_LABELS,
  FONT_FAMILIES,
  FONT_LABELS,
  LIMITS,
  PAGE_SIZES,
  PAGE_SIZE_LABELS,
  PRESETS,
  applyPresetStyle,
  contrastWithWhite,
  moveSection,
  normalizeColor,
  sectionLabel,
  setSectionVisible,
  type DocType,
  type DocumentDesign,
  type PresetId,
} from '@/lib/documentTemplates';

const SELECT_CLASS =
  'focus-ring min-h-[44px] w-full rounded-xl border border-border bg-bg-primary px-3 text-sm text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';

function Group({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="group rounded-2xl border border-border bg-bg-secondary">
      <summary className="focus-ring flex min-h-[48px] cursor-pointer list-none items-center justify-between rounded-2xl px-4 text-sm font-semibold text-text-primary">
        {title}
        <span aria-hidden="true" className="text-text-secondary transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="space-y-4 border-t border-border p-4">{children}</div>
    </details>
  );
}

function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex min-h-[44px] cursor-pointer items-center justify-between gap-3 text-sm text-text-primary">
      <span>{label}</span>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="focus-ring h-5 w-5 shrink-0 accent-[var(--accent-primary,#2563eb)]"
      />
    </label>
  );
}

function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">
        {label}
      </label>
      <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)} className={SELECT_CLASS}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ColorField({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const id = useId();
  const [text, setText] = useState(value);
  // Keep the text box in sync when the value changes from the picker or a preset.
  useEffect(() => setText(value), [value]);
  const commit = (raw: string) => {
    setText(raw);
    const ok = normalizeColor(raw, '');
    if (ok) onChange(ok);
  };
  const invalid = text !== value && !normalizeColor(text, '');
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">
        {label}
      </label>
      <div className="flex items-start gap-2">
        <input
          id={id}
          type="color"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(normalizeColor(e.target.value, value))}
          aria-label={`${label} color picker`}
          className="focus-ring h-12 w-14 shrink-0 cursor-pointer rounded-xl border border-border bg-bg-primary p-1 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <Input
          aria-label={`${label} hex value`}
          value={text}
          disabled={disabled}
          maxLength={7}
          error={invalid ? 'Use a hex color like #203AD8.' : undefined}
          onChange={(e) => commit(e.target.value)}
          onBlur={() => setText(value)}
          className="font-mono uppercase"
        />
      </div>
    </div>
  );
}

function RangeField({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 flex items-center justify-between text-sm font-medium text-text-primary">
        <span>{label}</span>
        <span className="text-text-secondary">
          {value} {unit}
        </span>
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="focus-ring h-11 w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
      />
    </div>
  );
}

export interface DesignerPanelProps {
  docType: DocType;
  design: DocumentDesign;
  onChange: (next: DocumentDesign) => void;
  readOnly?: boolean;
}

export function DesignerPanel({ docType, design, onChange, readOnly = false }: DesignerPanelProps) {
  const set = <K extends keyof DocumentDesign>(key: K, patch: Partial<DocumentDesign[K]>) =>
    onChange({ ...design, [key]: { ...(design[key] as object), ...patch } } as DocumentDesign);
  const isReport = docType === 'report';
  const lowContrastText = contrastWithWhite(design.theme.primary) < 3;

  return (
    <div className="space-y-3" aria-label="Template settings">
      <Group title="Style" defaultOpen>
        <div>
          <p className="mb-2 text-sm font-medium text-text-primary">Start from a preset</p>
          <div className="grid grid-cols-2 gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={readOnly}
                onClick={() => onChange(applyPresetStyle(design, docType, p.id as PresetId))}
                className="focus-ring min-h-[56px] rounded-xl border border-border bg-bg-primary p-3 text-left transition-colors hover:border-accent/50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="block text-sm font-semibold text-text-primary">{p.label}</span>
                <span className="block text-xs text-text-secondary">{p.description}</span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-text-secondary">A preset changes colors, font and table style. Your text, labels and section order are kept.</p>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ColorField label="Primary color" value={design.theme.primary} disabled={readOnly} onChange={(v) => set('theme', { primary: v })} />
          <ColorField label="Accent color" value={design.theme.accent} disabled={readOnly} onChange={(v) => set('theme', { accent: v })} />
        </div>
        {lowContrastText && (
          <p role="status" className="rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-xs text-text-primary">
            This primary color is very light. Titles and table headers may be hard to read on white paper — pick a darker one.
          </p>
        )}
        <SelectField
          label="Font"
          value={design.theme.font}
          disabled={readOnly}
          options={FONT_FAMILIES.map((f) => ({ value: f, label: FONT_LABELS[f] }))}
          onChange={(v) => set('theme', { font: v })}
        />
        <RangeField
          label="Text size"
          value={design.theme.baseSize}
          min={LIMITS.sizeMin}
          max={LIMITS.sizeMax}
          step={0.5}
          unit="pt"
          disabled={readOnly}
          onChange={(v) => set('theme', { baseSize: v })}
        />
      </Group>

      <Group title="Page">
        <SelectField
          label="Paper size"
          value={design.page.size}
          disabled={readOnly}
          options={PAGE_SIZES.map((s) => ({ value: s, label: PAGE_SIZE_LABELS[s] }))}
          onChange={(v) => set('page', { size: v })}
        />
        <RangeField
          label="Margins"
          value={design.page.margin}
          min={LIMITS.marginMin}
          max={LIMITS.marginMax}
          step={2}
          unit="pt"
          disabled={readOnly}
          onChange={(v) => set('page', { margin: v })}
        />
      </Group>

      <Group title="Header">
        <SelectField
          label="Accent style"
          value={design.header.accentBar}
          disabled={readOnly}
          options={ACCENT_BARS.map((a) => ({ value: a, label: ACCENT_BAR_LABELS[a] }))}
          onChange={(v) => set('header', { accentBar: v })}
        />
        <Input
          label="Document title"
          value={design.header.title}
          maxLength={LIMITS.title}
          disabled={readOnly}
          onChange={(e) => set('header', { title: e.target.value })}
          helperText="Shown large in the header, e.g. QUOTE or TAX INVOICE."
        />
        <Input
          label="Tagline"
          value={design.header.tagline}
          maxLength={LIMITS.tagline}
          disabled={readOnly}
          onChange={(e) => set('header', { tagline: e.target.value })}
          helperText="Optional line under your business name."
        />
        <SelectField
          label="Brand position"
          value={design.header.logoAlign}
          disabled={readOnly}
          options={[
            { value: 'left', label: 'Brand left, title right' },
            { value: 'right', label: 'Brand right, title left' },
          ]}
          onChange={(v) => set('header', { logoAlign: v })}
        />
        <Toggle label="Show logo (from Branding settings)" checked={design.header.showLogo} disabled={readOnly} onChange={(v) => set('header', { showLogo: v })} />
        <Toggle label="Show business name" checked={design.header.showBusinessName} disabled={readOnly} onChange={(v) => set('header', { showBusinessName: v })} />
        <Toggle label="Show business contact details" checked={design.header.showBusinessContact} disabled={readOnly} onChange={(v) => set('header', { showBusinessContact: v })} />
      </Group>

      <Group title={isReport ? 'Data table' : 'Line items table'}>
        <SelectField
          label="Header style"
          value={design.table.headerStyle}
          disabled={readOnly}
          options={[
            { value: 'filled', label: 'Tinted background' },
            { value: 'underline', label: 'Underline only' },
          ]}
          onChange={(v) => set('table', { headerStyle: v })}
        />
        <Toggle label="Striped rows" checked={design.table.zebra} disabled={readOnly} onChange={(v) => set('table', { zebra: v })} />
        {!isReport && (
          <>
            <Toggle label="Show quantity column" checked={design.table.showQty} disabled={readOnly} onChange={(v) => set('table', { showQty: v })} />
            <Toggle label="Show unit price column" checked={design.table.showUnitPrice} disabled={readOnly} onChange={(v) => set('table', { showUnitPrice: v })} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input label="Description label" value={design.table.descriptionLabel} maxLength={LIMITS.label} disabled={readOnly} onChange={(e) => set('table', { descriptionLabel: e.target.value })} />
              <Input label="Quantity label" value={design.table.qtyLabel} maxLength={LIMITS.label} disabled={readOnly} onChange={(e) => set('table', { qtyLabel: e.target.value })} />
              <Input label="Unit price label" value={design.table.unitLabel} maxLength={LIMITS.label} disabled={readOnly} onChange={(e) => set('table', { unitLabel: e.target.value })} />
              <Input label="Amount label" value={design.table.amountLabel} maxLength={LIMITS.label} disabled={readOnly} onChange={(e) => set('table', { amountLabel: e.target.value })} />
            </div>
          </>
        )}
      </Group>

      {!isReport && (
        <Group title="Totals">
          <Toggle label="Show subtotal" checked={design.totals.showSubtotal} disabled={readOnly} onChange={(v) => set('totals', { showSubtotal: v })} />
          <Toggle label="Show discount (when there is one)" checked={design.totals.showDiscount} disabled={readOnly} onChange={(v) => set('totals', { showDiscount: v })} />
          <Toggle label="Show tax" checked={design.totals.showTax} disabled={readOnly} onChange={(v) => set('totals', { showTax: v })} />
          <Input label="Total label" value={design.totals.totalLabel} maxLength={LIMITS.label} disabled={readOnly} onChange={(e) => set('totals', { totalLabel: e.target.value })} helperText="For example Total, Amount due or Estimated total." />
        </Group>
      )}

      <Group title="Sections & order" defaultOpen>
        <ul className="space-y-2" aria-label="Document sections">
          {design.sections.map((s, i) => (
            <li key={s.id} className="flex items-center gap-2 rounded-xl border border-border bg-bg-primary p-2">
              <span className={`min-w-0 flex-1 truncate px-1 text-sm ${s.visible ? 'text-text-primary' : 'text-text-secondary line-through'}`}>{sectionLabel(s.id, docType)}</span>
              <button
                type="button"
                disabled={readOnly}
                onClick={() => onChange(setSectionVisible(design, s.id, !s.visible))}
                aria-label={`${s.visible ? 'Hide' : 'Show'} ${sectionLabel(s.id, docType)}`}
                aria-pressed={s.visible}
                className="focus-ring flex h-11 w-11 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
              >
                {s.visible ? <Eye size={16} aria-hidden="true" /> : <EyeOff size={16} aria-hidden="true" />}
              </button>
              <button
                type="button"
                disabled={readOnly || i === 0}
                onClick={() => onChange(moveSection(design, s.id, -1))}
                aria-label={`Move ${sectionLabel(s.id, docType)} up`}
                className="focus-ring flex h-11 w-11 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-30"
              >
                <ArrowUp size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                disabled={readOnly || i === design.sections.length - 1}
                onClick={() => onChange(moveSection(design, s.id, 1))}
                aria-label={`Move ${sectionLabel(s.id, docType)} down`}
                className="focus-ring flex h-11 w-11 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-30"
              >
                <ArrowDown size={16} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </Group>

      <Group title="Text & footer">
        {!isReport && (
          <Textarea
            label="Terms & conditions"
            value={design.terms}
            rows={5}
            maxLength={LIMITS.terms}
            disabled={readOnly}
            onChange={(e) => onChange({ ...design, terms: e.target.value })}
            helperText={`${design.terms.length}/${LIMITS.terms} characters. Review with your own advisor — this text is yours, not legal advice.`}
          />
        )}
        {docType === 'quote' && (
          <Input label="Signature label" value={design.signatureLabel} maxLength={LIMITS.signature} disabled={readOnly} onChange={(e) => onChange({ ...design, signatureLabel: e.target.value })} />
        )}
        <Textarea
          label="Footer text"
          value={design.footer.text}
          rows={3}
          maxLength={LIMITS.footer}
          disabled={readOnly}
          onChange={(e) => set('footer', { text: e.target.value })}
        />
        <Toggle label="Show page numbers" checked={design.footer.showPageNumbers} disabled={readOnly} onChange={(v) => set('footer', { showPageNumbers: v })} />
        <Toggle label="Show “Generated with Vireek”" checked={design.footer.showBranding} disabled={readOnly} onChange={(v) => set('footer', { showBranding: v })} />
      </Group>
    </div>
  );
}
