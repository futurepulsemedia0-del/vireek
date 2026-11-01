import { useEffect, useState } from 'react';
import { useTrustT } from '@/hooks/useTrustT';
import { Check, Copy, Mail, RefreshCw, TriangleAlert } from 'lucide-react';
import { buildSupportMailto, safeUrl } from '@/lib/incident';
import type { AppError } from '@/lib/trust/appError';

interface Props {
  error: AppError;
  /** Retry / wait-then-retry. */
  onRetry?: () => void;
  onSignIn?: () => void;
  onRefresh?: () => void;
  /** Move focus to the first invalid field. */
  onFixFields?: () => void;
  variant?: 'inline' | 'page';
  className?: string;
}

/**
 * One component for every failure the user can see (component, page and
 * toast-follow-up level). It only ever renders the localized message for
 * `error.kind` plus the support reference — never raw server text.
 */
export function ErrorPanel({ error, onRetry, onSignIn, onRefresh, onFixFields, variant = 'inline', className = '' }: Props) {
  const { t } = useTrustT();
  const [copied, setCopied] = useState(false);
  const [waitLeft, setWaitLeft] = useState(error.recovery === 'wait' ? Math.ceil((error.retryAfterMs ?? 0) / 1000) : 0);

  useEffect(() => {
    if (waitLeft <= 0) return;
    const id = window.setTimeout(() => setWaitLeft((n) => n - 1), 1000);
    return () => window.clearTimeout(id);
  }, [waitLeft]);

  const mailto = buildSupportMailto({
    incidentId: error.referenceId,
    url: typeof window === 'undefined' ? '' : safeUrl(window.location.href),
    time: new Date().toISOString(),
    message: error.kind,
  });

  const copyRef = async () => {
    try {
      await navigator.clipboard.writeText(error.referenceId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable: the ID is still visible and selectable */
    }
  };

  const primary = (() => {
    switch (error.recovery) {
      case 'retry':
        return onRetry ? { label: t('recovery.retry'), run: onRetry, disabled: false } : null;
      case 'wait':
        return onRetry ? { label: t('recovery.wait', { seconds: Math.max(waitLeft, 0) }), run: onRetry, disabled: waitLeft > 0 } : null;
      case 'sign_in':
        return { label: t('recovery.sign_in'), run: onSignIn ?? (() => window.location.assign('/login')), disabled: false };
      case 'refresh':
        return onRefresh ? { label: t('recovery.refresh'), run: onRefresh, disabled: false } : null;
      case 'fix_field':
        return onFixFields ? { label: t('recovery.fix_field'), run: onFixFields, disabled: false } : null;
      default:
        return null;
    }
  })();

  const pad = variant === 'page' ? 'px-6 py-16' : 'px-5 py-8';

  return (
    <div
      role="alert"
      className={`flex flex-col items-center justify-center rounded-2xl border border-danger/30 bg-danger/5 text-center ${pad} ${className}`}
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-danger/10 text-danger" aria-hidden="true">
        <TriangleAlert size={24} />
      </span>
      <h2 className="mt-4 text-base font-semibold text-text-primary">{t(`${error.messageKey.replace('trust.', '')}.title`)}</h2>
      <p className="mt-1.5 max-w-md text-sm leading-relaxed text-text-secondary">{t(`${error.messageKey.replace('trust.', '')}.body`)}</p>

      {error.fieldErrors && (
        <ul className="mt-3 max-w-md space-y-1 text-start text-sm text-danger">
          {Object.entries(error.fieldErrors).map(([field, msg]) => (
            <li key={field}>{msg}</li>
          ))}
        </ul>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        {primary && (
          <button
            type="button"
            onClick={primary.run}
            disabled={primary.disabled}
            className="focus-ring inline-flex items-center gap-2 rounded-xl bg-cta px-4 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw size={15} aria-hidden="true" />
            {primary.label}
          </button>
        )}
        <a
          href={mailto}
          className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
        >
          <Mail size={15} aria-hidden="true" />
          {t('recovery.contact_support')}
        </a>
      </div>

      <div className="mt-4 flex items-center gap-2 text-xs text-text-secondary">
        <span>{t('reference.label')}:</span>
        <code dir="ltr" className="select-all rounded-md bg-bg-tertiary px-2 py-0.5 font-mono text-text-primary">
          {error.referenceId}
        </code>
        <button
          type="button"
          onClick={copyRef}
          aria-label={t('reference.copy')}
          className="focus-ring rounded-md p-1 text-text-secondary hover:text-text-primary"
        >
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        </button>
        <span role="status" aria-live="polite" className="sr-only">
          {copied ? t('reference.copied') : ''}
        </span>
      </div>
    </div>
  );
}
