import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export function HeaderLoginButton({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Link
      to="/login"
      className={`focus-ring hidden h-9 items-center justify-center rounded-full border border-border bg-transparent px-4 text-[13px] font-medium tracking-[-0.01em] text-text-primary transition-colors duration-150 hover:bg-bg-tertiary active:scale-[0.98] lg:inline-flex ${className}`}
    >
      {t('cta.login')}
    </Link>
  );
}
