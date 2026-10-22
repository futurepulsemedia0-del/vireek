import { useState } from 'react';
import { Copy, KeyRound, ShieldCheck } from 'lucide-react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import {
  fetchEncryptionPolicy, fetchKeys, fetchSealedCounts, keySetupInfo, registerKey, revalidateKey, revokeKey,
  rewrapKeys, saveEncryptionPolicy, type EncryptionPolicy, type KeyRow,
} from '@/lib/trustPack/api';
import { parseKmsArn } from '@/lib/trustPack/kms';
import { regionLabel } from '@/lib/trustPack/regions';
import { Badge, Card, Field, PanelError, PanelSkeleton, Spinner, fmtDate, inputClass, useLoader, type Tone } from './ui';

const KEY_TONE: Record<KeyRow['status'], Tone> = { active: 'ok', pending: 'warn', retired: 'neutral', revoked: 'bad' };

export function EncryptionPanel({ ownerId, isOwner }: { ownerId: string; isOwner: boolean }) {
  const { toast } = useToast();
  const { data, status, error, reload, retry } = useLoader(async () => {
    const [keys, policy, counts, setup] = await Promise.all([
      fetchKeys(ownerId), fetchEncryptionPolicy(ownerId), fetchSealedCounts(ownerId),
      isOwner ? keySetupInfo().catch(() => ({ configured: false, principalArn: null, policyStatement: null })) : Promise.resolve(null),
    ]);
    return { keys, policy, counts, setup };
  });

  const [arn, setArn] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<KeyRow | null>(null);

  if (status === 'loading') return <PanelSkeleton />;
  if (status === 'error' || !data) return <PanelError message={error || 'Could not load encryption settings.'} onRetry={retry} />;

  const active = data.keys.find((k) => k.status === 'active');
  const arnTrim = arn.trim();
  const arnError = arnTrim && !parseKmsArn(arnTrim) ? 'Use the format arn:aws:kms:<region>:<12-digit account>:key/<id>' : undefined;
  const itemsByKey = (id: string) => Object.values(data.counts).reduce((s, r) => s + (r.byKey[id] ?? 0), 0);

  async function run(tag: string, fn: () => Promise<string | void>, okMsg: string) {
    setBusy(tag);
    try { const msg = await fn(); toast(msg || okMsg, 'success'); await reload(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Something went wrong.', 'error'); await reload(); }
    finally { setBusy(null); }
  }

  async function rewrapAll(from: KeyRow) {
    if (!active) return;
    let total = 0;
    for (let i = 0; i < 200; i++) { // bounded: 200 batches of 100
      const r = await rewrapKeys(from.id, active.id);
      total += r.rewrapped;
      if (r.remaining === 0) return `Re-encrypted ${total} item(s) under your new key.`;
      if (r.rewrapped === 0) throw new Error(`${r.remaining} item(s) could not be re-encrypted. Keep the old key enabled and try again.`);
    }
    return `Re-encrypted ${total} item(s). Run it again to finish.`;
  }

  const togglePolicy = (patch: Partial<EncryptionPolicy>) =>
    run('policy', () => saveEncryptionPolicy(ownerId, { ...data.policy, ...patch }), 'Encryption settings saved');

  const policyJson = data.setup?.policyStatement ? JSON.stringify(data.setup.policyStatement, null, 2) : '';

  return (
    <div className="space-y-6">
      <Card title="Customer-managed encryption key" icon={KeyRound} aside={active ? <Badge tone="ok">Active</Badge> : <Badge>Not set up</Badge>}>
        <p className="text-sm text-text-secondary">
          Your data is encrypted with keys you control in AWS KMS. If you disable the key or remove Vireek’s access, sealed data becomes unreadable immediately.
        </p>

        {isOwner && data.setup && !data.setup.configured && (
          <p role="alert" className="mt-4 rounded-xl bg-amber-500/5 p-3 text-sm text-text-secondary">Customer-managed keys are not enabled on this deployment yet. Contact support to turn them on.</p>
        )}

        {isOwner && data.setup?.configured && (
          <div className="mt-4 space-y-4">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-text-secondary">
              <li>Create a symmetric KMS key in your AWS account.</li>
              <li>Add this statement to the key policy (it limits access to your account only).</li>
              <li>Paste the key ARN below — we verify access before turning anything on.</li>
            </ol>
            <div className="relative">
              <pre className="max-h-56 overflow-auto rounded-xl bg-bg-tertiary p-3 text-xs text-text-primary">{policyJson}</pre>
              <Button size="sm" variant="ghost" className="absolute right-2 top-2" aria-label="Copy key policy statement"
                onClick={() => { void navigator.clipboard?.writeText(policyJson).then(() => toast('Copied', 'success')).catch(() => toast('Could not copy', 'error')); }}>
                <Copy size={14} aria-hidden />
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Key ARN" error={arnError}>
                <input className={inputClass} value={arn} onChange={(e) => setArn(e.target.value)} placeholder="arn:aws:kms:eu-central-1:123456789012:key/…" autoComplete="off" spellCheck={false} />
              </Field>
              <Field label="Label (optional)">
                <input className={inputClass} value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder="Production key" />
              </Field>
            </div>
            <Button size="sm" disabled={!arnTrim || !!arnError || busy !== null}
              onClick={() => run('register', async () => { await registerKey(arnTrim, label); setArn(''); setLabel(''); }, active ? 'New key active — re-encrypt existing data to finish rotating' : 'Key verified and active')}>
              {busy === 'register' ? <Spinner /> : null} {active ? 'Rotate to this key' : 'Verify and activate'}
            </Button>
          </div>
        )}

        <h3 className="mt-6 text-sm font-semibold text-text-primary">Keys</h3>
        {data.keys.length === 0 ? (
          <p className="mt-2 text-sm text-text-secondary">No keys registered yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border">
            {data.keys.map((k) => {
              const n = itemsByKey(k.id);
              return (
                <li key={k.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-primary">
                      {k.label || 'Key'} <Badge tone={KEY_TONE[k.status]}>{k.status}</Badge>
                      {k.last_error && <Badge tone="bad">last check failed</Badge>}
                    </p>
                    <p className="truncate text-xs text-text-secondary" title={k.key_arn}>{k.key_arn}</p>
                    <p className="text-xs text-text-secondary">Checked {fmtDate(k.last_validated_at)} · {n} sealed item(s)</p>
                  </div>
                  {isOwner && k.status !== 'revoked' && (
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => run(`v${k.id}`, async () => {
                        const r = await revalidateKey(k.id);
                        if (!r.ok) throw new Error(r.error || 'Key check failed.');
                      }, 'Key access verified')}>{busy === `v${k.id}` ? <Spinner /> : null} Verify</Button>
                      {k.status === 'retired' && active && n > 0 && (
                        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => run(`r${k.id}`, () => rewrapAll(k), 'Re-encrypted')}>
                          {busy === `r${k.id}` ? <Spinner /> : null} Re-encrypt {n}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setRevokeTarget(k)}>Revoke</Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="What gets sealed" icon={ShieldCheck}>
        <div className="space-y-3">
          {([
            ['seal_recordings', 'Call recordings', 'Archived as encrypted files in your region.'],
            ['seal_transcripts', 'Call transcripts', 'Stored as ciphertext; opened on demand with your key.'],
          ] as const).map(([k, title, desc]) => (
            <label key={k} className="flex items-start justify-between gap-4 rounded-xl border border-border p-4">
              <span>
                <span className="block text-sm font-medium text-text-primary">{title}</span>
                <span className="block text-xs text-text-secondary">{desc}</span>
              </span>
              <input type="checkbox" className="mt-1 h-5 w-5 accent-[rgb(var(--accent-primary))]" checked={data.policy[k]}
                disabled={!isOwner || !active || busy !== null} onChange={(e) => togglePolicy({ [k]: e.target.checked })} aria-label={title} />
            </label>
          ))}
        </div>
        {!active && <p className="mt-3 text-xs text-text-secondary">Register a key to turn encryption on.</p>}
        <p className="mt-3 text-xs text-text-secondary">If your key becomes unavailable, new transcripts are withheld rather than stored unprotected, and recordings stay at their original link until archiving succeeds.</p>
        {Object.keys(data.counts).length > 0 && (
          <ul className="mt-4 text-xs text-text-secondary">
            {Object.entries(data.counts).map(([region, c]) => <li key={region}>{regionLabel(region)}: {c.total} sealed item(s)</li>)}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={!!revokeTarget}
        title="Revoke this key?"
        description="Vireek will stop using it. Data sealed with it stays encrypted but cannot be opened until you re-encrypt it under another key — do that first if you still need access."
        confirmPhrase="revoke key"
        confirmLabel="Revoke key"
        onCancel={() => setRevokeTarget(null)}
        onConfirm={async () => { const k = revokeTarget; setRevokeTarget(null); if (k) await run(`x${k.id}`, async () => { await revokeKey(k.id); }, 'Key revoked'); }}
      />
    </div>
  );
}
