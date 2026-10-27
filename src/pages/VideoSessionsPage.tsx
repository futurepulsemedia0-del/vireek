import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, TriangleAlert, Video } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { VideoSessionRow } from '@/components/video/VideoSessionRow';
import { useAuth } from '@/contexts/AuthContext';
import { useRealtimeSubscription } from '@/lib/realtime';
import { effectiveStatus, type VideoClipRow } from '@/lib/videoSession';
import { fetchClips, fetchVideoSessionPage, type SessionWithJob } from '@/lib/videoSessionApi';

const LABEL = 'Video Sessions';
const PAGE = 30;
type Filter = 'all' | 'active' | 'ended';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'ended', label: 'Ended' },
];

export function VideoSessionsPage() {
  const { user, isOwner, permissions, profile, teamMember } = useAuth();
  const ownerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const canManage = isOwner || permissions.can_edit_business_profile;
  const [rows, setRows] = useState<SessionWithJob[]>([]);
  const [clips, setClips] = useState<VideoClipRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async () => {
    try {
      const page = await fetchVideoSessionPage({ limit: PAGE });
      setRows(page);
      setHasMore(page.length === PAGE);
      setClips(await fetchClips(page.map((r) => r.id)));
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    if (ownerId) void load();
  }, [ownerId, load]);

  const refresh = useCallback(() => void load(), [load]);
  useRealtimeSubscription({ channelName: `video-sessions-${ownerId}`, table: 'video_sessions', event: '*', filter: `user_id=eq.${ownerId}`, onChange: refresh, enabled: !!ownerId });

  const loadMore = async () => {
    const last = rows[rows.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const page = await fetchVideoSessionPage({ before: last.created_at, limit: PAGE });
      setRows((prev) => [...prev, ...page]);
      setHasMore(page.length === PAGE);
      const extra = await fetchClips(page.map((r) => r.id));
      setClips((prev) => [...prev, ...extra]);
    } catch {
      setState('error');
    } finally {
      setLoadingMore(false);
    }
  };

  const visible = useMemo(
    () =>
      rows.filter((r) => {
        const s = effectiveStatus(r);
        if (filter === 'active') return s === 'waiting' || s === 'live';
        if (filter === 'ended') return s !== 'waiting' && s !== 'live';
        return true;
      }),
    [rows, filter],
  );

  return (
    <DashboardLayout activeLabel={LABEL}>
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
          <Video size={22} aria-hidden="true" /> Video Sessions
        </h1>
        <p className="mt-1 text-sm text-text-secondary">Live video with remote experts, and the clips recorded on each job. Start a session from any job.</p>
      </div>

      <div role="tablist" aria-label="Filter sessions" className="mb-4 inline-flex gap-1 rounded-xl border border-border bg-bg-primary p-1">
        {FILTERS.map((f) => (
          <button key={f.value} type="button" role="tab" aria-selected={filter === f.value} onClick={() => setFilter(f.value)} className={`focus-ring rounded-lg px-3 py-1.5 text-xs font-medium ${filter === f.value ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}>
            {f.label}
          </button>
        ))}
      </div>

      {state === 'loading' && <SkeletonCardList count={3} />}
      {state === 'error' && <EmptyStateError icon={TriangleAlert} title="Could not load video sessions" onRetry={refresh} />}
      {state === 'ready' && visible.length === 0 && (
        rows.length === 0 ? (
          <EmptyState icon={Video} title="No video sessions yet" description="Open a job and choose Start session to bring in a remote expert." />
        ) : (
          <EmptyState icon={Video} title="Nothing matches this filter" description="Try another filter to see more sessions." action={{ label: 'Show all', onClick: () => setFilter('all') }} />
        )
      )}
      {state === 'ready' && visible.length > 0 && (
        <ul className="space-y-2.5">
          {visible.map((r) => (
            <VideoSessionRow
              key={r.id}
              session={r}
              clips={clips.filter((c) => c.session_id === r.id)}
              title={r.title}
              subtitle={r.jobs?.customer_name ?? 'Job'}
              canEnd={r.created_by === user?.id || canManage}
              canDeleteClips={canManage}
              onChanged={refresh}
            />
          ))}
        </ul>
      )}
      {state === 'ready' && visible.length > 0 && (
        <p className="mt-3 text-xs text-text-secondary">
          Jump to a job from its page: <Link className="text-accent underline" to="/dashboard/jobs">All jobs</Link>
        </p>
      )}
      {state === 'ready' && hasMore && (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Load more
          </Button>
        </div>
      )}
    </DashboardLayout>
  );
}
