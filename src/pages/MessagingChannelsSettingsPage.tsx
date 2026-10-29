import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, BadgeCheck, MessagesSquare, Send, ShieldAlert, Unplug } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  connectMessenger,
  connectTelegram,
  disconnectChannel,
  fetchDmConnections,
  isFacebookPageId,
  isPageAccessToken,
  isTelegramToken,
  type DmChannelKey,
  type DmConnection,
} from '@/lib/dmChannels';

const inputCls = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary';

type Notice = { tone: 'ok' | 'error'; text: string } | null;

function StatusBadge({ connection }: { connection: DmConnection | undefined }) {
  const connected = connection?.status === 'connected';
  const broken = connection?.status === 'error';
  const tone = connected ? 'bg-success/10 text-success' : broken ? 'bg-red-500/10 text-red-500' : 'bg-bg-tertiary text-text-secondary';
  const Icon = connected ? BadgeCheck : broken ? ShieldAlert : Unplug;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>
      <Icon size={12} aria-hidden="true" /> {connected ? 'Connected' : broken ? 'Needs attention' : 'Not connected'}
    </span>
  );
}

interface CardProps {
  channel: DmChannelKey;
  title: string;
  icon: typeof Send;
  intro: string;
  steps: string[];
  connection: DmConnection | undefined;
  onChanged: () => Promise<void>;
  children: (args: { disabled: boolean }) => ReactNode;
  validate: () => string | null;
  submit: () => Promise<{ ok: boolean; error?: string }>;
  reset: () => void;
}

