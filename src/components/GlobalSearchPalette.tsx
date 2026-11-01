import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  AlertCircle,
  ArrowUpRight,
  BookOpen,
  BookUser,
  Cpu,
  FileText,
  Loader2,
  PhoneCall,
  Plus,
  Receipt,
  Search,
  UserCog,
  Users,
  Wrench,
  CornerDownLeft,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { trackEvent } from '@/lib/analytics';
import { useFocusTrap } from '@/lib/a11y/focusTrap';
import { PRODUCTIVITY_NS } from '@/i18n/productivityLocales';
import { navLabelKey } from '@/lib/navLabel';
import { OperatorPanel } from '@/components/operator/OperatorPanel';
import { ShortcutHint } from '@/components/shortcuts/ShortcutHint';
import { useShortcutHandlers } from '@/lib/shortcuts/useShortcuts';
import {
  MIN_QUERY_LENGTH,
  PAGES,
  QUICK_ACTIONS,
  SCOPE_PREFIX,
  SCOPE_TYPES,
  createSearchCache,
  groupResults,
  highlightSegments,
  loadRecents,
  parseScopedQuery,
  pushRecent,
  rankCommands,
  rowToResult,
  scoreCommand,
  type GlobalSearchResult,
  type GlobalSearchRow,
  type PaletteCommand,
  type PaletteScope,
  type RecentItem,
  type SearchEntityType,
} from '@/lib/globalSearch';

/** Fire this from any button to open the palette: window.dispatchEvent(new Event(OPEN_PALETTE_EVENT)). */
export const OPEN_PALETTE_EVENT = 'vireek:open-command-palette';

/** Opens the palette, optionally pre-filled (e.g. openPalette('> ') for actions only). */
export function openPalette(query?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT, { detail: { query } }));
}

/** Short on purpose: client-side commands are instant and repeat queries hit the cache, so this is the only wait. */
const DEBOUNCE_MS = 90;

const ENTITY_ICONS: Record<SearchEntityType, LucideIcon> = {
  customer: BookUser,
  job: Wrench,
  quote: FileText,
  invoice: Receipt,
  equipment: Cpu,
  team: UserCog,
  knowledge: BookOpen,
  lead: Users,
  call: PhoneCall,
};

interface PaletteItem {
  id: string;
  label: string;
  sublabel: string;
  status?: string | null;
  icon: LucideIcon;
  href: string;
  state?: unknown;
  shortcutId?: string;
  /** Set on the "Ask Operator" row: opens the Operator panel instead of navigating. */
  operator?: string;
  recent: RecentItem;
}

interface Section {
  id: string;
  label: string;
  items: PaletteItem[];
}

function commandToItem(cmd: PaletteCommand, label: string, actionLabel: string): PaletteItem {
  return {
    id: cmd.id,
    label,
    sublabel: cmd.kind === 'action' ? actionLabel : '',
    icon: cmd.kind === 'action' ? Plus : ArrowUpRight,
    href: cmd.href,
    state: cmd.state,
    shortcutId: cmd.shortcutId,
    recent: { key: cmd.id, kind: 'command', label, sublabel: '', href: cmd.href, state: cmd.state },
  };
}

function resultToItem(r: GlobalSearchResult): PaletteItem {
  return {
    id: r.key,
    label: r.title,
    sublabel: r.subtitle,
    status: r.status,
    icon: ENTITY_ICONS[r.type],
    href: r.href,
    recent: { key: r.key, kind: 'result', type: r.type, label: r.title, sublabel: r.subtitle, href: r.href },
  };
}

function recentToItem(r: RecentItem): PaletteItem {
  return {
    id: `recent:${r.key}`,
    label: r.label,
    sublabel: r.sublabel,
    icon: r.type ? ENTITY_ICONS[r.type] : ArrowUpRight,
    href: r.href,
    state: r.state,
    recent: r,
  };
}

