import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Archive,
  ArchiveRestore,
  AudioLines,
  FileAudio,
  Loader2,
  Lock,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import {
  COMPLIANCE_CHECKS,
  DROP_CAMPAIGN_LABELS,
  DROP_CAMPAIGN_OPTIONS,
  MAX_DURATION_SECONDS,
  MAX_FILE_BYTES,
  deliveryRate,
  filterDrops,
  formatBytes,
  formatDuration,
  getComplianceGaps,
  summarizeLibrary,
  validateAudioFile,
  validateDropName,
  type ComplianceFlags,
  type DropCampaignType,
  type DropStatusFilter,
  type VoicemailDrop,
  type VoicemailDropStats,
} from '@/lib/voicemailDrops';
import {
  createVoicemailDrop,
  deleteVoicemailDrop,
  fetchVoicemailDropStats,
  fetchVoicemailDrops,
  getVoicemailDropAudioUrl,
  readAudioDuration,
  setVoicemailDropStatus,
  updateVoicemailDrop,
} from '@/lib/voicemailDropsApi';

// ============================================================
// HELPERS
// ============================================================

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const STATUS_TABS: { key: DropStatusFilter; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'archived', label: 'Archived' },
  { key: 'all', label: 'All' },
];

// ============================================================
// SMALL PIECES
// ============================================================

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

function ComplianceBadge({ ready }: { ready: boolean }) {
  return ready ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-success-500/10 px-2.5 py-0.5 text-xs font-medium text-success-500">
      <ShieldCheck size={12} aria-hidden="true" /> Compliance ready
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-warning-500/10 px-2.5 py-0.5 text-xs font-medium text-warning-500">
      <ShieldAlert size={12} aria-hidden="true" /> Needs review
    </span>
  );
}

/** Fetches a short-lived signed URL only when the user presses play. */
function DropPlayer({ path }: { path: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const signedRef = useRef<{ url: string; at: number } | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle');

  const toggle = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (state === 'playing') {
      audio.pause();
      return;
    }
    try {
      setState('loading');
      let cached = signedRef.current;
      if (!cached || Date.now() - cached.at > 4 * 60_000) {
        cached = { url: await getVoicemailDropAudioUrl(path), at: Date.now() };
        signedRef.current = cached;
        audio.src = cached.url;
      }
      await audio.play();
    } catch {
      setState('error');
    }
  };

  return (
    <div className="flex shrink-0 flex-col items-center gap-1">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={state === 'loading'}
        aria-label={state === 'playing' ? 'Pause preview' : 'Play preview'}
        className="focus-ring flex h-10 w-10 items-center justify-center rounded-full bg-accent/10 text-accent transition-colors hover:bg-accent/20 disabled:opacity-60"
      >
        {state === 'loading' ? (
          <Loader2 size={16} className="animate-spin" />
        ) : state === 'playing' ? (
          <Pause size={16} />
        ) : (
          <Play size={16} />
        )}
      </button>
      {state === 'error' && (
        <span role="alert" className="text-[11px] text-danger">
          Can't play
        </span>
      )}
      <audio
        ref={audioRef}
        preload="none"
        onPlay={() => setState('playing')}
        onPause={() => setState('idle')}
        onEnded={() => setState('idle')}
        onError={() => setState('error')}
      />
    </div>
  );
}

// ============================================================
// DROP CARD
// ============================================================

interface DropCardProps {
  drop: VoicemailDrop;
  stats: VoicemailDropStats | undefined;
  busy: boolean;
  onEdit: (drop: VoicemailDrop) => void;
  onToggleArchive: (drop: VoicemailDrop) => void;
  onDelete: (drop: VoicemailDrop) => void;
}

