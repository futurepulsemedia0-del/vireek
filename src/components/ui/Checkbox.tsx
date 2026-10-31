// src/components/ui/Checkbox.tsx
import { InputHTMLAttributes, forwardRef, useEffect, useId, useImperativeHandle, useRef } from 'react';
import { disabledLook } from '@/lib/ui/interaction';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'id'> {
  label: string;
  helperText?: string;
  error?: string;
  indeterminate?: boolean;
  /** Shown inline when disabled, so the reason never depends on hover. */
  disabledReason?: string;
  id?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ label, helperText, error, indeterminate = false, disabledReason, disabled, id, className = '', ...props }, ref) => {
    const generated = useId();
    const fieldId = id ?? generated;
    const noteId = `${fieldId}-note`;
    const note = error ?? (disabled && disabledReason ? disabledReason : helperText);
    const inner = useRef<HTMLInputElement>(null);
    useImperativeHandle(ref, () => inner.current as HTMLInputElement);
    useEffect(() => {
      if (inner.current) inner.current.indeterminate = indeterminate;
    }, [indeterminate]);

    return (
      <div className={className}>
        <label htmlFor={fieldId} className={`inline-flex min-h-[24px] items-start gap-3 ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
          <input
            ref={inner}
            id={fieldId}
            type="checkbox"
            disabled={disabled}
            aria-invalid={!!error || undefined}
            aria-describedby={note ? noteId : undefined}
            className={`focus-ring mt-0.5 h-5 w-5 shrink-0 cursor-[inherit] rounded accent-accent ${disabledLook} ${error ? 'outline outline-2 outline-danger' : ''}`}
            {...props}
          />
          <span className="text-sm font-medium text-text-primary">{label}</span>
        </label>
        {note && (
          <p id={noteId} role={error ? 'alert' : undefined} className={`ms-8 mt-0.5 text-xs ${error ? 'text-danger' : 'text-text-secondary'}`}>
            {note}
          </p>
        )}
      </div>
    );
  },
);
Checkbox.displayName = 'Checkbox';
