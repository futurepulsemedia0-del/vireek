// src/components/ui/Select.tsx
//
// Native <select> (best a11y + mobile pickers) wearing the shared field recipe.
import { SelectHTMLAttributes, forwardRef, useId } from 'react';
import { ChevronDown } from 'lucide-react';
import { FieldFooter, FieldLabel, fieldBase, fieldBorder } from '@/components/ui/Input';

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label?: string;
  error?: string;
  helperText?: string;
  id?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, helperText, id, required, className = '', children, ...props }, ref) => {
    const generated = useId();
    const fieldId = id ?? generated;
    return (
      <div className="w-full">
        <FieldLabel label={label} id={fieldId} required={required} />
        <div className="relative">
          <select
            ref={ref}
            id={fieldId}
            required={required}
            aria-invalid={!!error}
            aria-describedby={error || helperText ? `${fieldId}-description` : undefined}
            className={`${fieldBase} ${fieldBorder(!!error)} appearance-none pe-10 ${className}`}
            {...props}
          >
            {children}
          </select>
          <ChevronDown size={16} aria-hidden="true" className="pointer-events-none absolute end-3.5 top-1/2 -translate-y-1/2 text-text-secondary" />
        </div>
        <FieldFooter error={error} helperText={helperText} id={fieldId} />
      </div>
    );
  },
);
Select.displayName = 'Select';
