import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Inbox, LayoutDashboard, MoreHorizontal, PhoneCall, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { BOTTOM_NAV_ITEMS, getBottomNavActiveKey, type BottomNavKey } from '@/lib/mobileNav';
import { tapHaptic } from '@/lib/pwa/tapHaptic';

const ICONS: Record<BottomNavKey, typeof LayoutDashboard> = {
  overview: LayoutDashboard,
  jobs: Wrench,
  calls: PhoneCall,
  inbox: Inbox,
};

// min-h-12 = 48px tap target; touch-manipulation removes the double-tap-zoom delay.
const TAB_BASE =
  'focus-ring flex h-full min-h-12 w-full touch-manipulation select-none flex-col items-center justify-center gap-0.5 rounded-xl text-[11px] font-medium leading-none transition-colors active:bg-bg-tertiary motion-reduce:transition-none';

function TabIcon({ icon: Icon, active }: { icon: typeof LayoutDashboard; active: boolean }) {
  return (
    <span
      className={`flex h-7 w-12 items-center justify-center rounded-full transition-colors motion-reduce:transition-none ${
        active ? 'bg-accent/10 text-accent' : 'text-text-secondary'
      }`}
    >
      <Icon size={20} strokeWidth={active ? 2.4 : 2} aria-hidden="true" />
    </span>
  );
}

export function MobileBottomNav({ onMore, moreOpen }: { onMore: () => void; moreOpen: boolean }) {
  const { pathname } = useLocation();
  const { t } = useTranslation('dashboard');
  const activeKey = getBottomNavActiveKey(pathname);

  // Lets floating widgets/toasts lift themselves above the bar via --vk-bottom-nav-h (see index.css).
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-bottom-nav', '');
    return () => root.removeAttribute('data-bottom-nav');
  }, []);

  return (
    <nav
      aria-label={t('nav.mobile.bottomNavigation', { defaultValue: 'Mobile navigation' })}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border/80 bg-bg-secondary/90 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] backdrop-blur-xl lg:hidden print:hidden"
    >
      <ul className="mx-auto grid h-16 max-w-xl grid-cols-5 gap-1 px-1">
        {BOTTOM_NAV_ITEMS.map((item) => {
          const active = activeKey === item.key;
          return (
            <li key={item.key} className="min-w-0">
              <Link
                to={item.href}
                onClick={tapHaptic}
                aria-current={active ? 'page' : undefined}
                className={`${TAB_BASE} ${active ? 'text-accent' : 'text-text-secondary'}`}
              >
                <TabIcon icon={ICONS[item.key]} active={active} />
                <span className="max-w-full truncate">
                  {t(`nav.mobile.${item.key}`, { defaultValue: item.defaultLabel })}
                </span>
              </Link>
            </li>
          );
        })}
        <li className="min-w-0">
          <button
            type="button"
            onClick={() => {
              tapHaptic();
              onMore();
            }}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            className={`${TAB_BASE} ${moreOpen ? 'text-accent' : 'text-text-secondary'}`}
          >
            <TabIcon icon={MoreHorizontal} active={moreOpen} />
            <span className="max-w-full truncate">{t('nav.mobile.more', { defaultValue: 'More' })}</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}
