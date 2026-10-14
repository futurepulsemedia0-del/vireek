import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  Briefcase,
  FileText,
  Mail,
  MessageSquare,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  PhoneCall,
  Receipt,
  Search,
  Star,
  StickyNote,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { formatCents } from '@/lib/quotes';
import {
  BILLING_KINDS,
  KIND_LABELS,
  MAX_NOTE_LENGTH,
  TIMELINE_KINDS,
  buildFeed,
  checkAttachments,
  countByKind,
  formatBytes,
  groupByDay,
  mapNote,
  noteErrorMessage,
  pinnedNotes,
  validateNoteBody,
  type CustomerNote,
  type CustomerNoteAttachment,
  type TimelineEvent,
  type TimelineKind,
  type TimelineTone,
} from '@/lib/customerTimeline';
import {
  createNote,
  deleteAttachment,
  deleteNote,
  fetchFeed,
  fetchNotes,
  getAttachmentUrl,
  setNotePinned,
  updateNoteBody,
  type FeedResult,
} from '@/lib/customerTimelineApi';

const PAGE_SIZE = 40;

const KIND_ICONS: Record<TimelineKind, LucideIcon> = {
  note: StickyNote,
  call: PhoneCall,
  sms: MessageSquare,
  email: Mail,
  job: Briefcase,
  quote: FileText,
  invoice: Receipt,
  payment: Banknote,
  review: Star,
};

const TONE_STYLES: Record<TimelineTone, string> = {
  neutral: 'bg-bg-tertiary text-text-secondary',
  good: 'bg-success-500/10 text-success-500',
  warn: 'bg-warning-500/10 text-warning-500',
  bad: 'bg-danger/10 text-danger',
};

const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const fullDateLabel = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

interface CustomerTimelineProps {
  customerId: string;
  phone: string | null;
  email: string | null;
}

