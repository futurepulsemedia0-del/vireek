import { useId, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Link, useLocation } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NAV_ITEMS, isInternalHref, isNavItemActive, type MegaLink } from '@/lib/headerNav';

const EASE = [0.16, 1, 0.3, 1] as const;

function MobileLink({ link, onNavigate, strong }: { link: MegaLink; onNavigate: () => void; strong?: boolean }) {
  const Icon = link.icon;
  const cls = `focus-ring flex min-h-touch items-center gap-2.5 rounded-xl px-3 text-sm transition-colors hover:bg-bg-tertiary ${
    strong ? 'font-semibold text-accent' : 'text-text-secondary hover:text-text-primary'
  }`;
  const inner = (
    <>
      {Icon && <Icon size={15} className="shrink-0 text-accent/70" aria-hidden="true" />}
      {link.label}
    </>
  );
  return isInternalHref(link.href) ? (
    <Link to={link.href} onClick={onNavigate} className={cls}>
      {inner}
    </Link>
  ) : (
    <a href={link.href} onClick={onNavigate} className={cls}>
      {inner}
    </a>
  );
}

export function MobileNav({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const reduce = useReducedMotion();
  const baseId = useId();
  const [expanded, setExpanded] = useState<string | null>(
    () => NAV_ITEMS.find((i) => i.panel && isNavItemActive(i, pathname))?.id ?? null,
  );

  return (
    <nav aria-label="Mobile" className="flex-1 overflow-y-auto px-4 py-4">
      <ul className="space-y-1">
        {NAV_ITEMS.map((item, i) => {
          const label = t(item.labelKey);
          const active = isNavItemActive(item, pathname);
          const open = expanded === item.id;
          const rowCls = `focus-ring flex min-h-touch w-full items-center justify-between rounded-2xl px-4 text-base font-medium transition-colors ${
            active ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
          }`;
          return (
            <motion.li
              key={item.id}
              initial={reduce ? false : { opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: reduce ? 0 : 0.06 + i * 0.04, duration: reduce ? 0 : 0.26, ease: EASE }}
            >
              {item.panel ? (
                <>
                  <button
                    type="button"
                    className={rowCls}
                    aria-expanded={open}
                    aria-controls={`${baseId}-${item.id}`}
                    onClick={() => setExpanded(open ? null : item.id)}
                  >
                    {label}
                    <ChevronDown size={16} aria-hidden="true" className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                  </button>
                  <AnimatePresence initial={false}>
                    {open && (
                      <motion.div
                        id={`${baseId}-${item.id}`}
                        initial={reduce ? false : { height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
                        transition={{ duration: reduce ? 0 : 0.24, ease: EASE }}
                        className="overflow-hidden"
                      >
                        <div className="ml-4 space-y-3 border-l border-border py-2 pl-3">
                          <MobileLink link={item.panel.overview} onNavigate={onNavigate} strong />
                          {item.panel.groups.map((g) => (
                            <div key={g.title}>
                              <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-text-secondary">{g.title}</p>
                              {g.links.map((l) => (
                                <MobileLink key={`${l.href}-${l.label}`} link={l} onNavigate={onNavigate} />
                              ))}
                            </div>
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </>
              ) : (
                <Link to={item.href} onClick={onNavigate} className={rowCls} aria-current={active ? 'page' : undefined}>
                  {label}
                </Link>
              )}
            </motion.li>
          );
        })}
      </ul>
    </nav>
  );
}