function ChannelCard({ channel, title, icon: Icon, intro, steps, connection, onChanged, children, validate, submit, reset }: CardProps) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const live = connection && connection.status !== 'disconnected';

  const run = async (action: () => Promise<{ ok: boolean; error?: string }>, okText: string) => {
    setBusy(true);
    setNotice(null);
    const res = await action();
    if (res.ok) {
      reset();
      setConfirming(false);
      setNotice({ tone: 'ok', text: okText });
    } else {
      setNotice({ tone: 'error', text: res.error ?? 'Something went wrong.' });
    }
    await onChanged();
    setBusy(false);
  };

  const connect = () => {
    const invalid = validate();
    if (invalid) return setNotice({ tone: 'error', text: invalid });
    return run(submit, `${title} connected.`);
  };

  return (
    <section className="rounded-2xl border border-border p-4 sm:p-5" aria-labelledby={`dm-${channel}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`dm-${channel}`} className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
          <Icon size={15} aria-hidden="true" /> {title}
        </h2>
        <StatusBadge connection={connection} />
      </div>
      <p className="mt-2 text-xs leading-relaxed text-text-secondary">{intro}</p>

      {notice && (
        <p role="status" className={`mt-3 rounded-xl px-3.5 py-2.5 text-sm ${notice.tone === 'ok' ? 'bg-success/10 text-success' : 'bg-red-500/10 text-red-500'}`}>
          {notice.text}
        </p>
      )}

      {live ? (
        <div className="mt-4 space-y-3">
          <p className="break-all text-sm text-text-primary">
            {connection.displayName ?? connection.externalAccountId}
            <span className="ml-2 text-xs text-text-secondary">ID {connection.externalAccountId}</span>
          </p>
          {connection.status === 'error' && (
            <p className="rounded-xl bg-red-500/10 px-3.5 py-2.5 text-xs text-red-500">
              {connection.lastError ?? 'The connection stopped working.'} Reconnect with a fresh token below.
            </p>
          )}
          {connection.status === 'error' && <div className="space-y-3">{children({ disabled: busy })}</div>}
          {connection.status === 'error' && (
            <button type="button" onClick={connect} disabled={busy} className="focus-ring rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50">
              {busy ? 'Reconnecting…' : 'Reconnect'}
            </button>
          )}
          {confirming ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-text-secondary">Stop receiving messages from this {channel === 'telegram' ? 'bot' : 'Page'}?</span>
              <button type="button" onClick={() => run(() => disconnectChannel(channel), `${title} disconnected.`)} disabled={busy} className="focus-ring rounded-xl bg-red-500 px-3.5 py-2 text-xs font-medium text-white disabled:opacity-50">
                {busy ? 'Disconnecting…' : 'Yes, disconnect'}
              </button>
              <button type="button" onClick={() => setConfirming(false)} disabled={busy} className="focus-ring rounded-xl border border-border px-3.5 py-2 text-xs font-medium text-text-secondary">
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirming(true)} className="focus-ring rounded-xl border border-border px-3.5 py-2 text-xs font-medium text-text-secondary hover:text-text-primary">
              Disconnect
            </button>
          )}
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <ol className="list-decimal space-y-1 pl-5 text-xs text-text-secondary">
            {steps.map((s) => <li key={s}>{s}</li>)}
          </ol>
          {children({ disabled: busy })}
          <button type="button" onClick={connect} disabled={busy} className="focus-ring w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50 sm:w-auto">
            {busy ? 'Connecting…' : `Connect ${title}`}
          </button>
        </div>
      )}
    </section>
  );
}

export function MessagingChannelsSettingsPage() {
  const [connections, setConnections] = useState<DmConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [botToken, setBotToken] = useState('');
  const [pageId, setPageId] = useState('');
  const [pageToken, setPageToken] = useState('');

  const load = useCallback(async () => {
    try {
      setConnections(await fetchDmConnections());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load your channels.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const byChannel = (c: DmChannelKey) => connections.find((x) => x.channel === c);

  return (
    <DashboardLayout activeLabel="Inbox">
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-5">
        <Link to="/dashboard/inbox" className="focus-ring mb-4 inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary">
          <ArrowLeft size={13} /> Back to inbox
        </Link>
        <h1 className="text-lg font-semibold text-text-primary">Messaging channels</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Connect Telegram and Facebook Messenger so customer messages arrive in your inbox and your team can reply from one place.
          Customers can send STOP at any time to opt out.
        </p>

        {loadError && (
          <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-red-500/10 px-3.5 py-2.5 text-sm text-red-500">
            <span>{loadError}</span>
            <button type="button" onClick={() => { setLoading(true); load(); }} className="focus-ring rounded-lg border border-red-500/30 px-3 py-1 text-xs font-medium">
              Retry
            </button>
          </div>
        )}

        {loading ? (
          <p className="mt-6 text-sm text-text-secondary">Loading…</p>
        ) : (
          <div className="mt-6 grid gap-4">
            <ChannelCard
              channel="telegram"
              title="Telegram"
              icon={Send}
              intro="Customers message your business bot; replies go out from the same bot. Telegram bots cannot start a conversation, so the customer must write first."
              steps={['In Telegram, open @BotFather and send /newbot.', 'Name the bot and copy the token it gives you.', 'Paste the token below and connect.']}
              connection={byChannel('telegram')}
              onChanged={load}
              validate={() => (isTelegramToken(botToken) ? null : 'That does not look like a bot token (format 123456789:AA…).')}
              submit={() => connectTelegram(botToken)}
              reset={() => setBotToken('')}
            >
              {({ disabled }) => (
                <label className="block text-xs text-text-secondary">
                  Bot token
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={disabled}
                    className={`${inputCls} mt-1`}
                    value={botToken}
                    onChange={(e) => setBotToken(e.target.value)}
                    placeholder="123456789:AA…"
                  />
                </label>
              )}
            </ChannelCard>

            <ChannelCard
              channel="messenger"
              title="Facebook Messenger"
              icon={MessagesSquare}
              intro="Customers message your Facebook Page. Meta allows free-form replies within 24 hours of the customer's last message."
              steps={['In your Meta app, add the Messenger product and your Page.', 'Generate a Page access token for that Page.', 'Paste the Page ID and token below and connect.']}
              connection={byChannel('messenger')}
              onChanged={load}
              validate={() =>
                !isFacebookPageId(pageId) ? 'Page ID must be the numeric ID of your Page.'
                : !isPageAccessToken(pageToken) ? 'Paste the Page access token (a long string without spaces).'
                : null}
              submit={() => connectMessenger(pageId, pageToken)}
              reset={() => { setPageId(''); setPageToken(''); }}
            >
              {({ disabled }) => (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-xs text-text-secondary">
                    Page ID
                    <input inputMode="numeric" disabled={disabled} className={`${inputCls} mt-1`} value={pageId} onChange={(e) => setPageId(e.target.value)} placeholder="1234567890" />
                  </label>
                  <label className="block text-xs text-text-secondary">
                    Page access token
                    <input type="password" autoComplete="off" spellCheck={false} disabled={disabled} className={`${inputCls} mt-1`} value={pageToken} onChange={(e) => setPageToken(e.target.value)} placeholder="EAAB…" />
                  </label>
                </div>
              )}
            </ChannelCard>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
