import { useEffect, useState } from 'react';
import { CheckCircle2, CircleDashed } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { useComplianceT } from '@/i18n/complianceNamespace';
import { fetchPublicClaims } from '@/lib/compliance/api';
import { allInProgress, type ClaimView } from '@/lib/compliance/trustClaims';

/**
 * Trust Center claims registry. Starts as "In progress" for every claim and upgrades a claim
 * only when the database gate reports fresh, passing evidence. Errors never upgrade anything.
 */
export function TrustClaimsSection({ load = fetchPublicClaims }: { load?: () => Promise<ClaimView[]> }) {
  const { t, language } = useComplianceT();
  const [claims, setClaims] = useState<ClaimView[]>(allInProgress);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((c) => {
        if (!cancelled) setClaims(c);
      })
      .catch(() => {
        if (!cancelled) setClaims(allInProgress());
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const fmt = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(language, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

  return (
    <section aria-labelledby="trust-claims-heading" className="px-5 py-12 sm:px-6 sm:py-16">
      <div className="mx-auto max-w-4xl">
        <h2 id="trust-claims-heading" className="text-center text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">
          {t('claims.heading')}
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-sm leading-relaxed text-text-secondary">{t('claims.intro')}</p>
        <ul className="mt-8 grid gap-3 sm:grid-cols-2" aria-busy={!ready}>
          {claims.map((c) => {
            const done = c.state === 'evidenced';
            const Icon = done ? CheckCircle2 : CircleDashed;
            return (
              <li key={c.key}>
                <Card interactive={false} className="h-full !p-5">
                  <div className="flex items-start gap-3">
                    <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${done ? 'text-success-500' : 'text-text-secondary'}`} aria-hidden="true" />
                    <div>
                      <h3 className="text-sm font-semibold text-text-primary">{t(`claims.${c.key}.title`)}</h3>
                      <p className="mt-1 text-xs leading-relaxed text-text-secondary">{t(`claims.${c.key}.body`)}</p>
                      <p className="mt-2 text-xs font-semibold text-text-primary">
                        {t(`claims.state.${c.state}`)}
                        <span className="font-normal text-text-secondary">
                          {' · '}
                          {done && c.lastVerified ? t('claims.verified', { date: fmt(c.lastVerified) }) : t('claims.unverified')}
                        </span>
                      </p>
                    </div>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
        <p className="mt-6 text-center text-xs text-text-secondary">{t('claims.footnote')}</p>
      </div>
    </section>
  );
}
