import { useEffect, useRef, useState, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { Icon } from '@/components/ui/Icon';
import { PUBLIC_NAV, isEntryActive, isHrefActive, leafText } from '@/lib/publicNav';

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

const ROW =
  'focus-ring flex min-h-12 w-full items-center justify-between gap-3 rounded-lg px-3 text-start text-base font-medium transition-colors active:bg-bg-tertiary motion-reduce:transition-none';

interface MobileDrawerProps {
  open: boolean;
  sheetId: string;
  pathname: string;
  buttonRef: RefObject<HTMLButtonElement | null>;
  /** Esc / explicit close: the parent also restores focus to the hamburger. */
  onClose: () => void;
  /** Link tapped: close without stealing focus from the route-change focus handler. */
  onNavigate: () => void;
}

export function MobileDrawer({ open, sheetId, pathname, buttonRef, onClose, onNavigate }: MobileDrawerProps) {
  const { t } = useTranslation();
  const sheetRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const translate = (key: string): string => t(key);

  // Scroll lock without layout jump.
  useEffect(() => {
    if (!open) return;
    const { body, documentElement } = document;
    const prevOverflow = body.style.overflow;
    const prevPadding = body.style.paddingRight;
    const gap = window.innerWidth - documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (gap > 0) body.style.paddingRight = `${gap}px`;
    return () => {
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPadding;
    };
  }, [open]);

  // On open: expand the active group and move focus into the sheet.
  useEffect(() => {
    if (!open) return;
    const active = PUBLIC_NAV.find((e) => e.kind === 'menu' && isEntryActive(pathname, e));
    setExpanded(active ? active.id : null);
    const raf = requestAnimationFrame(() => {
      sheetRef.current?.querySelector<HTMLElement>('nav a, nav button')?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open, pathname]);

  // Esc + focus trap (the hamburger button is part of the trap, since it stays visible above the sheet).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const sheet = sheetRef.current;
      if (!sheet) return;
      const button = buttonRef.current;
      const list = [...(button ? [button] : []), ...Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE))].filter(
        (el) => el.getClientRects().length > 0,
      );
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      const current = document.activeElement as HTMLElement | null;
      const outside = !current || !list.includes(current);
      if (e.shiftKey && (current === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, buttonRef]);

  return (
    <div
      ref={sheetRef}
      id={sheetId}
      role="dialog"
      aria-label={t('nav.mobileLabel')}
      className={`fixed inset-0 z-40 flex flex-col bg-bg-primary pt-[calc(3.5rem+env(safe-area-inset-top))] transition-[opacity,transform,visibility] duration-200 ease-out motion-reduce:transition-none lg:hidden ${
        open ? 'visible translate-y-0 opacity-100' : 'invisible -translate-y-2 opacity-0'
      }`}
    >
      <div className="flex-none px-4 pb-2 pt-2">
        <LanguageSwitcher variant="drawer" className="min-h-11" />
      </div>

      <nav aria-label={t('nav.ariaMain')} className="flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
        <ul className="space-y-1">
          {PUBLIC_NAV.map((entry) => {
            const active = isEntryActive(pathname, entry);
            const tone = active ? 'text-accent' : 'text-text-primary hover:bg-bg-tertiary';
            if (entry.kind === 'link') {
              return (
                <li key={entry.id}>
                  <Link
                    to={entry.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={`${ROW} ${tone}`}
                  >
                    {t(entry.labelKey)}
                  </Link>
                </li>
              );
            }
            const isOpen = expanded === entry.id;
            const regionId = `${sheetId}-${entry.id}`;
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={regionId}
                  onClick={() => setExpanded(isOpen ? null : entry.id)}
                  className={`${ROW} ${tone}`}
                >
                  {t(entry.labelKey)}
                  <Icon
                    icon={ChevronDown}
                    size="sm"
                    className={`transition-transform duration-150 motion-reduce:transition-none ${isOpen ? 'rotate-180' : ''}`}
                  />
                </button>
                {isOpen && (
                  <div id={regionId} className="mb-2 ms-3 border-s border-border ps-2">
                    {entry.groups.map((group) => (
                      <ul key={group.id} className="space-y-0.5">
                        {group.items.map((item) => {
                          const { title, desc } = leafText(translate, item);
                          return (
                            <li key={item.id}>
                              <Link
                                to={item.href}
                                onClick={onNavigate}
                                aria-current={isHrefActive(pathname, item.href) ? 'page' : undefined}
                                className="focus-ring flex min-h-12 items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-bg-tertiary aria-[current=page]:bg-bg-tertiary motion-reduce:transition-none"
                              >
                                <Icon icon={item.icon} size="md" className="shrink-0 text-accent" />
                                <span className="min-w-0">
                                  <span className="block text-[0.9375rem] font-medium text-text-primary">{title}</span>
                                  <span className="line-clamp-1 block text-[0.8125rem] text-text-secondary">{desc}</span>
                                </span>
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    ))}
                    {entry.footer && (
                      <Link
                        to={entry.footer.href}
                        onClick={onNavigate}
                        className="focus-ring flex min-h-12 items-center gap-2 rounded-lg px-3 text-[0.9375rem] font-medium text-accent hover:bg-bg-tertiary"
                      >
                        {t(entry.footer.labelKey)}
                        <Icon icon={ArrowRight} size="sm" className="rtl:rotate-180" />
                      </Link>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="flex-none space-y-2 border-t border-border px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
        <Link
          to="/login"
          onClick={onNavigate}
          className="focus-ring flex h-12 w-full items-center justify-center rounded-lg border border-border text-base font-medium text-text-primary transition-colors hover:bg-bg-tertiary motion-reduce:transition-none"
        >
          {t('cta.login')}
        </Link>
        <Link
          to="/signup"
          onClick={onNavigate}
          className="focus-ring flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-accent text-base font-semibold text-white transition-[filter] hover:brightness-110 motion-reduce:transition-none"
        >
          {t('cta.startFreeTrial')}
          <Icon icon={ArrowRight} size="sm" className="rtl:rotate-180" />
        </Link>
      </div>
    </div>
  );
}
