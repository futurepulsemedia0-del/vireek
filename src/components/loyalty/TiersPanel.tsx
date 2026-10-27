/**
 * Loyalty — tiers: lifetime-points thresholds that unlock an earn multiplier and perks.
 */

import { useState } from 'react';
import { Crown, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import { Dialog, Pill } from '@/components/loyalty/loyaltyUi';
import { createTier, deleteTier, updateTier } from '@/lib/loyaltyApi';
import {
  MAX_TIERS,
  emptyTierForm,
  formatMultiplier,
  formatPoints,
  sortTiers,
  tierToForm,
  tierToPayload,
  validateTier,
  type FieldErrors,
  type LoyaltyTier,
  type TierForm,
} from '@/lib/loyalty';

interface Props {
  ownerId: string;
  tiers: LoyaltyTier[];
  onChanged: () => void;
}

export function TiersPanel({ ownerId, tiers, onChanged }: Props) {
  const { toast } = useToast();
  const [editing, setEditing] = useState<LoyaltyTier | 'new' | null>(null);
  const [form, setForm] = useState<TierForm>(emptyTierForm());
  const [errors, setErrors] = useState<FieldErrors<TierForm>>({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<LoyaltyTier | null>(null);
  const ordered = sortTiers(tiers);

  const openEditor = (t: LoyaltyTier | 'new') => {
    setEditing(t);
    setForm(t === 'new' ? emptyTierForm() : tierToForm(t));
    setErrors({});
  };

  const submit = async () => {
    const e = validateTier(form, tiers, editing && editing !== 'new' ? editing.id : null);
    setErrors(e);
    if (Object.keys(e).length > 0 || !editing) return;
    setSaving(true);
    try {
      const payload = tierToPayload(form);
      if (editing === 'new') await createTier(ownerId, payload);
      else await updateTier(ownerId, editing.id, payload);
      toast(editing === 'new' ? 'Tier added.' : 'Tier updated.', 'success');
      setEditing(null);
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the tier.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteTier(ownerId, deleting.id);
      toast('Tier deleted.', 'success');
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete the tier.', 'error');
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-text-secondary">
          A customer&apos;s tier comes from their lifetime points (spending points never lowers it). Up to {MAX_TIERS} tiers.
        </p>
        <Button size="sm" onClick={() => openEditor('new')} disabled={tiers.length >= MAX_TIERS}>
          <Plus size={16} /> Add tier
        </Button>
      </div>

      {ordered.length === 0 ? (
        <EmptyState
          icon={Crown}
          title="No tiers yet"
          description="Tiers reward your best customers with a higher earn rate. Start with a tier at 0 points for everyone."
          action={{ label: 'Add first tier', onClick: () => openEditor('new') }}
        />
      ) : (
        <ul className="space-y-2">
          {ordered.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-bg-secondary p-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-text-primary">{t.name}</p>
                  <Pill tone={t.earn_multiplier > 1 ? 'success' : 'neutral'}>{formatMultiplier(t.earn_multiplier)} points</Pill>
                </div>
                <p className="mt-0.5 text-xs text-text-secondary">
                  From {formatPoints(t.min_lifetime_points)} lifetime points{t.perks ? ` · ${t.perks}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => openEditor(t)} aria-label={`Edit ${t.name}`}><Pencil size={16} /></Button>
                <Button variant="ghost" size="sm" onClick={() => setDeleting(t)} aria-label={`Delete ${t.name}`}><Trash2 size={16} /></Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add tier' : 'Edit tier'}>
        <div className="space-y-4">
          <Input label="Tier name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} error={errors.name} maxLength={40} required />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Starts at (lifetime points)" value={form.min_lifetime_points} onChange={(e) => setForm({ ...form, min_lifetime_points: e.target.value })} inputMode="numeric" error={errors.min_lifetime_points} required />
            <Input label="Earn multiplier" value={form.earn_multiplier} onChange={(e) => setForm({ ...form, earn_multiplier: e.target.value })} inputMode="decimal" error={errors.earn_multiplier} helperText="1 = normal, 1.5 = 50% more." required />
          </div>
          <Textarea label="Perks shown to the customer (optional)" value={form.perks} onChange={(e) => setForm({ ...form, perks: e.target.value })} rows={3} maxLength={300} error={errors.perks} />
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <Button variant="secondary" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
            <Button size="sm" onClick={() => void submit()} disabled={saving}>
              {saving && <Loader2 size={16} className="animate-spin" />} Save tier
            </Button>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete this tier?"
        description={`Customers in "${deleting?.name ?? ''}" fall back to the next lower tier. Their points are not affected.`}
        confirmLabel="Delete tier"
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
