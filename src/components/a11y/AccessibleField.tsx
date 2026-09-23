// src/components/a11y/AccessibleField.tsx
//
// label/input/error که درست به هم وصل شدن: <label htmlFor> که واقعاً به
// id همون input اشاره می‌کنه، hint و error هردو با aria-describedby لینک
// شدن، و aria-invalid هروقت خطا هست ست می‌شه — پس screen reader دقیقاً
// همونی که کاربر بینا می‌بینه (لیبل، راهنما، خطا) رو اعلام می‌کنه، نه
// این‌که کاربر رو با یک border قرمز بی‌معنی تنها بذاره (WCAG 3.3.1, 3.3.2, 4.1.2).
import { useId, type ReactNode } from 'react';

interface AccessibleFieldProps {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: (fieldProps: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': boolean;
    'aria-required': boolean;
  }) => ReactNode;
}

export function AccessibleField({ label, hint, error, required = false, children }: AccessibleFieldProps) {
  const inputId = useId();
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div>
      <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-text-primary">
        {label}
        {required && (
          <span aria-hidden="true" className="ml-0.5 text-danger">
            *
          </span>
        )}
      </label>
      {children({ id: inputId, 'aria-describedby': describedBy, 'aria-invalid': Boolean(error), 'aria-required': required })}
      {hint && !error && (
        <p id={hintId} className="mt-1.5 text-xs text-text-secondary">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="mt-1.5 text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
