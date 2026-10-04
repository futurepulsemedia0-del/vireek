import { useState } from 'react';
import { Copy, Link2, Plug, Unplug } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { ageLabel, telematicsConnect, type TelematicsConnection, type TelematicsSettings } from '@/lib/telematics';

interface Props {
  connections: TelematicsConnection[];
  onChanged: () => void | Promise<void>;
}

const INPUT = 'w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';
const BTN = 'focus-ring rounded-lg px-3 py-2 text-xs font-medium disabled:opacity-60';

export function TelematicsConnectPanel({ connections, onChanged }: Props) {
  const { toast } = useToast();
  const [apiToken, setApiToken] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ url: string; token: string } | null>(null);

  const samsara = connections.find((c) => c.provider === 'samsara');
  const webhook = connections.find((c) => c.provider === 'webhook');

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } finally { setBusy(null); }
  };

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast('Copied.', 'success'); } catch { toast('Copy failed — select and copy manually.', 'error'); }
  };

  const connectSamsara = (e: React.FormEvent) => {
    e.preventDefault();
    void run('samsara', async () => {
      const r = await telematicsConnect('connect_samsara', { api_token: apiToken });
      if (r.error) { toast(r.error, 'error'); return; }
      setApiToken('');
      if (r.ingest_token && r.ingest_url) setReveal({ url: r.ingest_url, token: r.ingest_token });
      toast(`Connected. ${r.linked ?? 0} vehicles matched, ${r.created ?? 0} added.`, 'success');
      await onChanged();
    });
  };

  const createWebhook = () => run('webhook', async () => {
    const r = await telematicsConnect('create_webhook');
    if (r.error || !r.ingest_token || !r.ingest_url) { toast(r.error ?? 'Could not create webhook.', 'error'); return; }
    setReveal({ url: r.ingest_url, token: r.ingest_token });
    await onChanged();
  });

  const rotate = (id: string) => run(`rotate-${id}`, async () => {
    const r = await telematicsConnect('rotate_token', { connection_id: id });
    if (r.error || !r.ingest_token || !r.ingest_url) { toast(r.error ?? 'Could not rotate.', 'error'); return; }
    setReveal({ url: r.ingest_url, token: r.ingest_token });
    toast('Token rotated — the old one stopped working.', 'success');
  });

  const saveSecret = (e: React.FormEvent) => {
    e.preventDefault();
    if (!samsara) return;
    void run('secret', async () => {
      const r = await telematicsConnect('set_webhook_secret', { connection_id: samsara.id, secret });
      if (r.error) { toast(r.error, 'error'); return; }
      setSecret('');
      toast('Webhook secret saved.', 'success');
    });
  };

  const disconnect = (id: string) => {
    if (!window.confirm('Disconnect this telematics source? Stored credentials are deleted. History is kept.')) return;
    void run(`dc-${id}`, async () => {
      const r = await telematicsConnect('disconnect', { connection_id: id });
      if (r.error) { toast(r.error, 'error'); return; }
      await onChanged();
    });
  };

  const toggleAutoAdvance = (c: TelematicsConnection) => run(`set-${c.id}`, async () => {
    const settings: TelematicsSettings = { ...c.settings, auto_advance_job_status: !c.settings.auto_advance_job_status };
    const r = await telematicsConnect('save_settings', { connection_id: c.id, settings });
    if (r.error) { toast(r.error, 'error'); return; }
    await onChanged();
  });

  const row = (c: TelematicsConnection) => (
    <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary p-4">
      <div>
        <p className="text-sm font-semibold capitalize text-text-primary">{c.provider === 'webhook' ? 'Generic webhook' : c.provider}</p>
        <p className={`text-xs ${c.status === 'error' ? 'text-danger-500' : 'text-text-secondary'}`}>
          {c.status === 'error' ? c.last_error ?? 'Connection error' : `Connected · last data ${ageLabel(c.last_sync_at)}`}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-text-secondary">
          <input type="checkbox" checked={c.settings.auto_advance_job_status} onChange={() => void toggleAutoAdvance(c)} disabled={busy === `set-${c.id}`} />
          Auto-start job on GPS arrival
        </label>
        <button type="button" onClick={() => void rotate(c.id)} disabled={busy === `rotate-${c.id}`} className={`${BTN} border border-border text-text-secondary hover:text-text-primary`}>Rotate token</button>
        <button type="button" onClick={() => disconnect(c.id)} disabled={busy === `dc-${c.id}`} className={`${BTN} border border-border text-danger-500`}><Unplug size={12} className="mr-1 inline" />Disconnect</button>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {reveal && (
        <div role="alert" className="rounded-2xl border border-warning-500/40 bg-warning-500/10 p-4 text-sm">
          <p className="font-semibold text-text-primary">Save this token now — it is shown only once.</p>
          <div className="mt-3 space-y-2">
            {[['Endpoint', reveal.url], ['Token', reveal.token]].map(([k, v]) => (
              <div key={k} className="flex items-center gap-2">
                <span className="w-16 text-xs text-text-secondary">{k}</span>
                <code className="min-w-0 flex-1 truncate rounded bg-bg-primary px-2 py-1 text-xs text-text-primary">{v}</code>
                <button type="button" aria-label={`Copy ${k}`} onClick={() => void copy(v)} className={`${BTN} border border-border`}><Copy size={12} /></button>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-text-secondary">Samsara alert webhooks: use <code>endpoint?t=TOKEN&amp;provider=samsara</code>, then paste Samsara's signing secret below.</p>
          <button type="button" onClick={() => setReveal(null)} className={`${BTN} mt-3 bg-accent text-white`}>I saved it</button>
        </div>
      )}

      {[samsara, webhook].filter((c): c is TelematicsConnection => !!c).map(row)}

      {!samsara && (
        <form onSubmit={connectSamsara} className="rounded-2xl border border-border bg-bg-secondary p-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><Plug size={16} className="text-accent" /> Connect Samsara</h3>
          <p className="mt-1 text-xs text-text-secondary">Create a read-only API token in Samsara (Settings → API Tokens) with <em>Vehicles</em> and <em>Vehicle Statistics</em> read scopes. We encrypt it at rest and never show it again.</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input type="password" autoComplete="off" value={apiToken} onChange={(e) => setApiToken(e.target.value)} placeholder="Samsara API token" required minLength={20} className={INPUT} />
            <button type="submit" disabled={busy === 'samsara'} className={`${BTN} shrink-0 bg-accent text-white`}>{busy === 'samsara' ? 'Connecting…' : 'Connect'}</button>
          </div>
        </form>
      )}

      {samsara && (
        <form onSubmit={saveSecret} className="rounded-2xl border border-border bg-bg-secondary p-5">
          <h3 className="text-sm font-semibold text-text-primary">Samsara alert webhook secret (safety events)</h3>
          <p className="mt-1 text-xs text-text-secondary">Needed only for harsh-braking / speeding / collision alerts. Position, odometer, fuel and arrival detection work without it.</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Signing secret (base64)" required className={INPUT} />
            <button type="submit" disabled={busy === 'secret'} className={`${BTN} shrink-0 border border-border text-text-primary`}>Save secret</button>
          </div>
        </form>
      )}

      {!webhook && (
        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><Link2 size={16} className="text-accent" /> Generic webhook (Geotab, custom gateway, Zapier)</h3>
          <p className="mt-1 text-xs text-text-secondary">Push normalized JSON positions, events and faults from any telematics system. Map each device id to a vehicle from the Fleet Economics roster.</p>
          <button type="button" onClick={() => void createWebhook()} disabled={busy === 'webhook'} className={`${BTN} mt-3 bg-accent text-white`}>{busy === 'webhook' ? 'Creating…' : 'Create webhook endpoint'}</button>
        </div>
      )}
    </div>
  );
}
