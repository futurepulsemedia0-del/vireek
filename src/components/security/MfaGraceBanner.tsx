import { Link } from 'react-router-dom';
import { SECURITY_SETTINGS_PATH } from '@/lib/mfaChallenge';

export function MfaGraceBanner({ daysLeft }: { daysLeft: number | null }) {
  const when = daysLeft === null ? 'soon' : daysLeft <= 0 ? 'today' : daysLeft === 1 ? 'in 1 day' : `in ${daysLeft} days`;
  return (
    <div role="status" className="border-b border-border bg-bg-primary px-4 py-2 text-sm text-text-secondary">
      Two-factor authentication will be required for your role {when}.{' '}
      <Link to={SECURITY_SETTINGS_PATH} className="font-medium text-accent underline">
        Set it up now
      </Link>
    </div>
  );
}
