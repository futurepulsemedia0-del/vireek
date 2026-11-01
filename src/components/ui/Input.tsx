import { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes, forwardRef, useId } from 'react';
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

export const fieldBase =
  'focus-ring w-full rounded-xl border bg-bg-primary px-4 py-3 text-base text-text-primary placeholder:text-text-secondary/60 transition-colors hover:border-accent/40 focus-visible:border-accent read-only:bg-bg-tertiary disabled:cursor-not-allowed disabled:opacity-50';

export const fieldBorder = (hasError: boolean) => (hasError ? 'border-danger focus-visible:border-danger' : 'border-border');

interface FieldChromeProps {
  label?: string;
  error?: string;
  helperText?: string;
  id: string;
  required?: boolean;
  /** Rendered beside the label (e.g. <WhyWeAsk>). */
  labelAction?: ReactNode;
  /** Extra element ids to append to aria-describedby. */
  describedBy?: string;
}

export function FieldLabel({
  label,
  id,
  required,
  action,
}: {
  label?: string;
  id: string;
  required?: boolean;
  action?: ReactNode;
}) {
  if (!label) return null;
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-text-primary">
        {label}
        {required && (
          <span aria-hidden="true" className="ms-0.5 text-danger">
            *
          </span>
        )}
      </label>
      {action}
    </div>
  );
}

export function FieldFooter({ error, helperText, id }: { error?: string; helperText?: string; id: string }) {
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

const joinIds = (...ids: Array<string | undefined>) => ids.filter(Boolean).join(' ') || undefined;

// ============================================================
// <Input />
// ============================================================

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>, Omit<FieldChromeProps, 'id'> {
  /** Optional leading icon — matches the search-input pattern already used
   *  on CallsPage/LeadsPage, now available without hand-copying the
   *  absolute-positioned icon markup. */
  icon?: LucideIcon;
  id?: string;
  /** Decorative unit/symbol at the end of the field ("%", "$"). */
  endAdornment?: ReactNode;
  /** Positioned under the input (e.g. a combobox listbox). */
  popup?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      error,
      helperText,
      icon: Icon,
      id,
      required,
      labelAction,
      describedBy: extraDescribedBy,
      endAdornment,
      popup,
      className = '',
      ...props
    },
    ref,
  ) => {
    const generatedId = useId();
    const fieldId = id ?? generatedId;
    const describedBy = joinIds(error || helperText ? `${fieldId}-description` : undefined, extraDescribedBy);

    return (
      <div className="w-full">
        <FieldLabel label={label} id={fieldId} required={required} action={labelAction} />
        <div className="relative">
          {Icon && (
            <Icon
              size={16}
              className="pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 text-text-secondary"
              aria-hidden="true"
            />
          )}
          <input
            ref={ref}
            id={fieldId}
            required={required}
            aria-required={required || undefined}
            aria-invalid={!!error}
            className={`${fieldBase} ${fieldBorder(!!error)} ${Icon ? 'ps-10' : ''} ${endAdornment ? 'pe-11' : ''} ${className}`}
            {...props}
            aria-describedby={joinIds(describedBy, props['aria-describedby'])}
          />
          {endAdornment && (
            <span className="pointer-events-none absolute end-3.5 top-1/2 -translate-y-1/2 text-sm text-text-secondary">
              {endAdornment}
            </span>
          )}
          {popup}
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

interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'>, Omit<FieldChromeProps, 'id'> {
  id?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, helperText, id, required, labelAction, describedBy: extraDescribedBy, className = '', rows = 4, ...props }, ref) => {
    const generatedId = useId();
    const fieldId = id ?? generatedId;
    const describedBy = joinIds(error || helperText ? `${fieldId}-description` : undefined, extraDescribedBy);

    return (
      <div className="w-full">
        <FieldLabel label={label} id={fieldId} required={required} action={labelAction} />
        <textarea
          ref={ref}
          id={fieldId}
          rows={rows}
          required={required}
          aria-required={required || undefined}
          aria-invalid={!!error}
          className={`${fieldBase} ${fieldBorder(!!error)} resize-y ${className}`}
          {...props}
          aria-describedby={joinIds(describedBy, props['aria-describedby'])}
        />
        <FieldFooter error={error} helperText={helperText} id={fieldId} />
      </div>
    );
  },
);
Textarea.displayName = 'Textarea';
