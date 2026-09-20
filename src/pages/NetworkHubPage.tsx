import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Lock, Network, ShieldCheck, TriangleAlert as AlertTriangle } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { networkApi } from '@/lib/contractorNetworkApi';
import {
  NETWORK_CAPABILITIES,
  describeNetworkError,
  formatMoney,
  type NetworkHubSummary,
} from '@/lib/contractorNetwork';

function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 font-display text-2xl font-semibold text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

export function NetworkHubPage() {
  const { isOwner } = useAuth();
  const { toast } = useToast();

  const [summary, setSummary] = useState<NetworkHubSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await networkApi.summary();
      setSummary(s);
      setPhone((prev) => prev || s.contact_phone || '');
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const join = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await networkApi.setMembership(true, phone);
      toast('You joined the Contractor Network', 'success');
      await load();
    } catch (e) {
      toast(describeNetworkError(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const leave = async () => {
    try {
      await networkApi.setMembership(false);
      toast('You left the Contractor Network', 'info');
      setConfirmLeave(false);
      await load();
    } catch (e) {
      toast(describeNetworkError(e), 'error');
    }
  };

  const isMember = summary?.is_member ?? false;
  const hasHistory =
    !!summary &&
    (summary.handoffs_posted > 0 ||
      summary.handoffs_received_completed > 0 ||
      summary.releases > 0);

  return (
    <DashboardLayout activeLabel="Contractor Network">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Network size={20} />
          </span>
          <div>
            <h1 className="font-display text-xl font-semibold text-text-primary">
              Contractor Network
            </h1>
            <p className="text-sm text-text-secondary">
              Share capacity, crews and emergency work with trusted contractors in your region.
            </p>
          </div>
        </header>

        {loading ? (
          <>
            <SkeletonStatGrid count={4} />
            <SkeletonCardList count={3} />
          </>
        ) : loadFailed || !summary ? (
          <EmptyStateError
            icon={AlertTriangle}
            title="Couldn’t load the network"
            description="Check your connection and try again. If this keeps happening, the network migration may not be applied yet."
            onRetry={() => {
              setLoading(true);
              void load();
            }}
          />
        ) : (
          <>
            {/* Membership */}
            <section
              className="rounded-xl border border-border bg-bg-secondary p-5"
              aria-labelledby="network-membership"
            >
              {isMember ? (
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h2
                      id="network-membership"
                      className="flex items-center gap-2 text-sm font-semibold text-text-primary"
                    >
                      <ShieldCheck size={16} className="text-success-500" />
                      You’re in the network
                    </h2>
                    <p className="mt-1 text-xs text-text-secondary">
                      Region:{' '}
                      <span className="font-medium text-text-primary">{summary.region_key}</span>
                      {summary.contact_phone && (
                        <>
                          {' '}
                          · Coordination phone:{' '}
                          <span className="font-medium text-text-primary">
                            {summary.contact_phone}
                          </span>
                        </>
                      )}
                    </p>
                  </div>
                  {isOwner && (
                    <Button variant="secondary" size="sm" onClick={() => setConfirmLeave(true)}>
                      Leave network
                    </Button>
                  )}
                </div>
              ) : (
                <div className="grid gap-5 md:grid-cols-2">
                  <div>
                    <h2
                      id="network-membership"
                      className="flex items-center gap-2 text-sm font-semibold text-text-primary"
                    >
                      <Lock size={16} className="text-text-secondary" />
                      Join{' '}
                      {summary.members_total > 1
                        ? `${summary.members_total.toLocaleString()} contractors`
                        : 'the network'}
                    </h2>
                    <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-text-secondary">
                      <li>• Reciprocity: you only see the network if you’re in it.</li>
                      <li>• Customer details are hidden until another member accepts a job.</li>
                      <li>• Leave any time — your open handoffs are cancelled automatically.</li>
                    </ul>
                  </div>
                  <div className="space-y-3">
                    <Input
                      label="Coordination phone"
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      helperText="Shared only with the contractor who accepts your handoff."
                      disabled={!isOwner}
                    />
                    {isOwner ? (
                      <Button
                        onClick={join}
                        disabled={saving || phone.replace(/\D/g, '').length < 7}
                      >
                        {saving && <Loader2 size={16} className="animate-spin" />}
                        Join the network
                      </Button>
                    ) : (
                      <p className="text-xs text-text-secondary">
                        Ask the account owner to join the network.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </section>

            {/* Live pulse */}
            {isMember ? (
              <section
                aria-label="Network activity"
                className="grid grid-cols-2 gap-3 md:grid-cols-4"
              >
                <StatTile
                  label="Members near you"
                  value={summary.members_in_region}
                  hint={`of ${summary.members_total} total`}
                />
                <StatTile
                  label="Open handoffs"
                  value={summary.open_handoffs}
                  hint={`${summary.open_emergency} emergency`}
                />
                <StatTile
                  label="Labor listings"
                  value={summary.open_labor_listings}
                  hint="open now"
                />
                <StatTile
                  label="Mutual-aid requests"
                  value={summary.open_mutual_aid}
                  hint="open now"
                />
              </section>
            ) : (
              <p className="text-xs text-text-secondary">
                Live network activity appears here once you join.
              </p>
            )}

            {/* Capabilities */}
            <section
              aria-label="Network capabilities"
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
            >
              {NETWORK_CAPABILITIES.map((c) => {
                const Icon = c.icon;
                const stat = isMember && c.stat ? c.stat(summary) : null;
                return (
                  <Link
                    key={c.id}
                    to={c.href}
                    className="focus-ring group flex flex-col rounded-xl border border-border bg-bg-secondary p-4 transition-colors hover:border-accent/40"
                  >
                    <div className="flex items-center justify-between">
                      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent">
                        <Icon size={18} />
                      </span>
                      {c.isNew && (
                        <span className="rounded-full bg-cta/10 px-2 py-0.5 text-[11px] font-semibold text-cta">
                          New
                        </span>
                      )}
                    </div>
                    <h3 className="mt-3 text-sm font-semibold text-text-primary group-hover:text-accent">
                      {c.title}
                    </h3>
                    <p className="mt-1 flex-1 text-xs leading-relaxed text-text-secondary">
                      {c.description}
                    </p>
                    {stat && (
                      <p className="mt-3 text-xs text-text-secondary">
                        <span className="font-semibold text-text-primary">{stat.value}</span>{' '}
                        {stat.label}
                      </p>
                    )}
                  </Link>
                );
              })}
            </section>

            {/* Standing */}
            {(isMember || hasHistory) && (
              <section
                className="rounded-xl border border-border bg-bg-secondary p-5"
                aria-labelledby="network-standing"
              >
                <h2 id="network-standing" className="text-sm font-semibold text-text-primary">
                  Your network standing
                </h2>
                <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5">
                  <StatTile
                    label="Reliability"
                    value={summary.reliability_pct === null ? '—' : `${summary.reliability_pct}%`}
                    hint="completed vs released"
                  />
                  <StatTile
                    label="Handed off"
                    value={summary.handoffs_sent_completed}
                    hint={`${summary.handoffs_posted} posted`}
                  />
                  <StatTile
                    label="Completed for others"
                    value={summary.handoffs_received_completed}
                    hint={`${summary.active_claims} active`}
                  />
                  <StatTile
                    label="Fees owed to you"
                    value={formatMoney(summary.fees_owed_to_me_cents)}
                  />
                  <StatTile label="Fees you owe" value={formatMoney(summary.fees_i_owe_cents)} />
                </div>
              </section>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmLeave}
        title="Leave the Contractor Network?"
        description="Your open handoffs will be cancelled. Jobs you already accepted stay active until you complete or release them."
        confirmLabel="Leave network"
        onConfirm={leave}
        onCancel={() => setConfirmLeave(false)}
      />
    </DashboardLayout>
  );
}
