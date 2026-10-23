import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Handshake,
  Loader2,
  Lock,
  MessagesSquare,
  Mic,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { FadeIn, SkeletonStatGrid, SkeletonTable } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { ConversationRecorder } from '@/components/conversations/ConversationRecorder';
import {
  DEFAULT_SETTINGS,
  analyzeRecording,
  discardRecording,
  fetchCoachingRollup,
  fetchRecentCoachingNotes,
  fetchRecordingDetail,
  fetchRecordings,
  fetchSettings,
  saveSettings,
  type CoachingRollupRow,
  type IntelSettings,
  type InsightRow,
  type RecentCoachingNote,
  type RecordingDetail,
  type RecordingRow,
} from '@/lib/conversationIntelApi';
import {
  INSIGHT_KINDS,
  KIND_LABELS,
  STATUS_LABELS,
  formatDuration,
  retentionDaysLeft,
  type InsightKind,
} from '../../supabase/functions/_shared/conversation-intel/engine';

type Tab = 'conversations' | 'coaching' | 'settings';
type LoadState = 'loading' | 'ready' | 'error';

const KIND_STYLE: Record<InsightKind, string> = {
  commitment: 'bg-accent/10 text-accent',
  objection: 'bg-warning-500/10 text-warning-500',
  upsell: 'bg-success-500/10 text-success',
  safety: 'bg-danger/10 text-danger',
};

