/**
 * Loyalty — rewards catalog: what customers can spend points on.
 */

import { useState } from 'react';
import { Gift, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import { Dialog, Pill, SelectField } from '@/components/loyalty/loyaltyUi';
import { createReward, deleteReward, updateReward } from '@/lib/loyaltyApi';
import {
  MAX_REWARDS,
  REWARD_TYPE_OPTIONS,
  emptyRewardForm,
  formatPoints,
  formatRewardValue,
  rewardNeedsValue,
  rewardToForm,
  rewardToPayload,
  validateReward,
  type FieldErrors,
  type LoyaltyReward,
  type RewardForm,
} from '@/lib/loyalty';

interface Props {
  ownerId: string;
  rewards: LoyaltyReward[];
  pointsLabel: string;
  onChanged: () => void;
}

export function RewardsPanel({ ownerId, rewards, pointsLabel, onChanged }: Props) {
  const { toast } = useToast();
  const [editing, setEditing] = useState<LoyaltyReward | 'new' | null>(null);
  const [form, setForm] = useState<RewardForm>(emptyRewardForm());
  const [errors, setErrors] = useState<FieldErrors<RewardForm>>({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<LoyaltyReward | null>(null);

  const openEditor = (r: LoyaltyReward | 'new') => {
    setEditing(r);
    setForm(r === 'new' ? emptyRewardForm() : rewardToForm(r));
    setErrors({});
  };

  const submit = async () => {
    const e = validateReward(form);
    setErrors(e);
    if (Object.keys(e).length > 0 || !editing) return;
    setSaving(true);
    try {
      const payload = rewardToPayload(form);
      if (editing === 'new') await createReward(ownerId, payload);
      else await updateReward(ownerId, editing.id, payload);
      toast(editing === 'new' ? 'Reward added.' : 'Reward updated.', 'success');
      setEditing(null);
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the reward.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteReward(ownerId, deleting.id);
      toast('Reward deleted.', 'success');
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete the reward.', 'error');
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-text-secondary">
          Only active rewards appear in the customer portal. Up to {MAX_REWARDS} rewards.
        </p>
        <Button size="sm" onClick={() => openEditor('new')} disabled={rewards.length >= MAX_REWARDS}>
          <Plus size={16} /> Add reward
        </Button>
      </div>

      {rewards.length === 0 ? (
        <EmptyState
          icon={Gift}
          title="No rewards yet"
          description="Add something customers can redeem, such as a $25 service credit."
          action={{ label: 'Add reward', onClick: () => openEditor('new') }}
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {rewards.map((r) => (
            <li key={r.id} className="flex flex-col justify-between gap-3 rounded-2xl border border-border bg-bg-secondary p-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-text-primary">{r.name}</p>
                  <Pill tone={r.is_active ? 'success' : 'neutral'}>{r.is_active ? 'Active' : 'Hidden'}</Pill>
                </div>
                <p className="mt-1 text-xs text-text-secondary">{formatRewardValue(r)}</p>
                {r.description && <p className="mt-1 text-xs text-text-secondary">{r.description}</p>}
              </div>
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-text-primary">{formatPoints(r.points_cost)} {pointsLabel}</p>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => openEditor(r)} aria-label={`Edit ${r.name}`}><Pencil size={16} /></Button>
                  <Button variant="ghost" size="sm" onClick={() => setDeleting(r)} aria-label={`Delete ${r.name}`}><Trash2 size={16} /></Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add reward' : 'Edit reward'}>
        <div className="space-y-4">
          <Input label="Reward name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} error={errors.name} maxLength={60} required />
          <Textarea label="Description (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} maxLength={300} error={errors.description} />
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField label="Reward type" value={form.reward_type} onChange={(reward_type) => setForm({ ...form, reward_type })} options={REWARD_TYPE_OPTIONS} />
            {rewardNeedsValue(form.reward_type) && (
              <Input
                label={form.reward_type === 'credit' ? 'Credit amount ($)' : 'Discount (%)'}
                value={form.reward_value}
                onChange={(e) => setForm({ ...form, reward_value: e.target.value })}
                inputMode="decimal"
                error={errors.reward_value}
                required
              />
            )}
          </div>
          <Input label={`Cost (${pointsLabel})`} value={form.points_cost} onChange={(e) => setForm({ ...form, points_cost: e.target.value })} inputMode="numeric" error={errors.points_cost} required />
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} className="h-4 w-4 accent-accent" />
            Visible to customers
          </label>
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <Button variant="secondary" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
            <Button size="sm" onClick={() => void submit()} disabled={saving}>
              {saving && <Loader2 size={16} className="animate-spin" />} Save reward
            </Button>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete this reward?"
        description={`"${deleting?.name ?? ''}" is removed from the catalog. Redemptions already requested are kept.`}
        confirmLabel="Delete reward"
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
