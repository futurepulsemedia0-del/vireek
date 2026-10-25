import { useState } from 'react';
import { Check, Copy, KeyRound, RefreshCw, ShieldCheck, TriangleAlert as AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import { maskToken, normalizeAddress, validateAddress, webhookUrl, type DirectMailSettings } from '@/lib/directMail';
import { saveReturnAddress, updateProvider } from '@/lib/directMailApi';

interface Props {
  settings: DirectMailSettings;
  onChange: (next: DirectMailSettings | null) => void;
  onReload: () => void;
}

export function SetupPanel({ settings, onChange, onReload }: Props) {
  const { toast } = useToast();
  const ra = settings.return_address;
  const [apiKey, setApiKey] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [copied, setCopied] = useState(false);
  const [addr, setAddr] = useState({
    name: ra?.name ?? '', line1: ra?.line1 ?? '', line2: ra?.line2 ?? '', city: ra?.city ?? '', state: ra?.state ?? '', zip: ra?.zip ?? '',
  });
  const [addrErrors, setAddrErrors] = useState<string[]>([]);

  const hookUrl = webhookUrl(String(import.meta.env.VITE_SUPABASE_URL ?? ''), settings.webhook_token);

  const run = async (key: string, action: () => Promise<void>, success: string) => {
    setBusy(key);
    try {
      await action();
      toast(success, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong. Please try again.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const saveKey = () =>
    run('key', async () => {
      const next = await updateProvider({ action: 'save_key', api_key: apiKey.trim(), ...(secret.trim() ? { webhook_secret: secret.trim() } : {}) });
      setApiKey('');
      setSecret('');
      if (next) onChange(next); else onReload();
    }, 'Print provider connected.');

  const saveAddress = () => {
    const normalized = normalizeAddress(addr);
    const problems = validateAddress(normalized).filter((p) => p !== 'name_required' || !normalized.name);
    setAddrErrors(problems);
    if (problems.length) return;
    void run('addr', async () => {
      await saveReturnAddress(normalized, settings.default_landing_page_id);
      onReload();
    }, 'Return address saved.');
  };

  const copyHook = async () => {
    try {
      await navigator.clipboard.writeText(hookUrl);
      setCopied(true);
      toast('Webhook URL copied.', 'success');
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('Could not copy automatically — select the URL and copy it.', 'error');
    }
  };

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-border bg-bg-secondary p-5 sm:p-6" aria-label="Print provider">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><KeyRound size={16} className="text-accent" /> Print provider (Lob)</h2>
            <p className="mt-1 text-xs text-text-secondary">Postcards are printed and mailed by Lob using your own account, so costs appear on your Lob invoice.</p>
          </div>
          {settings.configured ? (
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${settings.api_mode === 'live' ? 'bg-success/10 text-success' : 'bg-warning-500/10 text-warning-500'}`}>
              {settings.api_mode === 'live' ? 'Live' : 'Test mode'} · …{settings.api_key_last4}
            </span>
          ) : (
            <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-xs font-medium text-text-secondary">Not connected</span>
          )}
        </div>

        {settings.configured && settings.api_mode === 'test' && (
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-warning-500/30 bg-warning-500/5 p-3 text-xs text-text-secondary">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning-500" />
            <span>Test keys create PDF proofs only — nothing is printed or mailed and nothing is charged. Connect your <code>live_</code> key to mail real postcards.</span>
          </div>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Input label={settings.configured ? 'Replace API key' : 'Lob API key'} type="password" autoComplete="off" value={apiKey}
            onChange={(e) => setApiKey(e.target.value)} placeholder="test_… or live_…" helperText="Stored encrypted. It is never shown again." />
          <Input label="Webhook signing secret (optional now)" type="password" autoComplete="off" value={secret}
            onChange={(e) => setSecret(e.target.value)} placeholder="From Lob → Settings → Webhooks" />
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void saveKey()} disabled={busy !== null || apiKey.trim().length < 10}>
            <ShieldCheck size={14} /> {busy === 'key' ? 'Verifying…' : 'Verify & save'}
          </Button>
          {settings.configured && (
            <Button size="sm" variant="secondary" onClick={() => setConfirmClear(true)} disabled={busy !== null}>Disconnect</Button>
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-bg-secondary p-5 sm:p-6" aria-label="Delivery tracking webhook">
        <h2 className="text-sm font-semibold text-text-primary">Delivery tracking webhook</h2>
        <p className="mt-1 text-xs text-text-secondary">
          In Lob → Settings → Webhooks add this URL for the postcard events (mailed, in transit, delivered, returned to sender, failed), then paste the signing secret above.
          Without a secret every webhook is rejected.
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input readOnly value={hookUrl ? maskToken(hookUrl) : 'Save the API key first'} onFocus={(e) => e.currentTarget.select()} aria-label="Webhook URL"
            className="focus-ring min-w-0 flex-1 truncate rounded-xl border border-border bg-bg-primary px-3 py-2 font-mono text-xs text-text-primary" />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void copyHook()} disabled={!hookUrl}>{copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy URL'}</Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirmRotate(true)} disabled={!settings.configured || busy !== null}><RefreshCw size={14} /> New URL</Button>
          </div>
        </div>
        <p className="mt-2 text-xs text-text-secondary">Signing secret: {settings.webhook_secret_set ? <span className="text-success">saved</span> : <span className="text-warning-500">not set — delivery status will not update</span>}</p>
        {settings.configured && !settings.webhook_secret_set && (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Input label="Webhook signing secret" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
            <Button size="sm" className="sm:mt-6" disabled={busy !== null || secret.trim().length < 8}
              onClick={() => void run('secret', async () => { const n = await updateProvider({ action: 'save_webhook_secret', webhook_secret: secret.trim() }); setSecret(''); if (n) onChange(n); else onReload(); }, 'Signing secret saved.')}>
              Save secret
            </Button>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-bg-secondary p-5 sm:p-6" aria-label="Return address">
        <h2 className="text-sm font-semibold text-text-primary">Return address</h2>
        <p className="mt-1 text-xs text-text-secondary">Printed as the sender and used as the brand name on every postcard.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Input label="Business name" value={addr.name} onChange={(e) => setAddr({ ...addr, name: e.target.value })} maxLength={120} />
          <Input label="Street address" value={addr.line1} onChange={(e) => setAddr({ ...addr, line1: e.target.value })} maxLength={200} />
          <Input label="Suite / unit (optional)" value={addr.line2} onChange={(e) => setAddr({ ...addr, line2: e.target.value })} maxLength={200} />
          <Input label="City" value={addr.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} maxLength={100} />
          <Input label="State" value={addr.state} onChange={(e) => setAddr({ ...addr, state: e.target.value.toUpperCase() })} maxLength={2} />
          <Input label="ZIP" value={addr.zip} onChange={(e) => setAddr({ ...addr, zip: e.target.value })} maxLength={10} inputMode="numeric" />
        </div>
        {addrErrors.length > 0 && (
          <p role="alert" className="mt-3 text-xs text-danger">Check the address: {addrErrors.map((e) => e.replace('_', ' ')).join(', ')}.</p>
        )}
        <Button size="sm" className="mt-4" onClick={saveAddress} disabled={busy !== null}>{busy === 'addr' ? 'Saving…' : 'Save return address'}</Button>
      </section>

      <ConfirmDialog open={confirmClear} title="Disconnect Lob?" confirmLabel="Yes, disconnect"
        description="Your stored API key and webhook secret are deleted. Campaigns already mailed keep their history; new sends are blocked until you reconnect."
        onCancel={() => setConfirmClear(false)}
        onConfirm={async () => { setConfirmClear(false); await run('clear', async () => { const n = await updateProvider({ action: 'clear_key' }); if (n) onChange(n); else onReload(); }, 'Print provider disconnected.'); }} />
      <ConfirmDialog open={confirmRotate} title="Create a new webhook URL?" confirmLabel="Yes, create new URL"
        description="The current URL stops working immediately. Update the webhook in your Lob dashboard, or delivery tracking will stop."
        onCancel={() => setConfirmRotate(false)}
        onConfirm={async () => { setConfirmRotate(false); await run('rotate', async () => { const n = await updateProvider({ action: 'rotate_webhook_token' }); if (n) onChange(n); else onReload(); }, 'New webhook URL created.'); }} />
    </div>
  );
}
