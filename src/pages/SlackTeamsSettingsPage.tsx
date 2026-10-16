import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  CircleCheck as CheckCircle2,
  CircleX as XCircle,
  Loader as Loader2,
  Lock,
  MessageSquareWarning,
  RefreshCw,
  Send,
  TriangleAlert as AlertTriangle,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { supabase } from '@/lib/supabase';
import {
  CSAT_THRESHOLD_OPTIONS,
  CHAT_PROVIDERS,
  EVENT_META,
  OAUTH_REASON_MESSAGES,
  PROVIDER_META,
  channelKey,
  channelLabel,
  draftsDirty,
  draftsToPayload,
  eventLabel,
  oauthResultFromParams,
  rulesToDrafts,
  timeAgo,
  validateDrafts,
  type AlertEventType,
  type ChatChannel,
  type ChatConnection,
  type ChatDelivery,
  type ChatListResponse,
  type ChatProvider,
  type ChatRule,
  type RuleDraft,
} from '@/lib/chatIntegrations';

// ============================================================
// SlackTeamsSettingsPage — /dashboard/settings/slack-teams
// ============================================================
//
// Connect Slack and/or Microsoft Teams (OAuth, handled by the chat-integrations
// edge function), map each alert type to a channel, send test alerts and review
// recent deliveries. Tokens never reach the browser: this page only ever sees
// workspace names, channel names and statuses. Everything is scoped to the
// account owner's id server-side; the gate here (owner or can_manage_team)
// mirrors the check the edge function enforces.

type LoadState = 'loading' | 'ready' | 'error';

async function callChat<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T & { error?: string }>('chat-integrations', { body });
  if (error || !data || (data as { error?: string }).error) {
    let message = (data as { error?: string } | null)?.error ?? '';
    if (!message) {
      try {
        const response = (error as { context?: Response } | null)?.context;
        message = response ? (((await response.json()) as { error?: string }).error ?? '') : '';
      } catch {
        message = '';
      }
    }
    throw new Error(message || 'Something went wrong. Please try again.');
  }
  return data as T;
}

function NoAccess() {
  return (
    <DashboardLayout activeLabel="Slack & Teams">
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
          <Lock size={26} />
        </span>
        <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
          Only the account owner, or a teammate with the "Manage Team" permission, can connect Slack and Teams.
        </p>
      </div>
    </DashboardLayout>
  );
}

function StatusPill({ connection }: { connection: ChatConnection | undefined }) {
  if (!connection) return <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-xs font-medium text-text-secondary">Not connected</span>;
  if (connection.status === 'error') {
    return <span className="rounded-full bg-warning-500/10 px-2.5 py-1 text-xs font-medium text-warning-500">Needs attention</span>;
  }
  return <span className="rounded-full bg-success-500/10 px-2.5 py-1 text-xs font-medium text-success-500">Connected</span>;
}

const SELECT_CLASS =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary disabled:opacity-50 md:w-64';

function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`focus-ring relative h-6 w-11 shrink-0 rounded-full border transition-colors ${checked ? 'border-accent bg-accent' : 'border-border bg-bg-tertiary'}`}
    >
      <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
    </button>
  );
}

interface ProviderSectionProps {
  provider: ChatProvider;
  configured: boolean;
  connection: ChatConnection | undefined;
  rules: ChatRule[];
  onConnect: (provider: ChatProvider) => Promise<void>;
  onDisconnect: (provider: ChatProvider) => void;
  onSaved: () => Promise<void>;
  onConnectionIssue: () => Promise<void>;
}

