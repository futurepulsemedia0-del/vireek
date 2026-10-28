import { useState } from 'react';
import { CheckCircle2, Loader2, Plug, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { StatusPill, Dialog } from '@/components/commissions/shared';
import { useToast } from '@/contexts/ToastContext';
import {
  PAYROLL_PROVIDERS,
  PROVIDER_META,
  defaultSettings,
  disconnectGusto,
  payrollErrorMessage,
  saveConnection,
  selectGustoCompany,
  startGustoOAuth,
  validateSettings,
  type ConnectorSettings,
  type PayrollConnection,
  type PayrollProvider,
} from '@/lib/payrollConnectors';

interface Props {
  connections: PayrollConnection[];
  onChanged: () => void;
  onGoToMapping: (provider: PayrollProvider) => void;
}

const EARNING_LABEL = {
  regular: 'Regular hours',
  overtime: 'Overtime hours',
  commission: 'Commission',
  tips: 'Tips',
} as const;

export function ConnectionsTab({ connections, onChanged, onGoToMapping }: Props) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {PAYROLL_PROVIDERS.map((p) => (
        <ProviderCard key={p} provider={p} connection={connections.find((c) => c.provider === p)} onChanged={onChanged} onGoToMapping={onGoToMapping} />
      ))}
    </div>
  );
}

