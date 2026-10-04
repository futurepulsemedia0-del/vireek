import { useCallback, useEffect, useMemo, useState } from 'react';
import { MapPinned, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import {
  CHANNEL_META, CHANNEL_ORDER, allowedTransitions, assessProperties, buildNeighborhoodPlan,
  buildOfferTemplate, channelEligibility, isStaleOpportunity, opportunityScore, requiresAck, serviceCategory,
  type CampaignStatus, type NearbyProperty, type NeighborhoodChannel,
} from '@/lib/neighborhoodRevenue';
import {
  createCampaignDraft, dismissOpportunity, fetchCampaignResults, fetchCampaigns, fetchNearbyProperties,
  fetchOverview, transitionCampaign,
  type CampaignResult, type NeighborhoodCampaign, type OpportunityOverview,
} from '@/lib/neighborhoodRevenueApi';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

interface CampaignRowProps {
  campaign: NeighborhoodCampaign;
  result?: CampaignResult;
  onTransition: (c: NeighborhoodCampaign, next: CampaignStatus, ack: boolean) => Promise<void>;
}

function CampaignRow({ campaign, result, onTransition }: CampaignRowProps) {
  const [ack, setAck] = useState(Boolean(campaign.compliance_ack_at));
  const [busy, setBusy] = useState(false);
  const next = allowedTransitions(campaign.status);
  const needsAck = next.some(requiresAck) && !campaign.compliance_ack_at;

  const run = async (to: CampaignStatus) => {
    setBusy(true);
    try {
      await onTransition(campaign, to, ack);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-text-primary">{CHANNEL_META[campaign.channel].label}</p>
        <span className="rounded-full bg-bg-tertiary px-3 py-1 text-xs font-medium capitalize text-text-secondary">
          {campaign.status}
        </span>
      </div>
      <p className="mt-2 text-sm text-text-secondary">{campaign.offer_text}</p>
      {result && (
        <p className="mt-2 text-xs text-text-secondary">
          Measured in zone during window: <strong className="text-text-primary">{result.zone_jobs}</strong> jobs,{' '}
          {result.zone_completed} completed, {money(result.zone_revenue)} invoiced.
        </p>
      )}
      {needsAck && (
        <label className="mt-3 flex items-start gap-2 text-xs text-text-secondary">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
          <span>I confirm this campaign follows the compliance notes for this channel and uses only opted-in contacts where personal.</span>
        </label>
      )}
      {next.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {next.map((to) => (
            <Button
              key={to}
              size="sm"
              variant={to === 'cancelled' ? 'ghost' : 'secondary'}
              disabled={busy || (requiresAck(to) && needsAck && !ack)}
              onClick={() => void run(to)}
            >
              {to === 'draft' ? 'Back to draft' : to === 'completed' ? 'Mark completed' : to === 'cancelled' ? 'Cancel' : to === 'approved' ? 'Approve' : 'Start'}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

export function NeighborhoodRevenuePage() {
  const { permissions } = useAuth();
  const { toast } = useToast();
  const [rows, setRows] = useState<OpportunityOverview[]>([]);
  const [campaigns, setCampaigns] = useState<NeighborhoodCampaign[]>([]);
  const [results, setResults] = useState<Record<string, CampaignResult>>({});
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nearby, setNearby] = useState<NearbyProperty[]>([]);
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [channel, setChannel] = useState<NeighborhoodChannel>('door_hanger');
  const [offer, setOffer] = useState('');
  const [budget, setBudget] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [saving, setSaving] = useState(false);
  const canView = permissions.can_view_billing;

  const reload = useCallback(async () => {
    const [o, c, r] = await Promise.all([fetchOverview(), fetchCampaigns(), fetchCampaignResults()]);
    setRows(o);
    setCampaigns(c);
    setResults(Object.fromEntries(r.map((x) => [x.campaign_id, x])));
    setSelectedId((cur) => (cur && o.some((x) => x.opportunity_id === cur) ? cur : o[0]?.opportunity_id ?? null));
  }, []);

  useEffect(() => {
    if (!canView) {
      setLoading(false);
      return;
    }
    let alive = true;
    reload()
      .catch((e) => alive && toast(errMsg(e), 'error'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [canView, reload, toast]);

  const selected = useMemo(() => rows.find((r) => r.opportunity_id === selectedId) ?? null, [rows, selectedId]);
  const category = useMemo(() => serviceCategory(selected?.service_type), [selected]);
  const geocoded = Boolean(selected && selected.latitude !== null && selected.longitude !== null);

  useEffect(() => {
    if (!selected || !geocoded) {
      setNearby([]);
      return;
    }
    let alive = true;
    setNearbyLoading(true);
    fetchNearbyProperties(selected.opportunity_id)
      .then((p) => alive && setNearby(p))
      .catch((e) => alive && toast(errMsg(e), 'error'))
      .finally(() => alive && setNearbyLoading(false));
    return () => {
      alive = false;
    };
  }, [selected, geocoded, toast]);

  useEffect(() => {
    setOffer(buildOfferTemplate(category, channel));
  }, [category, channel, selectedId]);

  const assessed = useMemo(() => assessProperties(nearby, category), [nearby, category]);
  const plan = useMemo(
    () => (selected ? buildNeighborhoodPlan(assessed, selected.scheduled_nearby, selected.radius_m) : null),
    [assessed, selected]
  );
  const topProperties = useMemo(
    () =>
      [...assessed]
        .sort((a, b) => Number(b.need.signal !== 'none') - Number(a.need.signal !== 'none') || a.property.distance_m - b.property.distance_m)
        .slice(0, 12),
    [assessed]
  );
  const selectedCampaigns = campaigns.filter((c) => c.opportunity_id === selectedId);

  const totals = useMemo(() => {
    const open = rows.filter((r) => r.status === 'open').length;
    const nearbyStops = rows.reduce((sum, r) => sum + r.scheduled_nearby, 0);
    return { open, nearbyStops };
  }, [rows]);

  const handleCreate = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await createCampaignDraft({
        opportunityId: selected.opportunity_id,
        channel,
        offerText: offer,
        budget: budget === '' ? 0 : Number(budget),
        startsOn: startsOn || null,
        endsOn: endsOn || null,
      });
      toast('Campaign draft saved.', 'success');
      await reload();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleTransition = async (c: NeighborhoodCampaign, next: CampaignStatus, ack: boolean) => {
    try {
      await transitionCampaign(c, next, ack);
      await reload();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  const handleDismiss = async () => {
    if (!selected) return;
    try {
      await dismissOpportunity(selected.opportunity_id);
      toast('Opportunity dismissed.', 'success');
      await reload();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <MapPinned size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Neighborhood Revenue Engine</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Turn every completed job into route-dense follow-on work in the same neighborhood.
            </p>
          </div>
        </div>

        {!canView ? (
          <EmptyState icon={ShieldCheck} title="Restricted" description="You need billing access to view neighborhood revenue." />
        ) : loading ? (
          <SkeletonCardList count={3} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={MapPinned}
            title="No neighborhood opportunities yet"
            description="When a job is marked completed, it appears here with nearby service demand and route density."
          />
        ) : (
          <div className="space-y-6">
            <Card className="grid grid-cols-2 gap-6 !p-6 sm:grid-cols-4">
              <Stat label="Open opportunities" value={totals.open} />
              <Stat label="Scheduled stops nearby" value={totals.nearbyStops} hint="Next 14 days, inside zones" />
              <Stat label="Active campaigns" value={campaigns.filter((c) => c.status === 'active').length} />
              <Stat
                label="Measured in-zone jobs"
                value={Object.values(results).reduce((s, r) => s + r.zone_jobs, 0)}
                hint="During campaign windows"
              />
            </Card>

            <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
              <div className="space-y-2">
                {rows.map((r) => {
                  const rowScore = r.opportunity_id === selectedId && plan
                    ? opportunityScore({ withSignal: plan.withSignal, totalNearby: plan.totalNearby, scheduledNearby: r.scheduled_nearby, completedAt: r.completed_at })
                    : null;
                  return (
                    <button
                      key={r.opportunity_id}
                      type="button"
                      onClick={() => setSelectedId(r.opportunity_id)}
                      className={`focus-ring w-full rounded-xl border p-3 text-left transition-colors ${
                        r.opportunity_id === selectedId ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary hover:border-accent/40'
                      }`}
                    >
                      <p className="text-sm font-semibold text-text-primary">{r.service_type || 'Completed job'}</p>
                      <p className="mt-0.5 truncate text-xs text-text-secondary">{r.address || r.customer_name}</p>
                      <p className="mt-1 text-xs text-text-secondary">
                        {r.scheduled_nearby} stops nearby
                        {isStaleOpportunity(r.completed_at) ? ' · stale' : ''}
                        {rowScore !== null ? ` · priority ${rowScore}` : ''}
                      </p>
                    </button>
                  );
                })}
              </div>

              {selected && (
                <div className="space-y-6">
                  {!geocoded ? (
                    <EmptyState
                      icon={MapPinned}
                      title="This job has no coordinates yet"
                      description="Open Advanced Routing and run “Geocode addresses”, then come back."
                    />
                  ) : nearbyLoading || !plan ? (
                    <SkeletonCardList count={2} />
                  ) : (
                    <>
                      <Card className="!p-6">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <h2 className="text-lg font-semibold text-text-primary">{selected.service_type || 'Completed job'}</h2>
                            <p className="text-sm text-text-secondary">
                              {selected.address} · {(selected.radius_m / 1000).toFixed(1)} km zone
                            </p>
                          </div>
                          <Button size="sm" variant="ghost" onClick={() => void handleDismiss()}>Dismiss</Button>
                        </div>
                        <div className="mt-5 grid grid-cols-2 gap-5 sm:grid-cols-4">
                          <Stat label="Your customers nearby" value={plan.totalNearby} />
                          <Stat label="Likely need" value={plan.withSignal} hint={`${plan.replacementWindow} replacement · ${plan.maintenanceDue} maintenance`} />
                          <Stat label="Projected bookings" value={`${plan.projectedBookings.low}–${plan.projectedBookings.high}`} hint="Estimate (planning assumptions)" />
                          <Stat label="Route density" value={plan.densityGrade} hint={`${plan.stopsInZone.existing} booked + ~${plan.stopsInZone.expected} projected · ${plan.stopsPerKm2}/km²`} />
                        </div>
                        {plan.estimatedDriveMinutesSaved > 0 && (
                          <p className="mt-4 text-xs text-text-secondary">
                            Estimated drive time saved if these stops are clustered: ~{plan.estimatedDriveMinutesSaved} min. Replaced by measured results once campaigns run.
                          </p>
                        )}
                      </Card>

                      <Card className="!p-6">
                        <h3 className="mb-3 text-sm font-semibold text-text-primary">Nearby customers with likely need</h3>
                        {topProperties.length === 0 ? (
                          <p className="text-sm text-text-secondary">None of your customers have jobs inside this zone yet. Use zone-wide channels below.</p>
                        ) : (
                          <ul className="divide-y divide-border">
                            {topProperties.map(({ property, need }) => (
                              <li key={property.customer_id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                                <div>
                                  <p className="text-sm font-medium text-text-primary">{property.customer_name}</p>
                                  <p className="text-xs text-text-secondary">
                                    {property.address || 'No address'} · {property.distance_m} m · {need.reason}
                                  </p>
                                </div>
                                <span className="text-xs text-text-secondary">
                                  {channelEligibility(property, 'sms_opt_in').eligible || channelEligibility(property, 'email_opt_in').eligible
                                    ? 'Opt-in reachable'
                                    : 'Zone channels only'}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                        <p className="mt-3 text-xs text-text-secondary">
                          Only your own customers are listed. Non-customer homes are never stored or profiled.
                        </p>
                      </Card>

                      <Card className="!p-6">
                        <h3 className="mb-3 text-sm font-semibold text-text-primary">Plan a compliant campaign</h3>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {CHANNEL_ORDER.map((ch) => {
                            const meta = CHANNEL_META[ch];
                            const count = ch === 'email_opt_in' || ch === 'sms_opt_in' ? plan.reachable[ch] : null;
                            return (
                              <button
                                key={ch}
                                type="button"
                                onClick={() => setChannel(ch)}
                                className={`focus-ring rounded-xl border p-3 text-left transition-colors ${
                                  channel === ch ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/40'
                                }`}
                              >
                                <p className="text-sm font-semibold text-text-primary">{meta.label}</p>
                                <p className="mt-0.5 text-xs text-text-secondary">{meta.description}</p>
                                {count !== null && <p className="mt-1 text-xs font-medium text-text-primary">{count} eligible</p>}
                              </button>
                            );
                          })}
                        </div>
                        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-text-secondary">
                          {CHANNEL_META[channel].notes.map((n) => (
                            <li key={n}>{n}</li>
                          ))}
                        </ul>
                        <label htmlFor="nre-offer" className="mb-1.5 mt-4 block text-sm font-medium text-text-primary">Offer text</label>
                        <textarea
                          id="nre-offer"
                          value={offer}
                          onChange={(e) => setOffer(e.target.value)}
                          rows={3}
                          maxLength={1000}
                          className="focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                        />
                        <div className="mt-3 grid gap-3 sm:grid-cols-3">
                          <Input id="nre-budget" label="Budget" type="number" min={0} value={budget} onChange={(e) => setBudget(e.target.value)} />
                          <Input id="nre-start" label="Starts" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
                          <Input id="nre-end" label="Ends" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
                        </div>
                        <div className="mt-4">
                          <Button disabled={saving} onClick={() => void handleCreate()}>
                            {saving ? 'Saving…' : 'Save campaign draft'}
                          </Button>
                        </div>
                      </Card>

                      {selectedCampaigns.length > 0 && (
                        <Card className="!p-6">
                          <h3 className="mb-3 text-sm font-semibold text-text-primary">Campaigns for this zone</h3>
                          <div className="space-y-3">
                            {selectedCampaigns.map((c) => (
                              <CampaignRow key={c.id} campaign={c} result={results[c.id]} onTransition={handleTransition} />
                            ))}
                          </div>
                        </Card>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
