import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Webhook,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Copy,
  Send,
  Power,
  CheckCircle2,
  XCircle,
  Key,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { supabase } from '@/lib/supabase';
import {
  EVENT_CATALOG,
  EVENT_CATEGORIES,
  eventLabel,
  type EventType,
  type WebhookEndpoint,
  type WebhookLog,
} from '@/lib/eventBus';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

function StatusPill({ status }: { status: 'success' | 'error' }) {
  const ok = status === 'success';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
        ok ? 'bg-success-500/10 text-success-500' : 'bg-danger/10 text-danger'
      }`}
    >
      {ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
      {ok ? 'Success' : 'Error'}
    </span>
  );
}

function NewEndpointForm({ onCreated }: { onCreated: () => void }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<EventType[]>([]);
  const [saving, setSaving] = useState(false);

  const toggleEvent = (type: EventType) => {
    setEvents((prev) => (prev.includes(type) ? prev.filter((e) => e !== type) : [...prev, type]));
  };

  const handleCreate = async () => {
    if (!user || !url.trim() || events.length === 0) return;
    setSaving(true);
    const { error } = await supabase
      .from('webhook_endpoints')
      .insert({ user_id: user.id, url: url.trim(), description: description.trim() || null, events });
    setSaving(false);
    if (error) {
      toast('Could not create this endpoint — check the URL', 'error');
      return;
    }
    toast('Endpoint created', 'success');
    setUrl('');
    setDescription('');
    setEvents([]);
    onCreated();
  };

  return (
    <Card className="mb-8 p-6">
      <h2 className="text-sm font-semibold text-text-primary">Add an endpoint</h2>
      <p className="mt-1 text-xs text-text-secondary">
        We'll POST a signed JSON payload to this URL every time a subscribed event happens.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <input
          className={inputClass}
          type="url"
          placeholder="https://your-app.com/webhooks/vireek"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <input
          className={inputClass}
          placeholder="Description (optional) — e.g. Zapier relay"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="mt-4 space-y-3">
        {EVENT_CATEGORIES.map((category) => (
          <div key={category}>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary/70">
              {category}
            </p>
            <div className="flex flex-wrap gap-2">
              {EVENT_CATALOG.filter((e) => e.category === category).map((entry) => {
                const active = events.includes(entry.type);
                return (
                  <button
                    key={entry.type}
                    type="button"
                    title={entry.description}
                    onClick={() => toggleEvent(entry.type)}
                    className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                      active
                        ? 'border-accent bg-accent text-white'
                        : 'border-border bg-bg-secondary text-text-secondary hover:border-accent/40 hover:text-text-primary'
                    }`}
                  >
                    {entry.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <Button
        variant="primary"
        size="sm"
        className="mt-5"
        disabled={saving || !url.trim() || events.length === 0}
        onClick={handleCreate}
      >
        <Plus size={14} /> {saving ? 'Creating…' : 'Add endpoint'}
      </Button>
    </Card>
  );
}

