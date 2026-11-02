import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { Accessibility, RotateCcw, Search, X } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useAccessibility } from '@/contexts/AccessibilityContext';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { announce } from '@/lib/a11y/announce';
import { startMediaGuard } from '@/lib/a11y/mediaControl';
import { CENTER_TABS, REGISTRY, SECTIONS, matchesQuery, type CenterTab, type SectionDef } from '@/lib/a11y/registry';
import { translate } from '@/lib/a11y/strings';
import { useA11yText } from '../useA11yText';
import { LiveRegion, Magnifier, ReadingAids } from '../AccessibilityOverlays';
import { Btn, Notice, Section } from './controls';
import { DataPanel, LanguagePanel, PageMapPanel, ProfilesPanel, RegistryRow, ShortcutsPanel, TtsPanel, VoicePanel } from './panels';
import { RuntimeProvider, useRuntimeValue } from './runtime';

const DIALOG_ID = 'a11y-center-dialog';
const FOCUSABLE =
  'button:not([disabled]),a[href],input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function usePortalRoot(): HTMLElement | null {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let node = document.getElementById('a11y-portal');
    const created = node === null;
    if (!node) {
      node = document.createElement('div');
      node.id = 'a11y-portal';
      document.body.appendChild(node);
    }
    setEl(node);
    return () => { if (created) node?.remove(); };
  }, []);
  return el;
}

function SectionBody({ id }: { id: SectionDef['id'] }) {
  switch (id) {
    case 'profiles': return <ProfilesPanel />;
    case 'tts': return <TtsPanel />;
    case 'voice': return <VoicePanel />;
    case 'shortcuts': return <ShortcutsPanel />;
    case 'pageMap': return <PageMapPanel />;
    case 'language': return <LanguagePanel />;
    case 'data': return <DataPanel />;
  }
}

function TabContent({ tab }: { tab: CenterTab }) {
  const { t } = useA11yText();
  const items = REGISTRY.filter((i) => i.tab === tab);
  const sections = SECTIONS.filter((s) => s.tab === tab);
  const tabLabel = t(CENTER_TABS.find((c) => c.id === tab)?.labelKey ?? 'title');
  const before = sections.filter((s) => s.id === 'profiles');
  const after = sections.filter((s) => s.id !== 'profiles');
  return (
    <div className="space-y-4">
      {before.map((s) => <Section key={s.id} id={`a11y-s-${s.id}`} title={t(s.titleKey)}><SectionBody id={s.id} /></Section>)}
      {items.length > 0 && (
        <Section id={`a11y-s-${tab}`} title={tabLabel}>
          <div className="divide-y-2 divide-bg-tertiary">{items.map((i) => <RegistryRow key={i.id} item={i} />)}</div>
        </Section>
      )}
      {after.map((s) => <Section key={s.id} id={`a11y-s-${s.id}`} title={t(s.titleKey)}><SectionBody id={s.id} /></Section>)}
    </div>
  );
}

