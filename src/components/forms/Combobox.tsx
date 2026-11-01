import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useController, useFormContext, type FieldValues, type Path } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/Input';
import { useDebouncedValue } from '@/hooks/forms/useDebouncedValue';
import { useRecentSelections } from '@/hooks/forms/useRecentSelections';
import { fieldDomId, useFormUi } from './FormUiContext';
import { useTranslateMessage } from './useTranslateMessage';

export interface ComboboxOption {
  value: string;
  label: string;
  description?: string;
}

export interface ComboboxProps<TIn extends FieldValues> {
  name: Path<TIn>;
  label: string;
  loadOptions: (query: string, signal: AbortSignal) => Promise<ComboboxOption[]>;
  helperText?: string;
  placeholder?: string;
  minChars?: number;
  debounceMs?: number;
  /** Enables "Recent" picks. Include the user id: `${userId}:customers`. */
  recentsKey?: string;
  /** Accept typed text that is not an option (value = the text). Default: an option must be picked. */
  allowFreeText?: boolean;
  required?: boolean;
  autoComplete?: string;
  labelAction?: ReactNode;
  onSelect?: (option: ComboboxOption) => void;
}

/** WAI-ARIA 1.2 combobox with async, debounced, abortable search. */
export function Combobox<TIn extends FieldValues>({
  name,
  label,
  loadOptions,
  helperText,
  placeholder,
  minChars = 2,
  debounceMs = 250,
  recentsKey,
  allowFreeText = false,
  required,
  autoComplete = 'off',
  labelAction,
  onSelect,
}: ComboboxProps<TIn>) {
  const { t } = useTranslation('forms');
  const ui = useFormUi();
  const translate = useTranslateMessage();
  const { control } = useFormContext<TIn>();
  const { field, fieldState } = useController({ name, control });
  const fallbackId = useId();
  const id = fieldDomId(ui?.formId, name, fallbackId);
  const listId = `${id}-listbox`;
  const optionId = (i: number) => `${id}-opt-${i}`;
  const registerLabel = ui?.registerLabel;
  useEffect(() => registerLabel?.(name, label), [registerLabel, name, label]);

  const stored = typeof field.value === 'string' ? field.value : '';
  const selected = useRef<string>(stored);
  const [text, setText] = useState(stored);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ComboboxOption[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [active, setActive] = useState(-1);
  const [attempt, setAttempt] = useState(0);
  const debounced = useDebouncedValue(text, debounceMs);
  const { recents, push } = useRecentSelections(recentsKey);
  const loadRef = useRef(loadOptions);
  useEffect(() => {
    loadRef.current = loadOptions;
  });

  useEffect(() => {
    if (stored !== selected.current) {
      selected.current = stored; // reset / draft restore
      setText(stored);
    }
  }, [stored]);

  const showRecents = text.trim() === '' && recents.length > 0;
  const items: ComboboxOption[] = showRecents ? recents : options;

  useEffect(() => {
    if (!open || showRecents) return;
    const q = debounced.trim();
    if (q.length < minChars) {
      setOptions([]);
      setStatus('idle');
      return;
    }
    const ac = new AbortController();
    setStatus('loading');
    loadRef
      .current(q, ac.signal)
      .then((found) => {
        if (ac.signal.aborted) return;
        setOptions(found);
        setActive(found.length > 0 ? 0 : -1);
        setStatus('idle');
      })
      .catch(() => {
        if (!ac.signal.aborted) setStatus('error');
      });
    return () => ac.abort();
  }, [debounced, open, showRecents, minChars, attempt]);

  useEffect(() => {
    if (open && active >= 0) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, open]);

  const choose = (o: ComboboxOption) => {
    selected.current = o.value;
    field.onChange(o.value);
    setText(o.label);
    setOpen(false);
    push(o);
    onSelect?.(o);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        if (items.length === 0) return;
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((i) => (i + step + items.length) % items.length);
        return;
      }
      case 'Enter': {
        const picked = open && active >= 0 ? items[active] : undefined;
        if (picked) {
          e.preventDefault(); // select instead of submitting the form
          choose(picked);
        }
        return;
      }
      case 'Escape':
        if (open) {
          e.preventDefault(); // consumed: <Form> must not treat this Esc as "cancel"
          e.stopPropagation();
          setOpen(false);
        }
        return;
      case 'Tab':
        setOpen(false);
        return;
      default:
    }
  };

  const message =
    status === 'loading' ? t('forms.combobox.loading', { ns: 'forms' }) : status === 'error' ? t('forms.combobox.error', { ns: 'forms' }) : items.length === 0 && debounced.trim().length >= minChars && !showRecents ? t('forms.combobox.empty', { ns: 'forms' }) : t('forms.combobox.results', { ns: 'forms', count: items.length });

  const expanded = open && (items.length > 0 || status !== 'idle' || debounced.trim().length >= minChars);

  const popup = expanded ? (
    <div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-xl border border-border bg-bg-secondary shadow-card-hover dark:shadow-card-hover-dark">
      {showRecents && <p className="px-4 pb-1 pt-2 text-xs font-medium text-text-secondary">{t('forms.combobox.recent', { ns: 'forms' })}</p>}
      <ul id={listId} role="listbox" aria-label={label} className="max-h-60 overflow-auto py-1" onMouseDown={(e) => e.preventDefault()}>
        {items.map((o, i) => (
          <li
            key={o.value}
            id={optionId(i)}
            role="option"
            aria-selected={i === active}
            onMouseMove={() => setActive(i)}
            onClick={() => choose(o)}
            className={`cursor-pointer px-4 py-2 text-sm text-text-primary ${i === active ? 'bg-bg-tertiary' : ''}`}
          >
            <span className="block">{o.label}</span>
            {o.description && <span className="block text-xs text-text-secondary">{o.description}</span>}
          </li>
        ))}
      </ul>
      {(status !== 'idle' || (items.length === 0 && !showRecents)) && (
        <div className="flex items-center justify-between gap-2 px-4 py-2 text-xs text-text-secondary">
          <span>{status === 'loading' ? t('forms.combobox.loading', { ns: 'forms' }) : status === 'error' ? t('forms.combobox.error', { ns: 'forms' }) : t('forms.combobox.empty', { ns: 'forms' })}</span>
          {status === 'error' && (
            <button type="button" className="focus-ring rounded-md px-1 font-semibold underline" onMouseDown={(e) => e.preventDefault()} onClick={() => setAttempt((n) => n + 1)}>
              {t('forms.combobox.retry', { ns: 'forms' })}
            </button>
          )}
        </div>
      )}
    </div>
  ) : null;

  return (
    <>
      <Input
        id={id}
        ref={field.ref}
        name={field.name}
        label={label}
        labelAction={labelAction}
        helperText={helperText}
        required={required}
        placeholder={placeholder}
        autoComplete={autoComplete}
        error={translate(fieldState.error?.message)}
        value={text}
        role="combobox"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          selected.current = allowFreeText ? e.target.value : '';
          field.onChange(allowFreeText ? e.target.value : ''); // typing invalidates a previous pick
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          field.onBlur();
        }}
        onKeyDown={onKeyDown}
        popup={popup}
      />
      <span role="status" aria-live="polite" className="sr-only">
        {open ? message : ''}
      </span>
    </>
  );
}
