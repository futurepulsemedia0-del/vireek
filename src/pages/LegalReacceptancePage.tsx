// /legal/accept — shown to a signed-in user when a MATERIAL version of a legal document became effective.
// Lists what changed (diff summary) per document, links to the full text, and records the acceptance via
// accept_legal_versions(). Reached through the ProtectedRoute gate; nothing else in the product is usable until done.
import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Loader2, ScrollText } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { useLegalAcceptanceT } from '@/i18n/legalAcceptanceNamespace';
import { flattenChanges, localizedSummary, safeReturnPath, type LegalAcceptanceState } from '@/lib/legalAcceptance';
import { acceptRequiredLegal, fetchLegalAcceptanceState } from '@/lib/legalAcceptanceApi';

export function LegalReacceptancePage() {
  const { t, language } = useLegalAcceptanceT();
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = safeReturnPath((location.state as { from?: unknown } | null)?.from);

  const [state, setState] = useState<LegalAcceptanceState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // plain title, no useSEO: useSEO forces `robots: index` and this is a private, signed-in screen
  useEffect(() => {
    const prev = document.title;
    document.title = `${t('title')} | Vireek`;
    return () => { document.title = prev; };
  }, [t]);

  const load = async () => {
    setLoading(true);
    setLoadFailed(false);
    const s = await fetchLegalAcceptanceState();
    setState(s);
    setLoadFailed(s === null);
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);

  const accept = async () => {
    if (!state || !checked) return;
    setBusy(true);
    setError(null);
    try {
      await acceptRequiredLegal(state);
      navigate(from, { replace: true });
    } catch {
      setError(t('errorGeneric'));
    } finally {
      setBusy(false);
    }
  };

  if (!loading && !loadFailed && state && state.decision === 'ok') return <Navigate to={from} replace />;

  const date = (iso: string) => new Date(iso).toLocaleDateString(language, { year: 'numeric', month: 'long', day: 'numeric' });
  const titles = (state?.required ?? []).map((d) => d.title).join(', ');

  return (
    <main className="flex min-h-screen items-start justify-center bg-bg-primary px-4 py-12 sm:py-20">
      <div className="w-full max-w-2xl rounded-2xl border border-border bg-bg-secondary p-6 sm:p-8">
        <div className="flex items-center gap-3">
          <ScrollText className="text-accent" size={24} aria-hidden="true" />
          <h1 className="text-xl font-bold tracking-tight text-text-primary">{t('title')}</h1>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-text-secondary">{t('intro')}</p>

        {loading && <div className="mt-8 flex items-center gap-2 text-sm text-text-secondary"><Loader2 className="animate-spin" size={16} aria-hidden="true" /> {t('loading')}</div>}

        {!loading && loadFailed && (
          <div role="alert" className="mt-6 rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
            <p>{t('loadError')}</p>
            <Button className="mt-3" size="sm" variant="secondary" onClick={() => void load()}>{t('retry')}</Button>
          </div>
        )}

        {!loading && state && state.required.length > 0 && (
          <>
            <div className="mt-6 space-y-6">
              {state.required.map((d) => {
                const changes = flattenChanges(d);
                return (
                  <section key={d.version_id} aria-label={d.title} className="rounded-xl border border-border p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h2 className="text-base font-semibold text-text-primary">{d.title}</h2>
                      <span className="text-xs text-text-secondary">{t('effective', { date: date(d.effective_at) })}</span>
                    </div>
                    <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">{t('whatChanged')}</h3>
                    {changes.length === 0 ? (
                      <p className="mt-1 text-sm text-text-secondary">{t('noSummary')}</p>
                    ) : (
                      <ul className="mt-2 space-y-2">
                        {changes.map((c, i) => (
                          <li key={`${c.section}-${i}`} className="text-sm text-text-primary">
                            <span className="me-2 rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary">{t(`kind.${c.kind}`)}</span>
                            <span className="font-medium">{c.section}</span>
                            <span className="text-text-secondary"> — {localizedSummary(c, language)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {d.content_path && (
                      <Link to={d.content_path} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block text-sm font-medium text-accent hover:underline">
                        {t('readFull', { title: d.title })}
                      </Link>
                    )}
                  </section>
                );
              })}
            </div>

            <label className="mt-6 flex cursor-pointer items-start gap-2.5 text-sm leading-relaxed text-text-secondary select-none">
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="focus-ring mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-accent" />
              <span>{t('checkbox', { titles })}</span>
            </label>

            {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}

            <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
              <Button onClick={() => void accept()} disabled={!checked} loading={busy} loadingLabel={t('accepting')}>{t('accept')}</Button>
              <button type="button" onClick={() => void signOut()} className="text-sm text-text-secondary underline-offset-2 hover:underline">{t('signOut')}</button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
