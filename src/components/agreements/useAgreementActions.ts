import { useCallback, useState } from 'react';
import { useToast } from '@/contexts/ToastContext';
import type { WriteResult } from '@/lib/serviceAgreement';

/**
 * Runs one agreement write at a time: shows the friendly error on failure, otherwise reloads the
 * 360° data and confirms. Returns true on success so a form knows whether to close.
 */
export function useAgreementActions(reload: () => Promise<void>) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (write: () => Promise<WriteResult>, successMessage: string): Promise<boolean> => {
      setBusy(true);
      try {
        const { error } = await write();
        if (error) {
          toast(error, 'error');
          return false;
        }
        await reload();
        toast(successMessage, 'success');
        return true;
      } finally {
        setBusy(false);
      }
    },
    [reload, toast]
  );

  return { busy, run };
}
