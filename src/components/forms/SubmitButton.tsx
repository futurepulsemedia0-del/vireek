import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useFormUi } from './FormUiContext';

type Props = Omit<ComponentProps<typeof Button>, 'type'> & { loadingLabel?: string };

/** Submit button that is disabled + busy while the surrounding <Form> has a submit in flight. */
export function SubmitButton({ children, loadingLabel, disabled, ...rest }: Props) {
  const { t } = useTranslation('forms');
  const submitting = useFormUi()?.submitting ?? false;
  return (
    <Button {...rest} type="submit" disabled={disabled || submitting} aria-busy={submitting}>
      {submitting && <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden="true" />}
      {submitting ? (loadingLabel ?? t('forms.submit.saving', { ns: 'forms' })) : children}
    </Button>
  );
}
