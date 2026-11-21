import { useId, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Link, useLocation } from 'react-router-dom';
import { ArrowRight, ChevronDown, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/ui/Icon';
import { useDirection } from '@/hooks/useDirection';
import { NAV_ITEMS, isInternalHref, isNavItemActive, type MegaFeatured, type MegaLink } from '@/lib/headerNav';

const EASE = [0.16, 1, 0.3, 1] as const;

const ARROW = 'transition-transform group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5';

/** Exact-route match for one link. External hrefs (tel:, https:) are never "current". */
const isLinkCurrent = (href: string, pathname: string): boolean => isInternalHref(href) && pathname === href;

function RowIcon({ icon, active }: { icon?: LucideIcon; active: boolean }) {
  if (!icon) return null;
  return (
    <span
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border text-accent ${
        active ? 'border-accent/30 bg-accent/20' : 'border-border bg-bg-tertiary'
      }`}
    >
      <Icon icon={icon} size="md" />
    </span>
  );
}

interface MobileLinkProps {
  link: MegaLink;
  pathname: string;
  onNavigate: () => void;
  /** Dense row (icon + label only) for long lists such as industries and competitors. */
  compact?: boolean;
}

function MobileLink({ link, pathname, onNavigate, compact }: MobileLinkProps) {
  const glyph = link.icon;
  const uid = useId();
  const labelId = `${uid}-label`;
  const descId = `${uid}-desc`;
  const current = isLinkCurrent(link.href, pathname);
  const showDescription = !compact && Boolean(link.description);
  const cls = `focus-ring flex items-center gap-3 rounded-xl px-3 transition-colors active:bg-bg-tertiary motion-reduce:transition-none ${
    compact ? 'min-h-touch py-1.5' : 'min-h-14 py-2'
  } ${current ? 'bg-accent/10' : 'hover:bg-bg-tertiary'}`;
  const inner = (
    <>
      {glyph && (
        <span
          className={`flex shrink-0 items-center justify-center rounded-lg border border-accent/20 bg-accent/10 text-accent ${
            compact ? 'h-8 w-8' : 'h-10 w-10'
          }`}
        >
          <Icon icon={glyph} size={compact ? 'sm' : 'md'} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span id={labelId} className={`block text-sm ${current ? 'font-semibold text-accent' : 'font-medium text-text-primary'}`}>
          {link.label}
        </span>
        {showDescription && (
          <span id={descId} className="mt-0.5 block text-[0.8125rem] leading-snug text-text-secondary">
            {link.description}
          </span>
        )}
      </span>
    </>
  );
  // The accessible name stays the short label; the description is announced after it.
  const shared = {
    className: cls,
    onClick: onNavigate,
    'aria-labelledby': labelId,
    'aria-describedby': showDescription ? descId : undefined,
    'aria-current': current ? ('page' as const) : undefined,
  };
  return isInternalHref(link.href) ? (
    <Link to={link.href} {...shared}>
      {inner}
    </Link>
  ) : (
    <a href={link.href} {...shared}>
      {inner}
    </a>
  );
}

function MobileOverviewLink({ link, onNavigate }: { link: MegaLink; onNavigate: () => void }) {
  return (
    <Link
      to={link.href}
      onClick={onNavigate}
      className="focus-ring group flex min-h-touch items-center justify-between rounded-xl px-3 text-sm font-semibold text-accent transition-colors hover:bg-bg-tertiary motion-reduce:transition-none"
    >
      {link.label}
      <Icon icon={ArrowRight} size="sm" className={ARROW} />
    </Link>
  );
}

function MobileFeatured({ featured, onNavigate }: { featured: MegaFeatured; onNavigate: () => void }) {
  const cls =
    'focus-ring group flex items-start gap-3 rounded-xl border border-border bg-bg-tertiary p-3.5 transition-colors hover:border-accent motion-reduce:transition-none';
  const inner = (
    <>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent ring-1 ring-accent/20">
        <Icon icon={featured.icon} size="md" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold uppercase tracking-wider text-text-secondary">{featured.eyebrow}</span>
        <span className="mt-0.5 block text-sm font-semibold leading-snug text-text-primary">{featured.title}</span>
        <span className="mt-1 block text-[0.8125rem] leading-snug text-text-secondary">{featured.description}</span>
        <span className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-accent">
          {featured.cta.label}
          <Icon icon={ArrowRight} size="sm" className={ARROW} />
        </span>
      </span>
    </>
  );
  return isInternalHref(featured.cta.href) ? (
    <Link to={featured.cta.href} onClick={onNavigate} className={cls}>
      {inner}
    </Link>
  ) : (
    <a href={featured.cta.href} onClick={onNavigate} className={cls}>
      {inner}
    </a>
  );
}

export function MobileNav({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const reduce = useReducedMotion();
  const { isRtl } = useDirection();
  const baseId = useId();
  const [expanded, setExpanded] = useState<string | null>(
    () => NAV_ITEMS.find((i) => i.panel && isNavItemActive(i, pathname))?.id ?? null,
  );

  return (
    <nav aria-label="Mobile" className="flex-1 overflow-y-auto overscroll-contain px-4 py-4">
      <ul className="space-y-1">
        {NAV_ITEMS.map((item, i) => {
          const label = t(item.labelKey);
          const active = isNavItemActive(item, pathname);
          const open = expanded === item.id;
          const rowCls = `focus-ring flex min-h-14 w-full items-center gap-3 rounded-2xl px-3 text-base font-medium transition-colors ${
            active ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
          }`;
          return (
            <motion.li
              key={item.id}
              initial={reduce ? false : { opacity: 0, x: isRtl ? -24 : 24 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: reduce ? 0 : 0.06 + i * 0.04, duration: reduce ? 0 : 0.26, ease: EASE }}
            >
              {item.panel ? (
                <>
                  <button
                    type="button"
                    className={rowCls}
                    aria-expanded={open}
                    aria-current={active ? 'page' : undefined}
                    aria-controls={`${baseId}-${item.id}`}
                    onClick={() => setExpanded(open ? null : item.id)}
                  >
                    <RowIcon icon={item.icon} active={active} />
                    <span className="flex-1 text-start">{label}</span>
                    <Icon icon={ChevronDown} size="sm" className={`shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
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
                        <div className="ms-4 space-y-4 border-s border-border py-2 ps-2">
                          {item.panel.groups.map((g, gi) => {
                            const titleId = `${baseId}-${item.id}-g${gi}`;
                            return (
                              <div key={g.title} role="group" aria-labelledby={titleId}>
                                <p id={titleId} className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-text-secondary">
                                  {g.title}
                                </p>
                                {g.links.map((l) => (
                                  <MobileLink
                                    key={`${l.href}-${l.label}`}
                                    link={l}
                                    pathname={pathname}
                                    onNavigate={onNavigate}
                                    compact={g.compact}
                                  />
                                ))}
                              </div>
                            );
                          })}
                          <div className="space-y-2">
                            <MobileOverviewLink link={item.panel.overview} onNavigate={onNavigate} />
                            {item.panel.featured && <MobileFeatured featured={item.panel.featured} onNavigate={onNavigate} />}
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </>
              ) : (
                <Link to={item.href} onClick={onNavigate} className={rowCls} aria-current={active ? 'page' : undefined}>
                  <RowIcon icon={item.icon} active={active} />
                  <span className="flex-1 text-start">{label}</span>
                </Link>
              )}
            </motion.li>
          );
        })}
      </ul>
    </nav>
  );
}
