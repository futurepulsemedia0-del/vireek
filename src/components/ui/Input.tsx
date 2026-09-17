import { InputHTMLAttributes, TextareaHTMLAttributes, forwardRef, useId } from 'react';
import type { LucideIcon } from 'lucide-react';

// ============================================================
// Shared form-field styling recipe
// ============================================================
//
// This is the single source of truth for what a text field looks like
// anywhere in Vireek. Before this component existed, 9 different pages
// (OnboardingPage, QuotesPage, ContactPage, MembershipsPage,
// PriceBookPage, BetaProgramPage, EnterprisePage, InsuranceClaimsPage,
// PodcastPage) each defined their own local `inputClass` constant, and
// they had already drifted from each other — some included
// `focus-visible:border-accent`, some didn't; padding/text size varied
// between `px-4 py-3 text-base` and `px-4 py-2.5 text-sm`. That meant the
// same visual element (a text input) gave different focus feedback
// depending on which page you were on. Importing <Input> here everywhere
// makes that drift structurally impossible going forward — see
// scripts/check-design-system.mjs, which fails CI if a new local
// `inputClass` constant reappears anywhere outside this file.

const fieldBase =
  'focus-ring w-full rounded-xl border bg-bg-primary px-4 py-3 text-base text-text-primary placeholder:text-text-secondary/60 transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';

const fieldBorder = (hasError: boolean) => (hasError ? 'border-danger focus-visible:border-danger' : 'border-border');

interface FieldChromeProps {
  label?: string;
  error?: string;
  helperText?: string;
  id: string;
  required?: boolean;
}

function FieldLabel({ label, id, required }: { label?: string; id: string; required?: boolean }) {
  if (!label) return null;
  return (
    <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">
      {label}
      {required && <span className="ml-0.5 text-danger">*</span>}
    </label>
  );
}

function FieldFooter({ error, helperText, id }: { error?: string; helperText?: string; id: string }) {
  if (!error && !helperText) return null;
  return (
    <p
      id={`${id}-description`}
      className={`mt-1.5 text-xs ${error ? 'text-danger' : 'text-text-secondary'}`}
      role={error ? 'alert' : undefined}
    >
      {error || helperText}
    </p>
  );
}

// ============================================================
// <Input />
// ============================================================

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>, FieldChromeProps {
  /** Optional leading icon — matches the search-input pattern already used
   *  on CallsPage/LeadsPage, now available without hand-copying the
   *  absolute-positioned icon markup. */
  icon?: LucideIcon;
  id?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, helperText, icon: Icon, id, required, className = '', ...props }, ref) => {
    const generatedId = useId();
    const fieldId = id ?? generatedId;
    const describedBy = error || helperText ? `${fieldId}-description` : undefined;

    return (
      <div className="w-full">
        <FieldLabel label={label} id={fieldId} required={required} />
        <div className="relative">
          {Icon && (
            <Icon
              size={16}
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-text-secondary"
              aria-hidden="true"
            />
          )}
          <input
            ref={ref}
            id={fieldId}
            required={required}
            aria-invalid={!!error}
            aria-describedby={describedBy}
            className={`${fieldBase} ${fieldBorder(!!error)} ${Icon ? 'pl-10' : ''} ${className}`}
            {...props}
          />
        </div>
        <FieldFooter error={error} helperText={helperText} id={fieldId} />
      </div>
    );
  },
);
Input.displayName = 'Input';

// ============================================================
// <Textarea /> — same recipe, no icon slot (never needed one so far)
// ============================================================

interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'>, FieldChromeProps {
  id?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, helperText, id, required, className = '', rows = 4, ...props }, ref) => {
    const generatedId = useId();
    const fieldId = id ?? generatedId;
    const describedBy = error || helperText ? `${fieldId}-description` : undefined;

    return (
      <div className="w-full">
        <FieldLabel label={label} id={fieldId} required={required} />
        <textarea
          ref={ref}
          id={fieldId}
          rows={rows}
          required={required}
          aria-invalid={!!error}
          aria-describedby={describedBy}
          className={`${fieldBase} ${fieldBorder(!!error)} resize-y ${className}`}
          {...props}
        />
        <FieldFooter error={error} helperText={helperText} id={fieldId} />
      </div>
    );
  },
);
Textarea.displayName = 'Textarea';
