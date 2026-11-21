import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, Globe, KeyRound, Lock, Mail, ShieldCheck, User, type LucideIcon } from 'lucide-react';

const SECTIONS: Array<{ id: string; key: string; fallback: string; icon: LucideIcon }> = [
  { id: 'profile', key: 'account.nav.profile', fallback: 'Profile', icon: User },
  { id: 'email', key: 'account.nav.email', fallback: 'Email', icon: Mail },
  { id: 'password', key: 'account.nav.password', fallback: 'Password', icon: KeyRound },
  { id: 'security', key: 'account.nav.security', fallback: 'Security', icon: ShieldCheck },
  { id: 'preferences', key: 'account.nav.preferences', fallback: 'Language & region', icon: Globe },
  { id: 'activity', key: 'account.nav.activity', fallback: 'Activity', icon: Activity },
  { id: 'data', key: 'account.nav.data', fallback: 'Data & privacy', icon: Lock },
];

export function AccountSectionNav() {
  const { t } = useTranslation('dashboard');
  const [active, setActive] = useState(SECTIONS[0].id);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const els = SECTIONS.map((s) => document.getElementById(s.id)).filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-96px 0px -60% 0px', threshold: 0 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  const go = (id: string) => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    document.getElementById(id)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    setActive(id);
  };

  return (
    <nav aria-label={t('account.nav.label', { defaultValue: 'Account sections' })} className="mb-4 lg:sticky lg:top-6 lg:mb-0 lg:self-start">
      <ul className="flex gap-1.5 overflow-x-auto pb-1 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:pb-0">
        {SECTIONS.map(({ id, key, fallback, icon: Icon }) => {
          const current = active === id;
          return (
            <li key={id} className="shrink-0">
              <button
                type="button"
                onClick={() => go(id)}
                aria-current={current ? 'true' : undefined}
                className={`focus-ring flex w-full items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  current ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                }`}
              >
                <Icon size={15} aria-hidden="true" />
                {t(key, { defaultValue: fallback })}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
