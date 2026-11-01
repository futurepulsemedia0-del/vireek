import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import { useSecurityT } from '@/i18n/securityNamespace';
import { loadStepUpOptions, sendEmailCode, verifyEmailCode, verifyWithPassword, verifyWithTotp, type StepUpOptions } from '@/lib/stepUp';
import { isReauthRequiredError, StepUpCancelledError, type StepUpMethod } from '@/lib/stepUpCore';

interface StepUpContextValue {
  /** Runs `action`; if the server answers REAUTH_REQUIRED, asks the user to confirm it's them and retries once. */
  withStepUp: <T>(action: () => Promise<T>) => Promise<T>;
}

const StepUpContext = createContext<StepUpContextValue | null>(null);

export function useStepUp(): StepUpContextValue {
  const ctx = useContext(StepUpContext);
  if (!ctx) throw new Error('useStepUp must be used inside <StepUpProvider>');
  return ctx;
}

interface Pending {
  resolve: () => void;
  reject: (e: unknown) => void;
}

export function StepUpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pending = useRef<Pending | null>(null);

  const prompt = useCallback(
    () =>
      new Promise<void>((resolve, reject) => {
        pending.current?.reject(new StepUpCancelledError());
        pending.current = { resolve, reject };
        setOpen(true);
      }),
    [],
  );

  const withStepUp = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch (e) {
        if (!isReauthRequiredError(e)) throw e;
      }
      await prompt();
      return action();
    },
    [prompt],
  );

  const finish = (ok: boolean) => {
    const p = pending.current;
    pending.current = null;
    setOpen(false);
    if (ok) p?.resolve();
    else p?.reject(new StepUpCancelledError());
  };

  const value = useMemo(() => ({ withStepUp }), [withStepUp]);
  return (
    <StepUpContext.Provider value={value}>
      {children}
      <StepUpDialog open={open} onDone={() => finish(true)} onCancel={() => finish(false)} />
    </StepUpContext.Provider>
  );
}

function StepUpDialog({ open, onDone, onCancel }: { open: boolean; onDone: () => void; onCancel: () => void }) {
  const { t } = useSecurityT();
  const ref = useFocusTrap(open);
  useEscapeToClose(open, onCancel);
  const [opts, setOpts] = useState<StepUpOptions | null>(null);
  const [method, setMethod] = useState<StepUpMethod | null>(null);
  const [secret, setSecret] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSecret('');
    setError(null);
    setCodeSent(false);
    setOpts(null);
    void loadStepUpOptions().then((o) => {
      if (cancelled) return;
      setOpts(o);
      setMethod(o.methods[0] ?? null);
      if (o.methods.length === 0) setError(t('stepUp.errors.noMethod'));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!opts || !method || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (method === 'password') {
        if (!opts.email) throw new Error('no email');
        await verifyWithPassword(opts.email, secret);
      } else if (method === 'totp') {
        await verifyWithTotp(secret);
      } else if (!codeSent) {
        if (!opts.email) throw new Error('no email');
        await sendEmailCode(opts.email);
        setCodeSent(true);
        setSecret('');
        return;
      } else {
        if (!opts.email) throw new Error('no email');
        await verifyEmailCode(opts.email, secret);
      }
      onDone();
    } catch {
      setError(t(method === 'password' ? 'stepUp.errors.wrongPassword' : method === 'totp' || codeSent ? 'stepUp.errors.wrongCode' : 'stepUp.errors.generic'));
    } finally {
      setBusy(false);
    }
  };

  const needsSecret = method === 'password' || method === 'totp' || (method === 'emailCode' && codeSent);
  const label = method === 'password' ? t('stepUp.passwordLabel') : method === 'totp' ? t('stepUp.totpLabel') : t('stepUp.codeLabel');

  return (
    <>
      <div className="fixed inset-0 z-[110] bg-black/40 backdrop-blur-sm" aria-hidden="true" />
      <div
        className="fixed inset-0 z-[120] flex items-center justify-center p-4"
        onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      >
      <Card
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="stepup-title"
        aria-describedby="stepup-desc"
        className="w-full max-w-sm !p-6 hover:!translate-y-0"
      >
        <div className="flex items-start justify-between gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <ShieldCheck size={20} aria-hidden="true" />
          </span>
          <button type="button" onClick={onCancel} aria-label={t('stepUp.cancel')} className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <h2 id="stepup-title" className="mt-4 text-base font-semibold text-text-primary">{t('stepUp.title')}</h2>
        <p id="stepup-desc" className="mt-1.5 text-sm leading-relaxed text-text-secondary">{t('stepUp.description')}</p>

        <form onSubmit={submit} className="mt-4 space-y-3" noValidate>
          {opts && opts.methods.length > 1 && (
            <div role="radiogroup" aria-label={t('stepUp.title')} className="flex flex-wrap gap-2">
              {opts.methods.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={method === m}
                  onClick={() => { setMethod(m); setSecret(''); setError(null); setCodeSent(false); }}
                  className={`focus-ring rounded-lg border px-3 py-1.5 text-xs font-medium ${method === m ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}
                >
                  {t(`stepUp.methods.${m}`)}
                </button>
              ))}
            </div>
          )}

          {method === 'emailCode' && codeSent && <p className="text-xs text-text-secondary" role="status">{t('stepUp.codeSent', { email: opts?.email ?? '' })}</p>}

          {needsSecret && (
            <Input
              label={label}
              type={method === 'password' ? 'password' : 'text'}
              inputMode={method === 'password' ? undefined : 'numeric'}
              autoComplete={method === 'password' ? 'current-password' : 'one-time-code'}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoFocus
              required
            />
          )}

          {error && <p role="alert" className="text-sm text-danger">{error}</p>}

          <div className="flex gap-3 pt-1">
            <Button type="button" variant="secondary" size="sm" className="flex-1" onClick={onCancel}>{t('stepUp.cancel')}</Button>
            <Button type="submit" size="sm" className="flex-1" disabled={busy || !method || (needsSecret && secret.trim() === '')}>
              {busy ? t('stepUp.working') : method === 'emailCode' && !codeSent ? t('stepUp.sendCode') : t('stepUp.verify')}
            </Button>
          </div>
        </form>
      </Card>
      </div>
    </>
  );
}
