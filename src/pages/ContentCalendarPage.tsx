import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CalendarRange, ChevronLeft, ChevronRight, Download, Lock, Plus, RefreshCw, Search, TriangleAlert, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { supabase } from '@/lib/supabase';
import { AgendaView, DayList, EntryRow, MonthView, WeekView, type DnD } from '@/components/content-calendar/CalendarViews';
import { ItemEditorDialog } from '@/components/content-calendar/ItemEditorDialog';
import {
  CHANNELS,
  EMPTY_DRAFT,
  STATUSES,
  VIEW_OPTIONS,
  addDays,
  buildEntries,
  buildIcs,
  campaignEvents,
  detectWeekStart,
  draftFromItem,
  duplicateDraft,
  filterCampaigns,
  filterItems,
  groupByDay,
  hasActiveFilters,
  isContentStatus,
  isDraggable,
  isViewMode,
  moveToDay,
  parseDateKey,
  rangeLabel,
  shiftAnchor,
  startOfDay,
  summarize,
  toDateKey,
  toRowPayload,
  visibleRange,
  NO_FILTERS,
  type CalendarFilters,
  type CampaignEvent,
  type CampaignRow,
  type ChannelId,
  type ContentItem,
  type ItemDraft,
  type ViewMode,
} from '@/lib/contentCalendar';

const TABLE = 'content_calendar_items';
const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';

interface EditorState {
  item: ContentItem | null;
  seed: ItemDraft;
  nonce: number;
}

