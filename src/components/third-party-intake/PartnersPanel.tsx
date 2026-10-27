import { useState } from 'react';
import { Copy, Handshake, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SelectField } from '@/components/work-orders/WorkOrderForm';
import {
  buildCurlExample,
  buildIntakeEmailAlias,
  buildIntakeUrl,
  describeIntakeError,
  EMPTY_PAYER_FORM,
  PAYER_KIND_LABELS,
  PAYER_KIND_OPTIONS,
  payerToForm,
  toPayerPayload,
  validatePayerForm,
  type Payer,
  type PayerFormErrors,
  type PayerFormValues,
} from '@/lib/thirdPartyIntake';
import { deletePayer, rotatePayerToken, savePayer } from '@/lib/thirdPartyIntakeApi';

interface Props {
  userId: string;
  payers: Payer[];
  inboundToken: string | null;
  onChange: (next: Payer[]) => void;
}

type Editing = { id: string | null; values: PayerFormValues } | null;

export function PartnersPanel({ userId, payers, inboundToken, onChange }: Props) {
  const { toast } = useToast();
  const [editing, setEditing] = useState<Editing>(null);
  const [errors, setErrors] = useState<PayerFormErrors>({});
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState<Payer | null>(null);
  const [removing, setRemoving] = useState<Payer | null>(null);

  const url = buildIntakeUrl(import.meta.env.VITE_SUPABASE_URL as string | undefined);
  const domain = import.meta.env.VITE_INBOUND_EMAIL_DOMAIN as string | undefined;

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`, 'success');
    } catch {
      toast('Copy failed. Select the text and copy it manually.', 'error');
    }
  };

  const setField = <K extends keyof PayerFormValues>(k: K, v: PayerFormValues[K]) =>
    setEditing((e) => (e ? { ...e, values: { ...e.values, [k]: v } } : e));

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (!editing || saving) return;
    const errs = validatePayerForm(editing.values);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    try {
      const saved = await savePayer(userId, editing.id, toPayerPayload(editing.values));
      onChange(editing.id ? payers.map((p) => (p.id === saved.id ? saved : p)) : [...payers, saved].sort((a, b) => a.name.localeCompare(b.name)));
      toast(editing.id ? 'Partner updated. New requests use the new SLA.' : 'Partner added', 'success');
      setEditing(null);
    } catch (err) {
      toast(describeIntakeError(err as { code?: string; message?: string }), 'error');
    } finally {
      setSaving(false);
    }
  };

  const rotate = async () => {
    if (!rotating) return;
    try {
      const saved = await rotatePayerToken(userId, rotating.id);
      onChange(payers.map((p) => (p.id === saved.id ? saved : p)));
      toast('New token created. The old one stopped working.', 'success');
    } catch (err) {
      toast(describeIntakeError(err as { code?: string; message?: string }), 'error');
    } finally {
      setRotating(null);
    }
  };

  const remove = async () => {
    if (!removing) return;
    try {
      await deletePayer(userId, removing.id);
      onChange(payers.filter((p) => p.id !== removing.id));
      toast('Partner removed. Existing requests are kept.', 'success');
    } catch (err) {
      toast(describeIntakeError(err as { code?: string; message?: string }), 'error');
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="space-y-4">
      {!editing && (
        <div className="flex justify-end">
          <Button type="button" size="sm" className="w-full sm:w-auto" onClick={() => { setErrors({}); setEditing({ id: null, values: EMPTY_PAYER_FORM }); }}>
            <Plus size={16} aria-hidden="true" /> Add partner
          </Button>
        </div>
      )}

      {editing && (
        <Card className="!p-5">
          <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
            <h2 className="text-base font-semibold text-text-primary">{editing.id ? 'Edit partner' : 'New partner'}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Partner name" required value={editing.values.name} error={errors.name} onChange={(e) => setField('name', e.target.value)} />
              <SelectField label="Type" value={editing.values.kind} options={PAYER_KIND_OPTIONS} onChange={(v) => setField('kind', v as PayerFormValues['kind'])} />
              <Input
                label="Email alias tag"
                value={editing.values.emailTag}
                error={errors.emailTag}
                helperText="Adds +tag to your intake address. The most secure way to identify this partner."
                onChange={(e) => setField('emailTag', e.target.value)}
              />
              <Input
                label="Sender domains"
                value={editing.values.senderDomains}
                error={errors.senderDomains}
                helperText="Optional, comma separated. Emails from these domains are flagged for review."
                onChange={(e) => setField('senderDomains', e.target.value)}
              />
            </div>
            <fieldset className="grid gap-3 sm:grid-cols-3">
              <legend className="mb-1.5 text-sm font-medium text-text-primary">Service levels</legend>
              <Input label="Respond within (minutes)" inputMode="numeric" value={editing.values.acceptMinutes} error={errors.acceptMinutes} onChange={(e) => setField('acceptMinutes', e.target.value)} />
              <Input label="Schedule within (hours)" inputMode="numeric" value={editing.values.scheduleHours} error={errors.scheduleHours} onChange={(e) => setField('scheduleHours', e.target.value)} />
              <Input label="Complete within (hours)" inputMode="numeric" value={editing.values.completeHours} error={errors.completeHours} onChange={(e) => setField('completeHours', e.target.value)} />
            </fieldset>
            <Input label="Default not-to-exceed (USD, optional)" inputMode="decimal" value={editing.values.defaultNte} error={errors.defaultNte} onChange={(e) => setField('defaultNte', e.target.value)} />
            <label className="flex items-start gap-2 text-sm text-text-primary">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={editing.values.requireAuthorization} onChange={(e) => setField('requireAuthorization', e.target.checked)} />
              <span>Require the partner’s authorization before work can be scheduled or completed</span>
            </label>
            <label className="flex items-start gap-2 text-sm text-text-primary">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={editing.values.enabled} onChange={(e) => setField('enabled', e.target.checked)} />
              <span>Accept new requests from this partner</span>
            </label>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={() => setEditing(null)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={saving}>{saving ? 'Saving…' : 'Save partner'}</Button>
            </div>
          </form>
        </Card>
      )}

      {payers.length === 0 && !editing ? (
        <EmptyState
          icon={Handshake}
          title="Add your first partner"
          description="Add each warranty or insurance company you work for. You get a private API token and an email address for them, plus their own response and completion deadlines."
          action={{ label: 'Add partner', onClick: () => { setErrors({}); setEditing({ id: null, values: EMPTY_PAYER_FORM }); } }}
        />
      ) : (
        payers.map((p) => {
          const alias = buildIntakeEmailAlias(inboundToken, domain, p.email_tag);
          return (
            <Card key={p.id} className="!p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold text-text-primary">{p.name}</h3>
                  <p className="mt-0.5 text-xs text-text-secondary">
                    {PAYER_KIND_LABELS[p.kind]} · respond {p.accept_within_minutes} min · schedule {p.schedule_within_hours} h · complete {p.complete_within_hours} h
                    {p.require_authorization ? ' · authorization required' : ''}{p.enabled ? '' : ' · paused'}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button type="button" variant="ghost" size="sm" aria-label={`Edit ${p.name}`} onClick={() => { setErrors({}); setEditing({ id: p.id, values: payerToForm(p) }); }}>
                    <Pencil size={15} aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="ghost" size="sm" aria-label={`Rotate token for ${p.name}`} onClick={() => setRotating(p)}>
                    <KeyRound size={15} aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${p.name}`} className="text-danger" onClick={() => setRemoving(p)}>
                    <Trash2 size={15} aria-hidden="true" />
                  </Button>
                </div>
              </div>

              <div className="mt-4 space-y-3 text-sm">
                <CopyRow label="API endpoint" value={url} onCopy={() => void copy(url, 'Endpoint')} />
                <CopyRow label="Token (send as X-Vireek-Token)" value={p.intake_token} onCopy={() => void copy(p.intake_token, 'Token')} />
                {alias ? (
                  <CopyRow label="Email address for this partner" value={alias} onCopy={() => void copy(alias, 'Email address')} />
                ) : (
                  <p className="text-xs text-text-secondary">Email intake needs the inbound email domain to be configured.</p>
                )}
                <details className="text-xs text-text-secondary">
                  <summary className="focus-ring cursor-pointer rounded font-medium">Example request</summary>
                  <pre className="mt-2 overflow-auto whitespace-pre rounded-xl bg-bg-tertiary p-3">{buildCurlExample(url, p.intake_token)}</pre>
                  <Button type="button" variant="ghost" size="sm" className="mt-1" onClick={() => void copy(buildCurlExample(url, p.intake_token), 'Example')}>
                    <Copy size={14} aria-hidden="true" /> Copy example
                  </Button>
                </details>
              </div>
            </Card>
          );
        })
      )}

      <ConfirmDialog
        open={Boolean(rotating)}
        title="Create a new token?"
        description={`The current token for ${rotating?.name ?? 'this partner'} stops working immediately. Send them the new one.`}
        confirmLabel="Create new token"
        onConfirm={rotate}
        onCancel={() => setRotating(null)}
      />
      <ConfirmDialog
        open={Boolean(removing)}
        title="Remove this partner?"
        description="Their token and email address stop working. Existing requests and work orders are kept."
        confirmPhrase={removing?.name ?? undefined}
        confirmLabel="Remove partner"
        onConfirm={remove}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}

function CopyRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <div>
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-bg-tertiary px-3 py-2 text-xs text-text-primary">{value}</code>
        <Button type="button" variant="secondary" size="sm" aria-label={`Copy ${label}`} onClick={onCopy}>
          <Copy size={14} aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
