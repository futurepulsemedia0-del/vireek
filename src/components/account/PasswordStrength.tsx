import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Circle } from 'lucide-react';
import { checkPassword } from '@/lib/accountHelpers';

export function PasswordStrength({ password, email }: { password: string; email?: string | null }) {
  const { t } = useTranslation('dashboard');
  const check = useMemo(() => checkPassword(password, email), [password, email]);
  if (!password) return null;

  const bar = check.score <= 1 ? 'bg-danger' : check.score === 2 ? 'bg-warning' : 'bg-success';
  const text = check.score <= 1 ? 'text-danger' : check.score === 2 ? 'text-warning' : 'text-success';

  return (
    <div className="mt-3" aria-live="polite">
      <div className="flex items-center gap-3">
        <div className="flex flex-1 gap-1" aria-hidden="true">
          {[1, 2, 3, 4].map((i) => (
            <span key={i} className={`h-1.5 flex-1 rounded-full transition-colors ${i <= check.score ? bar : 'bg-bg-tertiary'}`} />
          ))}
        </div>
        <span className={`text-xs font-medium ${text}`}>
          {t(`account.password.strength.${check.score}`, { defaultValue: check.label })}
        </span>
      </div>
      <ul className="mt-2 grid gap-1 sm:grid-cols-2">
        {check.rules.map((r) => (
          <li key={r.id} className={`flex items-center gap-1.5 text-xs ${r.passed ? 'text-success' : 'text-text-muted'}`}>
            {r.passed ? <Check size={12} aria-hidden="true" /> : <Circle size={12} aria-hidden="true" />}
            {t(`account.password.rules.${r.id}`, { defaultValue: r.label })}
          </li>
        ))}
      </ul>
    </div>
  );
}