export default function ContentCalendarPage() {
  const { profile, teamMember, isOwner, permissions, loading: authLoading, profileLoading } = useAuth();
  const { toast } = useToast();

  // All rows are keyed by the ACCOUNT OWNER's id (differs from user.id for team members).
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canAccess = isOwner || permissions.can_edit_business_profile;
  // The email-campaign overlay is gated like the Email Campaigns page itself.
  const canSeeCampaigns = isOwner || permissions.can_view_billing;

  const [params, setParams] = useSearchParams();
  const view: ViewMode = isViewMode(params.get('view')) ? (params.get('view') as ViewMode) : 'month';
  const anchorParam = params.get('date');
  const anchor = useMemo(() => parseDateKey(anchorParam) ?? startOfDay(new Date()), [anchorParam]);
  const weekStartsOn = useMemo(() => detectWeekStart(), []);

  const [now, setNow] = useState(() => new Date());
  const [items, setItems] = useState<ContentItem[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ContentItem | null>(null);
  const [selectedKey, setSelectedKey] = useState(() => toDateKey(anchor));
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [filters, setFilters] = useState<CalendarFilters>(NO_FILTERS);
  const requestId = useRef(0);
  const nonce = useRef(0);

  // Keep "past due" and "today" honest while the page stays open.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // ---------- data ----------
  const range = useMemo(() => visibleRange(view, anchor, weekStartsOn), [view, anchor, weekStartsOn]);
  // Always load at least the last 90 / next 30 days so the summary + "needs attention" stay accurate on any month.
  const windowStartMs = Math.min(range.start.getTime(), addDays(startOfDay(new Date()), -90).getTime());
  const windowEndMs = Math.max(range.end.getTime(), addDays(startOfDay(new Date()), 31).getTime());

  const load = useCallback(
    async (silent = false) => {
      if (!ownerId) return;
      const id = ++requestId.current;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const [scheduled, unscheduled, camps] = await Promise.all([
          supabase
            .from(TABLE)
            .select('*')
            .eq('user_id', ownerId)
            .gte('scheduled_at', new Date(windowStartMs).toISOString())
            .lt('scheduled_at', new Date(windowEndMs).toISOString())
            .order('scheduled_at', { ascending: true })
            .limit(1500),
          supabase.from(TABLE).select('*').eq('user_id', ownerId).is('scheduled_at', null).order('created_at', { ascending: false }).limit(300),
          canSeeCampaigns
            ? supabase.from('email_campaigns').select('id, name, status, scheduled_at, started_at').eq('user_id', ownerId).order('created_at', { ascending: false }).limit(300)
            : Promise.resolve({ data: [], error: null }),
        ]);
        if (id !== requestId.current) return; // a newer request superseded this one
        const failure = scheduled.error ?? unscheduled.error;
        if (failure) {
          if (!silent) setError(failure.message);
        } else {
          const merged = new Map<string, ContentItem>();
          for (const row of [...(scheduled.data ?? []), ...(unscheduled.data ?? [])] as ContentItem[]) merged.set(row.id, row);
          setItems([...merged.values()]);
          // The overlay is a nice-to-have: if it fails the calendar still works.
          setCampaigns(camps.error ? [] : campaignEvents((camps.data ?? []) as CampaignRow[]));
        }
      } catch (e) {
        if (id === requestId.current && !silent) setError(e instanceof Error ? e.message : 'Could not load your calendar.');
      } finally {
        if (id === requestId.current && !silent) setLoading(false);
      }
    },
    [ownerId, canSeeCampaigns, windowStartMs, windowEndMs],
  );

  useEffect(() => {
    if (canAccess) void load();
  }, [canAccess, load]);

  // ---------- derived ----------
  const filteredItems = useMemo(() => filterItems(items, filters), [items, filters]);
  const filteredCampaigns = useMemo(() => filterCampaigns(campaigns, filters), [campaigns, filters]);
  const byDay = useMemo(() => groupByDay(buildEntries(filteredItems, filteredCampaigns)), [filteredItems, filteredCampaigns]);
  const summary = useMemo(() => summarize(items, campaigns, now), [items, campaigns, now]);
  const presentChannels = useMemo(() => {
    const ids = new Set<ChannelId>(items.map((i) => i.channel));
    filters.channels.forEach((c) => ids.add(c));
    return CHANNELS.filter((c) => ids.has(c.id));
  }, [items, filters.channels]);

  const agendaByDay = useMemo(() => {
    const from = toDateKey(range.start);
    const to = toDateKey(range.end);
    return new Map([...byDay].filter(([key]) => key >= from && key < to));
  }, [byDay, range]);

  const selectedDate = parseDateKey(selectedKey) ?? anchor;
  const selectedEntries = byDay.get(selectedKey) ?? [];
  const isEmptyCalendar = items.length === 0 && campaigns.length === 0;

  // ---------- navigation ----------
  const go = (next: { view?: ViewMode; date?: Date }) => {
    const p = new URLSearchParams(params);
    if (next.view) p.set('view', next.view);
    if (next.date) {
      p.set('date', toDateKey(next.date));
      setSelectedKey(toDateKey(next.date));
    }
    setParams(p, { replace: true });
  };

  // ---------- editor ----------
  const openNew = (date?: Date) =>
    setEditor({
      item: null,
      seed: { ...EMPTY_DRAFT, scheduled_at: date ? moveToDay(null, date) : null },
      nonce: ++nonce.current,
    });
  const openItem = (item: ContentItem) => setEditor({ item, seed: draftFromItem(item), nonce: ++nonce.current });

  const upsertLocal = (row: ContentItem) =>
    setItems((cur) => (cur.some((i) => i.id === row.id) ? cur.map((i) => (i.id === row.id ? row : i)) : [row, ...cur]));

  const save = async (draft: ItemDraft) => {
    if (!ownerId) return;
    const existing = editor?.item ?? null;
    const payload = toRowPayload(draft, new Date(), existing?.published_at ?? null);
    setSaving(true);
    try {
      const { data, error: e } = existing
        ? await supabase.from(TABLE).update(payload).eq('id', existing.id).eq('user_id', ownerId).select('*').single()
        : await supabase.from(TABLE).insert({ ...payload, user_id: ownerId }).select('*').single();
      if (e || !data) {
        toast(e?.message ?? 'Could not save. Please try again.', 'error');
        return;
      }
      upsertLocal(data as ContentItem);
      toast(existing ? 'Changes saved.' : 'Added to your calendar.', 'success');
      setEditor(null);
      void load(true);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save. Please try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete || !ownerId) return;
    const target = pendingDelete;
    const { error: e } = await supabase.from(TABLE).delete().eq('id', target.id).eq('user_id', ownerId);
    if (e) {
      toast(e.message, 'error');
      return;
    }
    setItems((cur) => cur.filter((i) => i.id !== target.id));
    setPendingDelete(null);
    toast('Deleted.', 'success');
  };

  // ---------- drag & drop reschedule (desktop; touch users use the editor's date field) ----------
  const dropOnDay = async (date: Date) => {
    const id = draggingId;
    setDraggingId(null);
    const item = items.find((i) => i.id === id);
    if (!item || !ownerId || !isDraggable(item.status)) return;
    const nextIso = moveToDay(item.scheduled_at, date);
    if (nextIso === item.scheduled_at) return;
    if (item.status === 'scheduled' && Date.parse(nextIso) < Date.now()) {
      toast('That time has already passed — pick a later day.', 'error');
      return;
    }
    setItems((cur) => cur.map((i) => (i.id === item.id ? { ...i, scheduled_at: nextIso } : i)));
    const { error: e } = await supabase.from(TABLE).update({ scheduled_at: nextIso }).eq('id', item.id).eq('user_id', ownerId);
    if (e) {
      setItems((cur) => cur.map((i) => (i.id === item.id ? item : i)));
      toast(e.message, 'error');
      return;
    }
    toast(`Moved to ${date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}.`, 'success');
    void load(true);
  };

  const dnd: DnD = {
    draggingId,
    onDragStart: setDraggingId,
    onDragEnd: () => setDraggingId(null),
    onDropOnDay: (d) => void dropOnDay(d),
  };

  // ---------- export ----------
  const exportIcs = () => {
    const list = filteredItems.filter((i) => i.scheduled_at && i.status !== 'cancelled');
    if (list.length === 0) {
      toast('Nothing scheduled to export yet.', 'info');
      return;
    }
    const ics = buildIcs(list, { calendarName: `${profile?.company_name || 'Vireek'} content calendar` });
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `content-calendar-${toDateKey(new Date())}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const toggleChannel = (id: ChannelId) =>
    setFilters((f) => {
      const next = new Set(f.channels);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...f, channels: next };
    });

  // ---------- gates ----------
  if (authLoading || profileLoading) {
    return (
      <DashboardLayout>
        <div className="mx-auto max-w-7xl space-y-4 px-4 py-8" aria-busy="true">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-96 w-full" />
        </div>
      </DashboardLayout>
    );
  }

  if (!canAccess) {
    return (
      <DashboardLayout>
        <div className="mx-auto max-w-2xl px-4 py-16">
          <EmptyState
            icon={Lock}
            title="You don't have access to the Content Calendar"
            description="The content calendar plans what your business publishes, so it's limited to the account owner and roles that can edit the business profile. Ask your account owner to grant access."
          />
        </div>
      </DashboardLayout>
    );
  }

  const attention = [...summary.overdue, ...summary.unscheduled];
  const firstGap = summary.gapDays[0] ? parseDateKey(summary.gapDays[0]) : null;

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-7xl px-4 py-6 sm:py-8">
        <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <CalendarRange className="h-7 w-7 text-accent" aria-hidden />
              <h1 className="text-2xl font-bold text-text-primary">Content Calendar</h1>
            </div>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">
              Plan and schedule what goes out on every channel — social, blog, email, text and mail. Email campaigns you schedule appear here automatically.
              Vireek tracks the plan; mark an item published once it's live.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="secondary" onClick={exportIcs} disabled={loading || !!error} title="Download scheduled items as an .ics file for Google, Apple or Outlook calendar">
              <Download className="h-4 w-4" aria-hidden /> Export
            </Button>
            <Button onClick={() => openNew()}>
              <Plus className="h-4 w-4" aria-hidden /> New content
            </Button>
          </div>
        </header>

        {loading ? (
          <div className="space-y-4" aria-busy="true" aria-label="Loading calendar">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-[28rem] w-full" />
          </div>
        ) : error ? (
          <Card className="!p-5 hover:translate-y-0">
            <p className="flex items-start gap-2 text-sm text-danger" role="alert">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {error}
            </p>
            <Button variant="secondary" size="sm" className="mt-3" onClick={() => void load()}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Retry
            </Button>
          </Card>
        ) : isEmptyCalendar ? (
          <EmptyState
            icon={CalendarRange}
            title="Your content calendar is empty"
            description="Add your first post, offer or email to start planning. Drag items between days to reschedule, and see every channel in one place."
            action={{ label: 'Plan your first piece of content', onClick: () => openNew() }}
          />
        ) : (
          <>
            {/* KPIs */}
            <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi label="Scheduled · next 7 days" value={summary.upcoming7} />
              <Kpi label="Past due" value={summary.overdue.length} tone={summary.overdue.length ? 'warning' : 'neutral'} />
              <Kpi label="Unscheduled" value={summary.unscheduled.length} />
              <Kpi
                label="Open days · next 14"
                value={summary.gapDays.length}
                action={firstGap ? { label: 'Plan one', onClick: () => openNew(firstGap) } : undefined}
              />
            </div>

            <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_20rem] xl:gap-6">
              <div className="min-w-0">
                {/* Toolbar */}
                <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="secondary" aria-label="Previous" onClick={() => go({ date: shiftAnchor(view, anchor, -1) })}>
                      <ChevronLeft className="h-4 w-4" aria-hidden />
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => go({ date: startOfDay(new Date()) })}>
                      Today
                    </Button>
                    <Button size="sm" variant="secondary" aria-label="Next" onClick={() => go({ date: shiftAnchor(view, anchor, 1) })}>
                      <ChevronRight className="h-4 w-4" aria-hidden />
                    </Button>
                    <h2 className="ml-1 text-lg font-semibold text-text-primary" aria-live="polite">
                      {rangeLabel(view, anchor, weekStartsOn)}
                    </h2>
                  </div>
                  <div role="tablist" aria-label="Calendar view" className="flex gap-1 rounded-xl bg-bg-tertiary p-1">
                    {VIEW_OPTIONS.map((v) => (
                      <button
                        key={v.key}
                        type="button"
                        role="tab"
                        aria-selected={view === v.key}
                        onClick={() => go({ view: v.key })}
                        className={`focus-ring min-h-[36px] flex-1 rounded-lg px-4 text-sm font-medium transition-colors lg:flex-none ${
                          view === v.key ? 'bg-bg-secondary text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'
                        }`}
                      >
                        {v.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Filters */}
                <div className="mb-3 flex flex-col gap-2 sm:flex-row">
                  <div className="flex-1">
                    <Input
                      icon={Search}
                      type="search"
                      aria-label="Search content"
                      placeholder="Search titles, copy and tags"
                      value={filters.query}
                      onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
                    />
                  </div>
                  <div className="sm:w-48">
                    <select
                      aria-label="Filter by status"
                      className={selectClass}
                      value={filters.status}
                      onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value === 'all' ? 'all' : isContentStatus(e.target.value) ? e.target.value : 'all' }))}
                    >
                      <option value="all">All statuses</option>
                      {STATUSES.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                {(presentChannels.length > 0 || hasActiveFilters(filters)) && (
                  <div className="mb-4 flex items-center gap-2">
                    <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Filter by channel">
                      {presentChannels.map((c) => {
                        const on = filters.channels.has(c.id);
                        return (
                          <button
                            key={c.id}
                            type="button"
                            aria-pressed={on}
                            onClick={() => toggleChannel(c.id)}
                            className={`focus-ring inline-flex min-h-[32px] shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors ${
                              on ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'
                            }`}
                          >
                            <span className={`h-2 w-2 rounded-full ${c.dot}`} aria-hidden />
                            {c.label}
                          </button>
                        );
                      })}
                    </div>
                    {hasActiveFilters(filters) && (
                      <button type="button" onClick={() => setFilters(NO_FILTERS)} className="focus-ring inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10">
                        <X className="h-3.5 w-3.5" aria-hidden /> Clear filters
                      </button>
                    )}
                  </div>
                )}

                {/* Views */}
                {view === 'month' && (
                  <MonthView
                    anchor={anchor}
                    weekStartsOn={weekStartsOn}
                    now={now}
                    byDay={byDay}
                    selectedKey={selectedKey}
                    dnd={dnd}
                    onSelectDay={(d) => setSelectedKey(toDateKey(d))}
                    onCreate={openNew}
                    onOpen={openItem}
                    onShowWeek={(d) => go({ view: 'week', date: d })}
                  />
                )}
                {view === 'week' && (
                  <WeekView
                    anchor={anchor}
                    weekStartsOn={weekStartsOn}
                    now={now}
                    byDay={byDay}
                    selectedKey={selectedKey}
                    dnd={dnd}
                    onSelectDay={(d) => setSelectedKey(toDateKey(d))}
                    onCreate={openNew}
                    onOpen={openItem}
                    onShowWeek={(d) => go({ view: 'week', date: d })}
                  />
                )}
                {view === 'agenda' &&
                  (agendaByDay.size === 0 ? (
                    <EmptyState
                      icon={CalendarRange}
                      title={hasActiveFilters(filters) ? 'Nothing matches your filters' : 'Nothing planned this month'}
                      description={hasActiveFilters(filters) ? 'Try a different search or clear the filters.' : 'Add content for this month, or jump to another month.'}
                      action={hasActiveFilters(filters) ? { label: 'Clear filters', onClick: () => setFilters(NO_FILTERS) } : { label: 'New content', onClick: () => openNew() }}
                    />
                  ) : (
                    <AgendaView byDay={agendaByDay} now={now} onOpen={openItem} onCreate={openNew} />
                  ))}

                {/* Selected day (month view: the only way to read a day on a phone) */}
                {view === 'month' && (
                  <div className="mt-5 rounded-2xl border border-border bg-bg-secondary p-4 xl:hidden">
                    <DayList date={selectedDate} entries={selectedEntries} now={now} onOpen={openItem} onCreate={openNew} />
                  </div>
                )}
              </div>

              {/* Side column */}
              <aside className="mt-6 space-y-5 xl:mt-0" aria-label="Calendar details">
                {view === 'month' && (
                  <div className="hidden rounded-2xl border border-border bg-bg-secondary p-4 xl:block">
                    <DayList date={selectedDate} entries={selectedEntries} now={now} onOpen={openItem} onCreate={openNew} />
                  </div>
                )}
                <section className="rounded-2xl border border-border bg-bg-secondary p-4" aria-label="Needs attention">
                  <h3 className="text-sm font-semibold text-text-primary">Needs attention</h3>
                  {attention.length === 0 ? (
                    <p className="mt-2 text-sm text-text-secondary">You're all caught up — nothing is past due or waiting for a date.</p>
                  ) : (
                    <ul className="mt-3 space-y-2">
                      {attention.slice(0, 6).map((item) => (
                        <li
                          key={item.id}
                          draggable={!item.scheduled_at}
                          onDragStart={(e) => {
                            e.dataTransfer.setData('text/plain', item.id);
                            e.dataTransfer.effectAllowed = 'move';
                            setDraggingId(item.id);
                          }}
                          onDragEnd={() => setDraggingId(null)}
                        >
                          <EntryRow entry={{ kind: 'content', key: `c:${item.id}`, at: item.scheduled_at, item }} now={now} onOpen={openItem} />
                        </li>
                      ))}
                    </ul>
                  )}
                  {attention.length > 6 && <p className="mt-2 text-xs text-text-secondary">+{attention.length - 6} more — use the status filter to see them all.</p>}
                  {summary.unscheduled.length > 0 && <p className="mt-2 hidden text-xs text-text-secondary xl:block">Tip: drag an unscheduled item onto a day to schedule it.</p>}
                </section>
                {canSeeCampaigns && (
                  <p className="px-1 text-xs text-text-secondary">
                    Dashed items are email campaigns. Manage them in{' '}
                    <Link to="/dashboard/email-campaigns" className="font-medium text-accent hover:underline">
                      Email Campaigns
                    </Link>
                    .
                  </p>
                )}
              </aside>
            </div>
          </>
        )}
      </div>

      {editor && (
        <ItemEditorDialog
          key={editor.item?.id ?? `new-${editor.nonce}`}
          item={editor.item}
          seed={editor.seed}
          saving={saving}
          onSave={save}
          onClose={() => setEditor(null)}
          onDuplicate={
            editor.item
              ? () => {
                  const source = editor.item as ContentItem;
                  setEditor({ item: null, seed: duplicateDraft(source), nonce: ++nonce.current });
                }
              : undefined
          }
          onDelete={
            editor.item
              ? () => {
                  setPendingDelete(editor.item);
                  setEditor(null);
                }
              : undefined
          }
        />
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete this content?"
        description={pendingDelete ? `“${pendingDelete.title}” will be removed from your calendar. This can't be undone.` : ''}
        confirmLabel="Yes, delete it"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </DashboardLayout>
  );
}

function Kpi({
  label,
  value,
  tone = 'neutral',
  action,
}: {
  label: string;
  value: number;
  tone?: 'neutral' | 'warning';
  action?: { label: string; onClick: () => void };
}) {
  return (
    <Card className="!p-4 hover:translate-y-0">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${tone === 'warning' ? 'text-warning-500' : 'text-text-primary'}`}>{value}</p>
      {action && (
        <button type="button" onClick={action.onClick} className="focus-ring mt-1 rounded text-xs font-medium text-accent hover:underline">
          {action.label}
        </button>
      )}
    </Card>
  );
}
