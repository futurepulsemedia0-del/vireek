import { useCallback, useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Link, useLocation } from 'react-router-dom';
import { ArrowRight, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDirection } from '@/hooks/useDirection';
import {
  NAV_ITEMS,
  isInternalHref,
  isNavItemActive,
  type MegaLink,
  type MegaPanel,
} from '@/lib/headerNav';

const EASE = [0.16, 1, 0.3, 1] as const;
const COLS = { 1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-3' } as const;

function MegaItemLink({ link, compact, onNavigate }: { link: MegaLink; compact?: boolean; onNavigate: () => void }) {
  const Icon = link.icon;
  const cls = `focus-ring group flex gap-3 rounded-xl px-3 transition-colors duration-150 hover:bg-bg-tertiary ${
    compact ? 'items-center py-2' : 'items-start py-2.5'
  }`;
  const inner = (
    <>
      {Icon && (
        <span
          className={`flex shrink-0 items-center justify-center rounded-lg border border-accent/20 bg-accent/10 text-accent transition-colors group-hover:border-accent/40 ${
            compact ? 'h-7 w-7' : 'mt-0.5 h-8 w-8'
          }`}
        >
          <Icon size={compact ? 14 : 16} aria-hidden="true" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-text-primary">{link.label}</span>
        {!compact && link.description && (
          <span className="mt-0.5 block text-xs leading-snug text-text-secondary">{link.description}</span>
        )}
      </span>
    </>
  );
  return isInternalHref(link.href) ? (
    <Link to={link.href} className={cls} onClick={onNavigate}>
      {inner}
    </Link>
  ) : (
    <a href={link.href} className={cls} onClick={onNavigate}>
      {inner}
    </a>
  );
}

function PanelContent({ panel, onNavigate }: { panel: MegaPanel; onNavigate: () => void }) {
  const f = panel.featured;
  const FIcon = f?.icon;
  const cols = COLS[Math.min(Math.max(panel.groups.length, 1), 3) as 1 | 2 | 3];
  return (
    <>
      <div className="grid grid-cols-12 gap-6 p-6">
        <div className={`grid gap-x-4 ${f ? 'col-span-9' : 'col-span-12'} ${cols}`}>
          {panel.groups.map((g) => (
            <div key={g.title}>
              <p className="px-3 pb-2 text-xs font-semibold uppercase tracking-wider text-text-secondary">{g.title}</p>
              <ul>
                {g.links.map((l) => (
                  <li key={`${l.href}-${l.label}`}>
                    <MegaItemLink link={l} compact={g.compact} onNavigate={onNavigate} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        {f && FIcon && (
          <div className="col-span-3 flex flex-col rounded-xl border border-border bg-bg-tertiary p-5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent ring-1 ring-accent/20">
              <FIcon size={18} aria-hidden="true" />
            </span>
            <p className="mt-4 text-xs font-semibold uppercase tracking-wider text-text-secondary">{f.eyebrow}</p>
            <p className="mt-1 text-base font-bold leading-snug text-text-primary">{f.title}</p>
            <p className="mt-2 text-sm leading-relaxed text-text-secondary">{f.description}</p>
            {isInternalHref(f.cta.href) ? (
              <Link
                to={f.cta.href}
                onClick={onNavigate}
                className="focus-ring group mt-auto inline-flex items-center gap-1.5 pt-4 text-sm font-semibold text-accent"
              >
                {f.cta.label}
                <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5" aria-hidden="true" />
              </Link>
            ) : (
              <a
                href={f.cta.href}
                onClick={onNavigate}
                className="focus-ring group mt-auto inline-flex items-center gap-1.5 pt-4 text-sm font-semibold text-accent"
              >
                {f.cta.label}
                <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5" aria-hidden="true" />
              </a>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center justify-end border-t border-border px-6 py-3">
        <Link
          to={panel.overview.href}
          onClick={onNavigate}
          className="focus-ring group inline-flex items-center gap-1.5 rounded text-sm font-semibold text-text-primary hover:text-accent"
        >
          {panel.overview.label}
          <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5" aria-hidden="true" />
        </Link>
      </div>
    </>
  );
}

type OpenMode = 'hover' | 'pinned' | null;

export function DesktopMegaNav() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const reduce = useReducedMotion();
  const { isRtl } = useDirection();
  const baseId = useId();
  const [openId, setOpenId] = useState<string | null>(null);
  const mode = useRef<OpenMode>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggers = useRef<Array<HTMLElement | null>>([]);
  const focusPanel = useRef(false);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const close = useCallback(() => {
    clear();
    mode.current = null;
    setOpenId(null);
  }, [clear]);

  useEffect(() => clear, [clear]);
  useEffect(() => close(), [pathname, close]);

  // Pinned panels (opened by click / keyboard) close on any outside press.
  useEffect(() => {
    if (!openId) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [openId, close]);

  // Keyboard open moves focus into the freshly opened panel.
  useEffect(() => {
    if (openId && focusPanel.current) {
      focusPanel.current = false;
      panelRef.current?.querySelector<HTMLElement>('a[href]')?.focus();
    }
  }, [openId]);

  const hoverOpen = (id: string) => {
    clear();
    if (openId !== null) {
      setOpenId(id);
      if (mode.current === null) mode.current = 'hover';
      return;
    }
    timer.current = setTimeout(() => {
      mode.current = 'hover';
      setOpenId(id);
    }, 90);
  };

  const scheduleClose = () => {
    clear();
    timer.current = setTimeout(close, 160);
  };

  const toggle = (id: string, viaKeyboard = false) => {
    clear();
    if (openId === id && mode.current === 'hover') {
      mode.current = 'pinned'; // first click after a hover-open keeps it open
      return;
    }
    if (openId === id) {
      close();
      return;
    }
    mode.current = 'pinned';
    focusPanel.current = viaKeyboard; // Enter/Space: move focus into the panel
    setOpenId(id);
  };

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLElement>, index: number, id: string, hasPanel: boolean) => {
    if (e.key === 'ArrowDown' && hasPanel) {
      e.preventDefault();
      mode.current = 'pinned';
      if (openId === id) {
        panelRef.current?.querySelector<HTMLElement>('a[href]')?.focus();
      } else {
        focusPanel.current = true;
        setOpenId(id);
      }
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const forward = (e.key === 'ArrowRight') !== isRtl;
      const next = (index + (forward ? 1 : -1) + NAV_ITEMS.length) % NAV_ITEMS.length;
      triggers.current[next]?.focus();
    }
  };

  const onWrapKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || !openId) return;
    const idx = NAV_ITEMS.findIndex((i) => i.id === openId);
    close();
    triggers.current[idx]?.focus();
  };

  const onWrapBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && !wrapRef.current?.contains(next)) close();
  };

  const openItem = NAV_ITEMS.find((i) => i.id === openId);

  return (
    <div
      ref={wrapRef}
      className="hidden items-center self-stretch lg:flex"
      onPointerEnter={clear}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse' && mode.current !== 'pinned') scheduleClose();
      }}
      onKeyDown={onWrapKeyDown}
      onBlur={onWrapBlur}
    >
      <nav aria-label="Main">
        <ul className="flex items-center gap-0.5">
          {NAV_ITEMS.map((item, index) => {
            const label = t(item.labelKey);
            const active = isNavItemActive(item, pathname);
            const open = openId === item.id;
            const hasPanel = Boolean(item.panel);
            const cls = `focus-ring group relative inline-flex h-9 items-center gap-1 rounded-lg px-2.5 text-sm font-medium transition-colors duration-150 ${
              active || open ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary'
            }`;
            const underline = active ? (
              <motion.span
                layoutId="header-active-underline"
                transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                className="absolute inset-x-2.5 bottom-0.5 h-px bg-accent"
              />
            ) : (
              <span className="absolute bottom-0.5 start-2.5 h-px w-0 bg-accent transition-all duration-200 ease-out group-hover:w-[calc(100%-1.25rem)]" />
            );
            return (
              <li key={item.id}>
                {hasPanel ? (
                  <button
                    type="button"
                    ref={(el) => {
                      triggers.current[index] = el;
                    }}
                    className={cls}
                    aria-expanded={open}
                    aria-haspopup="true"
                    aria-controls={open ? `${baseId}-panel` : undefined}
                    aria-current={active ? 'page' : undefined}
                    onClick={(e) => toggle(item.id, e.detail === 0)}
                    onKeyDown={(e) => onTriggerKeyDown(e, index, item.id, true)}
                    onPointerEnter={(e) => e.pointerType === 'mouse' && hoverOpen(item.id)}
                  >
                    {label}
                    <ChevronDown size={13} aria-hidden="true" className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                    {underline}
                  </button>
                ) : (
                  <Link
                    to={item.href}
                    ref={(el) => {
                      triggers.current[index] = el;
                    }}
                    className={cls}
                    aria-current={active ? 'page' : undefined}
                    onKeyDown={(e) => onTriggerKeyDown(e, index, item.id, false)}
                    onPointerEnter={(e) => {
                      if (e.pointerType === 'mouse' && mode.current !== 'pinned' && openId) scheduleClose();
                    }}
                  >
                    {label}
                    {underline}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      <AnimatePresence>
        {openItem?.panel && (
          <motion.div
            key="mega-panel"
            ref={panelRef}
            id={`${baseId}-panel`}
            role="group"
            aria-label={t(openItem.labelKey)}
            initial={reduce ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
            transition={{ duration: reduce ? 0 : 0.16, ease: EASE }}
            className="absolute inset-x-0 top-full z-dropdown pt-3"
          >
            <div className="overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-elevation-4">
              <PanelContent key={openItem.id} panel={openItem.panel} onNavigate={close} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