function whenLabel(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function techName(t: { member_name: string | null; member_email: string } | null): string {
  return t ? t.member_name || t.member_email : 'Owner';
}

function StatusBadge({ status }: { status: RecordingRow['status'] }) {
  const tone =
    status === 'analyzed' ? 'bg-success-500/10 text-success'
    : status === 'failed' ? 'bg-danger/10 text-danger'
    : status === 'declined' || status === 'discarded' ? 'bg-bg-tertiary text-text-secondary'
    : 'bg-accent/10 text-accent';
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>{STATUS_LABELS[status]}</span>;
}

function ScoreBar({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <div className="flex justify-between text-[11px] text-text-secondary"><span>{label}</span><span>{value ?? '—'}</span></div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-tertiary">
        <div className="h-full rounded-full bg-accent" style={{ width: `${value ?? 0}%` }} />
      </div>
    </div>
  );
}

function InsightList({ insights }: { insights: InsightRow[] }) {
  const navigate = useNavigate();
  if (insights.length === 0) return <p className="text-sm text-text-secondary">Nothing notable was detected in this conversation.</p>;
  return (
    <div className="space-y-4">
      {INSIGHT_KINDS.map((kind) => {
        const items = insights.filter((i) => i.kind === kind);
        if (items.length === 0) return null;
        return (
          <div key={kind}>
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${KIND_STYLE[kind]}`}>{KIND_LABELS[kind]} · {items.length}</span>
            <ul className="mt-2 space-y-2">
              {items.map((i) => (
                <li key={i.id} className="rounded-xl border border-border bg-bg-tertiary/50 p-3">
                  <p className="text-sm font-medium text-text-primary">{i.text}</p>
                  {i.evidence && <p className="mt-1 text-xs italic text-text-secondary">“{i.evidence}”</p>}
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
                    <span className="capitalize">{i.speaker}</span>
                    {(i.kind === 'safety' || i.kind === 'upsell') && <span className="capitalize">{i.severity}</span>}
                    {i.kind === 'objection' && <span>{i.resolved === true ? 'Resolved' : i.resolved === false ? 'Unresolved' : 'Unclear'}</span>}
                    {i.due_at && <span>Due {whenLabel(i.due_at)}{i.due_description ? ` (“${i.due_description}”)` : ''}</span>}
                    {i.commitment_id && (
                      <button type="button" onClick={() => navigate('/dashboard/commitments')} className="focus-ring font-medium text-accent hover:underline">
                        <Handshake size={11} className="mr-1 inline" />Commitment
                      </button>
                    )}
                    {i.task_id && (
                      <button type="button" onClick={() => navigate('/dashboard/tasks')} className="focus-ring font-medium text-accent hover:underline">
                        <CheckCircle2 size={11} className="mr-1 inline" />Follow-up task
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function RecordingCard({
  rec, now, canManage, onChanged,
}: { rec: RecordingRow; now: Date; canManage: boolean; onChanged: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<RecordingDetail | null>(null);
  const [detailState, setDetailState] = useState<LoadState>('loading');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadDetail = useCallback(async () => {
    setDetailState('loading');
    try {
      setDetail(await fetchRecordingDetail(rec.id));
      setDetailState('ready');
    } catch {
      setDetailState('error');
    }
  }, [rec.id]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !detail) void loadDetail();
  }

  async function retry() {
    setBusy(true);
    try {
      await analyzeRecording(rec.id);
      toast('Analysis complete.', 'success');
      setDetail(null);
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Analysis failed.', 'error');
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await discardRecording(rec.id);
      toast('Recording and everything derived from it were deleted.', 'success');
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete the recording.', 'error');
      setBusy(false);
    }
  }

  const gone = rec.status === 'discarded' || rec.status === 'declined';
  const left = retentionDaysLeft(rec.audio_expires_at, now);

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-text-primary">{rec.customer_name ?? 'Customer'}</p>
            <StatusBadge status={rec.status} />
            {rec.customer_consent_status === 'granted' && (
              <span className="flex items-center gap-1 rounded-full bg-bg-tertiary px-2.5 py-1 text-[11px] text-text-secondary">
                <CheckCircle2 size={11} /> Consent {rec.customer_consent_method === 'both' ? '(tap + spoken)' : '(tap)'}
                {rec.jurisdiction_state ? ` · ${rec.jurisdiction_state}` : ''}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-text-secondary">
            {techName(rec.technician)} · {whenLabel(rec.created_at)} · {formatDuration(rec.duration_seconds)}
            {left !== null && !gone ? ` · audio deleted in ${left}d` : ''}
          </p>
          {rec.summary && <p className="mt-2 text-sm text-text-primary">{rec.summary}</p>}
          {rec.status === 'failed' && rec.analysis_error && <p className="mt-2 text-xs text-danger">{rec.analysis_error}</p>}
        </div>
        {!gone && (
          <button type="button" onClick={toggle} className="focus-ring shrink-0 rounded-lg p-2 text-text-secondary hover:text-text-primary" aria-label={open ? 'Collapse' : 'Expand'} aria-expanded={open}>
            {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        )}
      </div>

      {open && !gone && (
        <div className="mt-4 space-y-4 border-t border-border/60 pt-4">
          {detailState === 'loading' && <p className="flex items-center gap-2 text-sm text-text-secondary"><Loader2 size={14} className="animate-spin" /> Loading…</p>}
          {detailState === 'error' && <p className="text-sm text-danger">Couldn’t load this conversation. <button type="button" className="font-medium underline" onClick={() => void loadDetail()}>Retry</button></p>}
          {detailState === 'ready' && detail && (
            <>
              <InsightList insights={detail.insights} />
              {detail.coaching && (
                <div className="rounded-xl border border-border p-3">
                  <p className="flex items-center gap-2 text-sm font-semibold text-text-primary"><Sparkles size={14} className="text-accent" /> Coaching note</p>
                  {detail.coaching.summary && <p className="mt-1 text-sm text-text-secondary">{detail.coaching.summary}</p>}
                  <div className="mt-3 grid gap-4 md:grid-cols-2">
                    <div>
                      <p className="text-xs font-semibold text-success">Did well</p>
                      <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-text-primary">{detail.coaching.strengths.map((s) => <li key={s}>{s}</li>)}</ul>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-warning-500">Try next time</p>
                      <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-text-primary">{detail.coaching.improvements.map((s) => <li key={s}>{s}</li>)}</ul>
                    </div>
                  </div>
                  {detail.coaching.focus_next && <p className="mt-3 text-sm text-text-primary"><span className="font-semibold">Focus:</span> {detail.coaching.focus_next}</p>}
                </div>
              )}
              {detail.transcript ? (
                <details className="rounded-xl border border-border p-3">
                  <summary className="cursor-pointer text-sm font-medium text-text-primary">Transcript</summary>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">{detail.transcript}</p>
                </details>
              ) : (
                <p className="text-xs text-text-secondary">The transcript has passed its retention period and was removed.</p>
              )}
            </>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
        {(rec.status === 'failed' || rec.status === 'uploaded') && (
          <Button size="sm" variant="secondary" onClick={() => void retry()} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} {rec.status === 'failed' ? 'Retry analysis' : 'Analyse now'}
          </Button>
        )}
        {!gone && (confirmDelete ? (
          <>
            <span className="text-xs text-text-secondary">Deletes the audio, transcript, insights, commitments and tasks from this conversation.</span>
            <Button size="sm" variant="secondary" onClick={() => void remove()} disabled={busy}><Trash2 size={14} /> Yes, delete</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)} disabled={busy}>Keep</Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)} disabled={busy}><Trash2 size={14} /> Delete{canManage ? '' : ' my recording'}</Button>
        ))}
      </div>
    </div>
  );
}

function CoachingTab({ rollup, notes }: { rollup: CoachingRollupRow[]; notes: RecentCoachingNote[] }) {
  if (rollup.length === 0 && notes.length === 0) {
    return (
      <EmptyState
        icon={Sparkles}
        title="No coaching notes yet"
        description="After a few analysed conversations, each technician’s strengths, focus areas and promise-keeping record appear here."
      />
    );
  }
  return (
    <div className="space-y-6">
      <div className="grid gap-3 md:grid-cols-2">
        {rollup.map((r) => (
          <Card key={r.technician_member_id ?? 'owner'} className="!p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-text-primary">{r.technician_name}</p>
              <span className="text-xs text-text-secondary">{r.conversations} conversation{r.conversations === 1 ? '' : 's'} · 30 days</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
              <ScoreBar label="Communication" value={r.avg_communication} />
              <ScoreBar label="Promise clarity" value={r.avg_commitment_clarity} />
              <ScoreBar label="Objection handling" value={r.avg_objection_handling} />
              <ScoreBar label="Safety awareness" value={r.avg_safety_awareness} />
              <ScoreBar label="Upsell discovery" value={r.avg_upsell_discovery} />
            </div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
              <span>Promises: {r.promises_kept}/{r.promises_made} kept{r.promises_broken > 0 ? ` · ${r.promises_broken} broken` : ''}</span>
              <span>Open objections: {r.objections_unresolved}</span>
              <span>Upsells found: {r.upsells_found}</span>
              <span>Safety flags: {r.safety_flags}</span>
            </div>
          </Card>
        ))}
      </div>
      {notes.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-text-primary">Latest coaching notes</h3>
          <div className="space-y-2">
            {notes.map((n) => (
              <div key={n.recording_id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                <p className="text-xs text-text-secondary">{techName(n.technician)} · {n.recording?.customer_name ?? 'Customer'} · {whenLabel(n.recording?.created_at ?? n.created_at)}</p>
                {n.focus_next && <p className="mt-1 text-sm font-medium text-text-primary">Focus: {n.focus_next}</p>}
                {n.summary && <p className="mt-1 text-sm text-text-secondary">{n.summary}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SettingsTab({ initial, onSaved }: { initial: IntelSettings; onSaved: (s: IntelSettings) => void }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<IntelSettings>(initial);
  const [saving, setSaving] = useState(false);

  async function save() {
    const audio = Math.round(draft.audio_retention_days);
    const text = Math.round(draft.transcript_retention_days);
    if (!(audio >= 1 && audio <= 365) || !(text >= 7 && text <= 730)) {
      toast('Audio can be kept 1–365 days and transcripts 7–730 days.', 'error');
      return;
    }
    const next = { ...draft, audio_retention_days: audio, transcript_retention_days: text };
    setSaving(true);
    try {
      await saveSettings(next);
      setDraft(next);
      onSaved(next);
      toast('Settings saved.', 'success');
    } catch {
      toast('Could not save settings.', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="!p-5">
      <div className="flex items-start gap-3">
        <input id="ci-enabled" type="checkbox" className="mt-1" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
        <label htmlFor="ci-enabled" className="text-sm text-text-primary">
          <span className="font-semibold">Allow technicians to record in-home conversations</span>
          <span className="mt-1 block text-text-secondary">
            Recording only starts after the customer and the technician both agree. The customer can decline with no effect on service, and a recording can be stopped and deleted at any time.
            Vireek requires explicit consent in every state and applies the strictest rules where the state is unknown. This is not legal advice — confirm the rules for the states you serve with your counsel.
          </span>
        </label>
      </div>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <Input label="Keep audio for (days)" type="number" min={1} max={365} value={draft.audio_retention_days} onChange={(e) => setDraft({ ...draft, audio_retention_days: Number(e.target.value) })} helperText="Audio is deleted automatically after this." />
        <Input label="Keep transcripts for (days)" type="number" min={7} max={730} value={draft.transcript_retention_days} onChange={(e) => setDraft({ ...draft, transcript_retention_days: Number(e.target.value) })} helperText="Insights, commitments and tasks you keep are separate." />
      </div>
      <div className="mt-4 flex items-start gap-3">
        <input id="ci-tasks" type="checkbox" className="mt-1" checked={draft.auto_create_tasks} onChange={(e) => setDraft({ ...draft, auto_create_tasks: e.target.checked })} />
        <label htmlFor="ci-tasks" className="text-sm text-text-primary">
          <span className="font-semibold">Create follow-up tasks automatically</span>
          <span className="mt-1 block text-text-secondary">Promises, unresolved objections, upsell opportunities and safety concerns become tasks. Promises are always added to the Commitment Graph.</span>
        </label>
      </div>
      <div className="mt-5"><Button onClick={() => void save()} disabled={saving}>{saving ? <Loader2 size={16} className="animate-spin" /> : null} Save settings</Button></div>
    </Card>
  );
}

export function ConversationIntelligencePage() {
  const navigate = useNavigate();
  const { profile, isOwner, teamMember, permissions, profileLoading } = useAuth();
  const resolving = profileLoading || !profile;
  const canAccess = isOwner || teamMember !== null;
  const canManage = isOwner || permissions.can_view_all_jobs;

  const [tab, setTab] = useState<Tab>('conversations');
  const [state, setState] = useState<LoadState>('loading');
  const [settings, setSettings] = useState<IntelSettings>(DEFAULT_SETTINGS);
  const [recordings, setRecordings] = useState<RecordingRow[]>([]);
  const [rollup, setRollup] = useState<CoachingRollupRow[]>([]);
  const [notes, setNotes] = useState<RecentCoachingNote[]>([]);
  const [recording, setRecording] = useState(false);
  const requestRef = useRef(0);

  const load = useCallback(async (silent: boolean) => {
    const id = ++requestRef.current;
    if (!silent) setState('loading');
    try {
      const [s, r, c, n] = await Promise.all([fetchSettings(), fetchRecordings(), fetchCoachingRollup(30), fetchRecentCoachingNotes()]);
      if (id !== requestRef.current) return;
      setSettings(s);
      setRecordings(r);
      setRollup(c);
      setNotes(n);
      setState('ready');
    } catch {
      if (id === requestRef.current) setState('error');
    }
  }, []);

  useEffect(() => {
    if (!resolving && canAccess) void load(false);
  }, [resolving, canAccess, load]);

  // Refresh while anything is still being processed.
  const processing = recordings.some((r) => r.status === 'uploaded' || r.status === 'analyzing' || r.status === 'recording');
  useEffect(() => {
    if (!processing) return;
    const t = window.setInterval(() => void load(true), 8000);
    return () => window.clearInterval(t);
  }, [processing, load]);

  const now = useMemo(() => new Date(), [recordings]); // eslint-disable-line react-hooks/exhaustive-deps
  const totals = useMemo(() => rollup.reduce(
    (a, r) => ({
      conversations: a.conversations + r.conversations,
      promises: a.promises + r.promises_made,
      objections: a.objections + r.objections_unresolved,
      safety: a.safety + r.safety_flags,
    }),
    { conversations: 0, promises: 0, objections: 0, safety: 0 },
  ), [rollup]);

  const tabs: { key: Tab; label: string }[] = [
    { key: 'conversations', label: 'Conversations' },
    { key: 'coaching', label: 'Coaching' },
    ...(canManage ? [{ key: 'settings' as Tab, label: 'Settings' }] : []),
  ];

  if (resolving) {
    return <DashboardLayout activeLabel="Conversation Intelligence"><SkeletonTable rows={4} columns={3} /></DashboardLayout>;
  }
  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Conversation Intelligence">
        <EmptyState icon={Lock} title="No access" description="Ask the account owner to give you access to this page." />
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Conversation Intelligence">
      <div className="mb-8 flex items-center gap-3">
        <button type="button" onClick={() => navigate('/dashboard')} className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary" aria-label="Back to dashboard">
          <ArrowLeft size={18} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent"><MessagesSquare size={16} /></span>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Conversation Intelligence</h1>
          </div>
          <p className="mt-1 text-sm text-text-secondary">Consent-based in-home recordings that turn into promises kept, follow-ups, safety flags and coaching</p>
        </div>
        {settings.enabled && !recording && (
          <Button size="sm" onClick={() => { setTab('conversations'); setRecording(true); }}><Mic size={16} /> Record</Button>
        )}
      </div>

      {state === 'loading' ? (
        <><SkeletonStatGrid count={4} /><div className="mt-6"><SkeletonTable rows={4} columns={4} /></div></>
      ) : state === 'error' ? (
        <EmptyStateError icon={AlertTriangle} title="Couldn’t load conversations" onRetry={() => void load(false)} />
      ) : (
        <FadeIn>
          {!settings.enabled && (
            <div className="mb-4 rounded-2xl border border-border bg-bg-secondary p-4 text-sm text-text-secondary">
              <p className="flex items-center gap-2 font-semibold text-text-primary"><ShieldAlert size={16} className="text-accent" /> Conversation Intelligence is off</p>
              <p className="mt-1">
                {canManage ? 'Turn it on in Settings when your team is ready to ask customers for consent.' : 'Your manager hasn’t turned this on yet.'}
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: 'Analysed (30d)', value: totals.conversations, tone: 'text-accent' },
              { label: 'Promises made', value: totals.promises, tone: 'text-accent' },
              { label: 'Open objections', value: totals.objections, tone: 'text-warning-500' },
              { label: 'Safety flags', value: totals.safety, tone: 'text-danger' },
            ].map((c) => (
              <div key={c.label} className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
                <span className={`text-xs font-medium ${c.tone}`}>{c.label}</span>
                <p className="mt-2 text-xl font-bold text-text-primary">{c.value}</p>
              </div>
            ))}
          </div>

          <div className="mt-6 flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1" role="tablist">
            {tabs.map((t) => (
              <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
                className={`focus-ring shrink-0 rounded-lg px-3.5 py-2 text-xs font-medium transition-colors ${tab === t.key ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}>
                {t.label}
              </button>
            ))}
          </div>

          <div className="mt-4 space-y-3">
            {tab === 'conversations' && (
              <>
                {recording && (
                  <ConversationRecorder
                    companyName={profile?.company_name ?? ''}
                    onCancel={() => setRecording(false)}
                    onFinished={() => { setRecording(false); void load(true); }}
                  />
                )}
                {recordings.length === 0 && !recording ? (
                  <EmptyState
                    icon={MessagesSquare}
                    title="No conversations yet"
                    description={settings.enabled ? 'Tap Record at the start of a visit. The customer decides — nothing is captured without their yes.' : 'Once enabled, recorded visits and what they uncover will appear here.'}
                    action={settings.enabled ? { label: 'Record a conversation', onClick: () => setRecording(true) } : undefined}
                  />
                ) : (
                  recordings.map((r) => <RecordingCard key={r.id} rec={r} now={now} canManage={canManage} onChanged={() => void load(true)} />)
                )}
              </>
            )}
            {tab === 'coaching' && <CoachingTab rollup={rollup} notes={notes} />}
            {tab === 'settings' && canManage && <SettingsTab initial={settings} onSaved={setSettings} />}
          </div>
        </FadeIn>
      )}
    </DashboardLayout>
  );
}
