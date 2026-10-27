/**
 * Loyalty — program settings, earn rules and a live "what would this invoice earn?" preview.
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import { Dialog, Pill, SelectField, Toggle } from '@/components/loyalty/loyaltyUi';
import { createEarnRule, deleteEarnRule, saveSettings, updateEarnRule } from '@/lib/loyaltyApi';
import {
  EARN_KIND_OPTIONS,
  MAX_EARN_RULES,
  describeEarnRule,
  earnRuleToForm,
  earnRuleToPayload,
  emptyEarnRuleForm,
  formatMultiplier,
  formatPoints,
  previewEarn,
  sortTiers,
  validateEarnRule,
  validateSettings,
  type EarnRule,
  type EarnRuleForm,
  type FieldErrors,
  type LoyaltySettings,
  type LoyaltyTier,
} from '@/lib/loyalty';

interface Props {
  ownerId: string;
  settings: LoyaltySettings | null;
  rules: EarnRule[];
  tiers: LoyaltyTier[];
  onChanged: () => void;
}

export function ProgramPanel({ ownerId, settings, rules, tiers, onChanged }: Props) {
  const { toast } = useToast();

  // ----- settings -----
  const [enabled, setEnabled] = useState(settings?.is_enabled ?? false);
  const [name, setName] = useState(settings?.program_name ?? 'Rewards');
  const [label, setLabel] = useState(settings?.points_label ?? 'points');
  const [portal, setPortal] = useState(settings?.portal_redemption_enabled ?? true);
  const [savingSettings, setSavingSettings] = useState(false);
  const settingsErrors = validateSettings({ program_name: name, points_label: label, portal_redemption_enabled: portal });

  useEffect(() => {
    setEnabled(settings?.is_enabled ?? false);
    setName(settings?.program_name ?? 'Rewards');
    setLabel(settings?.points_label ?? 'points');
    setPortal(settings?.portal_redemption_enabled ?? true);
  }, [settings]);

  const dirty =
    !settings ||
    enabled !== settings.is_enabled ||
    name.trim() !== settings.program_name ||
    label.trim() !== settings.points_label ||
    portal !== settings.portal_redemption_enabled;

  const submitSettings = async () => {
    if (Object.keys(settingsErrors).length > 0) return;
    setSavingSettings(true);
    try {
      await saveSettings(ownerId, { is_enabled: enabled, program_name: name, points_label: label, portal_redemption_enabled: portal });
      toast('Program settings saved.', 'success');
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the program settings.', 'error');
    } finally {
      setSavingSettings(false);
    }
  };

  // ----- rule editor -----
  const [editing, setEditing] = useState<EarnRule | 'new' | null>(null);
  const [form, setForm] = useState<EarnRuleForm>(emptyEarnRuleForm());
  const [errors, setErrors] = useState<FieldErrors<EarnRuleForm>>({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<EarnRule | null>(null);

  const openEditor = (r: EarnRule | 'new') => {
    setEditing(r);
    setForm(r === 'new' ? emptyEarnRuleForm() : earnRuleToForm(r));
    setErrors({});
  };

  const submitRule = async () => {
    const e = validateEarnRule(form);
    setErrors(e);
    if (Object.keys(e).length > 0 || !editing) return;
    setSaving(true);
    try {
      const payload = earnRuleToPayload(form);
      if (editing === 'new') await createEarnRule(ownerId, payload);
      else await updateEarnRule(ownerId, editing.id, payload);
      toast(editing === 'new' ? 'Earn rule added.' : 'Earn rule updated.', 'success');
      setEditing(null);
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the earn rule.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteEarnRule(ownerId, deleting.id);
      toast('Earn rule deleted.', 'success');
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete the earn rule.', 'error');
    } finally {
      setDeleting(null);
    }
  };

  // ----- preview -----
  const [amount, setAmount] = useState('450');
  const [service, setService] = useState('');
  const [tierId, setTierId] = useState('');
  const orderedTiers = useMemo(() => sortTiers(tiers), [tiers]);
  const lifetime = orderedTiers.find((t) => t.id === tierId)?.min_lifetime_points ?? 0;
  const preview = previewEarn(rules, tiers, { amount: Number(amount), service, lifetime });
  const pointsLabel = (settings?.points_label ?? label) || 'points';

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-labelledby="loyalty-settings-title">
        <h2 id="loyalty-settings-title" className="text-base font-semibold text-text-primary">Program settings</h2>
        <div className="mt-4 space-y-4">
          <Toggle
            checked={enabled}
            onChange={setEnabled}
            label="Program is on"
            description="Customers earn points when an invoice is marked paid. Turn off to pause earning and redeeming."
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Program name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} error={settingsErrors.program_name} />
            <Input label="What are points called?" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={20} error={settingsErrors.points_label} helperText='For example "points" or "stars".' />
          </div>
          <Toggle
            checked={portal}
            onChange={setPortal}
            label="Let customers redeem from their portal"
            description="Redemptions still wait for your team to fulfill them."
          />
          <Button size="sm" onClick={() => void submitSettings()} disabled={savingSettings || !dirty || Object.keys(settingsErrors).length > 0}>
            {savingSettings && <Loader2 size={16} className="animate-spin" />} Save settings
          </Button>
        </div>
      </section>

      <section aria-labelledby="loyalty-rules-title" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="loyalty-rules-title" className="text-base font-semibold text-text-primary">Earn rules</h2>
            <p className="text-sm text-text-secondary">Every matching rule adds up, then the customer&apos;s tier multiplier applies. Up to {MAX_EARN_RULES} rules.</p>
          </div>
          <Button size="sm" onClick={() => openEditor('new')} disabled={rules.length >= MAX_EARN_RULES}>
            <Plus size={16} /> Add rule
          </Button>
        </div>

        {rules.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title="No earn rules yet"
            description="Without a rule, paid invoices earn nothing. Add one such as 1 point per dollar."
            action={{ label: 'Add earn rule', onClick: () => openEditor('new') }}
          />
        ) : (
          <ul className="space-y-2">
            {rules.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-bg-secondary p-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-text-primary">{r.name}</p>
                  <p className="mt-0.5 text-xs text-text-secondary">{describeEarnRule(r)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Pill tone={r.is_active ? 'success' : 'neutral'}>{r.is_active ? 'Active' : 'Paused'}</Pill>
                  <Button variant="ghost" size="sm" onClick={() => openEditor(r)} aria-label={`Edit ${r.name}`}><Pencil size={16} /></Button>
                  <Button variant="ghost" size="sm" onClick={() => setDeleting(r)} aria-label={`Delete ${r.name}`}><Trash2 size={16} /></Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-labelledby="loyalty-preview-title">
        <h2 id="loyalty-preview-title" className="text-base font-semibold text-text-primary">Try it: what does an invoice earn?</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <Input label="Invoice amount ($)" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          <Input label="Service type (optional)" value={service} onChange={(e) => setService(e.target.value)} placeholder="AC repair" />
          <SelectField
            label="Customer tier"
            value={tierId}
            onChange={setTierId}
            options={[{ value: '', label: tiers.length ? 'Before any tier' : 'No tiers set up' }, ...orderedTiers.map((t) => ({ value: t.id, label: `${t.name} (${formatMultiplier(t.earn_multiplier)})` }))]}
          />
        </div>
        <p className="mt-4 text-sm text-text-secondary" aria-live="polite">
          <span className="text-2xl font-bold text-text-primary">{formatPoints(preview.points)}</span> {pointsLabel}
          {preview.matched.length > 0 ? ` from ${preview.matched.join(' + ')}` : ''}
          {preview.multiplier > 1 ? ` × ${formatMultiplier(preview.multiplier)} ${preview.tierName ?? ''}` : ''}
        </p>
      </section>

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add earn rule' : 'Edit earn rule'}>
        <div className="space-y-4">
          <Input label="Rule name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} error={errors.name} maxLength={60} required />
          <SelectField label="How points are earned" value={form.kind} onChange={(kind) => setForm({ ...form, kind })} options={EARN_KIND_OPTIONS} />
          <Input
            label={form.kind === 'per_dollar' ? 'Points per $1' : 'Points per paid job'}
            value={form.points_value}
            onChange={(e) => setForm({ ...form, points_value: e.target.value })}
            inputMode="decimal"
            error={errors.points_value}
            required
          />
          <Input
            label="Only for this service (optional)"
            value={form.service_type}
            onChange={(e) => setForm({ ...form, service_type: e.target.value })}
            error={errors.service_type}
            helperText="Must match the job's service type. Leave empty for all services."
          />
          <Input
            label="Minimum invoice ($)"
            value={form.min_invoice_amount}
            onChange={(e) => setForm({ ...form, min_invoice_amount: e.target.value })}
            inputMode="decimal"
            error={errors.min_invoice_amount}
          />
          <Toggle checked={form.is_active} onChange={(is_active) => setForm({ ...form, is_active })} label="Rule is active" />
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <Button variant="secondary" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
            <Button size="sm" onClick={() => void submitRule()} disabled={saving}>
              {saving && <Loader2 size={16} className="animate-spin" />} Save rule
            </Button>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete this earn rule?"
        description={`"${deleting?.name ?? ''}" will stop awarding points on future paid invoices. Points already earned are kept.`}
        confirmLabel="Delete rule"
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
