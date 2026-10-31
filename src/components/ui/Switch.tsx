// src/components/ui/Switch.tsx
import { useId } from 'react';
import { MiniLoader } from '@/components/ui/MiniLoader';
import { disabledLook, motionClass, pressable } from '@/lib/ui/interaction';

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  /** Shown inline (visible to everyone, no hover needed) when disabled. */
  disabledReason?: string;
  /** Saving the change: blocks re-entry, keeps focus. */
  loading?: boolean;
  id?: string;
}

export function Switch({ checked, onChange, label, hint, disabled = false, disabledReason, loading = false, id }: SwitchProps) {
  const generated = useId();
  const switchId = id ?? generated;
  const labelId = `${switchId}-label`;
  const noteId = `${switchId}-note`;
  const note = disabled && disabledReason ? disabledReason : hint;
  const blocked = disabled || loading;

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <span id={labelId} className="block text-sm font-medium text-text-primary">
          {label}
        </span>
        {note && (
          <span id={noteId} className="mt-0.5 block text-xs text-text-secondary">
            {note}
          </span>
        )}
      </div>
      <button
        type="button"
        id={switchId}
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={note ? noteId : undefined}
        aria-disabled={blocked || undefined}
        aria-busy={loading || undefined}
        data-selected={checked || undefined}
        onClick={() => {
          if (!blocked) onChange(!checked);
        }}
        className={`focus-ring relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border-2 ${motionClass} ${pressable} ${disabledLook} ${
          checked ? 'border-accent bg-accent' : 'border-text-secondary bg-bg-primary'
        }`}
      >
        <span
          className={`pointer-events-none flex h-5 w-5 items-center justify-center rounded-full shadow-sm ${motionClass} ${
            checked ? 'translate-x-6 bg-bg-primary text-accent rtl:-translate-x-6' : 'translate-x-0.5 bg-text-secondary text-bg-primary rtl:-translate-x-0.5'
          }`}
        >
          {loading && <MiniLoader size={12} />}
        </span>
      </button>
    </div>
  );
}
