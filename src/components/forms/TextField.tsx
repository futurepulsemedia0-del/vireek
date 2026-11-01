import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CompositionEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { useController, useFormContext, type FieldValues, type Path } from 'react-hook-form';
import { Input, Textarea } from '@/components/ui/Input';
import { computeNext, type DeleteDirection, type Mask } from '@/lib/forms/masks';
import { fieldDomId, useFormUi } from './FormUiContext';
import { useTranslateMessage } from './useTranslateMessage';

/** Valid HTML autocomplete tokens used by Vireek forms (WCAG 1.3.5). */
export type AutoComplete =
  | 'off'
  | 'name'
  | 'given-name'
  | 'family-name'
  | 'email'
  | 'tel'
  | 'tel-national'
  | 'organization'
  | 'street-address'
  | 'address-line1'
  | 'address-line2'
  | 'address-level1'
  | 'address-level2'
  | 'postal-code'
  | 'country'
  | 'one-time-code'
  | 'new-password'
  | 'current-password'
  | 'bday';

type NativeInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'name' | 'value' | 'defaultValue' | 'onChange' | 'onBlur' | 'id' | 'size' | 'autoComplete' | 'maxLength'
>;

export interface TextFieldProps<TIn extends FieldValues> extends NativeInputProps {
  name: Path<TIn>;
  label: string;
  helperText?: string;
  autoComplete?: AutoComplete;
  /** Input mask. Form state stores mask.value (canonical); the input shows mask.display. */
  mask?: Mask;
  /** Clipboard sanitizer (see lib/forms/paste). Falls back to mask.normalizePaste. */
  sanitizePaste?: (text: string) => string;
  /** Rendered beside the label, e.g. <WhyWeAsk>. */
  labelAction?: ReactNode;
  /** Unit or symbol at the end of the field ("%", "$"). Decorative: put units in the label too. */
  endAdornment?: ReactNode;
}

export function TextField<TIn extends FieldValues>({
  name,
  label,
  helperText,
  mask,
  sanitizePaste,
  labelAction,
  endAdornment,
  placeholder,
  ...rest
}: TextFieldProps<TIn>) {
  const ui = useFormUi();
  const translate = useTranslateMessage();
  const { control } = useFormContext<TIn>();
  const { field, fieldState } = useController({ name, control });
  const fallbackId = useId();
  const id = fieldDomId(ui?.formId, name, fallbackId);
  const registerLabel = ui?.registerLabel;
  useEffect(() => registerLabel?.(name, label), [registerLabel, name, label]);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const stored = typeof field.value === 'string' ? field.value : field.value == null ? '' : String(field.value);
  const emitted = useRef<string | null>(null);
  const [display, setDisplay] = useState(() => (mask ? mask.fromValue(stored) : stored));
  const [, force] = useState(0);
  const caret = useRef<number | null>(null);
  const composing = useRef(false);

  // Re-sync when the value changed from outside (reset, draft restore, setValue).
  useEffect(() => {
    if (!mask || emitted.current === stored) return;
    emitted.current = stored;
    setDisplay(mask.fromValue(stored));
  }, [stored, mask]);

  // Put the caret back after React re-renders the formatted value.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (caret.current !== null && el && document.activeElement === el) el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });

  const apply = (rawInput: string, caretPos: number, deleting: DeleteDirection) => {
    if (!mask) {
      field.onChange(rawInput);
      return;
    }
    const next = computeNext(mask, { prevDisplay: display, rawInput, caret: caretPos, deleting });
    caret.current = next.caret;
    emitted.current = next.value;
    setDisplay(next.display);
    if (next.display === display) force((n) => n + 1); // rejected keystroke: still restore caret
    field.onChange(next.value);
  };

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (!mask) {
      field.onChange(e.target.value);
      return;
    }
    if (composing.current) {
      setDisplay(e.target.value); // IME: format only when composition ends
      return;
    }
    const type = (e.nativeEvent as InputEvent).inputType;
    const deleting: DeleteDirection = type === 'deleteContentBackward' ? 'backward' : type === 'deleteContentForward' ? 'forward' : false;
    apply(e.target.value, e.target.selectionStart ?? e.target.value.length, deleting);
  };

  const onCompositionEnd = (e: CompositionEvent<HTMLInputElement>) => {
    composing.current = false;
    apply(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length, false);
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const transform = sanitizePaste ?? mask?.normalizePaste;
    if (!transform) return;
    e.preventDefault();
    const el = e.currentTarget;
    const text = transform(e.clipboardData.getData('text'));
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    apply(el.value.slice(0, start) + text + el.value.slice(end), start + text.length, false);
  };

  const onBlur = () => {
    if (mask?.finalize) {
      const done = mask.finalize(display);
      if (done.display !== display) {
        setDisplay(done.display);
        emitted.current = done.value;
        field.onChange(done.value);
      }
    }
    field.onBlur();
  };

  const error = translate(fieldState.error?.message);
  const numeric = mask && mask.inputMode !== 'text';

  return (
    <Input
      {...rest}
      id={id}
      ref={(el) => {
        inputRef.current = el;
        field.ref(el);
      }}
      name={field.name}
      label={label}
      labelAction={labelAction}
      endAdornment={endAdornment}
      helperText={helperText}
      error={error}
      value={mask ? display : stored}
      onChange={onChange}
      onBlur={onBlur}
      onPaste={onPaste}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={onCompositionEnd}
      placeholder={placeholder ?? mask?.example}
      inputMode={rest.inputMode ?? mask?.inputMode}
      dir={numeric ? 'ltr' : rest.dir}
      enterKeyHint={rest.enterKeyHint ?? 'next'}
    />
  );
}

/* ------------------------------------------------------------------ */

export interface TextAreaFieldProps<TIn extends FieldValues> {
  name: Path<TIn>;
  label: string;
  helperText?: string;
  placeholder?: string;
  rows?: number;
  required?: boolean;
  disabled?: boolean;
  labelAction?: ReactNode;
}

/** Multi-line field. Enter inserts a newline; Ctrl/Cmd+Enter submits (handled by <Form>). */
export function TextAreaField<TIn extends FieldValues>({ name, label, labelAction, ...rest }: TextAreaFieldProps<TIn>) {
  const ui = useFormUi();
  const translate = useTranslateMessage();
  const { control } = useFormContext<TIn>();
  const { field, fieldState } = useController({ name, control });
  const fallbackId = useId();
  const registerLabel = ui?.registerLabel;
  useEffect(() => registerLabel?.(name, label), [registerLabel, name, label]);
  return (
    <Textarea
      {...rest}
      id={fieldDomId(ui?.formId, name, fallbackId)}
      ref={field.ref}
      name={field.name}
      label={label}
      labelAction={labelAction}
      value={typeof field.value === 'string' ? field.value : ''}
      onChange={field.onChange}
      onBlur={field.onBlur}
      error={translate(fieldState.error?.message)}
    />
  );
}
