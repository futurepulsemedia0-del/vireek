import { useState } from 'react';
import { CheckCircle2, Loader2, Pencil, Play, RefreshCw, ShieldCheck, Trash2, XCircle } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import {
  DATASETS,
  deleteDestination,
  describeRunStats,
  destinationLabel,
  isRunning,
  runDestination,
  testDestination,
  timeAgo,
  type Destination,
  type SyncRun,
  type SyncState,
  type TestCheck,
} from '@/lib/dataPlatform';
import { Badge, STATUS_STYLE } from './ui';

interface Props {
  dest: Destination;
  runs: SyncRun[];
  syncState: SyncState[];
  now: number;
  /** One-line summary under the title, e.g. the table location or the audience. */
  summary: string;
  onEdit: () => void;
  onChanged: () => void;
}

export function DestinationCard({ dest, runs, syncState, now, summary, onEdit, onChanged }: Props) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<'run' | 'full' | 'test' | null>(null);
  const [checks, setChecks] = useState<TestCheck[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const running = isRunning(dest, now) || runs.some((r) => r.status === 'running');
  const last = runs[0];
  const warehouse = dest.role === 'warehouse';

  const run = async (full: boolean) => {
    setBusy(full ? 'full' : 'run');
    try {
      await runDestination(dest.id, full);
      toast(warehouse ? (full ? 'Full refresh started.' : 'Sync started.') : 'Send started.', 'success');
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not start the run.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    setChecks(null);
    try {
      const r = await testDestination(dest.id);
      setChecks(r.checks);
      toast(r.ok ? 'Connection looks good.' : 'Some checks failed. See details below.', r.ok ? 'success' : 'error');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not test the connection.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    try {
      await deleteDestination(dest.id);
      toast('Destination removed. Data already sent stays where it is.', 'success');
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete the destination.', 'error');
    } finally {
      setConfirmDelete(false);
    }
  };

  const status = running ? 'running' : dest.status === 'error' ? 'failed' : last?.status === 'partial' ? 'partial' : 'success';
  const statusLabel = running ? 'Running' : dest.status === 'error' ? 'Needs attention' : last?.status === 'partial' ? 'Partly synced' : last ? 'Healthy' : 'Not run yet';

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-semibold text-text-primary">{dest.name}</h3>
            <Badge cls={last || running ? STATUS_STYLE[status] : STATUS_STYLE.neutral}>
              {running && <Loader2 size={12} className="animate-spin" />}
              {statusLabel}
            </Badge>
            {!dest.auto_sync && <Badge cls={STATUS_STYLE.neutral}>Manual only</Badge>}
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            {destinationLabel(dest.kind)} · {summary}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => void run(false)} disabled={running || busy !== null}>
            {busy === 'run' ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
            {warehouse ? 'Sync now' : 'Send now'}
          </Button>
          {warehouse && (
            <Button size="sm" variant="ghost" onClick={() => void run(true)} disabled={running || busy !== null} title="Re-read every row and mark rows deleted in Vireek">
              {busy === 'full' ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
              Full refresh
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => void test()} disabled={busy !== null}>
            {busy === 'test' ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
            Test
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit} aria-label={`Edit ${dest.name}`}>
            <Pencil size={16} />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)} aria-label={`Delete ${dest.name}`}>
            <Trash2 size={16} className="text-danger" />
          </Button>
        </div>
      </div>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Last success</dt>
          <dd className="mt-0.5 text-text-primary">{timeAgo(dest.last_success_at, now)}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Next run</dt>
          <dd className="mt-0.5 text-text-primary">{dest.auto_sync ? (new Date(dest.next_run_at).getTime() <= now ? 'Due now' : `in ${Math.max(1, Math.round((new Date(dest.next_run_at).getTime() - now) / 60000))} min`) : 'Not scheduled'}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Last result</dt>
          <dd className="mt-0.5 text-text-primary">{last ? describeRunStats(last.stats) || last.status : '—'}</dd>
        </div>
      </dl>

      {dest.last_error && (
        <p role="alert" className="mt-4 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          {dest.last_error}
          {dest.consecutive_failures > 1 ? ` (${dest.consecutive_failures} failures in a row)` : ''}
        </p>
      )}

      {warehouse && syncState.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-text-secondary">
                <th className="py-1.5 pr-4 font-semibold">Table</th>
                <th className="py-1.5 pr-4 text-right font-semibold">Rows</th>
                <th className="py-1.5 font-semibold">Last synced</th>
              </tr>
            </thead>
            <tbody>
              {syncState.map((s) => (
                <tr key={s.dataset} className="border-t border-border/60">
                  <td className="py-1.5 pr-4 font-medium text-text-primary">{DATASETS[s.dataset]?.label ?? s.dataset}</td>
                  <td className="py-1.5 pr-4 text-right tabular-nums text-text-primary">{s.rows_total.toLocaleString()}</td>
                  <td className="py-1.5 text-text-secondary">{timeAgo(s.last_synced_at, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {checks && (
        <ul className="mt-4 space-y-1.5" aria-label="Connection checks">
          {checks.map((c) => (
            <li key={c.name} className="flex items-start gap-2 text-sm">
              {c.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success-500" /> : <XCircle size={16} className="mt-0.5 shrink-0 text-danger" />}
              <span className="text-text-primary">
                <span className="font-medium">{c.name}</span>
                {c.detail ? <span className="text-text-secondary"> — {c.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      {runs.length > 0 && (
        <details className="mt-4">
          <summary className="focus-ring cursor-pointer rounded text-sm font-semibold text-text-primary">Recent runs</summary>
          <ul className="mt-2 divide-y divide-border/60 text-sm">
            {runs.slice(0, 8).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="flex items-center gap-2">
                  <Badge cls={STATUS_STYLE[r.status]}>{r.status}</Badge>
                  <span className="text-text-secondary">
                    {r.trigger === 'scheduled' ? 'Scheduled' : 'Manual'} · {r.mode}
                  </span>
                </span>
                <span className="text-text-secondary">
                  {r.error ? <span className="text-danger">{r.error}</span> : describeRunStats(r.stats)} · {timeAgo(r.started_at, now)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${dest.name}?`}
        description="Vireek stops syncing and forgets the stored credentials. Data already written to the destination is not touched."
        confirmLabel="Delete destination"
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      />
    </Card>
  );
}
