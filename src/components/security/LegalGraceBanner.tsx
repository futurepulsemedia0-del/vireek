import { Link } from 'react-router-dom';
import { useLegalAcceptanceT } from '@/i18n/legalAcceptanceNamespace';

/** Non-blocking notice while updated legal terms are inside their grace window. [COUNSEL] wording lives in locales/*/legalAcceptance.json */
export function LegalGraceBanner({ deadline }: { deadline: string | null }) {
  const { t, language } = useLegalAcceptanceT();
  if (!deadline) return null;
  const when = new Date(deadline);
  if (Number.isNaN(when.getTime())) return null;
  const date = when.toLocaleDateString(language, { year: 'numeric', month: 'long', day: 'numeric' });
  return (
    <div role="status" className="border-b border-border bg-bg-primary px-4 py-2 text-sm text-text-secondary">
      {t('graceBanner', { date })}{' '}
      <Link to="/legal/accept" className="font-medium text-accent underline">
        {t('graceReview')}
      </Link>
    </div>
  );
}
