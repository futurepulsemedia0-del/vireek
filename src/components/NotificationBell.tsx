import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  Bell,
  BellOff,
  BellRing,
  PhoneCall,
  Gauge,
  Lightbulb,
  Wrench,
  Info,
  CheckCheck,
  Check,
  CircleDot,
  Settings,
  SlidersHorizontal,
  Trash2,
  Volume2,
  VolumeX,
  RotateCw,
  AlertCircle,
  ShieldAlert,
  Eye,
  AtSign,
  MessageSquare,
  ArrowRight,
} from 'lucide-react';
import { useNotifications } from '@/contexts/NotificationsContext';
import type { NotificationRow } from '@/contexts/NotificationsContext';

// Re-exported so existing imports of `NotificationRow` from this file
// (e.g. NotificationsPage.tsx) keep working unchanged — the type itself
// now lives in NotificationsContext, alongside the state it describes.
export type { NotificationRow };

const TYPE_ICON: Record<NotificationRow['type'], typeof Bell> = {
  emergency_call: PhoneCall,
  usage_alert: Gauge,
  ai_insight: Lightbulb,
  job_update: Wrench,
  warranty_alert: ShieldAlert,
  quote_viewed: Eye,
  comment_mention: AtSign,
  comment_reply: MessageSquare,
  system: Info,
};

const TYPE_COLOR: Record<NotificationRow['type'], string> = {
  emergency_call: 'bg-danger/10 text-danger',
  usage_alert: 'bg-warning-subtle text-warning',
  ai_insight: 'bg-ai/10 text-ai',
  job_update: 'bg-accent/10 text-accent',
  warranty_alert: 'bg-warning-subtle text-warning',
  quote_viewed: 'bg-success-subtle text-success',
  comment_mention: 'bg-accent/10 text-accent',
  comment_reply: 'bg-accent/10 text-accent',
  system: 'bg-bg-tertiary text-text-secondary',
};

const TYPE_LABEL: Record<NotificationRow['type'], string> = {
  emergency_call: 'Emergency call',
  usage_alert: 'Usage alert',
  ai_insight: 'AI insight',
  job_update: 'Job update',
  warranty_alert: 'Warranty alert',
  quote_viewed: 'Estimate activity',
  comment_mention: 'Mention',
  comment_reply: 'Thread reply',
  system: 'System',
};

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.floor(Math.max(0, Date.now() - then) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

type GroupKey = 'today' | 'yesterday' | 'earlier';
const GROUP_LABEL: Record<GroupKey, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  earlier: 'Earlier',
};

function groupByDay(rows: NotificationRow[]) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  const buckets: Record<GroupKey, NotificationRow[]> = { today: [], yesterday: [], earlier: [] };
  for (const row of rows) {
    const t = new Date(row.created_at).getTime();
    if (t >= startOfToday.getTime()) buckets.today.push(row);
    else if (t >= startOfYesterday.getTime()) buckets.yesterday.push(row);
    else buckets.earlier.push(row);
  }
  return (Object.keys(buckets) as GroupKey[])
    .filter((k) => buckets[k].length > 0)
    .map((k) => ({ key: k, label: GROUP_LABEL[k], rows: buckets[k] }));
}

/** Only in-app paths are navigable — blocks absolute URLs, `//host` and `javascript:` payloads. */
function isInternalPath(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//');
}

const PANEL_WIDTH = 400;
const EDGE = 8;
const GAP = 8;

interface PanelPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

function computePosition(trigger: HTMLElement): PanelPosition {
  const r = trigger.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(PANEL_WIDTH, vw - EDGE * 2);
  // Bell in the left half (desktop sidebar) → open rightwards; otherwise align to its right edge.
  const opensRight = r.left + r.width / 2 < vw / 2;
  const ideal = opensRight ? r.left : r.right - width;
  const left = Math.max(EDGE, Math.min(ideal, vw - width - EDGE));
  const top = r.bottom + GAP;
  const maxHeight = Math.max(200, Math.min(600, vh - top - EDGE));
  return { top, left, width, maxHeight };
}

