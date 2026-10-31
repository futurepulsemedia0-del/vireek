// src/hooks/useCopy.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { announce } from '@/lib/a11y/announcer';
import { writeClipboard } from '@/lib/clipboard';

export type CopyStatus = 'idle' | 'copied' | 'failed';

/**
 * Copy-to-clipboard with inline confirmation state (no toast) and a screen
 * reader announcement. Rapid repeated copies restart the reset timer instead of
 * stacking timers, so the "copied" state can never get stuck.
 */
export function useCopy({ resetMs = 2000 }: { resetMs?: number } = {}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CopyStatus>('idle');
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(
    async (text: string) => {
      const ok = await writeClipboard(text);
      setStatus(ok ? 'copied' : 'failed');
      announce(
        ok ? t('ui.copied', { defaultValue: 'Copied' }) : t('ui.copyFailed', { defaultValue: 'Copy failed' }),
        ok ? 'polite' : 'assertive',
      );
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setStatus('idle'), resetMs);
      return ok;
    },
    [resetMs, t],
  );

  return { status, copied: status === 'copied', failed: status === 'failed', copy };
}