export function CustomerTimeline({ customerId, phone, email }: CustomerTimelineProps) {
  const { user, profile, teamMember, isOwner, permissions } = useAuth();
  const { toast } = useToast();

  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canViewBilling = permissions.can_view_billing;
  // Mirrors public.tasks_can_view_all() used by the notes RLS policies.
  const isManager = isOwner || permissions.can_view_all_jobs;
  const authorName = profile?.full_name?.trim() || user?.email || null;

  const [feed, setFeed] = useState<FeedResult | null>(null);
  const [feedError, setFeedError] = useState(false);
  const [loadingFull, setLoadingFull] = useState(false);
  const [notes, setNotes] = useState<CustomerNote[]>([]);
  const [notesStatus, setNotesStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  const [kinds, setKinds] = useState<TimelineKind[]>([]);
  const [query, setQuery] = useState('');
  const [visible, setVisible] = useState(PAGE_SIZE);

  const [deleteTarget, setDeleteTarget] = useState<CustomerNote | null>(null);

  const feedToken = useRef(0);

  const loadFeed = useCallback(
    async (full = false) => {
      const token = ++feedToken.current;
      try {
        const result = await fetchFeed({ customerId, phone, email, includeBilling: canViewBilling }, { full });
        if (token !== feedToken.current) return; // a newer request superseded this one
        setFeed(result);
        setFeedError(false);
      } catch {
        if (token === feedToken.current) setFeedError(true);
      }
    },
    [customerId, phone, email, canViewBilling],
  );

  const loadNotes = useCallback(async () => {
    setNotesStatus('loading');
    try {
      setNotes(await fetchNotes(customerId));
      setNotesStatus('ready');
    } catch {
      setNotesStatus('error');
    }
  }, [customerId]);

  useEffect(() => {
    setFeed(null);
    setFeedError(false);
    void loadFeed();
  }, [loadFeed]);

  useEffect(() => {
    void loadNotes();
  }, [loadNotes]);

  const availableKinds = useMemo(() => TIMELINE_KINDS.filter((k) => canViewBilling || !BILLING_KINDS.includes(k)), [canViewBilling]);

  const allEvents = useMemo(() => [...(feed?.events ?? []), ...notes.map(mapNote)], [feed, notes]);
  const counts = useMemo(() => countByKind(allEvents), [allEvents]);
  const filtered = useMemo(() => buildFeed(allEvents, { kinds, query, excludePinnedNotes: true }), [allEvents, kinds, query]);
  const pinned = useMemo(() => pinnedNotes(notes, query), [notes, query]);
  const shown = useMemo(() => filtered.slice(0, visible), [filtered, visible]);
  const groups = useMemo(() => groupByDay(shown), [shown]);

  const toggleKind = (kind: TimelineKind) => {
    setVisible(PAGE_SIZE);
    setKinds((prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]));
  };

  const canEditNote = (n: CustomerNote) => isManager || n.author_id === user?.id;

  // ----- note actions -----------------------------------------------------

  const handleCreated = (note: CustomerNote) => setNotes((prev) => [note, ...prev]);

  const mergeNote = (patch: Partial<CustomerNote> & { id: string }) =>
    setNotes((prev) => prev.map((n) => (n.id === patch.id ? { ...n, ...patch } : n)));

  const handleTogglePin = async (note: CustomerNote) => {
    try {
      mergeNote(await setNotePinned(note.id, !note.pinned));
    } catch (e) {
      toast(noteErrorMessage(e as { message?: string; code?: string }), 'error');
    }
  };

  const handleSaveEdit = async (note: CustomerNote, body: string) => {
    mergeNote(await updateNoteBody(note.id, body)); // throws to the caller so the editor stays open
    toast('Note updated', 'success');
  };

  const handleDeleteNote = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    try {
      await deleteNote(target);
      setNotes((prev) => prev.filter((n) => n.id !== target.id));
      toast('Note deleted', 'success');
    } catch (e) {
      toast(noteErrorMessage(e as { message?: string; code?: string }), 'error');
    }
    setDeleteTarget(null);
  };

  const handleRemoveAttachment = async (note: CustomerNote, att: CustomerNoteAttachment) => {
    try {
      await deleteAttachment(att);
      mergeNote({ id: note.id, attachments: note.attachments.filter((a) => a.id !== att.id) });
    } catch (e) {
      toast(noteErrorMessage(e as { message?: string; code?: string }), 'error');
    }
  };

  const handleOpenAttachment = async (att: CustomerNoteAttachment) => {
    // Open the tab synchronously (popup blockers), then point it at the signed URL.
    const tab = window.open('about:blank', '_blank');
    try {
      const url = await getAttachmentUrl(att.storage_path);
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else {
        window.location.assign(url);
      }
    } catch {
      tab?.close();
      toast('Could not open this file', 'error');
    }
  };

  const handleLoadFull = async () => {
    setLoadingFull(true);
    await loadFeed(true);
    setLoadingFull(false);
  };

  const noteCardProps = {
    canEdit: canEditNote,
    onTogglePin: handleTogglePin,
    onSaveEdit: handleSaveEdit,
    onDelete: setDeleteTarget,
    onOpenAttachment: handleOpenAttachment,
    onRemoveAttachment: handleRemoveAttachment,
  };

  const loading = feed === null && !feedError;
  const hasFilters = kinds.length > 0 || query.trim().length > 0;

  return (
    <section aria-labelledby="customer-timeline-heading" className="mb-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 id="customer-timeline-heading" className="text-sm font-semibold text-text-primary">
          Activity timeline
        </h2>
        <label className="relative block w-full sm:w-64">
          <span className="sr-only">Search the timeline</span>
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setVisible(PAGE_SIZE);
            }}
            placeholder="Search activity and notes"
            className="focus-ring w-full rounded-lg border border-border bg-bg-secondary py-1.5 pl-8 pr-3 text-sm text-text-primary placeholder:text-text-secondary/60"
          />
        </label>
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Filter by activity type">
        <button
          type="button"
          onClick={() => setKinds([])}
          aria-pressed={kinds.length === 0}
          className={`focus-ring rounded-full border px-3 py-1 text-xs font-medium ${
            kinds.length === 0 ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:border-accent/50'
          }`}
        >
          All
        </button>
        {availableKinds.map((kind) => {
          const active = kinds.includes(kind);
          const Icon = KIND_ICONS[kind];
          return (
            <button
              key={kind}
              type="button"
              onClick={() => toggleKind(kind)}
              aria-pressed={active}
              className={`focus-ring flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${
                active ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:border-accent/50'
              }`}
            >
              <Icon size={12} aria-hidden="true" />
              {KIND_LABELS[kind]}
              <span className="tabular-nums opacity-70">{counts[kind]}</span>
            </button>
          );
        })}
      </div>

      <NoteComposer
        customerId={customerId}
        ownerId={ownerId}
        authorName={authorName}
        disabled={notesStatus === 'error'}
        onCreated={handleCreated}
      />

      {notesStatus === 'error' && (
        <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-warning-500/40 bg-warning-500/10 px-4 py-3 text-xs text-text-primary">
          <span>Notes couldn't be loaded. If this is a new setup, make sure the latest database migration has been applied.</span>
          <button type="button" onClick={() => void loadNotes()} className="focus-ring shrink-0 rounded-lg px-2 py-1 font-semibold text-accent hover:underline">
            Retry
          </button>
        </div>
      )}

      {feed && feed.failed.length > 0 && (
        <div role="status" className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-warning-500/40 bg-warning-500/10 px-4 py-3 text-xs text-text-primary">
          <span>Some activity couldn't be loaded: {feed.failed.map((k) => KIND_LABELS[k]).join(', ')}.</span>
          <button type="button" onClick={() => void loadFeed()} className="focus-ring shrink-0 rounded-lg px-2 py-1 font-semibold text-accent hover:underline">
            Retry
          </button>
        </div>
      )}

      {pinned.length > 0 && (
        <div className="mb-4 space-y-2" aria-label="Pinned notes">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
            <Pin size={11} aria-hidden="true" /> Pinned
          </p>
          {pinned.map((n) => (
            <NoteCard key={n.id} note={n} pinnedStyle {...noteCardProps} />
          ))}
        </div>
      )}

      {loading ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading timeline">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      ) : feedError ? (
        <div role="alert" className="rounded-xl border border-border bg-bg-secondary px-4 py-6 text-center">
          <p className="text-sm text-text-primary">We couldn't load this customer's activity.</p>
          <button type="button" onClick={() => void loadFeed()} className="focus-ring mt-2 rounded-lg px-3 py-1.5 text-xs font-semibold text-accent hover:underline">
            Try again
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={hasFilters ? Search : StickyNote}
          title={hasFilters ? 'Nothing matches these filters' : 'No activity recorded'}
          description={hasFilters ? 'Try a different search or clear the filters.' : 'Calls, messages, jobs, quotes and notes will appear here as they happen.'}
          action={hasFilters ? { label: 'Clear filters', onClick: () => { setKinds([]); setQuery(''); } } : undefined}
        />
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <div key={group.key}>
              <h3 className="sticky top-0 z-10 mb-2 bg-bg-primary/90 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary backdrop-blur">
                {group.label}
              </h3>
              <ol className="space-y-2">
                {group.events.map((event) => (
                  <li key={event.id}>{event.note ? <NoteCard note={event.note} {...noteCardProps} /> : <EventRow event={event} />}</li>
                ))}
              </ol>
            </div>
          ))}

          {filtered.length > shown.length && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => setVisible((v) => v + PAGE_SIZE)}
                className="focus-ring rounded-lg border border-border px-4 py-1.5 text-xs font-medium text-text-secondary hover:border-accent/50 hover:text-accent"
              >
                Show {Math.min(PAGE_SIZE, filtered.length - shown.length)} more
              </button>
            </div>
          )}

          {feed?.capped && filtered.length <= shown.length && (
            <p className="text-center text-xs text-text-secondary">
              Showing the most recent activity.{' '}
              <button type="button" onClick={() => void handleLoadFull()} disabled={loadingFull} className="focus-ring font-semibold text-accent hover:underline disabled:opacity-60">
                {loadingFull ? 'Loading…' : 'Load full history'}
              </button>
            </p>
          )}
        </div>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete this note?"
        description="The note and any files attached to it will be permanently removed for everyone on your team."
        confirmLabel="Yes, delete it"
        onConfirm={handleDeleteNote}
        onCancel={() => setDeleteTarget(null)}
      />
    </section>
  );
}

