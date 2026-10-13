import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
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
  type LucideIcon,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import {
  MIN_QUERY_LENGTH,
  PAGES,
  QUICK_ACTIONS,
  groupResults,
  highlightSegments,
  loadRecents,
  normalizeQuery,
  pushRecent,
  rankCommands,
  rowToResult,
  scoreCommand,
  type GlobalSearchResult,
  type GlobalSearchRow,
  type PaletteCommand,
  type RecentItem,
  type SearchEntityType,
} from '@/lib/globalSearch';

/** Fire this from any button to open the palette: window.dispatchEvent(new Event(OPEN_PALETTE_EVENT)). */
export const OPEN_PALETTE_EVENT = 'vireek:open-command-palette';

const DEBOUNCE_MS = 200;

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
  recent: RecentItem;
}

interface Section {
  id: string;
  label: string;
  items: PaletteItem[];
}

function commandToItem(cmd: PaletteCommand): PaletteItem {
  return {
    id: cmd.id,
    label: cmd.label,
    sublabel: cmd.kind === 'action' ? 'Quick action' : '',
    icon: cmd.kind === 'action' ? Plus : ArrowUpRight,
    href: cmd.href,
    state: cmd.state,
    recent: { key: cmd.id, kind: 'command', label: cmd.label, sublabel: '', href: cmd.href, state: cmd.state },
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

/**
 * Global Cmd+K / Ctrl+K palette: ranked, permission-aware search across
 * customers, jobs, quotes, invoices, equipment, team, knowledge, leads and
 * calls (Postgres RPC `global_search`), plus recent items, quick actions and
 * page navigation. Deliberately not bound to "/" (several pages own it).
 */
export function GlobalSearchPalette() {
  const { user, permissions } = useAuth();
  const navigate = useNavigate();
  const listId = useId();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [retry, setRetry] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [recents, setRecents] = useState<RecentItem[]>([]);

  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const requestRef = useRef(0);

  const q = normalizeQuery(query);
  const canSearch = q.length >= MIN_QUERY_LENGTH;

  const perms = useMemo(
    () => ({
      can_view_billing: permissions.can_view_billing,
      can_manage_team: permissions.can_manage_team,
      can_edit_business_profile: permissions.can_edit_business_profile,
    }),
    [permissions.can_view_billing, permissions.can_manage_team, permissions.can_edit_business_profile],
  );

  // --- open / close ----------------------------------------------------------
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    const onOpenEvent = () => setOpen(true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpenEvent);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpenEvent);
    };
  }, []);

  useEffect(() => {
    if (open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setRecents(loadRecents(user?.id));
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
    requestRef.current += 1; // invalidate in-flight requests
    setQuery('');
    setResults([]);
    setStatus('idle');
    setActiveIndex(0);
    returnFocusRef.current?.focus?.();
    return undefined;
  }, [open, user?.id]);

  // --- debounced server search ----------------------------------------------
  useEffect(() => {
    if (!open) return undefined;
    if (!canSearch) {
      requestRef.current += 1;
      setResults([]);
      setStatus('idle');
      return undefined;
    }
    setStatus('loading');
    const id = ++requestRef.current;
    const timer = setTimeout(async () => {
      const { data, error } = await supabase.rpc('global_search', { p_query: q, p_types: null, p_limit: 24 });
      if (id !== requestRef.current) return; // a newer query (or close) superseded this one
      if (error) {
        // eslint-disable-next-line no-console
        console.error('[Vireek] global_search failed', error);
        setStatus('error');
        return;
      }
      setResults(((data ?? []) as GlobalSearchRow[]).map(rowToResult));
      setStatus('done');
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, q, canSearch, retry]);

  // --- sections --------------------------------------------------------------
  const sections = useMemo<Section[]>(() => {
    const out: Section[] = [];
    const actions = rankCommands(q, QUICK_ACTIONS, perms, 3);
    const pages = rankCommands(q, PAGES, perms, q ? 5 : 8);

    if (!q) {
      if (recents.length > 0) out.push({ id: 'recent', label: 'Recent', items: recents.map(recentToItem) });
      out.push({ id: 'actions', label: 'Quick actions', items: actions.map(commandToItem) });
      out.push({ id: 'pages', label: 'Pages', items: pages.map(commandToItem) });
      return out.filter((s) => s.items.length > 0);
    }

    const resultSections: Section[] = groupResults(results).map((g) => ({
      id: g.type,
      label: g.label,
      items: g.items.map(resultToItem),
    }));
    const actionSection: Section = { id: 'actions', label: 'Quick actions', items: actions.map(commandToItem) };
    const pageSection: Section = { id: 'pages', label: 'Pages', items: pages.map(commandToItem) };

    // A strong match on an action ("new job") goes above record results.
    const strongAction = actions.length > 0 && scoreCommand(q, actions[0]) >= 1.0;
    return (strongAction ? [actionSection, ...resultSections, pageSection] : [...resultSections, actionSection, pageSection]).filter(
      (s) => s.items.length > 0,
    );
  }, [q, results, recents, perms]);

  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  useEffect(() => setActiveIndex(0), [q, results]);

  useEffect(() => {
    document.getElementById(`${listId}-opt-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, listId]);

  // --- actions ---------------------------------------------------------------
  const choose = useCallback(
    (item: PaletteItem) => {
      pushRecent(user?.id, item.recent);
      setOpen(false);
      navigate(item.href, item.state !== undefined ? { state: item.state } : undefined);
    },
    [navigate, user?.id],
  );

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
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
      if (item) choose(item);
    }
  };

  const showEmpty = canSearch && status === 'done' && flat.length === 0;
  const liveText =
    status === 'loading' ? 'Searching' : status === 'error' ? 'Search unavailable' : canSearch ? `${flat.length} results` : '';

  let runningIndex = -1;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="cmdk-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={close}
            className="fixed inset-0 z-[130] bg-black/40 backdrop-blur-sm"
          />
          <motion.div
            key="cmdk-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Search and quick navigation"
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="fixed left-1/2 top-[12vh] z-[140] w-[94vw] max-w-xl -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card-hover dark:shadow-card-hover-dark"
          >
            <div className="flex items-center gap-3 border-b border-border px-4 py-3.5">
              {status === 'loading' ? (
                <Loader2 size={17} className="animate-spin text-text-secondary" aria-hidden="true" />
              ) : (
                <Search size={17} className="text-text-secondary" aria-hidden="true" />
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
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                maxLength={80}
                placeholder="Search customers, jobs, quotes, invoices, equipment…"
                className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-secondary/60"
              />
              <kbd className="hidden rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-text-secondary sm:inline">
                Esc
              </kbd>
            </div>

            <p className="sr-only" role="status" aria-live="polite">
              {liveText}
            </p>

            <div id={listId} role="listbox" aria-label="Results" className="max-h-[56vh] overflow-y-auto py-2">
              {status === 'error' && (
                <div className="flex items-center gap-3 px-4 py-3 text-sm text-text-secondary">
                  <AlertCircle size={16} aria-hidden="true" />
                  <span className="flex-1">Search is unavailable right now.</span>
                  <button
                    type="button"
                    onClick={() => setRetry((n) => n + 1)}
                    className="focus-ring rounded-md border border-border px-2.5 py-1 text-xs font-medium text-text-primary hover:bg-bg-tertiary"
                  >
                    Retry
                  </button>
                </div>
              )}

              {q.length > 0 && !canSearch && (
                <p className="px-4 py-2 text-xs text-text-secondary">Type at least {MIN_QUERY_LENGTH} characters to search records.</p>
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
                        onClick={() => choose(item)}
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
                        {active && <CornerDownLeft size={13} className="shrink-0 text-text-secondary/60" aria-hidden="true" />}
                      </button>
                    );
                  })}
                </div>
              ))}

              {showEmpty && (
                <p className="px-4 py-8 text-center text-sm text-text-secondary">
                  No results for “{q}”. Try a name, phone number, serial number or invoice number.
                </p>
              )}
            </div>

            <div className="hidden items-center justify-between border-t border-border px-4 py-2 text-[11px] text-text-secondary sm:flex">
              <span>↑↓ to navigate · ↵ to open</span>
              <span>⌘K to toggle</span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
