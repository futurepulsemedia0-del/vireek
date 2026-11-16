import { useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/ui/Icon';
import { isHrefActive, leafText, type NavMenu } from '@/lib/publicNav';

interface MegaMenuPanelProps {
  entry: NavMenu;
  panelId: string;
  triggerId: string;
  open: boolean;
  pathname: string;
}

export function MegaMenuPanel({ entry, panelId, triggerId, open, pathname }: MegaMenuPanelProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const translate = (key: string): string => t(key);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const root = ref.current;
    if (!root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>('[data-nav-item]'));
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    const rtl = getComputedStyle(root).direction === 'rtl';
    const forward = idx < items.length - 1 ? idx + 1 : 0;
    const backward = idx > 0 ? idx - 1 : items.length - 1;
    let next: number;
    switch (e.key) {
      case 'ArrowDown': next = forward; break;
      case 'ArrowUp': next = backward; break;
      case 'ArrowRight': next = rtl ? backward : forward; break;
      case 'ArrowLeft': next = rtl ? forward : backward; break;
      case 'Home': next = 0; break;
      case 'End': next = items.length - 1; break;
      default: return;
    }
    e.preventDefault();
    items[next]?.focus();
  };

  const columns = `repeat(${entry.groups.length}, minmax(0, 1fr))${entry.featured ? ' minmax(0, 0.85fr)' : ''}`;

  return (
    <div
      className={`pointer-events-none absolute inset-x-0 top-full transition-[opacity,transform,visibility] duration-150 ease-out motion-reduce:transition-none ${
        open ? 'visible translate-y-0 opacity-100' : 'invisible translate-y-1 opacity-0'
      }`}
    >
      <div
        ref={ref}
        id={panelId}
        role="group"
        aria-labelledby={triggerId}
        onKeyDown={onKeyDown}
        className={`relative mx-auto mt-2 w-full max-w-4xl rounded-xl border border-border bg-bg-secondary shadow-elevation-3 before:absolute before:inset-x-0 before:-top-2 before:h-2 before:content-[''] ${
          open ? 'pointer-events-auto' : ''
        }`}
      >
        <div className="grid gap-1 p-2" style={{ gridTemplateColumns: columns }}>
          {entry.groups.map((group) => (
            <div key={group.id}>
              {group.labelKey && (
                <p className="px-3 pb-1 pt-2 text-xs font-medium text-text-secondary">{t(group.labelKey)}</p>
              )}
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const { title, desc } = leafText(translate, item);
                  const active = isHrefActive(pathname, item.href);
                  return (
                    <li key={item.id}>
                      <Link
                        to={item.href}
                        data-nav-item
                        aria-current={active ? 'page' : undefined}
                        className="focus-ring group flex items-start gap-3 rounded-lg p-3 transition-colors duration-150 hover:bg-bg-tertiary aria-[current=page]:bg-bg-tertiary motion-reduce:transition-none"
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-bg-primary text-accent">
                          <Icon icon={item.icon} size="md" />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-text-primary">{title}</span>
                          <span className="mt-0.5 line-clamp-2 block text-[0.8125rem] leading-snug text-text-secondary">
                            {desc}
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}

          {entry.featured && (
            <Link
              to={entry.featured.href}
              data-nav-item
              className="focus-ring group m-1 flex flex-col justify-between gap-6 rounded-lg border border-border bg-bg-tertiary p-4 transition-colors duration-150 hover:border-accent motion-reduce:transition-none"
            >
              <span>
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-bg-primary text-accent">
                  <Icon icon={entry.featured.icon} size="md" />
                </span>
                <span className="mt-3 block text-sm font-medium text-text-primary">{t(entry.featured.titleKey)}</span>
                <span className="mt-1 block text-[0.8125rem] leading-snug text-text-secondary">
                  {t(entry.featured.descKey)}
                </span>
              </span>
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-accent">
                {t(entry.featured.ctaKey)}
                <Icon icon={ArrowRight} size="sm" className="rtl:rotate-180" />
              </span>
            </Link>
          )}
        </div>

        {entry.footer && (
          <div className="border-t border-border px-2 py-2">
            <Link
              to={entry.footer.href}
              data-nav-item
              className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-text-primary transition-colors duration-150 hover:bg-bg-tertiary motion-reduce:transition-none"
            >
              {t(entry.footer.labelKey)}
              <Icon icon={ArrowRight} size="sm" className="rtl:rotate-180" />
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