function DropCard({ drop, stats, busy, onEdit, onToggleArchive, onDelete }: DropCardProps) {
  const archived = drop.status === 'archived';
  const rate = deliveryRate(stats);
  const gaps = getComplianceGaps(drop);

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={`rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5 ${archived ? 'opacity-70' : ''}`}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <DropPlayer path={drop.storage_path} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="break-words text-sm font-semibold text-text-primary">{drop.name}</h3>
              {archived && (
                <span className="rounded-full bg-bg-tertiary px-2.5 py-0.5 text-xs font-medium text-text-secondary">
                  Archived
                </span>
              )}
              <ComplianceBadge ready={drop.compliance_ready} />
              {drop.uses_ai_voice && (
                <span className="rounded-full bg-accent/10 px-2.5 py-0.5 text-xs font-medium text-accent">
                  AI voice
                </span>
              )}
            </div>
            {drop.description && (
              <p className="mt-1 text-xs leading-relaxed text-text-secondary">{drop.description}</p>
            )}
            <p className="mt-1.5 text-xs text-text-secondary">
              {formatDuration(drop.duration_seconds)} · {formatBytes(drop.size_bytes)} · Uploaded{' '}
              {formatDate(drop.created_at)}
            </p>
            {drop.campaign_types.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {drop.campaign_types.map((t) => (
                  <span
                    key={t}
                    className="rounded-full border border-border px-2.5 py-0.5 text-xs text-text-secondary"
                  >
                    {DROP_CAMPAIGN_LABELS[t as DropCampaignType] ?? t}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2 sm:justify-end">
          <Button variant="secondary" size="sm" onClick={() => onEdit(drop)} disabled={busy}>
            <Pencil size={14} /> Edit
          </Button>
          <Button variant="secondary" size="sm" onClick={() => onToggleArchive(drop)} disabled={busy}>
            {busy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : archived ? (
              <ArchiveRestore size={14} />
            ) : (
              <Archive size={14} />
            )}
            {archived ? 'Restore' : 'Archive'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDelete(drop)}
            disabled={busy}
            className="hover:text-danger"
            aria-label={`Delete ${drop.name}`}
          >
            <Trash2 size={14} />
          </Button>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-border/60 pt-4 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-text-secondary">Total uses</dt>
          <dd className="mt-0.5 text-sm font-semibold text-text-primary">{stats?.total_uses ?? 0}</dd>
        </div>
        <div>
          <dt className="text-text-secondary">Last 30 days</dt>
          <dd className="mt-0.5 text-sm font-semibold text-text-primary">{stats?.uses_30d ?? 0}</dd>
        </div>
        <div>
          <dt className="text-text-secondary">Delivery rate</dt>
          <dd className="mt-0.5 text-sm font-semibold text-text-primary">{rate === null ? '—' : `${rate}%`}</dd>
        </div>
        <div>
          <dt className="text-text-secondary">Last used</dt>
          <dd className="mt-0.5 text-sm font-semibold text-text-primary">
            {stats?.last_used_at ? formatDate(stats.last_used_at) : 'Never'}
          </dd>
        </div>
      </dl>

      {!archived && gaps.length > 0 && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-warning-500">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>Blocked from campaigns until: {gaps.join(', ').toLowerCase()}.</span>
        </p>
      )}
    </motion.li>
  );
}

// ============================================================
// UPLOAD / EDIT DIALOG
// ============================================================

interface DropFormDialogProps {
  accountOwnerId: string;
  drop: VoicemailDrop | null;
  onClose: () => void;
  onSaved: (drop: VoicemailDrop, created: boolean) => void;
}

function DropFormDialog({ accountOwnerId, drop, onClose, onSaved }: DropFormDialogProps) {
  const { toast } = useToast();
  const isEdit = drop !== null;
  const titleId = useId();
  const fileId = useId();
  const dialogRef = useFocusTrap(true);

  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  const [name, setName] = useState(drop?.name ?? '');
  const [description, setDescription] = useState(drop?.description ?? '');
  const [transcript, setTranscript] = useState(drop?.transcript ?? '');
  const [campaignTypes, setCampaignTypes] = useState<DropCampaignType[]>(drop?.campaign_types ?? []);
  const [usesAiVoice, setUsesAiVoice] = useState(drop?.uses_ai_voice ?? false);
  const [flags, setFlags] = useState<ComplianceFlags>({
    discloses_business_name: drop?.discloses_business_name ?? false,
    includes_callback_number: drop?.includes_callback_number ?? false,
    includes_opt_out: drop?.includes_opt_out ?? false,
    consent_confirmed: drop?.consent_confirmed ?? false,
  });

  const guardedClose = useCallback(() => {
    if (!submitting) onClose();
  }, [submitting, onClose]);
  useEscapeToClose(true, guardedClose);

  const pickFile = async (picked: File | undefined) => {
    if (!picked) return;
    const problem = validateAudioFile(picked);
    if (problem) {
      setFile(null);
      setDuration(null);
      setFileError(problem);
      return;
    }
    const seconds = await readAudioDuration(picked);
    if (seconds !== null && seconds > MAX_DURATION_SECONDS) {
      setFile(null);
      setDuration(null);
      setFileError(`Recording is too long. Keep voicemail drops under ${MAX_DURATION_SECONDS} seconds.`);
      return;
    }
    setFile(picked);
    setDuration(seconds);
    setFileError(null);
    if (!name.trim()) {
      setName(picked.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 120));
    }
  };

  const toggleCampaign = (type: DropCampaignType) =>
    setCampaignTypes((prev) => (prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const nErr = validateDropName(name);
    setNameError(nErr);
    if (!isEdit && !file) setFileError('Choose an MP3 or WAV file.');
    if (nErr || (!isEdit && !file)) return;

    setSubmitting(true);
    try {
      const cleanDescription = description.trim() || null;
      const cleanTranscript = transcript.trim() || null;
      if (isEdit && drop) {
        const saved = await updateVoicemailDrop(accountOwnerId, drop.id, {
          name,
          description: cleanDescription,
          transcript: cleanTranscript,
          campaign_types: campaignTypes,
          uses_ai_voice: usesAiVoice,
          ...flags,
        });
        onSaved(saved, false);
        toast('Voicemail drop updated', 'success');
      } else if (file) {
        const saved = await createVoicemailDrop({
          accountOwnerId,
          file,
          name,
          description: cleanDescription,
          transcript: cleanTranscript,
          campaignTypes,
          usesAiVoice,
          durationSeconds: duration,
          ...flags,
        });
        onSaved(saved, true);
        toast('Voicemail drop uploaded', 'success');
      }
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save this voicemail drop', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) guardedClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 shadow-xl sm:max-w-lg sm:rounded-2xl sm:p-6"
      >
        <div className="mb-5 flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-lg font-bold text-text-primary">
            {isEdit ? 'Edit voicemail drop' : 'Upload voicemail drop'}
          </h2>
          <button
            type="button"
            onClick={guardedClose}
            disabled={submitting}
            aria-label="Close"
            className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={(e) => void submit(e)} className="space-y-5" noValidate>
          {isEdit && drop ? (
            <div className="flex items-center gap-3 rounded-xl border border-border bg-bg-primary p-3 text-xs text-text-secondary">
              <FileAudio size={16} className="shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-all">
                {drop.file_name} · {formatDuration(drop.duration_seconds)} · {formatBytes(drop.size_bytes)}
              </span>
            </div>
          ) : (
            <div>
              <label
                htmlFor={fileId}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  void pickFile(e.dataTransfer.files[0]);
                }}
                className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors focus-within:border-accent ${
                  dragging
                    ? 'border-accent bg-accent/5'
                    : fileError
                      ? 'border-danger'
                      : 'border-border hover:border-accent/50'
                }`}
              >
                <Upload size={22} className="text-text-secondary" aria-hidden="true" />
                {file ? (
                  <>
                    <span className="break-all text-sm font-medium text-text-primary">{file.name}</span>
                    <span className="text-xs text-text-secondary">
                      {formatDuration(duration)} · {formatBytes(file.size)} · tap to replace
                    </span>
                  </>
                ) : (
                  <>
                    <span className="text-sm font-medium text-text-primary">
                      Drop an audio file or tap to browse
                    </span>
                    <span className="text-xs text-text-secondary">
                      MP3 or WAV · up to {formatBytes(MAX_FILE_BYTES)} · max {MAX_DURATION_SECONDS}s
                    </span>
                  </>
                )}
                <input
                  id={fileId}
                  type="file"
                  accept=".mp3,.wav,audio/mpeg,audio/wav"
                  className="sr-only"
                  onChange={(e) => {
                    void pickFile(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </label>
              {fileError && (
                <p role="alert" className="mt-1.5 text-xs text-danger">
                  {fileError}
                </p>
              )}
            </div>
          )}

          <Input
            label="Name"
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={nameError ?? undefined}
            placeholder="e.g. Quote follow-up, friendly"
          />

          <Textarea
            label="Description"
            rows={2}
            maxLength={500}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="When should this drop be used?"
          />

          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-text-primary">Use for</legend>
            <div className="flex flex-wrap gap-2">
              {DROP_CAMPAIGN_OPTIONS.map((opt) => {
                const on = campaignTypes.includes(opt.type);
                return (
                  <button
                    key={opt.type}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleCampaign(opt.type)}
                    className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                      on
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-border text-text-secondary hover:border-accent/40'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-xs text-text-secondary">Leave empty to allow every campaign.</p>
          </fieldset>

          <Textarea
            label="Transcript (optional)"
            rows={3}
            maxLength={2000}
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            helperText="Paste what the recording says. It makes drops searchable and easy to audit."
          />

          <label className="flex items-start gap-3 text-sm text-text-primary">
            <input
              type="checkbox"
              checked={usesAiVoice}
              onChange={(e) => setUsesAiVoice(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-accent"
            />
            <span>This recording uses a cloned or AI-generated voice</span>
          </label>

          <fieldset className="rounded-xl border border-border bg-bg-primary p-4">
            <legend className="px-1 text-sm font-semibold text-text-primary">Compliance checklist</legend>
            <p className="mb-3 text-xs text-text-secondary">
              A self-attested checklist, not legal advice. Drops stay blocked from campaigns until all four are
              checked.
            </p>
            <div className="space-y-3">
              {COMPLIANCE_CHECKS.map((check) => (
                <label key={check.key} className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={flags[check.key]}
                    onChange={(e) => setFlags((prev) => ({ ...prev, [check.key]: e.target.checked }))}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-accent"
                  />
                  <span>
                    <span className="block text-sm text-text-primary">{check.label}</span>
                    <span className="block text-xs text-text-secondary">{check.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={guardedClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={submitting}>
              {submitting && <Loader2 size={14} className="animate-spin" />}
              {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Upload drop'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function VoicemailDropsPage() {
  const { profile, teamMember, isOwner, permissions } = useAuth();
  const { toast } = useToast();

  const canAccess = isOwner || permissions.can_view_billing;
  const accountOwnerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;

  const [drops, setDrops] = useState<VoicemailDrop[]>([]);
  const [stats, setStats] = useState<Record<string, VoicemailDropStats>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<DropStatusFilter>('active');
  const [query, setQuery] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<VoicemailDrop | null>(null);
  const [deleting, setDeleting] = useState<VoicemailDrop | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    if (!accountOwnerId || !canAccess) return;
    const requestId = ++requestRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const [dropRows, statRows] = await Promise.all([
        fetchVoicemailDrops(accountOwnerId),
        // Stats are a nice-to-have: never block the library on them.
        fetchVoicemailDropStats(accountOwnerId).catch((): Record<string, VoicemailDropStats> => ({})),
      ]);
      if (requestId !== requestRef.current) return;
      setDrops(dropRows);
      setStats(statRows);
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setLoadError(err instanceof Error ? err.message : 'Could not load voicemail drops.');
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [accountOwnerId, canAccess]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(() => summarizeLibrary(drops, stats), [drops, stats]);
  const visible = useMemo(
    () => filterDrops(drops, { status: statusFilter, query }),
    [drops, statusFilter, query],
  );
  const tabCounts: Record<DropStatusFilter, number> = {
    active: summary.active,
    archived: summary.archived,
    all: summary.total,
  };

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (drop: VoicemailDrop) => {
    setEditing(drop);
    setFormOpen(true);
  };
  const closeForm = useCallback(() => setFormOpen(false), []);

  const handleSaved = useCallback((saved: VoicemailDrop, created: boolean) => {
    setDrops((prev) => (created ? [saved, ...prev] : prev.map((d) => (d.id === saved.id ? saved : d))));
  }, []);

  const handleToggleArchive = async (drop: VoicemailDrop) => {
    if (!accountOwnerId) return;
    const next = drop.status === 'active' ? 'archived' : 'active';
    setBusyId(drop.id);
    try {
      const saved = await setVoicemailDropStatus(accountOwnerId, drop.id, next);
      handleSaved(saved, false);
      toast(next === 'archived' ? 'Drop archived' : 'Drop restored', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update this drop', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    const target = deleting;
    if (!target || !accountOwnerId) return;
    try {
      await deleteVoicemailDrop(accountOwnerId, target);
      setDrops((prev) => prev.filter((d) => d.id !== target.id));
      toast('Voicemail drop deleted', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete this drop', 'error');
    } finally {
      setDeleting(null);
    }
  };

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Voicemail Drops">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Voicemail Drops access is restricted. Ask your account owner to grant you the "View Billing"
            permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Voicemail Drops">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <AudioLines size={20} />
            </span>
            <div>
              <h1 className="text-2xl font-bold text-text-primary">Voicemail Drops</h1>
              <p className="mt-1 text-sm text-text-secondary">
                Pre-recorded messages Sarah can leave when an outbound call reaches voicemail.
              </p>
            </div>
          </div>
          <Button onClick={openCreate} size="sm" className="w-full sm:w-auto">
            <Upload size={16} /> Upload drop
          </Button>
        </div>

        <div className="mt-6">
          {loading ? (
            <div className="space-y-6">
              <SkeletonStatGrid count={4} />
              <SkeletonCardList count={3} rows={3} />
            </div>
          ) : loadError ? (
            <div
              role="alert"
              className="flex flex-col items-center gap-3 rounded-2xl border border-danger/30 bg-danger/5 px-6 py-12 text-center"
            >
              <TriangleAlert size={26} className="text-danger" aria-hidden="true" />
              <div>
                <p className="text-sm font-semibold text-text-primary">Couldn't load your voicemail drops</p>
                <p className="mt-1 text-xs text-text-secondary">{loadError}</p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => void load()}>
                <RefreshCw size={14} /> Try again
              </Button>
            </div>
          ) : drops.length === 0 ? (
            <EmptyState
              icon={AudioLines}
              title="No voicemail drops yet"
              description="Upload a short MP3 or WAV recording and Sarah can use it whenever an outbound call goes to voicemail."
              action={{ label: 'Upload your first drop', onClick: openCreate }}
            />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatTile label="Active drops" value={String(summary.active)} hint={`${summary.archived} archived`} />
                <StatTile
                  label="Compliance ready"
                  value={`${summary.complianceReady}/${summary.active}`}
                  hint={summary.needsReview > 0 ? `${summary.needsReview} need review` : 'All clear'}
                />
                <StatTile label="Used, last 30 days" value={String(summary.uses30d)} />
                <StatTile
                  label="Delivery rate"
                  value={summary.deliveryRate === null ? '—' : `${summary.deliveryRate}%`}
                />
              </div>

              <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div
                  role="group"
                  aria-label="Filter drops by status"
                  className="flex w-full rounded-xl border border-border bg-bg-secondary p-1 sm:w-auto"
                >
                  {STATUS_TABS.map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      aria-pressed={statusFilter === tab.key}
                      onClick={() => setStatusFilter(tab.key)}
                      className={`focus-ring flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors sm:flex-none ${
                        statusFilter === tab.key
                          ? 'bg-accent text-white'
                          : 'text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      {tab.label} <span className="opacity-70">{tabCounts[tab.key]}</span>
                    </button>
                  ))}
                </div>
                <div className="w-full sm:max-w-xs">
                  <Input
                    icon={Search}
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search drops"
                    aria-label="Search voicemail drops"
                  />
                </div>
              </div>

              <div className="mt-4">
                {visible.length === 0 ? (
                  <EmptyState
                    icon={Search}
                    title={query.trim() ? 'No drops match your search' : `No ${statusFilter} drops`}
                    description={
                      query.trim()
                        ? 'Try a different word, or clear the search.'
                        : 'Switch the filter above to see your other drops.'
                    }
                    action={query.trim() ? { label: 'Clear search', onClick: () => setQuery('') } : undefined}
                  />
                ) : (
                  <ul className="space-y-3">
                    {visible.map((drop) => (
                      <DropCard
                        key={drop.id}
                        drop={drop}
                        stats={stats[drop.id]}
                        busy={busyId === drop.id}
                        onEdit={openEdit}
                        onToggleArchive={(d) => void handleToggleArchive(d)}
                        onDelete={setDeleting}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>

        <p className="mt-6 text-xs text-text-secondary/70">
          Compliance flags are a self-attested checklist, not legal advice. Prerecorded and AI-voice messages
          generally require prior consent, so confirm your rules with your own counsel.
        </p>
      </div>

      {formOpen && accountOwnerId && (
        <DropFormDialog
          key={editing?.id ?? 'new'}
          accountOwnerId={accountOwnerId}
          drop={editing}
          onClose={closeForm}
          onSaved={handleSaved}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        title="Delete this voicemail drop?"
        description={`"${deleting?.name ?? ''}" and its audio file will be permanently removed, along with its usage history. Archive it instead if you may need it again.`}
        confirmLabel="Yes, delete drop"
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </DashboardLayout>
  );
}
