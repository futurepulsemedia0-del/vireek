import { useEffect, useState } from 'react';
import { Link2, Plug, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { errorMessage } from '@/lib/commissions';
import { Dialog, StatusPill } from '@/components/commissions/shared';
import {
  PAYROLL_PROVIDERS,
  PROVIDER_META,
  disconnectProvider,
  isProviderLive,
  normalizeSettings,
  saveSettings,
  startConnect,
  type PayrollConnection,
  type PayrollProvider,
} from '@/lib/payrollSync';

function SettingsForm({ connection, onSaved }: { connection: PayrollConnection; onSaved: () => void }) {
  const { toast } = useToast();
  const initial = normalizeSettings(connection.settings);
  const [s, setS] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => setS(normalizeSettings(connection.settings)), [connection.settings]);

  const save = async () => {
    setBusy(true);
    try {
      await saveSettings(connection.id, s);
      toast('Settings saved.', 'success');
      onSaved();
    } catch (e) {
      toast(errorMessage(e, 'Could not save settings.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 border-t border-border p-4">
      <p className="text-xs text-text-secondary">These must match the pay-line names on your payroll in {PROVIDER_META[connection.provider].label} exactly (not case sensitive).</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Input label="Regular hours name" value={s.regular_name} maxLength={60} onChange={(e) => setS({ ...s, regular_name: e.target.value })} />
        <Input label="Overtime name" value={s.overtime_name} maxLength={60} onChange={(e) => setS({ ...s, overtime_name: e.target.value })} />
        <Input label="Commission name" value={s.commission_name} maxLength={60} onChange={(e) => setS({ ...s, commission_name: e.target.value })} />
      </div>
      <label className="flex items-start gap-2 text-sm text-text-primary">
        <input type="checkbox" className="mt-1" checked={s.require_separate_approver} onChange={(e) => setS({ ...s, require_separate_approver: e.target.checked })} />
        <span>Require a different person to approve than the one who submitted<span className="block text-xs text-text-secondary">Recommended once you have more than one admin.</span></span>
      </label>
      <Button size="sm" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</Button>
    </div>
  );
}

export function ConnectionTab({ connections, onChanged }: { connections: PayrollConnection[]; onChanged: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<PayrollProvider | null>(null);
  const [confirm, setConfirm] = useState<PayrollConnection | null>(null);

  const connect = async (provider: PayrollProvider) => {
    setBusy(provider);
    try {
      const { url } = await startConnect(provider);
      window.location.assign(url);
    } catch (e) {
      toast(errorMessage(e, 'Could not start the connection.'), 'error');
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (!confirm) return;
    setBusy(confirm.provider);
    try {
      const n = await disconnectProvider(confirm.id);
      toast(n > 0 ? `Disconnected. ${n} unsent batch${n === 1 ? ' was' : 'es were'} cancelled.` : 'Disconnected.', 'success');
      setConfirm(null);
      onChanged();
    } catch (e) {
      toast(errorMessage(e, 'Could not disconnect.'), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="flex items-start gap-3 border-warning-500/30 p-4 hover:translate-y-0" role="note">
        <TriangleAlert size={18} className="mt-0.5 shrink-0 text-warning-500" />
        <p className="text-sm text-text-secondary">
          <strong className="text-text-primary">Not live-verified.</strong> The Gusto connector is built from Gusto’s public API and covered by mock tests only. Test it against a Gusto demo company before using it with real payroll. Vireek only fills hours and commissions on an open payroll; you always review and run payroll in the provider.
        </p>
      </Card>

      {PAYROLL_PROVIDERS.map((p) => {
        const meta = PROVIDER_META[p];
        const conn = connections.find((c) => c.provider === p && c.status !== 'disconnected');
        const live = isProviderLive(p);
        return (
          <Card key={p} className="p-0 hover:translate-y-0">
            <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"><Plug size={18} /></span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-text-primary">{meta.label}</p>
                  <p className="text-xs text-text-secondary">{meta.summary}</p>
                  <p className="mt-1 text-xs text-text-secondary">{meta.note}</p>
                  {conn && (
                    <p className="mt-1 text-xs text-text-secondary">
                      {conn.company_name ?? 'Connected company'} · {conn.environment === 'sandbox' ? 'Demo environment' : 'Production'}
                      {conn.last_error ? ` · ${conn.last_error}` : ''}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {conn ? <StatusPill tone={conn.status === 'connected' ? 'success' : 'danger'}>{conn.status === 'connected' ? 'Connected' : 'Needs reconnecting'}</StatusPill> : !live && <StatusPill tone="neutral">Planned</StatusPill>}
                {live && (!conn || conn.status === 'error') && (
                  <Button size="sm" disabled={busy !== null} onClick={() => void connect(p)}><Link2 size={14} /> {busy === p ? 'Opening…' : conn ? 'Reconnect' : 'Connect'}</Button>
                )}
                {conn && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirm(conn)}>Disconnect</Button>}
              </div>
            </div>
            {conn && conn.status === 'connected' && <SettingsForm connection={conn} onSaved={onChanged} />}
          </Card>
        );
      })}

      <Dialog
        open={confirm !== null}
        danger
        title="Disconnect payroll provider"
        description="Stored access is deleted and unsent batches are cancelled. Anything already sent stays in the provider and in your history."
        onClose={() => setConfirm(null)}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button size="sm" disabled={busy !== null} onClick={() => void disconnect()}>{busy ? 'Disconnecting…' : 'Disconnect'}</Button>
          </>
        }
      >
        <p className="text-sm text-text-secondary">You can reconnect at any time; employee links are kept if you reconnect the same company.</p>
      </Dialog>
    </div>
  );
}