// ===========================================================================
// Event row (everything except notes)
// ===========================================================================

function EventRow({ event }: { event: TimelineEvent }) {
  const Icon = KIND_ICONS[event.kind];
  const DirectionIcon = event.direction === 'inbound' ? ArrowDownLeft : event.direction === 'outbound' ? ArrowUpRight : null;

  return (
    <div className="flex gap-3 rounded-xl border border-border bg-bg-secondary px-4 py-3">
      <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${TONE_STYLES[event.tone]}`}>
        <Icon size={15} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <p className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
            {DirectionIcon && <DirectionIcon size={13} className="shrink-0 text-text-secondary" aria-label={event.direction ?? undefined} />}
            <span className="break-words">{event.title}</span>
          </p>
          <time dateTime={event.at} title={fullDateLabel(event.at)} className="text-xs text-text-secondary">
            {timeLabel(event.at)}
          </time>
        </div>
        {event.detail && <p className="mt-1 line-clamp-3 whitespace-pre-line break-words text-sm text-text-secondary">{event.detail}</p>}
        {(event.meta.length > 0 || event.amountCents !== null || event.href) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
            {event.amountCents !== null && <span className="font-semibold text-text-primary">{formatCents(event.amountCents)}</span>}
            {event.meta.map((m) => (
              <span key={m}>{m}</span>
            ))}
            {event.href && (
              <Link to={event.href} className="focus-ring ml-auto rounded font-medium text-accent hover:underline">
                Open
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// Note card (pinned panel + feed)
// ===========================================================================

interface NoteCardProps {
  note: CustomerNote;
  pinnedStyle?: boolean;
  canEdit: (note: CustomerNote) => boolean;
  onTogglePin: (note: CustomerNote) => Promise<void>;
  onSaveEdit: (note: CustomerNote, body: string) => Promise<void>;
  onDelete: (note: CustomerNote) => void;
  onOpenAttachment: (att: CustomerNoteAttachment) => Promise<void>;
  onRemoveAttachment: (note: CustomerNote, att: CustomerNoteAttachment) => Promise<void>;
}

function NoteCard({ note, pinnedStyle = false, canEdit, onTogglePin, onSaveEdit, onDelete, onOpenAttachment, onRemoveAttachment }: NoteCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const editable = canEdit(note);
  const long = note.body.length > 320 || note.body.split('\n').length > 5;

  const startEdit = () => {
    setDraft(note.body);
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    const problem = validateNoteBody(draft, note.attachments.length > 0);
    if (problem) {
      setError(problem);
      return;
    }
    if (draft.trim() === note.body) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSaveEdit(note, draft);
      setEditing(false);
    } catch (e) {
      setError(noteErrorMessage(e as { message?: string; code?: string }));
    }
    setSaving(false);
  };

  return (
    <article
      className={`rounded-xl border px-4 py-3 ${pinnedStyle ? 'border-accent/40 bg-accent/5' : 'border-border bg-bg-secondary'}`}
      aria-label={`Note by ${note.author_name ?? 'a team member'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <StickyNote size={15} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-text-primary">{note.author_name?.trim() || 'Team member'}</p>
            <p className="text-xs text-text-secondary">
              <time dateTime={note.created_at}>{fullDateLabel(note.created_at)}</time>
              {note.edited_at && <span title={fullDateLabel(note.edited_at)}> · edited</span>}
            </p>
          </div>
        </div>
        {editable && !editing && (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => void onTogglePin(note)}
              className="focus-ring rounded-lg p-1.5 text-text-secondary hover:text-accent"
              aria-label={note.pinned ? 'Unpin note' : 'Pin note'}
              aria-pressed={note.pinned}
            >
              {note.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
            <button type="button" onClick={startEdit} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:text-accent" aria-label="Edit note">
              <Pencil size={14} />
            </button>
            <button type="button" onClick={() => onDelete(note)} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:text-danger" aria-label="Delete note">
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>

      {editing ? (
        <div className="mt-3">
          <Textarea
            aria-label="Edit note"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={MAX_NOTE_LENGTH}
            rows={4}
            error={error ?? undefined}
            autoFocus
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className={`mt-3 whitespace-pre-wrap break-words text-sm text-text-primary ${long && !expanded ? 'line-clamp-5' : ''}`}>{note.body}</p>
          {long && (
            <button type="button" onClick={() => setExpanded((v) => !v)} className="focus-ring mt-1 rounded text-xs font-medium text-accent hover:underline">
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </>
      )}

      {note.attachments.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="Attachments">
          {note.attachments.map((att) => (
            <li key={att.id} className="flex items-center rounded-lg border border-border bg-bg-primary text-xs">
              <button
                type="button"
                onClick={() => void onOpenAttachment(att)}
                className="focus-ring flex max-w-[14rem] items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-text-primary hover:text-accent"
                title={att.file_name}
              >
                <Paperclip size={12} className="shrink-0" aria-hidden="true" />
                <span className="truncate">{att.file_name}</span>
                <span className="shrink-0 text-text-secondary">{formatBytes(att.size_bytes)}</span>
              </button>
              {editable && (
                <button
                  type="button"
                  onClick={() => void onRemoveAttachment(note, att)}
                  className="focus-ring mr-1 rounded p-1 text-text-secondary hover:text-danger"
                  aria-label={`Remove ${att.file_name}`}
                >
                  <X size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

// ===========================================================================
// Composer
// ===========================================================================

interface NoteComposerProps {
  customerId: string;
  ownerId: string | undefined;
  authorName: string | null;
  disabled: boolean;
  onCreated: (note: CustomerNote) => void;
}

function NoteComposer({ customerId, ownerId, authorName, disabled, onCreated }: NoteComposerProps) {
  const { toast } = useToast();
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [pin, setPin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const addFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const { accepted, errors } = checkAttachments(files, Array.from(list));
    if (accepted.length > 0) setFiles((prev) => [...prev, ...accepted]);
    setError(errors.length > 0 ? errors.join(' ') : null);
    if (fileInput.current) fileInput.current.value = ''; // allow re-selecting the same file
  };

  const submit = async () => {
    if (posting) return;
    const problem = validateNoteBody(body, files.length > 0);
    if (problem) {
      setError(problem);
      return;
    }
    if (!ownerId) {
      setError('Your account is still loading. Please try again in a moment.');
      return;
    }
    setPosting(true);
    setError(null);
    try {
      const { note, failedFiles } = await createNote({ customerId, ownerId, authorName, body, pinned: pin, files });
      onCreated(note);
      setBody('');
      setFiles([]);
      setPin(false);
      if (failedFiles.length > 0) {
        toast(`Note saved, but ${failedFiles.length} file${failedFiles.length === 1 ? '' : 's'} couldn't be uploaded: ${failedFiles.join(', ')}`, 'error');
      } else {
        toast('Note added', 'success');
      }
    } catch (e) {
      setError(noteErrorMessage(e as { message?: string; code?: string }));
    }
    setPosting(false);
  };

  return (
    <div className="mb-4 rounded-xl border border-border bg-bg-secondary p-3">
      <Textarea
        aria-label="Add an internal note"
        placeholder="Add an internal note — only your team can see this"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        maxLength={MAX_NOTE_LENGTH}
        rows={2}
        error={error ?? undefined}
        disabled={disabled || posting}
      />

      {files.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2" aria-label="Files to attach">
          {files.map((f) => (
            <li key={`${f.name}-${f.size}`} className="flex items-center gap-1.5 rounded-lg border border-border bg-bg-primary py-1 pl-2.5 pr-1 text-xs text-text-primary">
              <Paperclip size={12} aria-hidden="true" />
              <span className="max-w-[12rem] truncate">{f.name}</span>
              <span className="text-text-secondary">{formatBytes(f.size)}</span>
              <button
                type="button"
                onClick={() => setFiles((prev) => prev.filter((x) => x !== f))}
                disabled={posting}
                className="focus-ring rounded p-1 text-text-secondary hover:text-danger"
                aria-label={`Remove ${f.name}`}
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept="image/*,.pdf,.txt,.csv,.doc,.docx,.xls,.xlsx"
            onChange={(e) => addFiles(e.target.files)}
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={disabled || posting}
            className="focus-ring flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-text-secondary hover:text-accent disabled:opacity-50"
          >
            <Paperclip size={13} aria-hidden="true" /> Attach files
          </button>
          <label className="flex items-center gap-1.5 text-xs text-text-secondary">
            <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} disabled={disabled || posting} className="accent-accent" />
            Pin to top
          </label>
        </div>
        <Button type="button" size="sm" onClick={() => void submit()} disabled={disabled || posting || (body.trim().length === 0 && files.length === 0)}>
          {posting ? 'Posting…' : 'Add note'}
        </Button>
      </div>
    </div>
  );
}
