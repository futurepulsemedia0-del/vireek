import { useEffect, useState } from 'react';
import { AlertTriangle, Bell, CheckCircle2, Link2, Loader2, Plug, RefreshCw, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import {
  PLATFORM_LABEL,
  connectYelp,
  disconnectSource,
  saveReputationSettings,
  startOAuth,
  syncNow,
  timeAgo,
  type Connection,
  type Overview,
  type PlatformInfo,
} from '@/lib/reputation';

const STATUS: Record<Connection['status'], { label: string; cls: string }> = {
  active: { label: 'Connected', cls: 'bg-success/10 text-success' },
  needs_reauth: { label: 'Reconnect needed', cls: 'bg-warning-500/10 text-warning-500' },
  error: { label: 'Sync error', cls: 'bg-danger/10 text-danger' },
};

function PlatformCard({
  info,
  connections,
  isOwner,
  busy,
  run,
}: {
  info: PlatformInfo;
  connections: Connection[];
  isOwner: boolean;
  busy: string | null;
  run: (key: string, fn: () => Promise<Overview | void>, ok?: string) => Promise<void>;
}) {
  const [yelpId, setYelpId] = useState('');
  const [confirm, setConfirm] = useState<Connection | null>(null);
  const label = PLATFORM_LABEL[info.platform];

  const connect = () =>
    run(`connect-${info.platform}`, async () => {
      if (info.platform === 'yelp') return connectYelp(yelpId);
      const { url } = await startOAuth(info.platform as 'google' | 'facebook');
      window.location.assign(url);
    });

  return (
    <Card className="space-y-4 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-text-primary">{label}</h3>
          <p className="mt-1 max-w-xl text-sm text-text-secondary">{info.note}</p>
        </div>
        {!info.configured && <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-xs font-semibold text-text-secondary">Not enabled yet</span>}
      </div>

      {!info.configured ? (
        <p className="rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-secondary">
          {label} syncing isn't enabled on this workspace yet. You can still log {label} reviews by hand and draft replies. Contact support to enable it.
        </p>
      ) : (
        <>
          {connections.length > 0 && (
            <ul className="space-y-2">
              {connections.map((c) => (
                <li key={c.id} className="rounded-xl border border-border bg-bg-primary p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 break-words text-sm font-medium text-text-primary">{c.display_name}</span>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS[c.status].cls}`}>{STATUS[c.status].label}</span>
                  </div>
                  <p className="mt-1 text-xs text-text-secondary">Last synced {timeAgo(c.last_synced_at)}</p>
                  {c.last_error && (
                    <p className="mt-1 flex items-start gap-1.5 text-xs text-danger"><AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" /> {c.last_error}</p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {c.status === 'needs_reauth' && isOwner && info.oauth ? (
                      <Button type="button" size="sm" onClick={connect} disabled={busy !== null}><Link2 size={16} aria-hidden="true" /> Reconnect</Button>
                    ) : (
                      <Button type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={() => run(`sync-${c.id}`, () => syncNow(c.id), 'Sync complete.')}>
                        {busy === `sync-${c.id}` ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />} Sync now
                      </Button>
                    )}
                    {isOwner && (
                      <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirm(c)}>
                        <Unplug size={16} aria-hidden="true" /> Disconnect
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {isOwner ? (
            info.platform === 'yelp' ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <Input label="Yelp business page or alias" value={yelpId} placeholder="https://www.yelp.com/biz/your-business" onChange={(e) => setYelpId(e.target.value)} />
                </div>
                <Button type="button" size="sm" onClick={connect} disabled={busy !== null || !yelpId.trim()}>
                  {busy === 'connect-yelp' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Plug size={16} aria-hidden="true" />}
                  {connections.length ? 'Add another' : 'Connect Yelp'}
                </Button>
              </div>
            ) : (
              <Button type="button" size="sm" variant={connections.length ? 'secondary' : 'primary'} onClick={connect} disabled={busy !== null}>
                {busy === `connect-${info.platform}` ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Plug size={16} aria-hidden="true" />}
                {connections.length ? `Add more ${label} listings` : `Connect ${label}`}
              </Button>
            )
          ) : (
            connections.length === 0 && <p className="text-sm text-text-secondary">Only the account owner can connect {label}.</p>
          )}
        </>
      )}

      <ConfirmDialog
        open={!!confirm}
        title={`Disconnect ${confirm?.display_name ?? label}?`}
        description="New reviews stop syncing and replies can no longer be posted from Vireek. Reviews already in your inbox stay."
        confirmLabel="Disconnect"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const c = confirm;
          setConfirm(null);
          if (c) await run(`disc-${c.id}`, () => disconnectSource(c.id), 'Disconnected.');
        }}
      />
    </Card>
  );
}

export function ConnectionsPanel({ data, isOwner, onChange }: { data: Overview; isOwner: boolean; onChange: (o: Overview) => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [alerts, setAlerts] = useState(data.settings.alerts_enabled);
  const [maxRating, setMaxRating] = useState(data.settings.alert_max_rating);
  const [voice, setVoice] = useState(data.settings.brand_voice ?? '');
  const [signoff, setSignoff] = useState(data.settings.signoff ?? '');

  useEffect(() => {
    setAlerts(data.settings.alerts_enabled);
    setMaxRating(data.settings.alert_max_rating);
    setVoice(data.settings.brand_voice ?? '');
    setSignoff(data.settings.signoff ?? '');
  }, [data.settings]);

  const dirty =
    alerts !== data.settings.alerts_enabled ||
    maxRating !== data.settings.alert_max_rating ||
    voice !== (data.settings.brand_voice ?? '') ||
    signoff !== (data.settings.signoff ?? '');

  const run = async (key: string, fn: () => Promise<Overview | void>, ok?: string) => {
    setBusy(key);
    try {
      const out = await fn();
      if (out) onChange(out);
      if (ok) toast(ok, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong. Please try again.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const anyConnected = data.connections.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-text-primary">Review sources</h2>
        {anyConnected && (
          <Button type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={() => run('sync-all', () => syncNow(), 'Sync complete.')}>
            {busy === 'sync-all' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />} Sync all
          </Button>
        )}
      </div>

      <div className="space-y-4">
        {data.platforms.map((p) => (
          <PlatformCard key={p.platform} info={p} connections={data.connections.filter((c) => c.platform === p.platform)} isOwner={isOwner} busy={busy} run={run} />
        ))}
      </div>

      <Card className="space-y-4 p-5 sm:p-6">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-text-primary"><Bell size={18} aria-hidden="true" /> Alerts &amp; reply voice</h2>
          <p className="mt-1 text-sm text-text-secondary">Get a notification when a low-rated review comes in, and teach AI how your business sounds.</p>
        </div>

        <label className="flex cursor-pointer items-start gap-3">
          <input type="checkbox" checked={alerts} onChange={(e) => setAlerts(e.target.checked)} className="focus-ring mt-1 h-4 w-4 rounded border-border" />
          <span>
            <span className="block text-sm font-medium text-text-primary">Alert me about low ratings</span>
            <span className="block text-xs text-text-secondary">Sent to your notification bell. Reviews older than two weeks never trigger an alert.</span>
          </span>
        </label>

        <label className="block sm:max-w-xs">
          <span className="mb-1.5 block text-sm font-medium text-text-primary">Alert when the rating is</span>
          <select value={maxRating} disabled={!alerts} onChange={(e) => setMaxRating(Number(e.target.value))} className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary disabled:opacity-50">
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} star{n === 1 ? '' : 's'} or below</option>)}
          </select>
        </label>

        <Textarea label="Brand voice" rows={3} maxLength={500} value={voice} placeholder="Friendly and plain-spoken, family-owned, never pushy." helperText={`${voice.length}/500 · Used when drafting replies.`} onChange={(e) => setVoice(e.target.value)} />
        <Input label="Sign-off" maxLength={120} value={signoff} placeholder="— The team at Acme HVAC" onChange={(e) => setSignoff(e.target.value)} />

        <Button
          type="button"
          size="sm"
          disabled={!dirty || busy !== null}
          onClick={() => run('settings', () => saveReputationSettings({ alertsEnabled: alerts, alertMaxRating: maxRating, brandVoice: voice, signoff }), 'Settings saved.')}
        >
          {busy === 'settings' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />} Save settings
        </Button>
      </Card>
    </div>
  );
}
