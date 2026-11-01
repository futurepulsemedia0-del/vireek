import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { parseMsg } from '@/lib/forms/errors';

/** Turns a schema message (key + params) into localized text. */
export function useTranslateMessage() {
  const { t } = useTranslation('forms');
  return useCallback(
    (raw: string | undefined): string | undefined => {
      if (!raw) return undefined;
      const { key, params } = parseMsg(raw);
      return t(key, { ...params, ns: 'forms' });
    },
    [t],
  );
}