function EndpointCard({
  endpoint,
  logs,
  onChanged,
  onRemove,
}: {
  endpoint: WebhookEndpoint;
  logs: WebhookLog[];
  onChanged: () => void;
  onRemove: () => void;
}) {
  const { toast } = useToast();
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleCopySecret = () => {
    navigator.clipboard.writeText(endpoint.signing_secret);
    toast('Signing secret copied', 'success');
  };

  const handleToggleStatus = async () => {
    setBusy(true);
    const nextStatus = endpoint.status === 'active' ? 'disabled' : 'active';
    const { error } = await supabase.from('webhook_endpoints').update({ status: nextStatus }).eq('id', endpoint.id);
    setBusy(false);
    if (error) {
      toast('Could not update this endpoint', 'error');
      return;
    }
    onChanged();
  };

  const handleSendTest = async () => {
    setBusy(true);
    const { error } = await supabase.rpc('send_test_webhook_event', { p_endpoint_id: endpoint.id });
    setBusy(false);
    if (error) {
      toast(error.message || 'Could not send the test event', 'error');
      return;
    }
    toast('Test event sent — check Recent deliveries below', 'success');
    setTimeout(onChanged, 1500);
  };

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate font-mono text-sm font-semibold text-text-primary">{endpoint.url}</p>
            <span
              className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold capitalize ${
                endpoint.status === 'active'
                  ? 'border-success-500/30 bg-success-500/10 text-success-500'
                  : 'border-border bg-bg-tertiary text-text-secondary'
              }`}
            >
              {endpoint.status}
            </span>
          </div>
          {endpoint.description && <p className="mt-1 text-xs text-text-secondary">{endpoint.description}</p>}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {endpoint.events.map((e) => (
              <span key={e} className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">
                {eventLabel(e)}
              </span>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={handleSendTest}>
            <Send size={14} /> Test
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={handleToggleStatus}>
            <Power size={14} /> {endpoint.status === 'active' ? 'Disable' : 'Enable'}
          </Button>
          <Button variant="ghost" size="sm" onClick={onRemove} aria-label="Remove endpoint">
            <Trash2 size={14} />
          </Button>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2 rounded-xl border border-border bg-bg-tertiary/60 px-3 py-2">
        <Key size={13} className="shrink-0 text-text-secondary" />
        <code className="min-w-0 flex-1 truncate text-xs text-text-secondary">
          {revealed ? endpoint.signing_secret : '•'.repeat(24)}
        </code>
        <button
          type="button"
          className="focus-ring shrink-0 text-text-secondary hover:text-text-primary"
          onClick={() => setRevealed((v) => !v)}
          aria-label={revealed ? 'Hide signing secret' : 'Reveal signing secret'}
        >
          {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
        <button
          type="button"
          className="focus-ring shrink-0 text-text-secondary hover:text-text-primary"
          onClick={handleCopySecret}
          aria-label="Copy signing secret"
        >
          <Copy size={14} />
        </button>
      </div>

      {logs.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary/70">
            Recent deliveries
          </p>
          <div className="space-y-1.5">
            {logs.slice(0, 5).map((log) => (
              <div
                key={log.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border/70 px-3 py-1.5 text-xs"
              >
                <span className="text-text-secondary">{eventLabel(log.event_type)}</span>
                <span className="text-text-secondary/70">{new Date(log.created_at).toLocaleString()}</span>
                <StatusPill status={log.status} />
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

export function EventBusPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [logs, setLogs] = useState<WebhookLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [endpointsRes, logsRes] = await Promise.all([
      supabase.from('webhook_endpoints').select('*').order('created_at', { ascending: false }),
      supabase
        .from('webhook_logs')
        .select('*')
        .not('endpoint_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(100),
    ]);
    if (endpointsRes.error) toast('Failed to load your endpoints', 'error');
    setEndpoints((endpointsRes.data as WebhookEndpoint[]) || []);
    setLogs((logsRes.data as WebhookLog[]) || []);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    if (user) fetchAll();
  }, [user, fetchAll]);

  const logsByEndpoint = useMemo(() => {
    const map = new Map<string, WebhookLog[]>();
    logs.forEach((log) => {
      if (!log.endpoint_id) return;
      const list = map.get(log.endpoint_id) || [];
      list.push(log);
      map.set(log.endpoint_id, list);
    });
    return map;
  }, [logs]);

  const handleRemove = async () => {
    if (!removingId) return;
    const { error } = await supabase.from('webhook_endpoints').delete().eq('id', removingId);
    if (error) {
      toast('Could not remove this endpoint', 'error');
    } else {
      setEndpoints((prev) => prev.filter((e) => e.id !== removingId));
      toast('Endpoint removed', 'success');
    }
    setRemovingId(null);
  };

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Webhook size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Event Bus</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Real-time, signed webhooks for your own systems — Zapier, a CRM, an internal dashboard. Manage API
              keys separately under{' '}
              <Link to="/dashboard/settings/api-keys" className="font-semibold text-accent hover:text-cta">
                API Keys
              </Link>
              .
            </p>
          </div>
        </div>

        {loading ? (
          <div className="space-y-4">
            {[0, 1].map((i) => (
              <div key={i} className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : (
          <>
            <NewEndpointForm onCreated={fetchAll} />

            <div className="space-y-5">
              {endpoints.map((endpoint) => (
                <EndpointCard
                  key={endpoint.id}
                  endpoint={endpoint}
                  logs={logsByEndpoint.get(endpoint.id) || []}
                  onChanged={fetchAll}
                  onRemove={() => setRemovingId(endpoint.id)}
                />
              ))}

              {endpoints.length === 0 && (
                <p className="py-10 text-center text-sm text-text-secondary">
                  No endpoints yet — add one above to start receiving events.
                </p>
              )}
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={!!removingId}
        title="Remove this endpoint?"
        description="Vireek will stop sending events to this URL immediately. This can't be undone."
        confirmLabel="Remove endpoint"
        onConfirm={handleRemove}
        onCancel={() => setRemovingId(null)}
      />
    </DashboardLayout>
  );
}
