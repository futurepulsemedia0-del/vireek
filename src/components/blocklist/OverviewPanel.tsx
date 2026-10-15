import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Ban, Loader2, PhoneOff, ShieldBan, ShieldCheck } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { NumberTester } from './NumberTester';
import {
  BLOCK_CATEGORY_LABELS,
  addEntry,
  fetchRecentEvents,
  fetchStats,
  fetchSuspectedSpam,
  formatPhone,
  type BlockCategory,
  type BlockEvent,
  type BlockStats,
  type SuspectedSpam,
} from '@/lib/callBlocklist';

interface OverviewPanelProps {
  ownerId: string;
  userId: string;
  refreshKey: number;
  onChanged: () => void;
}

function Kpi({ label, value, hint, icon: Icon }: { label: string; value: number; hint?: string; icon: typeof Ban }) {
  return (
    <Card className="p-4 hover:translate-y-0">
      <div className="flex items-center gap-2 text-text-secondary">
        <Icon size={14} />
        <span className="text-xs font-medium">{label}</span>
      </div>
      <p className="mt-2 text-2xl font-bold tracking-tight text-text-primary">{value.toLocaleString()}</p>
      {hint && <p className="text-[11px] text-text-secondary">{hint}</p>}
    </Card>
  );
}

export function OverviewPanel({ ownerId, userId, refreshKey, onChanged }: OverviewPanelProps) {
  const { toast } = useToast();
  const [stats, setStats] = useState<BlockStats | null>(null);
  const [spam, setSpam] = useState<SuspectedSpam[]>([]);
  const [events, setEvents] = useState<BlockEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [blocking, setBlocking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [s, sp, ev] = await Promise.all([fetchStats(ownerId), fetchSuspectedSpam(ownerId), fetchRecentEvents(ownerId)]);
      setStats(s);
      setSpam(sp);
      setEvents(ev);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [ownerId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const block = async (phone: string) => {
    setBlocking(phone);
    try {
      await addEntry('blocklist', ownerId, userId, phone, 'spam', 'Flagged as spam on a call');
      setSpam((prev) => prev.filter((s) => s.phone !== phone));
      toast('Number blocked.', 'success');
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not block that number.', 'error');
    } finally {
      setBlocking(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i} className="space-y-2 p-4 hover:translate-y-0"><Skeleton className="h-3 w-20" /><Skeleton className="h-7 w-12" /></Card>
          ))}
        </div>
        <Card className="space-y-2 p-5 hover:translate-y-0"><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-64" /></Card>
      </div>
    );
  }
  if (error || !stats) {
    return <EmptyState icon={AlertTriangle} title="Couldn't load the overview" description="Check your connection and try again." action={{ label: 'Retry', onClick: () => void load() }} />;
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Blocked (7 days)" value={stats.blocked7d} hint={`${stats.blocked30d.toLocaleString()} in 30 days`} icon={Ban} />
        <Kpi label="On blocklist" value={stats.blocklistTotal} icon={ShieldBan} />
        <Kpi label="Do-Not-Call" value={stats.dncTotal} icon={PhoneOff} />
        <Kpi label="Active rules" value={stats.activeRules} icon={ShieldCheck} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="min-w-0 space-y-6">
          <Card className="space-y-3 p-5 hover:translate-y-0">
            <div>
              <h2 className="text-sm font-semibold text-text-primary">Suspected spam</h2>
              <p className="text-xs text-text-secondary">Numbers your AI already marked as spam on real calls (last 90 days) that you have not blocked yet.</p>
            </div>
            {spam.length === 0 ? (
              <p className="rounded-xl bg-bg-tertiary p-3 text-xs text-text-secondary">Nothing to review. Spam calls the AI flags will show up here.</p>
            ) : (
              <ul className="divide-y divide-border">
                {spam.map((s) => (
                  <li key={s.phone} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-sm font-semibold text-text-primary">{formatPhone(s.phone)}</p>
                      <p className="text-xs text-text-secondary">{s.count} call{s.count === 1 ? '' : 's'} · last {new Date(s.lastAt).toLocaleDateString()}</p>
                    </div>
                    <Button type="button" variant="secondary" size="sm" onClick={() => void block(s.phone)} disabled={blocking === s.phone}>
                      {blocking === s.phone && <Loader2 size={14} className="animate-spin" />} Block
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="space-y-3 p-5 hover:translate-y-0">
            <h2 className="text-sm font-semibold text-text-primary">Recently blocked calls</h2>
            {events.length === 0 ? (
              <p className="rounded-xl bg-bg-tertiary p-3 text-xs text-text-secondary">Blocked calls are logged here as they happen.</p>
            ) : (
              <ul className="divide-y divide-border">
                {events.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-mono font-semibold text-text-primary">{e.phone ? formatPhone(e.phone) : 'Hidden caller ID'}</p>
                      <p className="truncate text-xs text-text-secondary">
                        {e.reason === 'rule' ? `Rule: ${e.ruleName ?? 'deleted rule'}` : `Blocklist${e.category ? ` · ${BLOCK_CATEGORY_LABELS[e.category as BlockCategory] ?? e.category}` : ''}`}
                      </p>
                    </div>
                    <time className="shrink-0 text-[11px] text-text-secondary" dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleString()}</time>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <NumberTester ownerId={ownerId} userId={userId} onChanged={onChanged} />
      </div>
    </div>
  );
}
