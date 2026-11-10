/**
 * Public "Fair Sale Promise" — /fair-sale-promise
 * Plain-language, multilingual customer notice + trusted-contact revocation (token link).
 * Describes Vireek's own practices; not legal advice. Have counsel review the wording and each
 * translation with a native speaker before relying on it publicly.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, HeartHandshake } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useFairSaleT } from '@/i18n/fairSaleNamespace';
import { revokeWithToken } from '@/lib/fairSale';

const ITEM_KEYS = ['never_rush', 'take_time', 'summary', 'price_check', 'trusted', 'manager', 'payment', 'callback', 'no_guess', 'emergency'] as const;

function Seo({ title, description }: { title: string; description: string }) {
  useEffect(() => {
    const prev = document.title;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const prevContent = meta?.getAttribute('content') ?? null;
    if (!meta) { meta = document.createElement('meta'); meta.setAttribute('name', 'description'); document.head.appendChild(meta); }
    meta.setAttribute('content', description);
    document.title = `${title} | Vireek`;
    return () => { document.title = prev; if (prevContent === null) meta?.remove(); else meta?.setAttribute('content', prevContent); };
  }, [title, description]);
  return null;
}

export function FairSalePromisePage() {
  const { t } = useFairSaleT();
  const [params] = useSearchParams();
  const [token, setToken] = useState(() => (params.get('token') ?? '').replace(/[^a-f0-9]/gi, '').slice(0, 128));
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (token.length < 32) return;
    setState('busy');
    try { await revokeWithToken(token); setState('done'); } catch { setState('error'); }
  };

  return (
    <>
      <Seo title={t('public.title')} description={t('public.metaDescription')} />
      <Header />
      <main id="main" className="mx-auto w-full max-w-3xl px-4 pb-20 pt-28">
        <div className="flex items-center gap-3 text-accent"><HeartHandshake className="h-7 w-7" aria-hidden /></div>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-text-primary md:text-4xl">{t('public.title')}</h1>
        <p className="mt-3 text-lg leading-relaxed text-text-secondary">{t('public.lead')}</p>

        <section aria-labelledby="promises" className="mt-10">
          <h2 id="promises" className="text-xl font-semibold text-text-primary">{t('public.promisesTitle')}</h2>
          <ol className="mt-4 space-y-3">
            {ITEM_KEYS.map((k) => (
              <li key={k} className="flex gap-3 rounded-2xl border border-border bg-bg-secondary p-4">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success-500" aria-hidden />
                <p className="leading-relaxed text-text-primary">{t(`public.items.${k}`)}</p>
              </li>
            ))}
          </ol>
        </section>

        <p className="mt-6 leading-relaxed text-text-secondary">{t('public.rights')}</p>

        <aside aria-labelledby="notice" className="mt-8 rounded-2xl border border-border bg-bg-tertiary/50 p-5">
          <h2 id="notice" className="text-base font-semibold text-text-primary">{t('public.notice.title')}</h2>
          <p className="mt-1 leading-relaxed text-text-secondary">{t('public.notice.body')}</p>
        </aside>

        <section id="revoke" aria-labelledby="revoke-title" className="mt-10 rounded-2xl border border-border bg-bg-secondary p-5">
          <h2 id="revoke-title" className="text-lg font-semibold text-text-primary">{t('public.revoke.title')}</h2>
          <p className="mt-1 text-sm leading-relaxed text-text-secondary">{t('public.revoke.body')}</p>
          <form onSubmit={(e) => void submit(e)} className="mt-4 flex flex-wrap items-end gap-3" noValidate>
            <div className="min-w-0 flex-1">
              <Input label={t('public.revoke.label')} value={token} onChange={(e) => setToken(e.target.value.replace(/[^a-f0-9]/gi, '').slice(0, 128))} autoComplete="off" spellCheck={false} dir="ltr" />
            </div>
            <Button type="submit" variant="secondary" loading={state === 'busy'} disabled={token.length < 32}>{t('public.revoke.button')}</Button>
          </form>
          <p role={state === 'error' ? 'alert' : 'status'} className={`mt-3 text-sm ${state === 'error' ? 'text-danger' : 'text-text-secondary'}`}>
            {state === 'done' ? t('public.revoke.done') : state === 'error' ? t('public.revoke.error') : ''}
          </p>
        </section>

        <p className="mt-8 text-xs text-text-secondary">{t('public.footnote')}</p>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
