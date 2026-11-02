import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Check, Minus, Plus, RotateCcw, X } from 'lucide-react';

/* Contrast notes (measured from index.css tokens): text-text-primary ≥16.7:1; border-text-secondary ≥5.6:1 (WCAG 1.4.11 needs 3:1).
   Body copy deliberately avoids text-text-secondary (5.6/6.8:1 < AAA 7:1). */

export function Btn({ variant = 'secondary', className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' }) {
  const tone = variant === 'primary' ? 'border-text-primary bg-text-primary text-bg-primary' : 'border-text-secondary bg-bg-secondary text-text-primary';
  return (
    <button
      type="button"
      {...p}
      className={`focus-ring inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-2 rounded-xl border-2 px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${tone} ${className}`}
    />
  );
}

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-h`} className="rounded-2xl border-2 border-text-secondary bg-bg-secondary p-4">
      <h3 id={`${id}-h`} className="mb-2 break-words text-lg font-bold text-text-primary">{title}</h3>
      {children}
    </section>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'error'; children: ReactNode }) {
  return (
    <p role={tone === 'error' ? 'alert' : 'status'} className="mt-2 break-words rounded-xl border-2 border-text-secondary bg-bg-tertiary px-3 py-2 text-sm text-text-primary">
      {children}
    </p>
  );
}

export function ToggleRow(p: { id: string; label: string; desc: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="min-w-0 flex-1 pt-1.5">
        <p id={`${p.id}-l`} className="break-words text-base font-semibold text-text-primary">{p.label}</p>
        <p id={`${p.id}-d`} className="mt-0.5 break-words text-sm text-text-primary">{p.desc}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={p.checked}
        aria-labelledby={`${p.id}-l`}
        aria-describedby={`${p.id}-d`}
        onClick={() => p.onChange(!p.checked)}
        className="focus-ring flex h-11 min-w-[3.75rem] shrink-0 items-center justify-center rounded-full"
      >
        <span className={`flex h-8 w-14 items-center rounded-full border-2 px-0.5 ${p.checked ? 'justify-end border-accent bg-accent' : 'justify-start border-text-secondary bg-bg-tertiary'}`}>
          <span className={`flex h-6 w-6 items-center justify-center rounded-full ${p.checked ? 'bg-white text-accent' : 'bg-text-secondary text-bg-secondary'}`}>
            {p.checked ? <Check size={14} aria-hidden="true" /> : <X size={14} aria-hidden="true" />}
          </span>
        </span>
      </button>
    </div>
  );
}

export function SliderRow(p: {
  id: string; label: string; desc?: string; value: number; min: number; max: number; step: number;
  display: string; decLabel: string; incLabel: string; resetLabel: string; onChange: (v: number) => void; onReset?: () => void;
}) {
  const nudge = (d: number) => p.onChange(Math.min(p.max, Math.max(p.min, Math.round((p.value + d) / p.step) * p.step)));
  return (
    <div className="py-2">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={p.id} className="min-w-0 break-words text-base font-semibold text-text-primary">{p.label}</label>
        <output htmlFor={p.id} className="shrink-0 text-base font-bold text-text-primary">{p.display}</output>
      </div>
      {p.desc && <p id={`${p.id}-d`} className="mt-0.5 break-words text-sm text-text-primary">{p.desc}</p>}
      <div className="mt-1 flex items-center gap-1">
        <Btn aria-label={p.decLabel} onClick={() => nudge(-p.step)} className="!px-2"><Minus size={18} aria-hidden="true" /></Btn>
        <input
          id={p.id} type="range" min={p.min} max={p.max} step={p.step} value={p.value}
          aria-valuetext={p.display} aria-describedby={p.desc ? `${p.id}-d` : undefined}
          onChange={(e) => p.onChange(Number(e.target.value))}
          className="focus-ring h-11 min-w-0 flex-1 cursor-pointer accent-accent"
        />
        <Btn aria-label={p.incLabel} onClick={() => nudge(p.step)} className="!px-2"><Plus size={18} aria-hidden="true" /></Btn>
        {p.onReset && <Btn aria-label={p.resetLabel} onClick={p.onReset} className="!px-2"><RotateCcw size={18} aria-hidden="true" /></Btn>}
      </div>
    </div>
  );
}

export function SelectRow(p: { id: string; label: string; desc?: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div className="py-2">
      <label htmlFor={p.id} className="block break-words text-base font-semibold text-text-primary">{p.label}</label>
      {p.desc && <p id={`${p.id}-d`} className="mt-0.5 break-words text-sm text-text-primary">{p.desc}</p>}
      <select
        id={p.id} value={p.value} aria-describedby={p.desc ? `${p.id}-d` : undefined}
        onChange={(e) => p.onChange(e.target.value)}
        className="focus-ring mt-1.5 min-h-[44px] w-full rounded-xl border-2 border-text-secondary bg-bg-secondary px-3 py-2 text-base text-text-primary"
      >
        {p.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
