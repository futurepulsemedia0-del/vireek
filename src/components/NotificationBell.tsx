import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Bell,
  PhoneCall,
  Gauge,
  Lightbulb,
  Wrench,
  Info,
  CheckCheck,
  Settings,
  Trash2,
  X,
  Volume2,
  VolumeX,
  RotateCw,
  AlertCircle,
  ShieldAlert,
  Eye,
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
  system: Info,
};

const TYPE_COLOR: Record<NotificationRow['type'], string> = {
  emergency_call: 'bg-danger/10 text-danger',
  usage_alert: 'bg-warning-500/10 text-warning-500',
  ai_insight: 'bg-ai/10 text-ai',
  job_update: 'bg-accent/10 text-accent',
  warranty_alert: 'bg-warning-500/10 text-warning-500',
  quote_viewed: 'bg-success-500/10 text-success-500',
  system: 'bg-bg-tertiary text-text-secondary',
};

const TYPE_LABEL: Record<NotificationRow['type'], string> = {
  emergency_call: 'Emergency call',
  usage_alert: 'Usage alert',
  ai_insight: 'AI insight',
  job_update: 'Job update',
  warranty_alert: 'Warranty alert',
  quote_viewed: 'Estimate activity',
  system: 'System',
};

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.max(0, Math.round(diffMs / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function NotificationSkeleton() {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="h-8 w-8 shrink-0 animate-pulse rounded-lg bg-bg-tertiary" />
      <div className="flex-1 space-y-2">
        <div className="h-3.5 w-2/3 animate-pulse rounded bg-bg-tertiary" />
        <div className="h-3 w-full animate-pulse rounded bg-bg-tertiary" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// All data (list, unread count, realtime sync) now lives in
// NotificationsContext — see the comment at the top of that file for why.
// This component is purely presentational: local UI state only (open,
// filter, the click-outside ref), everything else comes from the shared
// context so the desktop and mobile bells (both mounted at once in
// DashboardNav) stay in sync without each opening their own subscription.
// ---------------------------------------------------------------------
export function NotificationBell() {
  const navigate = useNavigate();
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

  const containerRef = useRef<HTMLDivElement>(null);

  // Click outside + Escape to close.
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  const handleRowClick = async (row: NotificationRow) => {
    await markRead(row);
    setOpen(false);
    if (row.action_url) navigate(row.action_url);
  };

  const handleToggleRead = (row: NotificationRow, e: React.MouseEvent) => {
    e.stopPropagation();
    toggleRead(row);
  };

  const handleDelete = (row: NotificationRow, e: React.MouseEvent) => {
    e.stopPropagation();
    deleteOne(row);
  };

  const visibleItems = useMemo(
    () => (filter === 'unread' ? items.filter((n) => !n.is_read) : items),
    [items, filter]
  );
  const hasReadItems = items.some((n) => n.is_read);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        aria-expanded={open}
        className="focus-ring relative flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-primary text-text-secondary transition-colors hover:border-accent/30 hover:text-text-primary"
      >
        <Bell size={18} />
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4.5 min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold leading-none text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="absolute right-0 z-50 mt-2 w-[360px] max-w-[92vw] overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card-hover dark:shadow-card-hover-dark"
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
              <p className="text-sm font-semibold text-text-primary">Notifications</p>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={toggleSound}
                  aria-label={soundOn ? 'Mute notification sound' : 'Enable notification sound'}
                  aria-pressed={soundOn}
                  title={soundOn ? 'Sound on' : 'Sound off'}
                  className="focus-ring flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                >
                  {soundOn ? <Volume2 size={14} /> : <VolumeX size={14} />}
                </button>
                <button
                  type="button"
                  onClick={toggleDesktop}
                  aria-pressed={desktopOn}
                  title={desktopOn ? 'Desktop alerts on' : 'Enable desktop alerts'}
                  className={`focus-ring flex h-7 w-7 items-center justify-center rounded-lg hover:bg-bg-tertiary ${
                    desktopOn ? 'text-accent' : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  <Bell size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    navigate('/dashboard/settings');
                  }}
                  aria-label="Notification settings"
                  title="Notification settings"
                  className="focus-ring flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                >
                  <Settings size={14} />
                </button>
              </div>
            </div>

            {/* Filter tabs + mark all read */}
            <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2">
              <div className="flex items-center gap-1 rounded-lg bg-bg-tertiary p-0.5">
                {(['all', 'unread'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      filter === f ? 'bg-bg-secondary text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {f === 'all' ? 'All' : `Unread${unreadCount > 0 ? ` (${unreadCount})` : ''}`}
                  </button>
                ))}
              </div>
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={markAllRead}
                  className="focus-ring flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10"
                >
                  <CheckCheck size={13} />
                  Mark all read
                </button>
              )}
            </div>

            {/* List */}
            <div className="max-h-[360px] overflow-y-auto">
              {loading ? (
                <>
                  <NotificationSkeleton />
                  <NotificationSkeleton />
                  <NotificationSkeleton />
                </>
              ) : loadError ? (
                <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                  <AlertCircle size={22} className="text-danger" />
                  <p className="text-sm text-text-secondary">Couldn't load notifications.</p>
                  <button
                    type="button"
                    onClick={loadNotifications}
                    className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-tertiary"
                  >
                    <RotateCw size={12} />
                    Retry
                  </button>
                </div>
              ) : visibleItems.length === 0 ? (
                <div className="px-4 py-10 text-center">
                  <p className="text-sm text-text-secondary">
                    {filter === 'unread' ? "No unread notifications." : "You're all caught up."}
                  </p>
                </div>
              ) : (
                <>
                  {visibleItems.map((n) => {
                    const Icon = TYPE_ICON[n.type] ?? Info;
                    return (
                      <div
                        key={n.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => handleRowClick(n)}
                        onKeyDown={(e) => e.key === 'Enter' && handleRowClick(n)}
                        className={`group flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-tertiary ${
                          !n.is_read ? 'bg-accent/5' : ''
                        }`}
                      >
                        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${TYPE_COLOR[n.type] ?? TYPE_COLOR.system}`}>
                          <Icon size={15} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className={`truncate text-sm ${!n.is_read ? 'font-semibold text-text-primary' : 'font-medium text-text-secondary'}`}>
                              {n.title}
                            </span>
                            {!n.is_read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-text-secondary">{n.message}</span>
                          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-secondary/60">
                            {timeAgo(n.created_at)}
                            <span aria-hidden="true">·</span>
                            {TYPE_LABEL[n.type] ?? 'System'}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                          <button
                            type="button"
                            onClick={(e) => handleToggleRead(n, e)}
                            aria-label={n.is_read ? 'Mark as unread' : 'Mark as read'}
                            title={n.is_read ? 'Mark as unread' : 'Mark as read'}
                            className="focus-ring flex h-6 w-6 items-center justify-center rounded-md text-text-secondary hover:bg-bg-secondary hover:text-accent"
                          >
                            <span className={`block h-2 w-2 rounded-full ${n.is_read ? 'border border-text-secondary' : 'bg-accent'}`} />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => handleDelete(n, e)}
                            aria-label="Delete notification"
                            title="Delete"
                            className="focus-ring flex h-6 w-6 items-center justify-center rounded-md text-text-secondary hover:bg-bg-secondary hover:text-danger"
                          >
                            <Trash2 size={12} />
                          </button>
                        </span>
                      </div>
                    );
                  })}

                  {filter === 'all' && hasMore && (
                    <div className="px-4 py-2.5 text-center">
                      <button
                        type="button"
                        onClick={loadMore}
                        disabled={loadingMore}
                        className="focus-ring rounded-lg px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/10 disabled:opacity-60"
                      >
                        {loadingMore ? 'Loading…' : 'Load older'}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
              {hasReadItems ? (
                <button
                  type="button"
                  onClick={clearRead}
                  className="focus-ring flex items-center gap-1 rounded-lg px-1.5 py-1 text-xs font-medium text-text-secondary hover:text-danger"
                >
                  <X size={12} />
                  Clear read
                </button>
              ) : (
                <span />
              )}
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  navigate('/dashboard/notifications');
                }}
                className="focus-ring rounded-lg py-1.5 text-center text-xs font-medium text-text-secondary hover:text-accent"
              >
                View all notifications
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