function ProviderSection({ provider, configured, connection, rules, onConnect, onDisconnect, onSaved, onConnectionIssue }: ProviderSectionProps) {
  const { toast } = useToast();
  const meta = PROVIDER_META[provider];
  const connected = connection?.status === 'connected';

  const saved = useMemo(() => rulesToDrafts(provider, rules), [provider, rules]);
  const [drafts, setDrafts] = useState<RuleDraft[]>(saved);
  const [errors, setErrors] = useState<Partial<Record<AlertEventType, string>>>({});
  const [channels, setChannels] = useState<ChatChannel[] | null>(null);
  const [channelsState, setChannelsState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [channelsError, setChannelsError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<AlertEventType | null>(null);

  useEffect(() => setDrafts(saved), [saved]);

  const loadChannels = useCallback(async () => {
    setChannelsState('loading');
    setChannelsError('');
    try {
      const res = await callChat<{ channels: ChatChannel[] }>({ action: 'channels', provider });
      setChannels(res.channels);
      setChannelsState('idle');
    } catch (err) {
      setChannelsError(err instanceof Error ? err.message : 'Could not load channels.');
      setChannelsState('error');
      void onConnectionIssue(); // the server may have flagged the connection; refresh its status
    }
  }, [provider, onConnectionIssue]);

  useEffect(() => {
    if (connected) void loadChannels();
    else setChannels(null);
  }, [connected, loadChannels]);

  const dirty = draftsDirty(drafts, saved);
  const patch = (eventType: AlertEventType, change: Partial<RuleDraft>) => {
    setDrafts((prev) => prev.map((d) => (d.eventType === eventType ? { ...d, ...change } : d)));
    setErrors((prev) => ({ ...prev, [eventType]: undefined }));
  };

  const pickChannel = (eventType: AlertEventType, key: string) => {
    const found = channels?.find((c) => channelKey(c) === key);
    patch(eventType, { channelKey: key, channelName: found?.name ?? '', containerName: found?.containerName ?? '' });
  };

  const handleConnect = async () => {
    setConnecting(true);
    try {
      await onConnect(provider);
    } finally {
      setConnecting(false);
    }
  };

  const handleSave = async () => {
    const found = validateDrafts(drafts);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    try {
      await callChat({ action: 'save_rules', provider, rules: draftsToPayload(drafts) });
      await onSaved();
      toast(`${meta.label} alert routing saved.`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (eventType: AlertEventType) => {
    setTesting(eventType);
    try {
      await callChat({ action: 'test', provider, eventType });
      toast(`Test alert sent to ${meta.label}.`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Test failed.', 'error');
      void onConnectionIssue();
    } finally {
      setTesting(null);
    }
  };

  return (
    <Card>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-lg font-semibold text-text-primary">{meta.label}</h2>
            <StatusPill connection={connection} />
          </div>
          {connection ? (
            <p className="mt-1 text-sm text-text-secondary">
              {connection.workspaceName ?? `Your ${meta.workspaceNoun}`}
              {connection.connectedByName ? ` · connected by ${connection.connectedByName}` : ''}
            </p>
          ) : (
            <p className="mt-1 text-sm text-text-secondary">{meta.blurb}</p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {!connection && (
            <Button variant="primary" size="sm" onClick={() => void handleConnect()} disabled={!configured || connecting}>
              {connecting && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
              Connect {meta.label}
            </Button>
          )}
          {connection?.status === 'error' && (
            <Button variant="primary" size="sm" onClick={() => void handleConnect()} disabled={!configured || connecting}>
              {connecting && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
              Reconnect
            </Button>
          )}
          {connection && (
            <button
              type="button"
              onClick={() => onDisconnect(provider)}
              className="focus-ring min-h-[36px] rounded-lg px-3 text-sm font-medium text-danger transition-colors hover:bg-danger/10"
            >
              Disconnect
            </button>
          )}
        </div>
      </div>

      {!configured && !connection && (
        <p role="note" className="mt-4 flex items-start gap-2 rounded-xl border border-dashed border-border bg-bg-primary p-3 text-xs text-text-secondary">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />
          {meta.label} isn't configured on this server yet. Add the {meta.label} secrets from docs/slack-teams-alerts.md, then reload this page.
        </p>
      )}

      {connection?.status === 'error' && (
        <p role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-warning-500/30 bg-warning-500/10 p-3 text-sm text-text-primary">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />
          {connection.lastError ?? `The ${meta.label} connection needs to be re-authorized.`} Alerts are paused until you reconnect.
        </p>
      )}

      {connected && (
        <div className="mt-6 border-t border-border pt-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-text-primary">Alert routing</h3>
            {channelsState === 'loading' && <span className="text-xs text-text-secondary">Loading channels…</span>}
          </div>

          {channelsState === 'error' && (
            <div role="alert" className="mb-3 flex flex-col gap-2 rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm sm:flex-row sm:items-center">
              <p className="flex-1 text-text-primary">{channelsError}</p>
              <Button variant="secondary" size="sm" onClick={() => void loadChannels()}>
                <RefreshCw size={13} aria-hidden="true" /> Retry
              </Button>
            </div>
          )}

          <ul className="space-y-3">
            {drafts.map((draft) => {
              const eventMeta = EVENT_META[draft.eventType];
              const savedDraft = saved.find((s) => s.eventType === draft.eventType);
              const inChannelList = !draft.channelKey || channels?.some((c) => channelKey(c) === draft.channelKey);
              const canTest = !!savedDraft?.channelKey && savedDraft.channelKey === draft.channelKey && !dirty;
              const grouped = provider === 'teams';
              const groups = grouped ? Array.from(new Set((channels ?? []).map((c) => c.containerName ?? ''))) : [];
              return (
                <li key={draft.eventType} className="rounded-xl border border-border bg-bg-primary p-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <Switch checked={draft.enabled} label={`${eventMeta.label} alerts`} onChange={(next) => patch(draft.eventType, { enabled: next })} />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-text-primary">{eventMeta.label}</p>
                        <p className="text-xs text-text-secondary">{eventMeta.description}</p>
                      </div>
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <select
                        aria-label={`${eventMeta.label} channel`}
                        className={SELECT_CLASS}
                        value={draft.channelKey}
                        disabled={channelsState === 'loading' || channels === null}
                        onChange={(e) => pickChannel(draft.eventType, e.target.value)}
                      >
                        <option value="">{channelsState === 'loading' ? 'Loading…' : 'Choose a channel'}</option>
                        {!inChannelList && <option value={draft.channelKey}>{draft.channelName || 'Unavailable channel'} (unavailable)</option>}
                        {grouped
                          ? groups.map((group) => (
                              <optgroup key={group} label={group || 'Team'}>
                                {channels!.filter((c) => (c.containerName ?? '') === group).map((c) => (
                                  <option key={channelKey(c)} value={channelKey(c)}>{channelLabel(provider, c)}</option>
                                ))}
                              </optgroup>
                            ))
                          : (channels ?? []).map((c) => (
                              <option key={channelKey(c)} value={channelKey(c)}>{channelLabel(provider, c)}</option>
                            ))}
                      </select>
                      {draft.eventType === 'low_csat' && (
                        <select
                          aria-label="Low CSAT threshold"
                          className={`${SELECT_CLASS} sm:w-40 md:w-40`}
                          value={draft.threshold}
                          onChange={(e) => patch('low_csat', { threshold: Number(e.target.value) })}
                        >
                          {CSAT_THRESHOLD_OPTIONS.map((n) => (
                            <option key={n} value={n}>{`${n} star${n === 1 ? '' : 's'} or less`}</option>
                          ))}
                        </select>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleTest(draft.eventType)}
                        disabled={!canTest || testing !== null}
                        title={canTest ? 'Send a test alert' : 'Save your changes to test this channel'}
                        className="focus-ring inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-text-primary transition-colors hover:bg-bg-tertiary disabled:opacity-40"
                      >
                        {testing === draft.eventType ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Send size={13} aria-hidden="true" />}
                        Test
                      </button>
                    </div>
                  </div>
                  {errors[draft.eventType] && (
                    <p role="alert" className="mt-2 text-xs font-medium text-danger">{errors[draft.eventType]}</p>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            {dirty && (
              <Button variant="secondary" size="sm" onClick={() => { setDrafts(saved); setErrors({}); }} disabled={saving}>
                Discard
              </Button>
            )}
            <Button variant="primary" size="sm" onClick={() => void handleSave()} disabled={!dirty || saving}>
              {saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
              {saving ? 'Saving…' : 'Save routing'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function DeliveryRow({ delivery }: { delivery: ChatDelivery }) {
  const ok = delivery.status === 'sent';
  return (
    <li className="flex items-start gap-3 py-3">
      {ok ? (
        <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-success-500" aria-label="Sent" />
      ) : (
        <XCircle size={18} className="mt-0.5 shrink-0 text-danger" aria-label="Failed" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-primary">
          {eventLabel(delivery.eventType)} → {PROVIDER_META[delivery.provider].label}
          {delivery.channelName ? ` · ${PROVIDER_META[delivery.provider].channelPrefix}${delivery.channelName}` : ''}
        </p>
        {delivery.error && <p className="mt-0.5 text-xs text-danger">{delivery.error}</p>}
      </div>
      <span className="shrink-0 text-xs text-text-secondary">{timeAgo(delivery.createdAt)}</span>
    </li>
  );
}

export function SlackTeamsSettingsPage() {
  const navigate = useNavigate();
  const { user, profileLoading, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const canAccess = isOwner || permissions.can_manage_team;

  const [state, setState] = useState<LoadState>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [data, setData] = useState<ChatListResponse | null>(null);
  const [disconnecting, setDisconnecting] = useState<ChatProvider | null>(null);
  const generationRef = useRef(0);

  const load = useCallback(async (silent = false) => {
    const generation = ++generationRef.current;
    if (!silent) setState('loading');
    try {
      const res = await callChat<ChatListResponse>({ action: 'list' });
      if (generation !== generationRef.current) return;
      setData(res);
      setState('ready');
    } catch (err) {
      if (generation !== generationRef.current) return;
      if (!silent) {
        setErrorMessage(err instanceof Error ? err.message : 'Could not load your integrations.');
        setState('error');
      }
    }
  }, []);

  useEffect(() => {
    if (profileLoading || !user || !canAccess) return;
    void load();
    return () => {
      generationRef.current += 1;
    };
  }, [profileLoading, user, canAccess, load]);

  // Result of the OAuth round-trip (?slack=connected, ?teams=error&reason=…).
  useEffect(() => {
    const result = oauthResultFromParams(searchParams);
    if (!result) return;
    if (result.ok) toast(`${PROVIDER_META[result.provider].label} connected.`, 'success');
    else toast(OAUTH_REASON_MESSAGES[result.reason ?? ''] ?? 'We could not connect. Please try again.', 'error');
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams, toast]);

  const handleConnect = useCallback(async (provider: ChatProvider) => {
    try {
      const { url } = await callChat<{ url: string }>({ action: 'connect', provider });
      window.location.assign(url);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not start the connection.', 'error');
    }
  }, [toast]);

  const confirmDisconnect = async () => {
    if (!disconnecting) return;
    const provider = disconnecting;
    try {
      await callChat({ action: 'disconnect', provider });
      toast(`${PROVIDER_META[provider].label} disconnected.`, 'success');
      await load(true);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not disconnect.', 'error');
    } finally {
      setDisconnecting(null);
    }
  };

  const refreshQuietly = useCallback(() => load(true), [load]);

  if (profileLoading) {
    return (
      <DashboardLayout activeLabel="Slack & Teams">
        <Skeleton className="h-40 w-full" />
      </DashboardLayout>
    );
  }
  if (!canAccess) return <NoAccess />;

  return (
    <DashboardLayout activeLabel="Slack & Teams">
      <button
        type="button"
        onClick={() => navigate('/dashboard/settings')}
        className="focus-ring mb-4 flex items-center gap-1.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
      >
        <ArrowLeft size={15} aria-hidden="true" />
        Back to Settings
      </button>

      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <MessageSquareWarning size={24} aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Slack &amp; Teams alerts</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Send emergencies, new jobs, missed calls and low CSAT ratings straight to your team's chat.
          </p>
        </div>
      </div>

      {state === 'loading' && (
        <div aria-busy="true" aria-live="polite" className="space-y-6">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}

      {state === 'error' && (
        <div role="alert" className="flex flex-col items-center rounded-2xl border border-danger/30 bg-danger/10 px-6 py-12 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-danger/15 text-danger">
            <AlertTriangle size={22} aria-hidden="true" />
          </span>
          <h3 className="mt-4 text-base font-semibold text-text-primary">We couldn't load your integrations</h3>
          <p className="mt-1.5 max-w-sm text-sm text-text-secondary">{errorMessage}</p>
          <Button variant="primary" size="sm" className="mt-5" onClick={() => void load()}>
            <RefreshCw size={14} aria-hidden="true" /> Try again
          </Button>
        </div>
      )}

      {state === 'ready' && data && (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }} className="space-y-6">
          {CHAT_PROVIDERS.map((provider) => (
            <ProviderSection
              key={provider}
              provider={provider}
              configured={data.configured[provider]}
              connection={data.connections.find((c) => c.provider === provider)}
              rules={data.rules}
              onConnect={handleConnect}
              onDisconnect={setDisconnecting}
              onSaved={refreshQuietly}
              onConnectionIssue={refreshQuietly}
            />
          ))}

          <section aria-label="Recent alerts">
            <h2 className="mb-2 text-base font-semibold text-text-primary">Recent alerts</h2>
            {data.deliveries.length === 0 ? (
              <EmptyState
                icon={MessageSquareWarning}
                title="No alerts sent yet"
                description="Once an alert is switched on, every message Vireek posts to Slack or Teams shows up here."
              />
            ) : (
              <ul className="divide-y divide-border rounded-2xl border border-border bg-bg-secondary px-4">
                {data.deliveries.map((d) => (
                  <DeliveryRow key={d.id} delivery={d} />
                ))}
              </ul>
            )}
          </section>
        </motion.div>
      )}

      <ConfirmDialog
        open={disconnecting !== null}
        title={`Disconnect ${disconnecting ? PROVIDER_META[disconnecting].label : ''}?`}
        description="Alerts to this workspace stop immediately and your channel mapping is deleted. You can reconnect at any time."
        confirmLabel="Disconnect"
        onConfirm={confirmDisconnect}
        onCancel={() => setDisconnecting(null)}
      />
    </DashboardLayout>
  );
}
