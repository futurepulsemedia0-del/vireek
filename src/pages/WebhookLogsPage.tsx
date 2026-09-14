import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Webhook,
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Loader as Loader2,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { useAuth } from '@/contexts/AuthContext';
import { supabase, WebhookLog } from '@/lib/supabase';

type Direction = 'incoming' | 'outgoing';

function StatusPill({ status }: { status: WebhookLog['status'] }) {
  const isSuccess = status === 'success';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
        isSuccess
          ? 'bg-success-500/10 text-success-500'
          : 'bg-danger-500/10 text-danger-500'
      }`}
    >
      {isSuccess ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
      {isSuccess ? 'Success' : 'Error'}
    </span>
  );
}

function LogRow({ log, direction }: { log: WebhookLog; direction: Direction }) {
  return (
    <motion.tr
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="border-b border-border/60 last:border-0"
    >
      <td className="whitespace-nowrap px-4 py-3 text-xs text-text-secondary">
        {new Date(log.created_at).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })}
      </td>
      <td className="px-4 py-3 text-sm font-medium text-text-primary">{log.event_type}</td>
      <td className="px-4 py-3">
        <StatusPill status={log.status} />
      </td>
      <td className="px-4 py-3 text-xs text-text-secondary">
        {log.status_code ?? '—'}
      </td>
      {direction === 'outgoing' ? (
        <td className="max-w-[240px] truncate px-4 py-3 text-xs text-text-secondary" title={log.target_url ?? ''}>
          {log.target_url ?? '—'}
        </td>
      ) : (
        <td className="px-4 py-3 text-xs text-text-secondary">{log.request_id ?? '—'}</td>
      )}
      <td className="max-w-[280px] truncate px-4 py-3 text-xs text-danger-500" title={log.error_message ?? ''}>
        {log.error_message ?? '—'}
      </td>
    </motion.tr>
  );
}

function LogsTable({ logs, direction, loading }: { logs: WebhookLog[]; direction: Direction; loading: boolean }) {
  if (loading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-10 animate-pulse rounded-lg bg-bg-tertiary" />
        ))}
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
        <Webhook size={28} className="text-text-secondary/40" />
        <p className="text-sm font-medium text-text-primary">No {direction} webhook activity yet</p>
        <p className="max-w-xs text-xs text-text-secondary">
          {direction === 'outgoing'
            ? 'Once a webhook URL is connected under Integrations, deliveries for new calls, leads, and jobs will show up here.'
            : 'Incoming events from your voice assistant will appear here as calls come in.'}
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-border text-xs font-semibold uppercase tracking-wider text-text-secondary/60">
            <th className="whitespace-nowrap px-4 py-2.5">Time</th>
            <th className="px-4 py-2.5">Event</th>
            <th className="px-4 py-2.5">Status</th>
            <th className="px-4 py-2.5">Code</th>
            <th className="px-4 py-2.5">{direction === 'outgoing' ? 'Target URL' : 'Request ID'}</th>
            <th className="px-4 py-2.5">Error</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => (
            <LogRow key={log.id} log={log} direction={direction} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WebhookLogsPage() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<Direction>('outgoing');
  const [incomingLogs, setIncomingLogs] = useState<WebhookLog[]>([]);
  const [outgoingLogs, setOutgoingLogs] = useState<WebhookLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadLogs = useCallback(
    async (isRefresh = false) => {
      if (!user) return;

      // NOTE: this used to be a bare ternary expression used only for its
      // side effects (`isRefresh ? setRefreshing(true) : setLoading(true);`),
      // which ESLint flags via `no-unused-expressions` since a ternary's
      // whole point is to produce a value, not to be a standalone statement.
      // A plain if/else is the correct construct for branching side effects.
      if (isRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      try {
        const { data, error } = await supabase
          .from('webhook_logs')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(200);
        if (error) throw error;
        const rows = (data ?? []) as WebhookLog[];
        setIncomingLogs(rows.filter((r) => r.direction === 'incoming'));
        setOutgoingLogs(rows.filter((r) => r.direction === 'outgoing'));
      } catch {
        // Empty state on failure — table may not exist yet if the
        // migration hasn't been applied, so fail quietly here.
        setIncomingLogs([]);
        setOutgoingLogs([]);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [user]
  );

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  const activeLogs = activeTab === 'incoming' ? incomingLogs : outgoingLogs;

  return (
    <DashboardLayout activeLabel="Webhook Logs">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <Webhook size={24} />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Webhook Logs</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Debug incoming events from your assistant and outgoing deliveries to your integrations.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => loadLogs(true)}
          disabled={refreshing}
          className="focus-ring flex shrink-0 items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary disabled:opacity-50"
        >
          {refreshing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          Refresh
        </button>
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-2 rounded-xl border border-border bg-bg-secondary p-1">
        <button
          type="button"
          onClick={() => setActiveTab('outgoing')}
          className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors ${
            activeTab === 'outgoing'
              ? 'bg-accent/10 text-accent'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          <ArrowUpFromLine size={16} />
          Outgoing
          <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs">{outgoingLogs.length}</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('incoming')}
          className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors ${
            activeTab === 'incoming'
              ? 'bg-accent/10 text-accent'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          <ArrowDownToLine size={16} />
          Incoming
          <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs">{incomingLogs.length}</span>
        </button>
      </div>

      <div className="rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark">
        <LogsTable logs={activeLogs} direction={activeTab} loading={loading} />
      </div>

      <p className="mt-4 text-xs text-text-secondary/60">
        {activeTab === 'outgoing'
          ? 'Outgoing deliveries fire for new calls, leads, and jobs when a webhook URL is connected under Integrations.'
          : 'Incoming events are received from your voice assistant provider (Vapi) for every call.'}
      </p>
    </DashboardLayout>
  );
}