function ProviderCard({ provider, connection, onChanged, onGoToMapping }: { provider: PayrollProvider; connection?: PayrollConnection; onChanged: () => void; onGoToMapping: (p: PayrollProvider) => void }) {
  const { toast } = useToast();
  const meta = PROVIDER_META[provider];
  const initial = (() => {
    const r = validateSettings(provider, connection?.settings ?? {});
    return r.ok ? r.settings : defaultSettings(provider);
  })();
  const [settings, setSettings] = useState<ConnectorSettings>(initial);
  const [busy, setBusy] = useState<'save' | 'connect' | 'disconnect' | 'company' | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [companyId, setCompanyId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const isApi = connection?.mode === 'api';
  const needsCompany = isApi && !connection?.external_company_id;
  const companies = connection?.meta?.companies ?? [];
  const dirty = JSON.stringify(settings) !== JSON.stringify(initial);

  async function run(kind: NonNullable<typeof busy>, fn: () => Promise<void>, ok?: string) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      if (ok) toast(ok, 'success');
      onChanged();
    } catch (e) {
      const msg = payrollErrorMessage(e, 'Something went wrong.');
      setError(msg);
      toast(msg, 'error');
    } finally {
      setBusy(null);
    }
  }

  function save() {
    const v = validateSettings(provider, settings);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    void run('save', async () => void (await saveConnection(provider, v.settings)), connection ? 'Settings saved.' : `${meta.label} is set up. Next, map your employees.`);
  }

  return (
    <Card className="flex flex-col gap-4 p-5 hover:translate-y-0">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-text-primary">{meta.label}</h2>
          <p className="mt-1 text-xs text-text-secondary">{meta.tagline}</p>
        </div>
        {!connection ? (
          <StatusPill tone="neutral">Not set up</StatusPill>
        ) : connection.status === 'error' ? (
          <StatusPill tone="danger">Needs attention</StatusPill>
        ) : isApi ? (
          <StatusPill tone="success">Connected</StatusPill>
        ) : (
          <StatusPill tone="info">File export</StatusPill>
        )}
      </div>

      {connection?.status === 'error' && connection.last_error && (
        <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{connection.last_error}</p>
      )}

      <ul className="list-disc space-y-1 pl-5 text-xs text-text-secondary">
        {meta.setup.map((s) => <li key={s}>{s}</li>)}
      </ul>

      {meta.needsCompanyCode && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="ADP company code" value={settings.adp.co_code} maxLength={6} onChange={(e) => setSettings((s) => ({ ...s, adp: { ...s.adp, co_code: e.target.value } }))} helperText="The 2-3 character code in your ADP import file." />
          <Input label="Batch ID prefix" value={settings.adp.batch_prefix} maxLength={4} onChange={(e) => setSettings((s) => ({ ...s, adp: { ...s.adp, batch_prefix: e.target.value } }))} helperText="Batch ID = prefix + period end (MMDD)." />
        </div>
      )}

      {meta.editableEarnings && (
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-text-primary">{provider === 'adp' ? 'Earnings codes' : 'Earning names'} in {meta.label}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {(provider === 'adp' ? (['commission', 'tips'] as const) : (['regular', 'overtime', 'commission', 'tips'] as const)).map((k) => (
              <Input key={k} label={EARNING_LABEL[k]} value={settings.earnings[k]} maxLength={40} onChange={(e) => setSettings((s) => ({ ...s, earnings: { ...s.earnings, [k]: e.target.value } }))} />
            ))}
          </div>
        </fieldset>
      )}

      {needsCompany && (
        <div className="space-y-3 rounded-xl border border-border p-3">
          <p className="text-sm font-medium text-text-primary">Choose the Gusto company to send payroll data to</p>
          {companies.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {companies.map((c) => (
                <Button key={c.id} variant="secondary" size="sm" disabled={busy !== null} onClick={() => void run('company', async () => void (await selectGustoCompany(connection!.id, c.id)), `${c.name} selected.`)}>{c.name}</Button>
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <Input label="Gusto company ID" value={companyId} onChange={(e) => setCompanyId(e.target.value)} placeholder="UUID from Gusto" />
              <Button variant="secondary" disabled={busy !== null || !companyId.trim()} onClick={() => void run('company', async () => void (await selectGustoCompany(connection!.id, companyId)), 'Company saved.')}>Save</Button>
            </div>
          )}
        </div>
      )}

      {isApi && connection?.external_company_id && (
        <p className="flex items-center gap-2 text-sm text-text-secondary">
          <CheckCircle2 size={16} className="text-success-500" aria-hidden="true" />
          {connection.company_name ?? 'Gusto company'} is connected{connection.environment === 'sandbox' ? ' (sandbox)' : ''}.
        </p>
      )}

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}

      <div className="mt-auto flex flex-wrap items-center gap-2">
        {(meta.editableEarnings || meta.needsCompanyCode || !connection) && (
          <Button variant={connection ? 'secondary' : 'primary'} size="sm" onClick={save} disabled={busy !== null || (!!connection && !dirty)}>
            {busy === 'save' && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {connection ? 'Save settings' : provider === 'gusto' ? 'Use file export' : 'Set up'}
          </Button>
        )}
        {meta.supportsApi && !isApi && (
          <Button size="sm" disabled={busy !== null} onClick={() => void run('connect', async () => { window.location.href = await startGustoOAuth(); })}>
            {busy === 'connect' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Plug size={14} aria-hidden="true" />}
            Connect Gusto
          </Button>
        )}
        {isApi && (
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirmDisconnect(true)}>
            <Unplug size={14} aria-hidden="true" /> Disconnect
          </Button>
        )}
        {connection && <Button variant="ghost" size="sm" onClick={() => onGoToMapping(provider)}>Map employees</Button>}
      </div>

      <Dialog
        open={confirmDisconnect}
        danger
        title="Disconnect Gusto?"
        description="Vireek forgets its Gusto access. Past exports, employee mapping and file export keep working. You can reconnect any time."
        onClose={() => setConfirmDisconnect(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDisconnect(false)}>Cancel</Button>
            <Button disabled={busy === 'disconnect'} onClick={() => void run('disconnect', async () => { await disconnectGusto(connection!.id); setConfirmDisconnect(false); }, 'Gusto disconnected.')}>
              {busy === 'disconnect' && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Disconnect
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-secondary">Exports already sent to Gusto are not affected.</p>
      </Dialog>
    </Card>
  );
}
