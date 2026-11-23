import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CircleCheck as CheckCircle2, CircleAlert as AlertCircle } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/Skeleton';
import { useOffboardingT } from '@/i18n/offboardingNamespace';
import { confirmUnsubscribe, lookupUnsubscribe, type UnsubscribeLookup } from '@/lib/offboarding';

type State = 'loading' | 'ready' | 'working' | 'done' | 'already' | 'invalid' | 'error';

/**
 * Public page linked from every win-back email (/winback/unsubscribe/:token).
 * Two steps (look up -> confirm) so link scanners that merely open the URL can't unsubscribe anyone.
 * Shows the company name only, never an email address.
 */
export default function WinbackUnsubscribePage() {
  const { token = '' } = useParams();
  const { t } = useOffboardingT();
  const [state, setState] = useState<State>('loading');
  const [info, setInfo] = useState<UnsubscribeLookup | null>(null);

  // Never index a per-recipient URL.
  useEffect(() => {
    const previous = document.title;
    document.title = t('unsubscribe.title');
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => {
      document.title = previous;
      meta.remove();
    };
  }, [t]);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const res = await lookupUnsubscribe(token);
      if (!res) return setState('invalid');
      setInfo(res);
      setState(res.already ? 'already' : 'ready');
    } catch {
      setState('error');
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const confirm = async () => {
    setState('working');
    try {
      setState((await confirmUnsubscribe(token)) ? 'done' : 'invalid');
    } catch {
      setState('error');
    }
  };

  const company = info?.company || t('unsubscribe.fallbackCompany');

  const result = (icon: 'ok' | 'bad', title: string, text: string, retry = false) => (
    <>
      {icon === 'ok' ? <CheckCircle2 size={36} className="mx-auto text-success" aria-hidden="true" /> : <AlertCircle size={36} className="mx-auto text-danger" aria-hidden="true" />}
      <h1 className="mt-3 text-xl font-bold text-text-primary">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-text-secondary">{text}</p>
      {retry && <Button type="button" className="mt-5" onClick={() => void load()}>{t('unsubscribe.retry')}</Button>}
    </>
  );

  return (
    <>
      <Header />
      <main className="flex min-h-screen flex-col items-center justify-center bg-bg-primary px-4 pb-12 pt-24">
        <Card className="w-full max-w-md p-6 text-center hover:translate-y-0 sm:p-8" aria-live="polite">
          {state === 'loading' && (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="mx-auto h-6 w-48" />
              <Skeleton className="mx-auto h-4 w-64" />
              <Skeleton className="mx-auto h-12 w-full" />
            </div>
          )}
          {(state === 'ready' || state === 'working') && (
            <>
              <h1 className="text-xl font-bold text-text-primary">{t('unsubscribe.title')}</h1>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">{t('unsubscribe.text', { company })}</p>
              <Button type="button" className="mt-5" fullWidth loading={state === 'working'} loadingLabel={t('unsubscribe.working')} onClick={() => void confirm()}>
                {t('unsubscribe.confirm')}
              </Button>
            </>
          )}
          {state === 'done' && result('ok', t('unsubscribe.doneTitle'), t('unsubscribe.doneText'))}
          {state === 'already' && result('ok', t('unsubscribe.alreadyTitle'), t('unsubscribe.alreadyText'))}
          {state === 'invalid' && result('bad', t('unsubscribe.invalidTitle'), t('unsubscribe.invalidText'))}
          {state === 'error' && result('bad', t('unsubscribe.errorTitle'), t('unsubscribe.errorText'), true)}
        </Card>
      </main>
      <Footer />
    </>
  );
}
