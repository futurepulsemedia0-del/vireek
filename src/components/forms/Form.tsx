import { useCallback, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { FormProvider, useForm, type FieldErrors, type Path, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import type { FieldValues } from 'react-hook-form';
import { useAuth } from '@/contexts/AuthContext';
import { useFormDraft } from '@/hooks/forms/useFormDraft';
import { useSubmitGuard } from '@/hooks/forms/useSubmitGuard';
import { useUnsavedChanges } from '@/hooks/forms/useUnsavedChanges';
import { FormSubmitError, flattenFieldErrors, formErrorMap } from '@/lib/forms/errors';
import type { SubmitContext } from '@/lib/forms/submitGuard';
import { DraftRestoreBanner } from './DraftRestoreBanner';
import { FormUiContext, type FormUi } from './FormUiContext';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';
import { useTranslateMessage } from './useTranslateMessage';

export type FormSchema = z.ZodType<FieldValues, z.ZodTypeDef, FieldValues>;

export interface FormProps<S extends FormSchema> {
  /** Stable id: DOM ids, draft key. Unique per form. */
  formId: string;
  schema: S;
  defaultValues: z.input<S>;
  /** Receives validated + transformed values and an idempotency key. Throw FormSubmitError to map server errors onto fields. */
  onSubmit: (values: z.output<S>, ctx: SubmitContext) => Promise<unknown>;
  onSuccess?: (result: unknown, values: z.output<S>) => void;
  /** Called on Esc (after the unsaved-changes check). */
  onCancel?: () => void;
  /** Draft persistence. Omit or pass false to turn it off. */
  draft?: { version: number; exclude?: readonly string[]; allowAnonymous?: boolean } | false;
  /** Warn before losing edits. Default true. */
  unsavedGuard?: boolean;
  /** Show the error summary banner when at least this many fields are invalid. Default 3. */
  summaryThreshold?: number;
  className?: string;
  children: ReactNode | ((form: UseFormReturn<z.input<S>, unknown, z.output<S>>) => ReactNode);
}

export function Form<S extends FormSchema>({
  formId,
  schema,
  defaultValues,
  onSubmit,
  onSuccess,
  onCancel,
  draft: draftOptions = false,
  unsavedGuard = true,
  summaryThreshold = 3,
  className,
  children,
}: FormProps<S>) {
  type TIn = z.input<S>;
  type TOut = z.output<S>;
  const { t } = useTranslation('forms');
  const translate = useTranslateMessage();
  const { user } = useAuth();
  const formRef = useRef<HTMLFormElement | null>(null);
  const labels = useRef(new Map<string, string>());
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<TIn, unknown, TOut>({
    resolver: zodResolver(schema, { errorMap: formErrorMap }),
    defaultValues,
    mode: 'onTouched', // validate on first blur, then live on every change
    reValidateMode: 'onChange',
    shouldFocusError: false, // we focus the first invalid field in DOM order ourselves
  });

  const draftApi = useFormDraft(form, {
    userId: user?.id ?? null,
    formId,
    version: draftOptions ? draftOptions.version : 0,
    exclude: draftOptions ? draftOptions.exclude : undefined,
    allowAnonymous: draftOptions ? draftOptions.allowAnonymous : false,
    enabled: draftOptions !== false,
  });

  const guard = useSubmitGuard(async (values: TOut, ctx: SubmitContext) => onSubmit(values, ctx));
  const markSavedRef = useRef<() => void>(() => undefined);

  const focusFirstInvalid = useCallback(() => {
    requestAnimationFrame(() => {
      const el = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
      el?.focus();
    });
  }, []);

  const submitValues = useCallback(
    async (values: TOut): Promise<boolean> => {
      setFormError(null);
      const out = await guard.run(values);
      if (out.status === 'ignored') return false;
      if (out.status === 'success') {
        draftApi.clear();
        markSavedRef.current();
        form.reset(form.getValues());
        onSuccess?.(out.value, values);
        return true;
      }
      if (out.error instanceof FormSubmitError) {
        for (const [name, message] of Object.entries(out.error.fieldErrors)) {
          form.setError(name as Path<TIn>, { type: 'server', message });
        }
        setFormError(out.error.messageKey);
        focusFirstInvalid();
      } else {
        setFormError(out.offline ? 'forms.submit.offline' : 'forms.submit.failed');
      }
      return false;
    },
    [guard, draftApi, form, onSuccess, focusFirstInvalid],
  );

  const onInvalid = useCallback(
    (_errors: FieldErrors<TIn>) => {
      focusFirstInvalid();
    },
    [focusFirstInvalid],
  );

  const saveFromDialog = useCallback(async (): Promise<boolean> => {
    let ok = false;
    await form.handleSubmit(async (values) => {
      ok = await submitValues(values);
    }, onInvalid)();
    return ok;
  }, [form, submitValues, onInvalid]);

  const unsaved = useUnsavedChanges({
    when: unsavedGuard && form.formState.isDirty,
    onSave: saveFromDialog,
  });
  markSavedRef.current = unsaved.markSaved;

  const handleSubmit = form.handleSubmit(async (values) => {
    await submitValues(values);
  }, onInvalid);

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Escape' && !e.defaultPrevented && onCancel) {
      e.preventDefault();
      unsaved.guardClose(onCancel)();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target instanceof HTMLTextAreaElement) {
      e.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  const ui = useMemo<FormUi>(
    () => ({
      formId,
      submitting: guard.submitting,
      registerLabel: (name, label) => void labels.current.set(name, label),
      getLabel: (name) => labels.current.get(name),
    }),
    [formId, guard.submitting],
  );

  const errorList = flattenFieldErrors(form.formState.errors);
  const showSummary = form.formState.submitCount > 0 && errorList.length >= summaryThreshold;

  return (
    <FormProvider {...form}>
      <FormUiContext.Provider value={ui}>
        <form
          id={formId}
          ref={formRef}
          noValidate
          aria-busy={guard.submitting}
          className={className}
          onSubmit={(e: FormEvent<HTMLFormElement>) => void handleSubmit(e)}
          onKeyDown={onKeyDown}
        >
          {draftApi.draft && <DraftRestoreBanner savedAt={draftApi.draft.savedAt} onRestore={draftApi.restore} onDiscard={draftApi.discard} />}
          {showSummary && (
            <div role="alert" className="mb-4 rounded-xl border border-danger/40 bg-danger/5 p-4 text-sm text-text-primary">
              <p className="font-semibold">{t('forms.summary.title', { ns: 'forms', count: errorList.length })}</p>
              <ul className="mt-2 list-disc space-y-1 ps-5">
                {errorList.map((e) => (
                  <li key={e.name}>
                    <a
                      href={`#${formId}-${e.name.replace(/[^A-Za-z0-9_-]/g, '-')}`}
                      className="focus-ring rounded-sm underline"
                      onClick={(ev) => {
                        ev.preventDefault();
                        document.getElementById(`${formId}-${e.name.replace(/[^A-Za-z0-9_-]/g, '-')}`)?.focus();
                      }}
                    >
                      {labels.current.get(e.name) ?? e.name}
                    </a>
                    {': '}
                    {translate(e.message)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {formError && (
            <div role="alert" className="mb-4 rounded-xl border border-danger/40 bg-danger/5 p-4 text-sm text-text-primary">
              {t(formError, { ns: 'forms' })}
            </div>
          )}
          {typeof children === 'function' ? children(form) : children}
        </form>
        <UnsavedChangesDialog
          {...unsaved.dialog}
          onDiscard={() => {
            draftApi.discard();
            unsaved.dialog.onDiscard();
          }}
        />
      </FormUiContext.Provider>
    </FormProvider>
  );
}
