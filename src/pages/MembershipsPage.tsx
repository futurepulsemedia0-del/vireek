import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Award, Plus, Trash2, Pencil, X, Check } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { supabase, MembershipPlan, Membership } from '@/lib/supabase';
import {
  formatPrice,
  formatBillingInterval,
  toMonthlyCents,
  MEMBERSHIP_STATUS_LABELS,
  MEMBERSHIP_STATUS_COLORS,
} from '@/lib/memberships';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

type MembershipWithPlan = Membership & {
  plan: Pick<MembershipPlan, 'name' | 'price_cents' | 'billing_interval'> | null;
};

// ============================================================
// PLAN FORM (add / edit)
// ============================================================

interface PlanFormState {
  name: string;
  price: string;
  billing_interval: 'monthly' | 'yearly';
  benefits: string;
}

const EMPTY_PLAN_FORM: PlanFormState = { name: '', price: '', billing_interval: 'yearly', benefits: '' };

function PlanForm({
  initial,
  onCancel,
  onSave,
}: {
  initial: PlanFormState;
  onCancel: () => void;
  onSave: (form: PlanFormState) => Promise<void>;
}) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!form.name.trim() || !form.price.trim()) return;
    setSaving(true);
    await onSave(form);
    setSaving(false);
  };

  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <input
          type="text"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="e.g. Annual Maintenance Plan"
          className={inputClass}
        />
        <div className="flex gap-2">
          <input
            type="number"
            min={0}
            value={form.price}
            onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
            placeholder="Price ($)"
            className={inputClass}
          />
          <select
            value={form.billing_interval}
            onChange={(e) => setForm((f) => ({ ...f, billing_interval: e.target.value as 'monthly' | 'yearly' }))}
            className={inputClass}
          >
            <option value="yearly">Yearly</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>
      </div>
      <textarea
        value={form.benefits}
        onChange={(e) => setForm((f) => ({ ...f, benefits: e.target.value }))}
        placeholder="One benefit per line, e.g.:&#10;Priority scheduling&#10;Annual tune-up included&#10;15% off repairs"
        rows={3}
        className={`${inputClass} mt-3`}
      />
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="focus-ring flex items-center gap-1 rounded-xl px-3 py-2 text-sm text-text-secondary hover:text-text-primary"
        >
          <X size={14} /> Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !form.name.trim() || !form.price.trim()}
          className="focus-ring flex items-center gap-1 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
        >
          <Check size={14} /> Save plan
        </button>
      </div>
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function MembershipsPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [plans, setPlans] = useState<MembershipPlan[]>([]);
  const [memberships, setMemberships] = useState<MembershipWithPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [addingPlan, setAddingPlan] = useState(false);
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null);
  const [deletingPlanId, setDeletingPlanId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'offered' | 'active' | 'cancelled'>('all');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [plansRes, membershipsRes] = await Promise.all([
      supabase.from('membership_plans').select('*').order('created_at', { ascending: false }),
      supabase
        .from('memberships')
        .select('*, plan:membership_plans(name, price_cents, billing_interval)')
        .order('created_at', { ascending: false })
        .limit(50),
    ]);

    if (plansRes.error || membershipsRes.error) {
      toast('Failed to load memberships', 'error');
    } else {
      setPlans((plansRes.data as MembershipPlan[]) || []);
      setMemberships((membershipsRes.data as MembershipWithPlan[]) || []);
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    if (user) fetchAll();
  }, [user, fetchAll]);

  const stats = useMemo(() => {
    const active = memberships.filter((m) => m.status === 'active');
    const offered = memberships.filter((m) => m.status === 'offered');
    const mrrCents = active.reduce((sum, m) => {
      if (!m.plan) return sum;
      return sum + toMonthlyCents(m.plan.price_cents, m.plan.billing_interval);
    }, 0);
    return { activeCount: active.length, offeredCount: offered.length, mrrCents };
  }, [memberships]);

  const filteredMemberships = memberships.filter((m) => statusFilter === 'all' || m.status === statusFilter);

  const handleSavePlan = async (form: PlanFormState, planId?: string) => {
    if (!user) return;
    const payload = {
      user_id: user.id,
      name: form.name.trim(),
      price_cents: Math.round(Number(form.price) * 100),
      billing_interval: form.billing_interval,
      benefits: form.benefits.split('\n').map((b) => b.trim()).filter(Boolean),
    };

    const query = planId
      ? supabase.from('membership_plans').update(payload).eq('id', planId)
      : supabase.from('membership_plans').insert(payload);

    const { error } = await query;
    if (error) {
      toast('Could not save plan', 'error');
      return;
    }
    toast('Plan saved', 'success');
    setAddingPlan(false);
    setEditingPlanId(null);
    fetchAll();
  };

  const handleTogglePlanActive = async (plan: MembershipPlan) => {
    const { error } = await supabase
      .from('membership_plans')
      .update({ active: !plan.active })
      .eq('id', plan.id);
    if (error) {
      toast('Could not update plan', 'error');
      return;
    }
    setPlans((prev) => prev.map((p) => (p.id === plan.id ? { ...p, active: !p.active } : p)));
  };

  const handleDeletePlan = async () => {
    if (!deletingPlanId) return;
    const { error } = await supabase.from('membership_plans').delete().eq('id', deletingPlanId);
    if (error) {
      toast('Could not delete plan', 'error');
    } else {
      setPlans((prev) => prev.filter((p) => p.id !== deletingPlanId));
      toast('Plan deleted', 'success');
    }
    setDeletingPlanId(null);
  };

  const handleUpdateMembershipStatus = async (
    membership: MembershipWithPlan,
    status: 'active' | 'cancelled'
  ) => {
    const patch: Record<string, unknown> = { status };
    if (status === 'active') patch.started_at = new Date().toISOString();
    if (status === 'cancelled') patch.cancelled_at = new Date().toISOString();

    const { error } = await supabase.from('memberships').update(patch).eq('id', membership.id);
    if (error) {
      toast('Could not update membership', 'error');
      return;
    }
    setMemberships((prev) => prev.map((m) => (m.id === membership.id ? { ...m, ...patch } as MembershipWithPlan : m)));
  };

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Award size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Memberships & Upsell</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Sarah pitches these plans on qualifying calls. Track offers, active members, and recurring revenue here.
            </p>
          </div>
        </div>

        {loading ? (
          <div className="space-y-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : (
          <>
            <div className="mb-8 grid grid-cols-3 gap-3">
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">{stats.activeCount}</p>
                <p className="text-xs text-text-secondary">Active members</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">{formatPrice(stats.mrrCents)}</p>
                <p className="text-xs text-text-secondary">Est. MRR from memberships</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">{stats.offeredCount}</p>
                <p className="text-xs text-text-secondary">Awaiting response</p>
              </div>
            </div>

            <div className="mb-8">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-text-primary">Your plans</h2>
                {!addingPlan && (
                  <button
                    type="button"
                    onClick={() => setAddingPlan(true)}
                    className="focus-ring flex items-center gap-1.5 rounded-xl border border-dashed border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
                  >
                    <Plus size={14} /> Add plan
                  </button>
                )}
              </div>

              {addingPlan && (
                <div className="mb-3">
                  <PlanForm
                    initial={EMPTY_PLAN_FORM}
                    onCancel={() => setAddingPlan(false)}
                    onSave={(form) => handleSavePlan(form)}
                  />
                </div>
              )}

              {plans.length === 0 && !addingPlan ? (
                <div className="rounded-2xl border border-dashed border-border py-10 text-center">
                  <p className="text-sm text-text-secondary">
                    No membership plans yet — add one so Sarah has something to offer.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {plans.map((plan) =>
                    editingPlanId === plan.id ? (
                      <PlanForm
                        key={plan.id}
                        initial={{
                          name: plan.name,
                          price: String(plan.price_cents / 100),
                          billing_interval: plan.billing_interval,
                          benefits: plan.benefits.join('\n'),
                        }}
                        onCancel={() => setEditingPlanId(null)}
                        onSave={(form) => handleSavePlan(form, plan.id)}
                      />
                    ) : (
                      <div
                        key={plan.id}
                        className={`rounded-xl border p-4 ${
                          plan.active ? 'border-border bg-bg-secondary' : 'border-border/50 bg-bg-secondary/50 opacity-60'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-text-primary">
                              {plan.name}{' '}
                              <span className="font-normal text-text-secondary">
                                — {formatPrice(plan.price_cents)}{formatBillingInterval(plan.billing_interval)}
                              </span>
                            </p>
                            {plan.benefits.length > 0 && (
                              <ul className="mt-1.5 list-inside list-disc text-xs text-text-secondary">
                                {plan.benefits.map((b, i) => (
                                  <li key={i}>{b}</li>
                                ))}
                              </ul>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              onClick={() => handleTogglePlanActive(plan)}
                              className="focus-ring rounded-lg px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                            >
                              {plan.active ? 'Deactivate' : 'Activate'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingPlanId(plan.id)}
                              className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                              aria-label="Edit plan"
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeletingPlanId(plan.id)}
                              className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-danger/10 hover:text-danger"
                              aria-label="Delete plan"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  )}
                </div>
              )}
            </div>

            <div>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-text-primary">Members</h2>
                <div className="flex gap-1.5">
                  {(['all', 'offered', 'active', 'cancelled'] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setStatusFilter(f)}
                      className={`focus-ring rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors ${
                        statusFilter === f
                          ? 'bg-accent text-white'
                          : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>

              {filteredMemberships.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border py-10 text-center">
                  <p className="text-sm text-text-secondary">
                    No members here yet — offers Sarah makes during calls will show up in this list.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredMemberships.map((m) => (
                    <motion.div
                      key={m.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-secondary px-4 py-3"
                    >
                      <div>
                        <p className="text-sm font-medium text-text-primary">{m.customer_name}</p>
                        <p className="text-xs text-text-secondary">
                          {m.plan?.name ?? 'Plan deleted'} · {m.customer_phone || 'No phone on file'}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-medium ${MEMBERSHIP_STATUS_COLORS[m.status]}`}
                        >
                          {MEMBERSHIP_STATUS_LABELS[m.status]}
                        </span>
                        {m.status === 'offered' && (
                          <button
                            type="button"
                            onClick={() => handleUpdateMembershipStatus(m, 'active')}
                            className="focus-ring rounded-lg px-2 py-1 text-xs font-medium text-success-500 hover:bg-success-500/10"
                          >
                            Mark active
                          </button>
                        )}
                        {m.status === 'active' && (
                          <button
                            type="button"
                            onClick={() => handleUpdateMembershipStatus(m, 'cancelled')}
                            className="focus-ring rounded-lg px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary"
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(deletingPlanId)}
        title="Delete this plan?"
        description="Existing members on this plan will keep their record, but it'll show as 'Plan deleted'."
        confirmLabel="Yes, delete this plan"
        onConfirm={handleDeletePlan}
        onCancel={() => setDeletingPlanId(null)}
      />
    </DashboardLayout>
  );
}