function Panel({ tab, setTab, onClose, returnRef, isDesktop }: { tab: CenterTab; setTab: (t: CenterTab) => void; onClose: () => void; returnRef: RefObject<HTMLButtonElement | null>; isDesktop: boolean }) {
  const { t, language, rtl } = useA11yText();
  const { resetAll } = useAccessibility();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [query, setQuery] = useState('');
  const [confirm, setConfirm] = useState(false);
  const q = query.trim();

  /* modal behaviour: inert background, scroll lock (mobile), focus trap, Esc, focus return */
  useEffect(() => {
    const root = document.getElementById('root');
    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root?.setAttribute('inert', '');
    const prevOverflow = document.body.style.overflow;
    if (!isDesktop) document.body.style.overflow = 'hidden';
    dialog?.focus();
    const items = (): HTMLElement[] => (dialog ? Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0) : []);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== 'Tab' || !dialog) return;
      const list = items();
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) { e.preventDefault(); return; }
      const active = document.activeElement;
      if (active === dialog && e.shiftKey) { e.preventDefault(); last.focus(); }
      else if (!dialog.contains(active)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      root?.removeAttribute('inert'); // must precede focus(): inert elements cannot take focus
      document.body.style.overflow = prevOverflow;
      (returnRef.current ?? previouslyFocused)?.focus();
    };
  }, [isDesktop, returnRef]);

  const results = useMemo(() => {
    if (!q) return null;
    const items = REGISTRY.filter((i) => matchesQuery([t(i.labelKey), t(i.descKey), translate('en', i.labelKey), i.keywords], q));
    const sections = SECTIONS.filter((s) => matchesQuery([t(s.titleKey), translate('en', s.titleKey), s.keywords], q));
    return { items, sections };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, language]);
  const count = results ? results.items.length + results.sections.length : 0;
  useEffect(() => {
    if (!q) return;
    const id = window.setTimeout(() => announce(count > 0 ? t('resultsCount', { n: count }) : t('noResults')), 500);
    return () => window.clearTimeout(id);
  }, [q, count, t]);

  const onTabKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const idx = CENTER_TABS.findIndex((c) => c.id === tab);
    const fwd = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    let next = -1;
    if (e.key === fwd) next = (idx + 1) % CENTER_TABS.length;
    else if (e.key === back) next = (idx - 1 + CENTER_TABS.length) % CENTER_TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = CENTER_TABS.length - 1;
    const target = CENTER_TABS[next];
    if (!target) return;
    e.preventDefault();
    setTab(target.id);
    requestAnimationFrame(() => document.getElementById(`a11y-tab-${target.id}`)?.focus());
  };

  return (
    <>
      <div aria-hidden="true" data-a11y-ui onClick={onClose} className={`fixed inset-0 z-[73] ${isDesktop ? 'bg-transparent' : 'bg-black/60'}`} />
      <motion.div
        ref={dialogRef} id={DIALOG_ID} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        initial={{ opacity: 0, x: isDesktop ? (rtl ? -32 : 32) : 0, y: isDesktop ? 0 : 32 }}
        animate={{ opacity: 1, x: 0, y: 0 }} transition={{ duration: 0.2 }}
        className={`fixed z-[74] flex flex-col overflow-hidden bg-bg-primary text-text-primary shadow-card-hover outline-none ${isDesktop ? 'inset-y-0 end-0 w-[26rem] max-w-[100vw] border-s-2 border-text-secondary' : 'inset-0 h-[100dvh]'}`}
      >
        <div className="flex items-start justify-between gap-3 px-4 pb-2 pt-4">
          <div className="min-w-0">
            <h2 id={titleId} className="break-words text-xl font-extrabold text-text-primary">{t('title')}</h2>
            <p className="mt-0.5 break-words text-sm text-text-primary">{t('subtitle')}</p>
          </div>
          <Btn aria-label={t('close')} onClick={onClose} className="shrink-0 !px-2"><X size={20} aria-hidden="true" /></Btn>
        </div>

        <div className="px-4 pb-2">
          <label htmlFor="a11y-search" className="sr-only">{t('searchLabel')}</label>
          <div className="relative">
            <Search size={18} aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-text-primary" />
            <input id="a11y-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('searchPlaceholder')} autoComplete="off"
              className="focus-ring min-h-[44px] w-full rounded-xl border-2 border-text-secondary bg-bg-secondary py-2 pe-3 ps-10 text-base text-text-primary" />
          </div>
        </div>

        {!q && (
          <div role="tablist" aria-label={t('tabs')} aria-orientation="horizontal" onKeyDown={onTabKey} className="flex gap-1 overflow-x-auto px-3 pb-2">
            {CENTER_TABS.map((c) => {
              const on = c.id === tab;
              return (
                <button key={c.id} type="button" role="tab" id={`a11y-tab-${c.id}`} aria-selected={on} aria-controls={`a11y-panel-${c.id}`} tabIndex={on ? 0 : -1}
                  onClick={() => setTab(c.id)}
                  className={`focus-ring min-h-[44px] shrink-0 whitespace-nowrap rounded-xl border-2 px-3 py-2 text-sm font-bold ${on ? 'border-text-primary bg-text-primary text-bg-primary' : 'border-text-secondary bg-bg-secondary text-text-primary'}`}>
                  {t(c.labelKey)}
                </button>
              );
            })}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
          {results ? (
            <div role="region" aria-label={t('searchResults')} className="space-y-4">
              {count === 0 && <Notice>{t('noResults')}</Notice>}
              {results.items.length > 0 && (
                <Section id="a11y-s-results" title={t('searchResults')}>
                  <div className="divide-y-2 divide-bg-tertiary">{results.items.map((i) => <RegistryRow key={i.id} item={i} />)}</div>
                </Section>
              )}
              {results.sections.map((s) => <Section key={s.id} id={`a11y-s-${s.id}`} title={t(s.titleKey)}><SectionBody id={s.id} /></Section>)}
            </div>
          ) : (
            <div role="tabpanel" id={`a11y-panel-${tab}`} aria-labelledby={`a11y-tab-${tab}`} tabIndex={0} className="focus-ring rounded-xl outline-none">
              <TabContent tab={tab} />
            </div>
          )}
        </div>

        <div className="border-t-2 border-text-secondary bg-bg-primary px-4 py-3">
          {confirm ? (
            <div role="alertdialog" aria-labelledby="a11y-reset-q">
              <p id="a11y-reset-q" className="break-words text-sm font-semibold text-text-primary">{t('resetConfirm')}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Btn variant="primary" autoFocus onClick={() => { resetAll(); setConfirm(false); announce(t('resetDone')); }}>{t('resetYes')}</Btn>
                <Btn onClick={() => setConfirm(false)}>{t('cancel')}</Btn>
              </div>
            </div>
          ) : (
            <Btn onClick={() => setConfirm(true)} className="w-full"><RotateCcw size={16} aria-hidden="true" />{t('reset')}</Btn>
          )}
        </div>
      </motion.div>
    </>
  );
}

export function AccessibilityCenter({ openOnMount = false }: { openOnMount?: boolean }) {
  const { t } = useA11yText();
  const { settings } = useAccessibility();
  const { pathname } = useLocation();
  const isDesktop = useMediaQuery('(min-width: 640px)', true);
  const portal = usePortalRoot();
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(openOnMount);
  const [tab, setTab] = useState<CenterTab>('quick');
  const openCenter = useCallback((next?: CenterTab) => { if (next) setTab(next); setOpen(true); }, []);
  const closeCenter = useCallback(() => setOpen(false), []);
  const runtime = useRuntimeValue(openCenter, closeCenter);

  useEffect(() => {
    const onOpen = (e: Event) => openCenter((e as CustomEvent<{ tab?: CenterTab } | undefined>).detail?.tab);
    window.addEventListener('vk-a11y-open', onOpen);
    return () => window.removeEventListener('vk-a11y-open', onOpen);
  }, [openCenter]);

  const guard = settings.stopAnimations || settings.focusMode;
  useEffect(() => (guard ? startMediaGuard() : undefined), [guard]);

  if (pathname.startsWith('/wallboard')) return null;
  return (
    <RuntimeProvider value={runtime}>
      <button
        ref={btnRef} type="button" aria-label={t('open')} aria-haspopup="dialog" aria-expanded={open} aria-controls={DIALOG_ID}
        onClick={() => openCenter()} data-a11y-ui
        className="focus-ring fixed bottom-[calc(1.25rem+var(--vk-bottom-nav-h,0px))] end-5 z-[72] flex h-14 w-14 items-center justify-center rounded-full border-2 border-bg-secondary bg-accent text-white shadow-card-hover"
      >
        <Accessibility size={26} aria-hidden="true" />
      </button>
      {portal && createPortal(
        <>
          <LiveRegion />
          {settings.magnifier && <Magnifier />}
          {(settings.readingMask || settings.readingGuide) && <ReadingAids mask={settings.readingMask} guide={settings.readingGuide} />}
          {open && <Panel tab={tab} setTab={setTab} onClose={closeCenter} returnRef={btnRef} isDesktop={isDesktop} />}
        </>,
        portal,
      )}
    </RuntimeProvider>
  );
}
