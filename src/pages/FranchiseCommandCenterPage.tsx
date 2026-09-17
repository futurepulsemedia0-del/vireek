import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Building2,
  Plus,
  Mail,
  Check,
  X,
  Trash2,
  Phone,
  Wrench,
  DollarSign,
  Star,
  AlertTriangle,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { supabase } from '@/lib/supabase';
import {
  type FranchiseGroup,
  type FranchiseLocation,
  type FranchiseLocationStats,
  type PendingFranchiseInvite,
  formatCurrency,
  formatRating,
  sumStats,
} from '@/lib/franchise';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

const STATUS_STYLES: Record<string, string> = {
  active: 'border-success-500/30 bg-success-500/10 text-success-500',
  invited: 'border-border bg-bg-tertiary text-text-secondary',
  declined: 'border-danger/30 bg-danger/10 text-danger',
};

export function FranchiseCommandCenterPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [group, setGroup] = useState<FranchiseGroup | null>(null);
  const [locations, setLocations] = useState<FranchiseLocation[]>([]);
  const [stats, setStats] = useState<FranchiseLocationStats[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingFranchiseInvite[]>([]);

  const [groupName, setGroupName] = useState('');
  const [creating, setCreating] = useState(false);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteLabel, setInviteLabel] = useState('');
  const [inviting, setInviting] = useState(false);

  const [removingId, setRemovingId] = useState<string | null>(null);
  const [respondingId, setRespondingId] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [groupRes, invitesRes] = await Promise.all([
      supabase.from('franchise_groups').select('*').maybeSingle(),
      supabase.rpc('get_pending_franchise_invites'),
    ]);

    setPendingInvites((invitesRes.data as PendingFranchiseInvite[]) || []);

    const franchiseGroup = (groupRes.data as FranchiseGroup | null) || null;
    setGroup(franchiseGroup);

    if (franchiseGroup) {
      const [locationsRes, statsRes] = await Promise.all([
        supabase
          .from('franchise_locations')
          .select('*')
          .eq('franchise_group_id', franchiseGroup.id)
          .order('invited_at', { ascending: true }),
        supabase.rpc('get_franchise_dashboard_stats', { p_group_id: franchiseGroup.id }),
      ]);
      setLocations((locationsRes.data as FranchiseLocation[]) || []);
      setStats((statsRes.data as FranchiseLocationStats[]) || []);
    } else {
      setLocations([]);
      setStats([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (user) fetchAll();
  }, [user, fetchAll]);

  const totals = useMemo(() => sumStats(stats), [stats]);
  const statsByLocationId = useMemo(() => {
    const map = new Map<string, FranchiseLocationStats>();
    stats.forEach((s) => map.set(s.location_id, s));
    return map;
  }, [stats]);

  const handleCreateGroup = async () => {
    if (!user || !groupName.trim()) return;
    setCreating(true);
    const { error } = await supabase.from('franchise_groups').insert({ owner_id: user.id, name: groupName.trim() });
    setCreating(false);
    if (error) {
      toast('Could not create your Command Center', 'error');
      return;
    }
    toast('Franchise Command Center created', 'success');
    setGroupName('');
    fetchAll();
  };

  const handleInvite = async () => {
    if (!group || !inviteEmail.trim() || !inviteLabel.trim()) return;
    setInviting(true);
    const { error } = await supabase.from('franchise_locations').insert({
      franchise_group_id: group.id,
      invited_email: inviteEmail.trim().toLowerCase(),
      label: inviteLabel.trim(),
    });
    setInviting(false);
    if (error) {
      toast(
        error.code === '23505' ? 'That email is already invited to this franchise' : 'Could not send the invite',
        'error',
      );
      return;
    }
    toast('Location invited', 'success');
    setInviteEmail('');
    setInviteLabel('');
    fetchAll();
  };

  const handleRemoveLocation = async () => {
    if (!removingId) return;
    const { error } = await supabase.from('franchise_locations').delete().eq('id', removingId);
    if (error) {
      toast('Could not remove this location', 'error');
    } else {
      setLocations((prev) => prev.filter((l) => l.id !== removingId));
      toast('Location removed', 'success');
    }
    setRemovingId(null);
  };

  const handleRespond = async (inviteId: string, accept: boolean) => {
    setRespondingId(inviteId);
    const { error } = await supabase.rpc('respond_to_franchise_invite', {
      p_location_id: inviteId,
      p_accept: accept,
    });
    setRespondingId(null);
    if (error) {
      toast('Could not update this invite', 'error');
      return;
    }
    toast(accept ? "You're now sharing stats with this franchise" : 'Invite declined', 'success');
    fetchAll();
  };

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Building2 size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Franchise Command Center</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Roll up calls, jobs, revenue, and review scores across every location — each location keeps its
              own independent Vireek account and only shares data once it accepts your invite.
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
            {pendingInvites.length > 0 && (
              <div className="mb-8 space-y-3">
                {pendingInvites.map((invite) => (
                  <Card key={invite.id} className="flex flex-wrap items-center justify-between gap-3 p-5">
                    <div>
                      <p className="text-sm font-semibold text-text-primary">
                        {invite.franchise_name} invited this account as "{invite.label}"
                      </p>
                      <p className="mt-1 text-xs text-text-secondary">
                        Accepting shares your calls, jobs, revenue, and review scores with that franchise's HQ
                        dashboard.
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={respondingId === invite.id}
                        onClick={() => handleRespond(invite.id, false)}
                      >
                        <X size={14} /> Decline
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={respondingId === invite.id}
                        onClick={() => handleRespond(invite.id, true)}
                      >
                        <Check size={14} /> Accept
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            )}

            {!group ? (
              <Card className="mx-auto max-w-lg p-8 text-center">
                <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
                  <Building2 size={22} />
                </span>
                <h2 className="mt-4 text-lg font-semibold text-text-primary">Set up your Command Center</h2>
                <p className="mt-2 text-sm text-text-secondary">
                  Give it a name — usually your brand or holding company — then invite each location's Vireek
                  account to link in.
                </p>
                <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                  <input
                    className={inputClass}
                    placeholder="e.g. Acme Home Services Group"
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                  />
                  <Button variant="primary" disabled={creating || !groupName.trim()} onClick={handleCreateGroup}>
                    {creating ? 'Creating…' : 'Create'}
                  </Button>
                </div>
              </Card>
            ) : (
              <>
                <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                    <p className="text-xl font-bold text-text-primary">{totals.activeLocations}</p>
                    <p className="text-xs text-text-secondary">Active locations</p>
                  </div>
                  <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                    <p className="text-xl font-bold text-text-primary">{totals.totalCalls}</p>
                    <p className="text-xs text-text-secondary">Calls (30d)</p>
                  </div>
                  <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                    <p className="text-xl font-bold text-text-primary">{totals.totalJobs}</p>
                    <p className="text-xs text-text-secondary">Jobs (30d)</p>
                  </div>
                  <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                    <p className="text-xl font-bold text-text-primary">{formatCurrency(totals.totalRevenue)}</p>
                    <p className="text-xs text-text-secondary">Revenue (30d)</p>
                  </div>
                  <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                    <p className="text-xl font-bold text-text-primary">{formatRating(totals.avgRating)}</p>
                    <p className="text-xs text-text-secondary">Avg. rating</p>
                  </div>
                </div>

                <Card className="mb-8 p-6">
                  <h2 className="text-sm font-semibold text-text-primary">Invite a location</h2>
                  <p className="mt-1 text-xs text-text-secondary">
                    They'll see this invite the next time they open their own Vireek dashboard.
                  </p>
                  <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                    <input
                      className={inputClass}
                      placeholder="Location name, e.g. Downtown Branch"
                      value={inviteLabel}
                      onChange={(e) => setInviteLabel(e.target.value)}
                    />
                    <input
                      className={inputClass}
                      type="email"
                      placeholder="location@theirbusiness.com"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                    />
                    <Button
                      variant="primary"
                      disabled={inviting || !inviteEmail.trim() || !inviteLabel.trim()}
                      onClick={handleInvite}
                    >
                      <Plus size={16} /> {inviting ? 'Sending…' : 'Invite'}
                    </Button>
                  </div>
                </Card>

                <div className="space-y-3">
                  {locations.map((location) => {
                    const s = location.location_profile_id ? statsByLocationId.get(location.id) : undefined;
                    return (
                      <Card key={location.id} className="p-5">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <div className="flex items-center gap-2">
                              <h3 className="text-sm font-semibold text-text-primary">{location.label}</h3>
                              <span
                                className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold capitalize ${STATUS_STYLES[location.status]}`}
                              >
                                {location.status}
                              </span>
                            </div>
                            <p className="mt-1 flex items-center gap-1.5 text-xs text-text-secondary">
                              <Mail size={12} /> {location.invited_email}
                              {s?.company_name ? ` · ${s.company_name}` : ''}
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setRemovingId(location.id)}
                            aria-label={`Remove ${location.label}`}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>

                        {location.status === 'active' && s && (
                          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
                            <div className="rounded-xl border border-border bg-bg-tertiary/60 p-3 text-center">
                              <p className="flex items-center justify-center gap-1 text-sm font-bold text-text-primary">
                                <Phone size={12} /> {s.calls_30d}
                              </p>
                              <p className="text-[11px] text-text-secondary">Calls</p>
                            </div>
                            <div className="rounded-xl border border-border bg-bg-tertiary/60 p-3 text-center">
                              <p className="flex items-center justify-center gap-1 text-sm font-bold text-text-primary">
                                <AlertTriangle size={12} /> {s.emergency_calls_30d}
                              </p>
                              <p className="text-[11px] text-text-secondary">Emergencies</p>
                            </div>
                            <div className="rounded-xl border border-border bg-bg-tertiary/60 p-3 text-center">
                              <p className="flex items-center justify-center gap-1 text-sm font-bold text-text-primary">
                                <Wrench size={12} /> {s.jobs_30d}
                              </p>
                              <p className="text-[11px] text-text-secondary">Jobs</p>
                            </div>
                            <div className="rounded-xl border border-border bg-bg-tertiary/60 p-3 text-center">
                              <p className="flex items-center justify-center gap-1 text-sm font-bold text-text-primary">
                                <DollarSign size={12} /> {formatCurrency(s.revenue_30d)}
                              </p>
                              <p className="text-[11px] text-text-secondary">Revenue</p>
                            </div>
                            <div className="rounded-xl border border-border bg-bg-tertiary/60 p-3 text-center">
                              <p className="flex items-center justify-center gap-1 text-sm font-bold text-text-primary">
                                <Star size={12} /> {formatRating(s.avg_rating)}
                              </p>
                              <p className="text-[11px] text-text-secondary">Rating</p>
                            </div>
                          </div>
                        )}
                      </Card>
                    );
                  })}

                  {locations.length === 0 && (
                    <p className="py-10 text-center text-sm text-text-secondary">
                      No locations invited yet — invite your first one above.
                    </p>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={!!removingId}
        title="Remove this location?"
        description="They'll stop sharing stats with your Command Center. Their own Vireek account and data are unaffected."
        confirmLabel="Remove location"
        onConfirm={handleRemoveLocation}
        onCancel={() => setRemovingId(null)}
      />
    </DashboardLayout>
  );
}
