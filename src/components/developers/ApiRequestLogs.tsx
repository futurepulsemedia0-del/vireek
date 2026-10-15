import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, KeyRound, Loader2, Lock, RefreshCw, ScrollText } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useAuth } from '@/contexts/AuthContext';
import { listApiKeys, type ApiKeyRow } from '@/lib/apiKeys';
import {
  LOG_FILTERS,
  LOG_PAGE_SIZE,
  fetchApiRequestLogs,
  formatLogTime,
  statusTone,
  summarizeLogs,
  type ApiRequestLogRow,
  type LogFilter,
} from '@/lib/apiRequestLogs';

const TONE_CLASS = {
  success: 'bg-success-500/10 text-success-500',
  warning: 'bg-warning-500/10 text-warning-500',
  danger: 'bg-danger-500/10 text-danger-500',
} as const;

function StatusPill({ status }: { status: number }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${TONE_CLASS[statusTone(status)]}`}>
      {status}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-primary px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-lg font-semibold text-text-primary">{value}</p>
    </div>
  );
}

function Gate({ icon: Icon, title, body, action }: { icon: typeof Lock; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-bg-primary/50 px-6 py-14 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
        <Icon size={22} />
      </span>
      <h3 className="mt-4 text-base font-semibold text-text-primary">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

function LogsViewer() {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [keyId, setKeyId] = useState('');
  const [filter, setFilter] = useState<LogFilter>('all');

  const [rows, setRows] = useState<ApiRequestLogRow[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const ticketRef = useRef(0);

  const loadKeys = useCallback(async () => {
    setKeysLoading(true);
    setKeysError(null);
    try {
      const list = await listApiKeys();
      setKeys(list);
      setKeyId((current) => current || (list.find((k) => !k.revoked_at) ?? list[0])?.id || '');
    } catch (e) {
      setKeysError(e instanceof Error ? e.message : 'Could not load your API keys.');
    } finally {
      setKeysLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  /** `before` undefined = fresh load, otherwise append the next page. */
  const loadLogs = useCallback(
    async (before?: string) => {
      if (!keyId) return;
      const ticket = ++ticketRef.current;
      if (before) setLoadingMore(true);
      else setLogsLoading(true);
      setLogsError(null);
      try {
        const page = await fetchApiRequestLogs({ keyId, filter, before });
        if (ticket !== ticketRef.current) return;
        setRows((prev) => (before ? [...prev, ...page] : page));
        setHasMore(page.length === LOG_PAGE_SIZE);
      } catch (e) {
        if (ticket !== ticketRef.current) return;
        setLogsError(e instanceof Error ? e.message : 'Could not load request logs.');
        if (!before) {
          setRows([]);
          setHasMore(false);
        }
      } finally {
        if (ticket === ticketRef.current) {
          setLogsLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [keyId, filter],
  );

  useEffect(() => {
    setRows([]);
    void loadLogs();
  }, [loadLogs]);

  const summary = useMemo(() => summarizeLogs(rows), [rows]);

  if (keysLoading) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-border bg-bg-primary/50 py-16">
        <Loader2 size={22} className="animate-spin text-accent" />
      </div>
    );
  }

  if (keysError) {
    return (
      <Gate
        icon={AlertCircle}
        title="Couldn't load your API keys"
        body={keysError}
        action={
          <Button variant="secondary" size="sm" onClick={() => void loadKeys()}>
            <RefreshCw size={14} /> Try again
          </Button>
        }
      />
    );
  }

  if (keys.length === 0) {
    return (
      <Gate
        icon={KeyRound}
        title="No API keys yet"
        body="Create a key, make a request, and every call it serves will show up here."
        action={
          <Link to="/dashboard/settings/api-keys">
            <Button variant="primary" size="sm">Create an API key</Button>
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <label className="block min-w-0 text-sm sm:w-72">
          <span className="mb-1.5 block text-xs font-medium text-text-secondary">API key</span>
          <select
            value={keyId}
            onChange={(e) => setKeyId(e.target.value)}
            className="w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
          >
            {keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name} — {k.key_prefix}…{k.revoked_at ? ' (revoked)' : ''}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Filter by status" className="flex rounded-xl border border-border bg-bg-primary p-1">
            {LOG_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={`focus-ring rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  filter === f.id ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <Button variant="secondary" size="sm" onClick={() => void loadLogs()} disabled={logsLoading} aria-label="Refresh logs">
            <RefreshCw size={14} className={logsLoading ? 'animate-spin' : ''} />
            Refresh
          </Button>
        </div>
      </div>

      {rows.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Loaded requests" value={String(summary.total)} />
          <Stat label="Success rate" value={summary.successRate === null ? '—' : `${summary.successRate}%`} />
          <Stat label="p50 latency" value={summary.p50 === null ? '—' : `${summary.p50} ms`} />
          <Stat label="p95 latency" value={summary.p95 === null ? '—' : `${summary.p95} ms`} />
        </div>
      )}

      {logsError && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-danger-500/30 bg-danger-500/5 px-3 py-2.5 text-sm text-danger-500">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{logsError}</span>
        </div>
      )}

      {logsLoading && rows.length === 0 ? (
        <div className="flex items-center justify-center rounded-xl border border-border bg-bg-primary/50 py-16">
          <Loader2 size={22} className="animate-spin text-accent" />
        </div>
      ) : rows.length === 0 && !logsError ? (
        <Gate
          icon={ScrollText}
          title={filter === 'all' ? 'No requests yet' : 'No matching requests'}
          body={
            filter === 'all'
              ? 'Requests made with this key appear here within seconds. Logs are kept for 30 days.'
              : 'No requests with this status in the retained window. Try another filter.'
          }
        />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-xl border border-border md:block">
            <table className="w-full text-left text-sm">
              <thead className="bg-bg-tertiary/60 text-xs uppercase tracking-wide text-text-secondary">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Time</th>
                  <th className="px-4 py-2.5 font-medium">Request</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Latency</th>
                  <th className="px-4 py-2.5 font-medium">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.id} className="bg-bg-primary/40">
                    <td className="whitespace-nowrap px-4 py-2.5 text-text-secondary">{formatLogTime(r.created_at)}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-text-primary">
                      <span className="mr-2 font-semibold text-accent">{r.method}</span>
                      {r.path}
                    </td>
                    <td className="px-4 py-2.5"><StatusPill status={r.status} /></td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-text-secondary">{r.latency_ms} ms</td>
                    <td className="max-w-xs truncate px-4 py-2.5 text-text-secondary" title={r.error ?? undefined}>{r.error ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <ul className="space-y-2 md:hidden">
            {rows.map((r) => (
              <li key={r.id} className="rounded-xl border border-border bg-bg-primary/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <StatusPill status={r.status} />
                  <span className="text-xs text-text-secondary">{r.latency_ms} ms</span>
                </div>
                <p className="mt-2 break-all font-mono text-xs text-text-primary">
                  <span className="mr-1.5 font-semibold text-accent">{r.method}</span>
                  {r.path}
                </p>
                {r.error && <p className="mt-1 text-xs text-danger-500">{r.error}</p>}
                <p className="mt-1 text-[11px] text-text-secondary">{formatLogTime(r.created_at)}</p>
              </li>
            ))}
          </ul>

          {hasMore && (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                disabled={loadingMore}
                onClick={() => void loadLogs(rows[rows.length - 1]?.created_at)}
              >
                {loadingMore && <Loader2 size={14} className="animate-spin" />}
                {loadingMore ? 'Loading…' : 'Load older requests'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function ApiRequestLogs() {
  const { session, isOwner, loading, profileLoading } = useAuth();

  let body: ReactNode;
  if (loading || (session && profileLoading)) {
    body = (
      <div className="flex items-center justify-center rounded-xl border border-border bg-bg-primary/50 py-16">
        <Loader2 size={22} className="animate-spin text-accent" />
      </div>
    );
  } else if (!session) {
    body = (
      <Gate
        icon={Lock}
        title="Sign in to see your request logs"
        body="Logs are private to your account. Sign in as the account owner to inspect every request each API key has made."
        action={
          <Link to="/login">
            <Button variant="primary" size="sm">Sign in</Button>
          </Link>
        }
      />
    );
  } else if (!isOwner) {
    body = (
      <Gate
        icon={Lock}
        title="Owner access only"
        body="Request logs reveal how your API keys are used, so only the account owner can view them."
      />
    );
  } else {
    body = <LogsViewer />;
  }

  return (
    <Card className="overflow-hidden border-border bg-bg-secondary/80 p-0 hover:translate-y-0">
      <div className="flex items-center gap-3 border-b border-border px-5 py-4">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <ScrollText size={18} />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Request logs</h3>
          <p className="text-xs text-text-secondary">Every authenticated request, per API key — kept for 30 days.</p>
        </div>
      </div>
      <div className="p-5">{body}</div>
    </Card>
  );
}
