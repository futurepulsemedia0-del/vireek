import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, UserCheck, Users } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import {
  TRADE_OPTIONS,
  describeMarketError,
  formatRate,
  parseRateToCents,
  skillMarketApi,
  type Availability,
  type MarketTrade,
  type TeamListing,
} from '@/lib/skillMarket';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';

function stateOf(t: TeamListing): { label: string; className: string } {
  if (t.listed) return { label: 'Live in market', className: 'bg-success-500/10 text-success-500' };
  if (t.paused && t.company_consent && t.technician_consent) return { label: 'Paused', className: 'bg-warning-500/10 text-warning-500' };
  if (t.company_consent && !t.technician_consent) return { label: 'Waiting for technician consent', className: 'bg-warning-500/10 text-warning-500' };
  if (!t.company_consent && t.technician_consent) return { label: 'Waiting for company approval', className: 'bg-warning-500/10 text-warning-500' };
  return { label: 'Not listed', className: 'bg-bg-tertiary text-text-secondary' };
}

export function SkillTeamPanel({ isManager }: { isManager: boolean }) {
  const { toast } = useToast();
  const [team, setTeam] = useState<TeamListing[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);

  const [trade, setTrade] = useState<MarketTrade | ''>('hvac');
  const [radius, setRadius] = useState('40');
  const [rate, setRate] = useState('');
  const [callout, setCallout] = useState('');
  const [remote, setRemote] = useState(false);

  const load = useCallback(async () => {
    try {
      setTeam(await skillMarketApi.myTeam());
      setFailed(false);
    } catch (e) {
      setFailed(true);
      toast(describeMarketError(e), 'error');
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (id: string, fn: () => Promise<void>, ok: string) => {
    setBusyId(id);
    try {
      await fn();
      toast(ok, 'success');
      return true;
    } catch (e) {
      toast(describeMarketError(e), 'error');
      return false;
    } finally {
      setBusyId(null);
      await load();
    }
  };

  const startEdit = (t: TeamListing) => {
    setEditId(t.technician_id);
    setTrade(t.trade ?? 'hvac');
    setRadius(String(t.service_radius_miles));
    setRate(t.hourly_rate_cents === null ? '' : String(t.hourly_rate_cents / 100));
    setCallout(t.callout_fee_cents === null ? '' : String(t.callout_fee_cents / 100));
    setRemote(t.remote_assist_enabled);
  };

  const saveListing = async (t: TeamListing) => {
    const hourly = parseRateToCents(rate);
    const fee = parseRateToCents(callout);
    const radiusNum = Number(radius);
    if (hourly !== null && !Number.isFinite(hourly)) return toast('Enter a valid hourly rate.', 'error');
    if (fee !== null && !Number.isFinite(fee)) return toast('Enter a valid call-out fee.', 'error');
    if (!Number.isInteger(radiusNum) || radiusNum < 1 || radiusNum > 500) return toast('Radius must be 1–500 miles.', 'error');
    const ok = await run(
      t.technician_id,
      () =>
        skillMarketApi.setListing({
          technicianId: t.technician_id,
          enabled: true,
          trade: trade === '' ? null : trade,
          radiusMiles: radiusNum,
          hourlyRateCents: hourly,
          calloutFeeCents: fee,
          remoteAssist: remote,
        }),
      'Listing saved. The technician must also give consent before going live.',
    );
    if (ok) setEditId(null);
  };

  if (team === null && !failed) return <SkeletonCardList count={3} />;

  if (!team || team.length === 0) {
    return <EmptyState icon={Users} title="No technicians to list" description="Invite technicians to your team first, then list them in the market." />;
  }

  return (
    <div className="space-y-4">
      <p className="rounded-xl border border-border bg-bg-secondary p-4 text-sm text-text-secondary">
        <UserCheck size={14} className="mr-1.5 inline text-accent" />
        A technician appears in the network only when <strong className="text-text-primary">both the company and the technician</strong>{' '}
        consent. Other companies never see names, phone numbers or coordinates until you accept a request.
      </p>

      <ul className="space-y-4" aria-label="Your technicians">
        {team.map((t) => {
          const st = stateOf(t);
          const busy = busyId === t.technician_id;
          const editing = editId === t.technician_id;
          return (
            <li key={t.technician_id} className="space-y-3 rounded-xl border border-border bg-bg-secondary p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-text-primary">{t.technician_name}</h3>
                  <p className="text-sm text-text-secondary">
                    {t.jobs_completed} jobs · {t.tier ?? 'unrated'}
                    {t.passport_index !== null ? ` · passport ${t.passport_index}` : ''}
                    {t.company_consent ? ` · ${formatRate(t.hourly_rate_cents)} · ${t.service_radius_miles} mi` : ''}
                  </p>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-medium ${st.className}`}>{st.label}</span>
              </div>

              {t.top_skills.length > 0 && (
                <ul className="flex flex-wrap gap-2 text-xs text-text-primary">
                  {t.top_skills.map((s) => (
                    <li key={`${s.kind}-${s.skill}`} className="rounded-full border border-border bg-bg-primary px-3 py-1">
                      {s.skill} · L{s.level} · {s.confidence}%
                    </li>
                  ))}
                </ul>
              )}

              {t.network_jobs > 0 && (
                <p className="text-xs text-text-secondary">
                  {t.network_jobs} in-network job{t.network_jobs === 1 ? '' : 's'} · {t.network_resolved_rate ?? 0}% resolved
                </p>
              )}

              {(t.company_consent || t.technician_consent) && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor={`sm-av-${t.technician_id}`} className="mb-1.5 block text-sm font-medium text-text-primary">
                      Availability
                    </label>
                    <select
                      id={`sm-av-${t.technician_id}`}
                      value={t.availability}
                      disabled={busy}
                      onChange={(e) =>
                        void run(t.technician_id, () => skillMarketApi.setAvailability(t.technician_id, e.target.value as Availability), 'Availability updated.')
                      }
                      className={selectClass}
                    >
                      <option value="open">Open for requests</option>
                      <option value="busy">Busy (ranked lower)</option>
                      <option value="offline">Offline (hidden)</option>
                    </select>
                  </div>
                  <div className="flex items-end">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run(t.technician_id, () => skillMarketApi.setAvailability(t.technician_id, t.availability, !t.paused), t.paused ? 'Listing resumed.' : 'Listing paused.')
                      }
                    >
                      {t.paused ? 'Resume listing' : 'Pause listing'}
                    </Button>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap justify-end gap-3">
                {!isManager && (
                  <Button
                    size="sm"
                    variant={t.technician_consent ? 'ghost' : 'primary'}
                    disabled={busy || !t.has_login}
                    onClick={() =>
                      void run(
                        t.technician_id,
                        () => skillMarketApi.setConsent(t.technician_id, !t.technician_consent),
                        t.technician_consent ? 'Consent withdrawn. You are hidden from the market.' : 'Consent given.',
                      )
                    }
                  >
                    {busy && <Loader2 size={14} className="animate-spin" />}
                    {t.technician_consent ? 'Withdraw my consent' : 'I agree to be listed'}
                  </Button>
                )}
                {isManager && t.company_consent && (
                  <>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(t.technician_id, () => skillMarketApi.refreshEvidence(t.technician_id), 'Evidence refreshed.')}>
                      <RefreshCw size={14} /> Refresh evidence
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          t.technician_id,
                          () =>
                            skillMarketApi.setListing({
                              technicianId: t.technician_id,
                              enabled: false,
                              trade: t.trade,
                              radiusMiles: t.service_radius_miles,
                              hourlyRateCents: t.hourly_rate_cents,
                              calloutFeeCents: t.callout_fee_cents,
                              remoteAssist: t.remote_assist_enabled,
                            }),
                          'Removed from the market.',
                        )
                      }
                    >
                      Remove
                    </Button>
                  </>
                )}
                {isManager && !editing && (
                  <Button size="sm" disabled={busy} onClick={() => startEdit(t)}>
                    {t.company_consent ? 'Edit terms' : 'List technician'}
                  </Button>
                )}
              </div>

              {isManager && editing && (
                <div className="space-y-4 rounded-xl border border-border bg-bg-primary p-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor={`sm-trade-${t.technician_id}`} className="mb-1.5 block text-sm font-medium text-text-primary">
                        Trade
                      </label>
                      <select id={`sm-trade-${t.technician_id}`} value={trade} onChange={(e) => setTrade(e.target.value as MarketTrade | '')} className={selectClass}>
                        <option value="">Any trade</option>
                        {TRADE_OPTIONS.map((x) => (
                          <option key={x} value={x}>
                            {x.charAt(0).toUpperCase() + x.slice(1)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <Input label="Service radius (miles)" inputMode="numeric" value={radius} onChange={(e) => setRadius(e.target.value)} />
                    <Input label="Hourly rate ($)" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} helperText="Used to match requests with a price ceiling." />
                    <Input label="Call-out fee ($, optional)" inputMode="decimal" value={callout} onChange={(e) => setCallout(e.target.value)} />
                  </div>
                  <label className="flex items-center gap-2 text-sm text-text-primary">
                    <input type="checkbox" checked={remote} onChange={(e) => setRemote(e.target.checked)} className="focus-ring h-4 w-4 rounded border-border" />
                    Available for remote diagnosis
                  </label>
                  <div className="flex justify-end gap-3">
                    <Button variant="ghost" size="sm" onClick={() => setEditId(null)} disabled={busy}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={() => void saveListing(t)} disabled={busy}>
                      {busy && <Loader2 size={14} className="animate-spin" />}
                      Save listing
                    </Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
