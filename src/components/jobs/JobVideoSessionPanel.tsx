import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Plus, TriangleAlert, Video } from 'lucide-react';
import { JobSection, SectionSkeleton } from '@/components/jobs/detail/JobSection';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { VideoSessionRow } from '@/components/video/VideoSessionRow';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useRealtimeSubscription } from '@/lib/realtime';
import {
  DEFAULT_TTL_MINUTES,
  TTL_OPTIONS,
  friendlyVideoError,
  validateStartForm,
  type VideoClipRow,
  type VideoSessionRow,
} from '@/lib/videoSession';
import { createVideoSession, fetchClips, fetchJobVideoSessions } from '@/lib/videoSessionApi';

/** Job detail section: start a live session with a remote expert, copy the link, review clips. */
export function JobVideoSessionPanel({ jobId, ownerId, canEdit }: { jobId: string; ownerId: string; canEdit: boolean }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, isOwner, permissions } = useAuth();
  const [sessions, setSessions] = useState<VideoSessionRow[]>([]);
  const [clips, setClips] = useState<VideoClipRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState('Remote expert session');
  const [expertLabel, setExpertLabel] = useState('');
  const [ttl, setTtl] = useState(DEFAULT_TTL_MINUTES);
  const [recordingAllowed, setRecordingAllowed] = useState(true);
  const [creating, setCreating] = useState(false);
  const [touched, setTouched] = useState(false);

  const canManage = isOwner || permissions.can_edit_business_profile;
  const errors = validateStartForm({ title, expertLabel });

  const load = useCallback(async () => {
    try {
      const list = await fetchJobVideoSessions(jobId);
      setSessions(list);
      setClips(await fetchClips(list.map((s) => s.id)));
      setState('ready');
    } catch {
      setState('error');
    }
  }, [jobId]);

  useEffect(() => {
    setState('loading');
    void load();
  }, [load]);

  const refresh = useCallback(() => void load(), [load]);
  const filter = `job_id=eq.${jobId}`;
  useRealtimeSubscription({ channelName: `job-video-sessions-${jobId}`, table: 'video_sessions', event: '*', filter, onChange: refresh, enabled: !!ownerId });
  useRealtimeSubscription({ channelName: `job-video-clips-${jobId}`, table: 'video_session_clips', event: '*', filter, onChange: refresh, enabled: !!ownerId });

  const clipsBySession = useMemo(() => {
    const map = new Map<string, VideoClipRow[]>();
    for (const c of clips) map.set(c.session_id, [...(map.get(c.session_id) ?? []), c]);
    return map;
  }, [clips]);

  const start = async () => {
    setTouched(true);
    if (errors.title || errors.expertLabel) return;
    setCreating(true);
    try {
      const created = await createVideoSession({ jobId, title, expertLabel, recordingAllowed, ttlMinutes: ttl });
      toast('Session created. Join it, then send the link to your expert.', 'success');
      navigate(`/live/${created.join_token}`);
    } catch (err) {
      toast(friendlyVideoError(err, 'Could not create the session.'), 'error');
      setCreating(false);
    }
  };

  return (
    <JobSection
      title="Live video with a remote expert"
      icon={Video}
      action={
        canEdit && !formOpen ? (
          <Button size="sm" onClick={() => setFormOpen(true)}>
            <Plus size={14} aria-hidden="true" /> Start session
          </Button>
        ) : undefined
      }
    >
      {formOpen && (
        <div className="mb-4 space-y-3 rounded-xl border border-border bg-bg-primary p-3">
          <Input id="vs-title" label="Session title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} error={touched ? errors.title : undefined} />
          <Input id="vs-expert" label="Who are you inviting? (optional)" value={expertLabel} onChange={(e) => setExpertLabel(e.target.value)} maxLength={80} placeholder="e.g. Carrier support engineer" error={touched ? errors.expertLabel : undefined} />
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="vs-ttl" className="mb-1.5 block text-sm font-medium text-text-primary">Link valid for</label>
              <select id="vs-ttl" value={ttl} onChange={(e) => setTtl(Number(e.target.value))} className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-3 text-base text-text-primary">
                {TTL_OPTIONS.map((o) => (
                  <option key={o.minutes} value={o.minutes}>{o.label}</option>
                ))}
              </select>
            </div>
            <label className="flex cursor-pointer items-start gap-2.5 self-end rounded-xl border border-border p-3 text-sm text-text-primary">
              <input type="checkbox" checked={recordingAllowed} onChange={(e) => setRecordingAllowed(e.target.checked)} className="focus-ring mt-0.5 h-4 w-4 accent-[var(--color-accent,#2563eb)]" />
              <span>Allow recording clips<span className="block text-xs text-text-secondary">The expert must agree before you can record.</span></span>
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setFormOpen(false)} disabled={creating}>Cancel</Button>
            <Button size="sm" onClick={() => void start()} disabled={creating}>
              {creating ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Video size={14} aria-hidden="true" />} Create and open
            </Button>
          </div>
        </div>
      )}

      {state === 'loading' && <SectionSkeleton rows={2} />}
      {state === 'error' && <EmptyStateError icon={TriangleAlert} title="Could not load video sessions" onRetry={refresh} />}
      {state === 'ready' && sessions.length === 0 && (
        <EmptyState
          icon={Video}
          title="No video sessions yet"
          description="Start a live session to show a remote expert exactly what you see on site. Clips you record appear here and in the job timeline."
          action={canEdit ? { label: 'Start session', onClick: () => setFormOpen(true) } : undefined}
        />
      )}
      {state === 'ready' && sessions.length > 0 && (
        <ul className="space-y-2.5">
          {sessions.map((s) => (
            <VideoSessionRow key={s.id} session={s} clips={clipsBySession.get(s.id) ?? []} canEnd={canEdit && (s.created_by === user?.id || canManage)} canDeleteClips={canManage} onChanged={refresh} />
          ))}
        </ul>
      )}
    </JobSection>
  );
}
