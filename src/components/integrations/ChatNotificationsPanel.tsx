import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Hash, Users, Check, Loader as Loader2, Link2, Link2Off, RefreshCw, Send, AlertTriangle, MessageSquare } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SkeletonCardList } from '@/components/Skeleton';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import {
  CHAT_EVENTS,
  CHAT_PROVIDERS,
  connectionHealth,
  deliveryTone,
  eventLabel,
  needsTeamsInstall,
  oauthReasonMessage,
  routeFor,
  summarizeRouting,
  type ChatChannel,
  type ChatConnection,
  type ChatEventDef,
  type ChatProvider,
  type Tone,
} from '@/lib/chatNotifications';
import {
  disconnectChat,
  fetchChatState,
  listChatChannels,
  refreshTeamsChannels,
  resendChatDelivery,
  saveChatRoute,
  sendChatTest,
  startChatOAuth,
  type ChatState,
} from '@/lib/chatNotificationsApi';

const TONE_CLASS: Record<Tone, string> = {
  success: 'bg-success-500/10 text-success-500',
  danger: 'bg-danger-500/10 text-danger-500',
  warning: 'bg-warning-500/10 text-warning-500',
  neutral: 'bg-bg-tertiary text-text-secondary',
};

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary disabled:opacity-50';

const CONTACT_EVENTS = new Set(['emergency_call', 'missed_call', 'new_job']);

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${TONE_CLASS[tone]}`}>{children}</span>;
}

export function ChatNotificationsPanel({ isOwner }: { isOwner: boolean }) {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [state, setState] = useState<ChatState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [channels, setChannels] = useState<Partial<Record<ChatProvider, ChatChannel[]>>>({});
  const [channelError, setChannelError] = useState<Partial<Record<ChatProvider, string>>>({});
  const [active, setActive] = useState<ChatProvider>('slack');
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await fetchChatState());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load chat notification settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadChannels = useCallback(async (provider: ChatProvider) => {
    try {
      const list = await listChatChannels(provider);
      setChannels((c) => ({ ...c, [provider]: list }));
      setChannelError((c) => ({ ...c, [provider]: undefined }));
    } catch (e) {
      setChannelError((c) => ({ ...c, [provider]: e instanceof Error ? e.message : 'Could not load channels.' }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Returning from the Slack / Microsoft consent screen.
  useEffect(() => {
    const slack = searchParams.get('slack');
    const teams = searchParams.get('teams');
    if (!slack && !teams) return;
    const provider = slack ? 'Slack' : 'Microsoft Teams';
    const result = slack ?? teams;
    if (result === 'connected') toast(`${provider} connected.`, 'success');
    else toast(oauthReasonMessage(searchParams.get('reason')), 'error');
    setActive(slack ? 'slack' : 'teams');
    searchParams.delete('slack');
    searchParams.delete('teams');
    searchParams.delete('reason');
    setSearchParams(searchParams, { replace: true });
    void refresh();
  }, [searchParams, setSearchParams, toast, refresh]);

  const connections = useMemo(() => state?.connections.filter((c) => c.status !== 'disconnected') ?? [], [state]);
  const connectedKey = connections.map((c) => `${c.provider}:${c.status}`).join('|');

  useEffect(() => {
    for (const c of connections) if (c.status === 'connected') void loadChannels(c.provider);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the set of connected providers changes
  }, [connectedKey, loadChannels]);

  const byProvider = (p: ChatProvider): ChatConnection | undefined => connections.find((c) => c.provider === p);

  const run = async (key: string, fn: () => Promise<void>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const connect = (p: ChatProvider) =>
    run(`connect:${p}`, async () => {
      window.location.href = await startChatOAuth(p);
    });

  const disconnect = (p: ChatProvider) => {
    if (!window.confirm(`Disconnect ${p === 'slack' ? 'Slack' : 'Microsoft Teams'}? Channel mappings will be removed.`)) return;
    return run(`disconnect:${p}`, async () => {
      await disconnectChat(p);
      setChannels((c) => ({ ...c, [p]: undefined }));
      await refresh();
    }, 'Disconnected.');
  };

  const saveRow = (conn: ChatConnection, def: ChatEventDef, patch: Partial<{ channel_id: string; enabled: boolean; actions_enabled: boolean; include_contact_details: boolean; csat_threshold: number }>) => {
    const current = routeFor(state?.routes ?? [], conn.id, def.id);
    const channelId = patch.channel_id ?? current?.channel_id ?? '';
    if (!channelId) return;
    const name = (channels[conn.provider] ?? []).find((c) => c.id === channelId)?.name ?? current?.channel_name ?? null;
    return run(`route:${conn.id}:${def.id}`, async () => {
      await saveChatRoute({
        connection_id: conn.id,
        event_type: def.id,
        channel_id: channelId,
        channel_name: name,
        enabled: patch.enabled ?? current?.enabled ?? true,
        actions_enabled: patch.actions_enabled ?? current?.actions_enabled ?? true,
        include_contact_details: patch.include_contact_details ?? current?.include_contact_details ?? true,
        csat_threshold: patch.csat_threshold ?? current?.csat_threshold ?? 2,
      });
      await refresh();
    });
  };

  if (loading) return <SkeletonCardList count={2} className="mt-10" />;

  if (loadError) {
    return (
      <Card className="mt-10 p-6">
        <div className="flex items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-sm text-danger-500"><AlertTriangle size={16} /> {loadError}</p>
          <Button variant="secondary" size="sm" onClick={() => { setLoading(true); void refresh(); }}>Retry</Button>
        </div>
      </Card>
    );
  }

  const activeConn = byProvider(active);
  const activeChannels = channels[active] ?? [];
  const groups = Array.from(new Set(activeChannels.map((c) => c.group ?? '')));

  return (
    <section aria-labelledby="chat-notifications-title" className="mt-10">
      <div className="mb-4 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent/10 text-accent"><MessageSquare size={22} /></span>
        <div>
          <h2 id="chat-notifications-title" className="text-xl font-bold tracking-tight text-text-primary">Team chat notifications</h2>
          <p className="mt-0.5 text-sm text-text-secondary">Send the events that matter to Slack or Microsoft Teams — and act on them with one tap.</p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {CHAT_PROVIDERS.map((p) => {
          const conn = byProvider(p.id);
          const health = connectionHealth(conn);
          const summary = conn ? summarizeRouting(state?.routes ?? [], conn.id) : null;
          const Icon = p.id === 'slack' ? Hash : Users;
          return (
            <Card key={p.id} className="p-6">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"><Icon size={22} /></span>
                  <div>
                    <h3 className="text-sm font-semibold text-text-primary">{p.name}</h3>
                    <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">
                      {conn?.external_name ? `${conn.external_name}${summary ? ` · ${summary.active}/${summary.total} events routed` : ''}` : p.description}
                    </p>
                  </div>
                </div>
                <Pill tone={health.tone}>{health.tone === 'success' && <Check size={12} />}{health.tone === 'danger' && <AlertTriangle size={12} />}{health.label}</Pill>
              </div>
              {conn?.status === 'error' && conn.last_error && <p className="mt-3 text-xs text-danger-500">{conn.last_error}</p>}
              {isOwner ? (
                <div className="mt-4 flex gap-2">
                  {(!conn || conn.status === 'error') && (
                    <Button size="sm" className="flex-1" disabled={busy === `connect:${p.id}`} onClick={() => void connect(p.id)}>
                      {busy === `connect:${p.id}` ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />}
                      {conn ? 'Reconnect' : 'Connect'}
                    </Button>
                  )}
                  {conn && (
                    <Button variant="secondary" size="sm" className="flex-1" disabled={busy === `disconnect:${p.id}`} onClick={() => void disconnect(p.id)}>
                      <Link2Off size={16} /> Disconnect
                    </Button>
                  )}
                </div>
              ) : (
                <p className="mt-4 text-xs text-text-secondary">Only the account owner can connect or change these settings.</p>
              )}
            </Card>
          );
        })}
      </div>

      {connections.length === 0 ? (
        <EmptyState
          className="mt-4"
          icon={MessageSquare}
          title="Connect a workspace to start routing alerts"
          description="Once connected, choose a channel for each event: emergency calls, missed calls, new jobs, completed jobs, low CSAT and failed payments."
        />
      ) : (
        <Card className="mt-4 p-6">
          {connections.length > 1 && (
            <div role="tablist" aria-label="Provider" className="mb-4 inline-flex gap-1 rounded-xl bg-bg-tertiary p-1">
              {connections.map((c) => (
                <button
                  key={c.provider}
                  type="button"
                  role="tab"
                  aria-selected={active === c.provider}
                  onClick={() => setActive(c.provider)}
                  className={`focus-ring rounded-lg px-3 py-1.5 text-sm font-medium ${active === c.provider ? 'bg-bg-secondary text-text-primary shadow-sm' : 'text-text-secondary'}`}
                >
                  {c.provider === 'slack' ? 'Slack' : 'Microsoft Teams'}
                </button>
              ))}
            </div>
          )}

          {!activeConn && <p className="text-sm text-text-secondary">Select a connected provider above.</p>}

          {activeConn && (
            <>
              {needsTeamsInstall(activeConn, activeChannels.length) && (
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary p-4">
                  <p className="text-sm text-text-secondary">
                    Add the <strong className="text-text-primary">Vireek</strong> app to a Team in Microsoft Teams (Apps → Manage your apps → Upload / Add to a team), then refresh to see its channels.
                  </p>
                  {isOwner && (
                    <Button variant="secondary" size="sm" disabled={busy === 'refresh'} onClick={() => void run('refresh', async () => { await refreshTeamsChannels(); await loadChannels('teams'); })}>
                      <RefreshCw size={14} /> Refresh channels
                    </Button>
                  )}
                </div>
              )}
              {channelError[active] && <p className="mb-3 text-sm text-danger-500">{channelError[active]}</p>}

              <ul className="space-y-3">
                {CHAT_EVENTS.map((def) => {
                  const r = routeFor(state?.routes ?? [], activeConn.id, def.id);
                  const rowBusy = busy === `route:${activeConn.id}:${def.id}`;
                  return (
                    <li key={def.id} className="grid gap-3 rounded-xl border border-border bg-bg-primary p-4 md:grid-cols-[1fr_minmax(240px,300px)]">
                      <div>
                        <p className="text-sm font-semibold text-text-primary">{def.label}</p>
                        <p className="mt-0.5 text-xs text-text-secondary">{def.description}</p>
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-text-secondary">
                          {def.buttons.length > 0 && (
                            <label className="inline-flex items-center gap-1.5">
                              <input type="checkbox" className="accent-accent" disabled={!isOwner || !r || rowBusy} checked={r?.actions_enabled ?? true} onChange={(e) => void saveRow(activeConn, def, { actions_enabled: e.target.checked })} />
                              {def.buttons.map((b) => (b === 'acknowledge' ? 'Acknowledge' : 'Assign')).join(' + ')} buttons
                            </label>
                          )}
                          {CONTACT_EVENTS.has(def.id) && (
                            <label className="inline-flex items-center gap-1.5">
                              <input type="checkbox" className="accent-accent" disabled={!isOwner || !r || rowBusy} checked={r?.include_contact_details ?? true} onChange={(e) => void saveRow(activeConn, def, { include_contact_details: e.target.checked })} />
                              Show phone &amp; address
                            </label>
                          )}
                          {def.id === 'low_csat' && (
                            <label className="inline-flex items-center gap-1.5">
                              Alert at
                              <select className="focus-ring rounded-lg border border-border bg-bg-secondary px-1.5 py-0.5" disabled={!isOwner || !r || rowBusy} value={r?.csat_threshold ?? 2} onChange={(e) => void saveRow(activeConn, def, { csat_threshold: Number(e.target.value) })}>
                                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} ★ or lower</option>)}
                              </select>
                            </label>
                          )}
                        </div>
                      </div>
                      <div className="space-y-2">
                        <select
                          aria-label={`Channel for ${def.label}`}
                          className={selectClass}
                          disabled={!isOwner || rowBusy || activeChannels.length === 0}
                          value={r?.channel_id ?? ''}
                          onChange={(e) => void saveRow(activeConn, def, { channel_id: e.target.value })}
                        >
                          <option value="">{activeChannels.length ? 'Choose a channel…' : 'Channels unavailable'}</option>
                          {groups.map((g) => {
                            const opts = activeChannels.filter((c) => (c.group ?? '') === g).map((c) => (
                              <option key={c.id} value={c.id}>{c.isPrivate ? '🔒 ' : active === 'slack' ? '# ' : ''}{c.name}</option>
                            ));
                            return g ? <optgroup key={g} label={g}>{opts}</optgroup> : opts;
                          })}
                          {r && !activeChannels.some((c) => c.id === r.channel_id) && <option value={r.channel_id}>{r.channel_name ?? r.channel_id}</option>}
                        </select>
                        <div className="flex items-center justify-between gap-2">
                          <label className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
                            <input type="checkbox" className="accent-accent" disabled={!isOwner || !r || rowBusy} checked={r?.enabled ?? false} onChange={(e) => void saveRow(activeConn, def, { enabled: e.target.checked })} />
                            Enabled
                          </label>
                          <Button variant="ghost" size="sm" disabled={!isOwner || !r || busy === `test:${def.id}`} onClick={() => void run(`test:${def.id}`, () => sendChatTest(active, def.id).then(() => undefined), 'Test message sent.')}>
                            {busy === `test:${def.id}` ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send test
                          </Button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Card>
      )}

      {(state?.deliveries.length ?? 0) > 0 && (
        <Card className="mt-4 p-6">
          <h3 className="text-sm font-semibold text-text-primary">Recent deliveries</h3>
          <ul className="mt-3 divide-y divide-border">
            {state?.deliveries.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm text-text-primary">
                    {d.event ? eventLabel(d.event.event_type) : 'Event'} → {d.provider === 'slack' ? '#' : ''}{d.channel_name ?? 'channel'}
                  </p>
                  <p className="text-xs text-text-secondary">{new Date(d.created_at).toLocaleString()}{d.error ? ` · ${d.error}` : ''}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Pill tone={deliveryTone(d.status)}>{d.status}</Pill>
                  {isOwner && d.status === 'failed' && (
                    <Button variant="ghost" size="sm" disabled={busy === `resend:${d.id}`} onClick={() => void run(`resend:${d.id}`, async () => { await resendChatDelivery(d.id); await refresh(); }, 'Retry queued.')}>
                      <RefreshCw size={14} /> Resend
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