function NotificationSkeleton() {
  return (
    <div className="flex items-start gap-3 px-3 py-2.5" aria-hidden="true">
      <div className="h-9 w-9 shrink-0 animate-pulse rounded-xl bg-bg-tertiary" />
      <div className="flex-1 space-y-2 pt-0.5">
        <div className="h-3.5 w-2/3 animate-pulse rounded bg-bg-tertiary" />
        <div className="h-3 w-full animate-pulse rounded bg-bg-tertiary" />
        <div className="h-3 w-1/3 animate-pulse rounded bg-bg-tertiary" />
      </div>
    </div>
  );
}

function PreferenceRow({
  icon: Icon,
  label,
  hint,
  checked,
  disabled,
  onToggle,
}: {
  icon: typeof Bell;
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-1 py-1.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bg-tertiary text-text-secondary">
        <Icon size={15} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-text-primary">{label}</span>
        <span className="block text-xs text-text-secondary">{hint}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={onToggle}
        className={`focus-ring relative h-6 w-10 shrink-0 rounded-full border border-border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          checked ? 'bg-accent' : 'bg-bg-tertiary'
        }`}
      >
        <span
          className={`absolute left-px top-px h-5 w-5 rounded-full bg-bg-primary shadow-sm transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}

function NotificationItem({
  row,
  onOpen,
  onToggleRead,
  onDelete,
}: {
  row: NotificationRow;
  onOpen: (row: NotificationRow) => void;
  onToggleRead: (row: NotificationRow) => void;
  onDelete: (row: NotificationRow) => void;
}) {
  const Icon = TYPE_ICON[row.type] ?? Info;
  const unread = !row.is_read;
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => onOpen(row)}
        className={`focus-ring flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-bg-tertiary ${
          unread ? 'bg-accent/5' : ''
        }`}
      >
        <span
          aria-hidden="true"
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${TYPE_COLOR[row.type] ?? TYPE_COLOR.system}`}
        >
          <Icon size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span
              className={`truncate text-sm leading-5 ${
                unread ? 'font-semibold text-text-primary' : 'font-medium text-text-secondary'
              }`}
            >
              {row.title}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-text-muted">{timeAgo(row.created_at)}</span>
          </span>
          {row.message && (
            <span className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-text-secondary">{row.message}</span>
          )}
          <span className="mt-1 flex items-center gap-1.5 text-[11px] text-text-muted">
            {unread && <span role="img" aria-label="Unread" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
            {TYPE_LABEL[row.type] ?? 'System'}
          </span>
        </span>
      </button>
      <span className="absolute bottom-2 right-3 flex items-center gap-0.5 rounded-lg bg-bg-tertiary p-0.5 opacity-0 shadow-sm transition-opacity focus-within:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        <button
          type="button"
          onClick={() => onToggleRead(row)}
          aria-label={unread ? 'Mark as read' : 'Mark as unread'}
          title={unread ? 'Mark as read' : 'Mark as unread'}
          className="focus-ring flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-bg-secondary hover:text-accent"
        >
          {unread ? <Check size={14} aria-hidden="true" /> : <CircleDot size={14} aria-hidden="true" />}
        </button>
        <button
          type="button"
          onClick={() => onDelete(row)}
          aria-label="Delete notification"
          title="Delete"
          className="focus-ring flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-bg-secondary hover:text-danger"
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------
// All data (list, unread count, realtime sync) lives in NotificationsContext.
// This component only owns local UI state (open, filter, prefs, position) so
// the desktop and mobile bells (both mounted in DashboardNav) stay in sync.
// The panel is portaled to <body> and positioned with `fixed` so it can never
// be clipped by the sidebar / header it is rendered inside.
// ---------------------------------------------------------------------
export function NotificationBell() {
  const navigate = useNavigate();
  const reduceMotion = useReducedMotion();
  const panelId = useId();
  const prefsId = useId();
  const {
    items,
    unreadCount,
    loading,
    loadingMore,
    hasMore,
    loadError,
    soundOn,
    desktopOn,
    loadNotifications,
    loadMore,
    markRead,
    markAllRead,
    toggleRead,
    deleteOne,
    clearRead,
    toggleSound,
    toggleDesktop,
  } = useNotifications();

  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [pos, setPos] = useState<PanelPosition | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback((returnFocus = false) => {
    setOpen(false);
    setPrefsOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const reposition = useCallback(() => {
    if (!triggerRef.current) return;
    const next = computePosition(triggerRef.current);
    setPos((prev) =>
      prev &&
      prev.top === next.top &&
      prev.left === next.left &&
      prev.width === next.width &&
      prev.maxHeight === next.maxHeight
        ? prev
        : next
    );
  }, []);

  // Position before paint, then keep it in sync with resize / outer scroll.
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onScroll = (e: Event) => {
      if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return;
      reposition();
    };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, reposition]);

  // Click outside + Escape (panel lives in a portal, so check both refs).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(true);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  // Move focus into the panel once it is mounted.
  const placed = pos !== null;
  useEffect(() => {
    if (open && placed) panelRef.current?.focus({ preventScroll: true });
  }, [open, placed]);

  const handlePanelBlur = (e: React.FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && !panelRef.current?.contains(next) && !triggerRef.current?.contains(next)) close();
  };

  const handleOpenRow = (row: NotificationRow) => {
    close();
    if (row.action_url && isInternalPath(row.action_url)) navigate(row.action_url);
    markRead(row).catch(() => undefined);
  };

  const visibleItems = useMemo(
    () => (filter === 'unread' ? items.filter((n) => !n.is_read) : items),
    [items, filter]
  );
  const groups = useMemo(() => groupByDay(visibleItems), [visibleItems]);
  const hasReadItems = items.some((n) => n.is_read);

  const desktopSupported = typeof window !== 'undefined' && 'Notification' in window;
  const desktopBlocked = desktopSupported && Notification.permission === 'denied';
  const badge = unreadCount > 99 ? '99+' : String(unreadCount);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={`focus-ring relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors hover:bg-bg-tertiary hover:text-text-primary ${
          open ? 'bg-bg-tertiary text-text-primary' : 'text-text-secondary'
        }`}
      >
        <Bell size={18} aria-hidden="true" />
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold leading-none tabular-nums text-on-danger shadow-[0_0_0_2px_rgb(var(--bg-secondary))]"
          >
            {badge}
          </span>
        )}
      </button>

      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              ref={panelRef}
              id={panelId}
              role="dialog"
              aria-label="Notifications"
              tabIndex={-1}
              onBlur={handlePanelBlur}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
              animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
              transition={{ duration: reduceMotion ? 0.01 : 0.16, ease: [0.16, 1, 0.3, 1] }}
              style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
              className="z-popover flex flex-col overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card-hover outline-none dark:shadow-card-hover-dark"
            >
              {/* Header */}
              <div className="flex shrink-0 items-center justify-between gap-2 px-4 pb-2 pt-3.5">
                <div className="flex items-center gap-2">
                  <h2 className="text-[15px] font-semibold text-text-primary">Notifications</h2>
                  {unreadCount > 0 && (
                    <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-accent">
                      {unreadCount} new
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setPrefsOpen((v) => !v)}
                  aria-expanded={prefsOpen}
                  aria-controls={prefsId}
                  aria-label="Notification preferences"
                  title="Preferences"
                  className={`focus-ring flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-bg-tertiary hover:text-text-primary ${
                    prefsOpen ? 'bg-bg-tertiary text-text-primary' : 'text-text-secondary'
                  }`}
                >
                  <SlidersHorizontal size={16} aria-hidden="true" />
                </button>
              </div>

              {/* Preferences (collapsible) */}
              {prefsOpen && (
                <div id={prefsId} className="shrink-0 border-y border-border bg-bg-primary px-3 py-2">
                  <PreferenceRow
                    icon={soundOn ? Volume2 : VolumeX}
                    label="Sound"
                    hint="Play a chime for new notifications"
                    checked={soundOn}
                    onToggle={toggleSound}
                  />
                  {desktopSupported && (
                    <PreferenceRow
                      icon={BellRing}
                      label="Desktop alerts"
                      hint={desktopBlocked ? 'Blocked in your browser settings' : 'Alert me while this tab is in the background'}
                      checked={desktopOn && !desktopBlocked}
                      disabled={desktopBlocked}
                      onToggle={() => void toggleDesktop()}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      close();
                      navigate('/dashboard/settings');
                    }}
                    className="focus-ring mt-1 flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-xs font-medium text-text-secondary hover:text-accent"
                  >
                    <Settings size={13} aria-hidden="true" />
                    All notification settings
                  </button>
                </div>
              )}

              {/* Tabs + mark all read */}
              <div className="flex shrink-0 items-center justify-between gap-2 px-4 pb-2.5">
                <div role="tablist" aria-label="Filter notifications" className="flex items-center gap-0.5 rounded-lg bg-bg-tertiary p-0.5">
                  {(['all', 'unread'] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      role="tab"
                      aria-selected={filter === f}
                      onClick={() => setFilter(f)}
                      className={`focus-ring rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        filter === f
                          ? 'bg-bg-secondary text-text-primary shadow-sm'
                          : 'text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      {f === 'all' ? 'All' : 'Unread'}
                      {f === 'unread' && unreadCount > 0 && (
                        <span className="ml-1.5 tabular-nums text-accent">{unreadCount}</span>
                      )}
                    </button>
                  ))}
                </div>
                {unreadCount > 0 && (
                  <button
                    type="button"
                    onClick={() => void markAllRead()}
                    className="focus-ring flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10"
                  >
                    <CheckCheck size={14} aria-hidden="true" />
                    Mark all read
                  </button>
                )}
              </div>

              {/* List */}
              <div
                role="tabpanel"
                aria-busy={loading}
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-border/60"
              >
                {loading ? (
                  <div className="px-2 py-1">
                    <NotificationSkeleton />
                    <NotificationSkeleton />
                    <NotificationSkeleton />
                  </div>
                ) : loadError ? (
                  <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                    <AlertCircle size={24} className="text-danger" aria-hidden="true" />
                    <p className="text-sm font-medium text-text-primary">Couldn't load notifications</p>
                    <p className="text-xs text-text-secondary">Check your connection and try again.</p>
                    <button
                      type="button"
                      onClick={() => void loadNotifications()}
                      className="focus-ring mt-1 flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-tertiary"
                    >
                      <RotateCw size={12} aria-hidden="true" />
                      Retry
                    </button>
                  </div>
                ) : visibleItems.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                    <span className="flex h-11 w-11 items-center justify-center rounded-full bg-bg-tertiary text-text-secondary">
                      {filter === 'unread' ? (
                        <CheckCheck size={20} aria-hidden="true" />
                      ) : (
                        <BellOff size={20} aria-hidden="true" />
                      )}
                    </span>
                    <p className="text-sm font-medium text-text-primary">
                      {filter === 'unread' ? "You're all caught up" : 'No notifications yet'}
                    </p>
                    <p className="text-xs text-text-secondary">
                      {filter === 'unread'
                        ? 'New activity will show up here.'
                        : 'Calls, jobs, estimates and mentions will appear here.'}
                    </p>
                  </div>
                ) : (
                  <div className="px-2 pb-1">
                    {groups.map((g) => (
                      <section key={g.key} aria-label={g.label}>
                        <h3 className="sticky top-0 z-raised bg-bg-secondary px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                          {g.label}
                        </h3>
                        <ul className="space-y-0.5">
                          {g.rows.map((n) => (
                            <NotificationItem
                              key={n.id}
                              row={n}
                              onOpen={handleOpenRow}
                              onToggleRead={(row) => void toggleRead(row)}
                              onDelete={(row) => void deleteOne(row)}
                            />
                          ))}
                        </ul>
                      </section>
                    ))}

                    {hasMore && (
                      <div className="py-2 text-center">
                        <button
                          type="button"
                          onClick={() => void loadMore()}
                          disabled={loadingMore}
                          className="focus-ring rounded-lg px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/10 disabled:opacity-60"
                        >
                          {loadingMore ? 'Loading…' : 'Load older'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-2">
                {hasReadItems ? (
                  <button
                    type="button"
                    onClick={() => void clearRead()}
                    className="focus-ring flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-text-secondary hover:text-danger"
                  >
                    <Trash2 size={13} aria-hidden="true" />
                    Clear read
                  </button>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  onClick={() => {
                    close();
                    navigate('/dashboard/notifications');
                  }}
                  className="focus-ring flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold text-accent hover:bg-accent/10"
                >
                  View all
                  <ArrowRight size={13} aria-hidden="true" />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  );
}