function Highlight({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightSegments(text, query).map((seg, i) =>
        seg.match ? (
          <mark key={i} className="bg-transparent font-semibold text-text-primary underline decoration-text-secondary/40 underline-offset-2">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

const NO_RESULTS: GlobalSearchResult[] = [];

const SCOPE_LABELS: Record<Exclude<PaletteScope, 'all'>, string> = { actions: 'Actions', people: 'People', jobs: 'Jobs' };

interface ScopedResults {
  scope: PaletteScope;
  rows: GlobalSearchResult[];
}

/** Free-form text of 3+ words reads like an instruction for Operator rather than a record lookup. */
const looksLikeInstruction = (q: string) => q.split(' ').filter(Boolean).length >= 3;

/**
 * Global Cmd+K / Ctrl+K command palette — the single search + command surface.
 *
 *  - Records: ranked, permission-aware search across customers, jobs, quotes,
 *    invoices, equipment, team, knowledge, leads and calls (RPC `global_search`,
 *    SECURITY INVOKER so RLS applies).
 *  - Scoped prefixes: ">" actions (+ Ask Operator), "@" people, "#" jobs.
 *  - Recent items, quick actions and page navigation with live key hints that
 *    come from the shortcut registry (so they follow user customisation).
 *  - Opened by the registry shortcut `palette.toggle` (default Cmd/Ctrl+K), not by its own key listener.
 *    Deliberately not bound to "/" (several pages own it).
 */
export function GlobalSearchPalette() {
  const { t } = useTranslation(PRODUCTIVITY_NS);
  const { t: tNav } = useTranslation('dashboard');
  const reduceMotion = useReducedMotion();
  const { user, permissions } = useAuth();
  const navigate = useNavigate();
  const listId = useId();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<ScopedResults>({ scope: 'all', rows: [] });
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [retry, setRetry] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [recents, setRecents] = useState<RecentItem[]>([]);
  const [operatorQuery, setOperatorQuery] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const lastSearchMs = useRef<number | null>(null);
  const cacheRef = useRef(createSearchCache<GlobalSearchResult[]>());
  const trapRef = useFocusTrap(open);

  const { scope, term: q } = parseScopedQuery(query);
  const serverTypes = SCOPE_TYPES[scope];
  const canSearch = q.length >= MIN_QUERY_LENGTH && !(serverTypes !== null && serverTypes.length === 0);
  // Results are only valid for the scope they were fetched under (never show people under "#").
  const results = found.scope === scope ? found.rows : NO_RESULTS;

  const perms = useMemo(
    () => ({
      can_view_billing: permissions.can_view_billing,
      can_manage_team: permissions.can_manage_team,
      can_edit_business_profile: permissions.can_edit_business_profile,
    }),
    [permissions.can_view_billing, permissions.can_manage_team, permissions.can_edit_business_profile],
  );

  // Labels are translated BEFORE ranking so matching works in the user's language.
  const pages = useMemo(
    () => PAGES.map((c) => ({ ...c, label: tNav(navLabelKey(c.label), { defaultValue: c.label }) })),
    [tNav],
  );
  const actions = useMemo(
    () => QUICK_ACTIONS.map((c) => ({ ...c, label: c.labelKey ? t(c.labelKey, { defaultValue: c.label }) : c.label })),
    [t],
  );

  // --- open / close ----------------------------------------------------------
  const close = useCallback(() => setOpen(false), []);

  // Open/toggle keys come from the central, user-customisable registry.
  useShortcutHandlers({
    'palette.toggle': () => setOpen((v) => !v),
    'palette.actions': () => {
      setQuery(`${SCOPE_PREFIX.actions} `);
      setOpen(true);
    },
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onOpenEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ query?: string } | undefined>).detail;
      if (typeof detail?.query === 'string') setQuery(detail.query);
      setOpen(true);
    };
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpenEvent);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpenEvent);
    };
  }, []);

  useEffect(() => {
    cacheRef.current.clear(); // never serve one user's cached rows to another
  }, [user?.id]);

  useEffect(() => {
    if (open) {
      setRecents(loadRecents(user?.id));
      trackEvent('palette_open'); // consent-gated inside trackEvent; carries no query text
      return undefined;
    }
    requestRef.current += 1; // invalidate in-flight requests
    setQuery('');
    setFound({ scope: 'all', rows: [] });
    setStatus('idle');
    setActiveIndex(0);
    setOperatorQuery(null);
    return undefined;
  }, [open, user?.id]);

  // --- debounced server search (+ instant cache hits) ------------------------
  useEffect(() => {
    if (!open) return undefined;
    if (!canSearch) {
      requestRef.current += 1;
      setFound({ scope, rows: [] });
      setStatus('idle');
      return undefined;
    }
    const id = ++requestRef.current;
    const cacheKey = `${user?.id ?? ''}|${scope}|${q.toLowerCase()}`;
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      setFound({ scope, rows: cached });
      setStatus('done');
      lastSearchMs.current = 0;
      return undefined;
    }
    setStatus('loading');
    const startedAt = performance.now();
    const timer = setTimeout(async () => {
      const { data, error } = await supabase.rpc('global_search', { p_query: q, p_types: serverTypes, p_limit: 24 });
      if (id !== requestRef.current) return; // a newer query (or close) superseded this one
      if (error) {
        // eslint-disable-next-line no-console
        console.error('[Vireek] global_search failed', error);
        setStatus('error');
        return;
      }
      const rows = ((data ?? []) as GlobalSearchRow[]).map(rowToResult);
      cacheRef.current.set(cacheKey, rows);
      lastSearchMs.current = Math.round(performance.now() - startedAt);
      setFound({ scope, rows });
      setStatus('done');
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `scope`/`serverTypes` derive from `query`; `q` is the normalised term.
  }, [open, q, scope, serverTypes, canSearch, retry, user?.id]);

  // --- sections --------------------------------------------------------------
  const sections = useMemo<Section[]>(() => {
    const actionLabel = t('palette.quickAction', { defaultValue: 'Quick action' });
    const toItems = (cmds: PaletteCommand[]) => cmds.map((c) => commandToItem(c, c.label, actionLabel));
    const sectionLabel = (id: 'recent' | 'actions' | 'pages', fallback: string) =>
      t(`palette.sections.${id}`, { defaultValue: fallback });
    const operatorSection = (text: string): Section => ({
      id: 'operator',
      label: sectionLabel('actions', 'Quick actions'),
      items: [
        {
          id: 'operator',
          label: t('palette.askOperator', { text, defaultValue: 'Ask Operator: “{{text}}”' }),
          sublabel: '',
          icon: Sparkles,
          href: '',
          operator: text,
          recent: { key: 'operator', kind: 'command', label: text, sublabel: '', href: '' },
        },
      ],
    });

    if (scope === 'actions') {
      const ranked = rankCommands(q, actions, perms, 8);
      const out: Section[] = [{ id: 'actions', label: sectionLabel('actions', 'Quick actions'), items: toItems(ranked) }];
      if (q.length >= 2) out.push(operatorSection(q));
      return out.filter((s) => s.items.length > 0);
    }

    const resultSections: Section[] = groupResults(results).map((g) => ({
      id: g.type,
      label: t(`palette.entities.${g.type}`, { defaultValue: g.label }),
      items: g.items.map(resultToItem),
    }));

    if (scope === 'people' || scope === 'jobs') return resultSections;

    const rankedActions = rankCommands(q, actions, perms, 3);
    const rankedPages = rankCommands(q, pages, perms, q ? 5 : 8);
    const actionSection: Section = { id: 'actions', label: sectionLabel('actions', 'Quick actions'), items: toItems(rankedActions) };
    const pageSection: Section = { id: 'pages', label: sectionLabel('pages', 'Pages'), items: toItems(rankedPages) };

    if (!q) {
      const out: Section[] = [];
      if (recents.length > 0) out.push({ id: 'recent', label: sectionLabel('recent', 'Recent'), items: recents.map(recentToItem) });
      out.push(actionSection, pageSection);
      return out.filter((s) => s.items.length > 0);
    }

    // A strong match on an action ("new job") goes above record results.
    const strongAction = rankedActions.length > 0 && scoreCommand(q, rankedActions[0]) >= 1.0;
    const ordered = strongAction
      ? [actionSection, ...resultSections, pageSection]
      : [...resultSections, actionSection, pageSection];
    const out = ordered.filter((s) => s.items.length > 0);
    // Nothing matched and it reads like an instruction: offer Operator as the fallback.
    if (out.length === 0 && status === 'done' && looksLikeInstruction(q)) out.push(operatorSection(q));
    return out;
  }, [q, scope, results, recents, perms, actions, pages, status, t]);

  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  useEffect(() => setActiveIndex(0), [q, scope, results]);

  useEffect(() => {
    document.getElementById(`${listId}-opt-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, listId]);

  // --- actions ---------------------------------------------------------------
  const choose = useCallback(
    (item: PaletteItem, position: number) => {
      trackEvent('palette_select', {
        scope,
        kind: item.operator !== undefined ? 'operator' : item.id.split(':')[0],
        position,
        search_ms: lastSearchMs.current,
      });
      if (item.operator !== undefined) {
        setOperatorQuery(item.operator);
        return;
      }
      pushRecent(user?.id, item.recent);
      setOpen(false);
      navigate(item.href, item.state !== undefined ? { state: item.state } : undefined);
    },
    [navigate, user?.id, scope],
  );

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return; // IME (Persian/CJK) confirmation must not trigger navigation
    if (flat.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % flat.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + flat.length) % flat.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = flat[activeIndex];
      if (item) choose(item, activeIndex);
    }
  };

  const hasRecordResults = flat.some((i) => i.operator === undefined);
  const showEmpty = canSearch && status === 'done' && !hasRecordResults;
  const showActionsEmpty = scope === 'actions' && q.length > 0 && !hasRecordResults && flat.length === 0;
  const liveText =
    status === 'loading'
      ? t('palette.live.searching', { defaultValue: 'Searching' })
      : status === 'error'
        ? t('palette.live.unavailable', { defaultValue: 'Search unavailable' })
        : canSearch || scope === 'actions'
          ? t('palette.live.results', { count: flat.length, defaultValue: '{{count}} results' })
          : '';

  let runningIndex = -1;
  const fade = { duration: reduceMotion ? 0 : 0.15 };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="cmdk-backdrop"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={fade}
            onClick={close}
            className="fixed inset-0 z-[130] bg-black/40 backdrop-blur-sm"
          />
          <div key="cmdk-wrap" className="pointer-events-none fixed inset-x-0 top-[12vh] z-[140] flex justify-center">
          <motion.div
            key="cmdk-panel"
            ref={trapRef}
            role="dialog"
            aria-modal="true"
            aria-label={t('palette.title', { defaultValue: 'Search and quick navigation' })}
            tabIndex={-1}
            initial={reduceMotion ? false : { opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.98 }}
            transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="pointer-events-auto w-[94vw] max-w-xl overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card-hover dark:shadow-card-hover-dark"
          >
            {operatorQuery !== null ? (
              <OperatorPanel instruction={operatorQuery} onBack={() => setOperatorQuery(null)} onClose={close} />
            ) : (
              <>
                <div className="flex items-center gap-3 border-b border-border px-4 py-3.5">
                  {status === 'loading' ? (
                    <Loader2 size={17} className="animate-spin text-text-secondary motion-reduce:animate-none" aria-hidden="true" />
                  ) : (
                    <Search size={17} className="text-text-secondary" aria-hidden="true" />
                  )}
                  {scope !== 'all' && (
                    <span className="shrink-0 rounded-md bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">
                      {t(`palette.scope.${scope}`, { defaultValue: SCOPE_LABELS[scope] })}
                    </span>
                  )}
                  <input
                    ref={inputRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onInputKeyDown}
                    role="combobox"
                    aria-expanded="true"
                    aria-controls={listId}
                    aria-activedescendant={flat.length > 0 ? `${listId}-opt-${activeIndex}` : undefined}
                    aria-autocomplete="list"
                    aria-label={t('palette.title', { defaultValue: 'Search and quick navigation' })}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    maxLength={80}
                    placeholder={t('palette.placeholder', { defaultValue: 'Search records, jump to a page, or type > for actions' })}
                    className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-secondary/60"
                  />
                  <kbd className="hidden rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-text-secondary sm:inline">
                    {t('palette.close', { defaultValue: 'Esc' })}
                  </kbd>
                </div>

                <p className="sr-only" role="status" aria-live="polite">
                  {liveText}
                </p>

                <div id={listId} role="listbox" aria-label={t('palette.results', { defaultValue: 'Results' })} className="max-h-[56vh] overflow-y-auto py-2">
                  {status === 'error' && (
                    <div className="flex items-center gap-3 px-4 py-3 text-sm text-text-secondary">
                      <AlertCircle size={16} aria-hidden="true" />
                      <span className="flex-1">{t('palette.unavailable', { defaultValue: 'Search is unavailable right now.' })}</span>
                      <button
                        type="button"
                        onClick={() => setRetry((n) => n + 1)}
                        className="focus-ring rounded-md border border-border px-2.5 py-1 text-xs font-medium text-text-primary hover:bg-bg-tertiary"
                      >
                        {t('palette.retry', { defaultValue: 'Retry' })}
                      </button>
                    </div>
                  )}

                  {q.length === 0 && (
                    <p className="px-4 pb-1 pt-1 text-[11px] text-text-secondary/70">
                      {t('palette.tip', { defaultValue: 'Tip: > actions · @ people · # jobs' })}
                    </p>
                  )}

                  {q.length > 0 && !canSearch && scope !== 'actions' && (
                    <p className="px-4 py-2 text-xs text-text-secondary">
                      {t('palette.minChars', { count: MIN_QUERY_LENGTH, defaultValue: 'Type at least {{count}} characters to search records.' })}
                    </p>
                  )}

                  {sections.map((section) => (
                    <div key={section.id} role="group" aria-label={section.label}>
                      <p className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-text-secondary/60">
                        {section.label}
                      </p>
                      {section.items.map((item) => {
                        runningIndex += 1;
                        const index = runningIndex;
                        const active = index === activeIndex;
                        return (
                          <button
                            key={item.id}
                            id={`${listId}-opt-${index}`}
                            type="button"
                            role="option"
                            aria-selected={active}
                            tabIndex={-1}
                            onClick={() => choose(item, index)}
                            onMouseMove={() => {
                              if (!active) setActiveIndex(index);
                            }}
                            className={`flex w-full items-center gap-3 px-4 py-2.5 text-start ${
                              active ? 'bg-bg-tertiary' : 'hover:bg-bg-tertiary'
                            }`}
                          >
                            <item.icon size={16} className="shrink-0 text-text-secondary" aria-hidden="true" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm text-text-primary">
                                <Highlight text={item.label} query={q} />
                              </span>
                              {item.sublabel && (
                                <span className="block truncate text-xs text-text-secondary">
                                  <Highlight text={item.sublabel} query={q} />
                                </span>
                              )}
                            </span>
                            {item.status && (
                              <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium capitalize text-text-secondary">
                                {item.status.replace(/_/g, ' ')}
                              </span>
                            )}
                            {item.shortcutId && <ShortcutHint id={item.shortcutId} className="hidden sm:inline-flex" />}
                            {active && <CornerDownLeft size={13} className="shrink-0 text-text-secondary/60 rtl:-scale-x-100" aria-hidden="true" />}
                          </button>
                        );
                      })}
                    </div>
                  ))}

                  {showEmpty && (
                    <p className="px-4 py-8 text-center text-sm text-text-secondary">
                      {t('palette.noResults', {
                        query: q,
                        defaultValue: 'No results for “{{query}}”. Try a name, phone number, serial number or invoice number.',
                      })}
                    </p>
                  )}
                  {showActionsEmpty && (
                    <p className="px-4 py-8 text-center text-sm text-text-secondary">
                      {t('palette.noActions', { defaultValue: 'No matching actions. Try “new job” or “invite”.' })}
                    </p>
                  )}
                </div>

                <div className="hidden items-center justify-between border-t border-border px-4 py-2 text-[11px] text-text-secondary sm:flex">
                  <span>{t('palette.navHint', { defaultValue: '↑↓ to navigate · ↵ to open' })}</span>
                  <ShortcutHint id="palette.toggle" />
                </div>
              </>
            )}
          </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
