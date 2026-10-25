import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Route as RouteIcon, Trash2, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import {
  addStops,
  createRoute,
  deleteRoute,
  fetchPlanCandidates,
  fetchRoutes,
  fetchTeam,
  friendlyTradePackError,
  removeStop,
  reorderStops,
  type PlanCandidate,
  type RouteStop,
  type TeamOption,
  type TradeRoute,
} from '@/lib/tradePacksApi';
import { WEEKDAY_LABELS, groupAgreementsForRoutes, jobMatchesPack, planRouteDay, type TradePack } from '@/lib/tradePacks';
import { Pill, SelectField } from './shared';

export function RoutesPanel({ pack, ownerId, canManage }: { pack: TradePack; ownerId: string; canManage: boolean }) {
  const { toast } = useToast();
  const [routes, setRoutes] = useState<TradeRoute[]>([]);
  const [stops, setStops] = useState<RouteStop[]>([]);
  const [team, setTeam] = useState<TeamOption[]>([]);
  const [plans, setPlans] = useState<PlanCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<TradeRoute | null>(null);

  const [name, setName] = useState('');
  const [weekday, setWeekday] = useState(String(pack.routes.weekdays[0] ?? 1));
  const [techId, setTechId] = useState('');
  const [startTime, setStartTime] = useState('08:00');

  const [addPlanId, setAddPlanId] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<{ routeId: string; label: string; address: string; lat: string; lng: string; minutes: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, t, p] = await Promise.all([fetchRoutes(ownerId, pack.key), fetchTeam(ownerId), fetchPlanCandidates(ownerId)]);
      setRoutes(r.routes);
      setStops(r.stops);
      setTeam(t);
      setPlans(p.filter((x) => jobMatchesPack(pack, x.service_type)));
    } catch (e) {
      toast(friendlyTradePackError(e, 'Could not load routes.'), 'error');
    } finally {
      setLoading(false);
    }
  }, [ownerId, pack, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const techName = (id: string | null) => team.find((t) => t.id === id)?.member_name ?? 'Unassigned';
  const stopsOf = useCallback((routeId: string) => stops.filter((s) => s.route_id === routeId).sort((a, b) => a.position - b.position), [stops]);
  const usedAgreementIds = useMemo(() => new Set(stops.map((s) => s.agreement_id).filter(Boolean) as string[]), [stops]);

  const run = async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok, 'success');
      await load();
    } catch (e) {
      toast(friendlyTradePackError(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    run(async () => {
      await createRoute(ownerId, { packKey: pack.key, name, weekday: Number(weekday), technicianId: techId || null, startTime });
      setName('');
    }, 'Route created.');

  const buildFromPlans = () =>
    run(async () => {
      const groups = groupAgreementsForRoutes(pack, plans);
      let created = 0;
      for (const g of groups) {
        const fresh = plans.filter((p) => g.agreementIds.includes(p.id) && !usedAgreementIds.has(p.id));
        if (!fresh.length) continue;
        const routeName = `${WEEKDAY_LABELS[g.weekday]} — ${techName(g.technicianId)}`;
        const route = routes.find((r) => r.name.toLowerCase() === routeName.toLowerCase());
        const routeId = route?.id ?? (await createRoute(ownerId, { packKey: pack.key, name: routeName, weekday: g.weekday, technicianId: g.technicianId, startTime: '08:00' }));
        const start = route ? stopsOf(route.id).length : 0;
        await addStops(ownerId, routeId, start, fresh.map((p) => ({ agreementId: p.id, customerId: p.customer_id, label: p.customer_name, address: p.address, minutes: p.duration_minutes || pack.routes.defaultStopMinutes })));
        created += fresh.length;
      }
      if (!created) throw new Error('No new weekly plans to place on routes.');
    }, 'Routes built from your weekly plans.');

  const move = (routeId: string, idx: number, delta: -1 | 1) => {
    const list = stopsOf(routeId).map((s) => s.id);
    const j = idx + delta;
    if (j < 0 || j >= list.length) return;
    [list[idx], list[j]] = [list[j], list[idx]];
    void run(() => reorderStops(routeId, list));
  };

  const optimize = (route: TradeRoute) =>
    run(async () => {
      const list = stopsOf(route.id);
      const plan = planRouteDay(
        list.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng, minutes: s.est_minutes })),
        { workdayMinutes: Number.MAX_SAFE_INTEGER, speedKmh: pack.routes.speedKmh },
      );
      await reorderStops(route.id, [...plan.stops, ...plan.overflow].map((s) => s.id));
    }, 'Stops re-ordered by nearest neighbour.');

  const addFromPlan = (route: TradeRoute) => {
    const p = plans.find((x) => x.id === addPlanId[route.id]);
    if (!p) return;
    void run(async () => {
      await addStops(ownerId, route.id, stopsOf(route.id).length, [{ agreementId: p.id, customerId: p.customer_id, label: p.customer_name, address: p.address, minutes: p.duration_minutes || pack.routes.defaultStopMinutes }]);
      setAddPlanId((s) => ({ ...s, [route.id]: '' }));
    });
  };

  const addCustom = () => {
    if (!custom) return;
    const lat = custom.lat.trim() ? Number(custom.lat) : null;
    const lng = custom.lng.trim() ? Number(custom.lng) : null;
    if ((lat === null) !== (lng === null) || (lat !== null && (!Number.isFinite(lat) || Math.abs(lat) > 90)) || (lng !== null && (!Number.isFinite(lng) || Math.abs(lng) > 180))) {
      toast('Enter both latitude and longitude, or leave both empty.', 'error');
      return;
    }
    void run(async () => {
      await addStops(ownerId, custom.routeId, stopsOf(custom.routeId).length, [{ label: custom.label, address: custom.address || null, lat, lng, minutes: Number(custom.minutes) || pack.routes.defaultStopMinutes }]);
      setCustom(null);
    });
  };

  const weeklyCount = groupAgreementsForRoutes(pack, plans).reduce((n, g) => n + g.agreementIds.filter((id) => !usedAgreementIds.has(id)).length, 0);

  if (loading) return <Skeleton className="h-40 w-full rounded-2xl" />;

  return (
    <div className="space-y-4">
      {canManage && (
        <Card className="space-y-4 p-6">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[12rem] flex-1">
              <Input label="Route name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Monday — North" />
            </div>
            <SelectField label="Day" value={weekday} onChange={setWeekday}>
              {WEEKDAY_LABELS.map((d, i) => (
                <option key={d} value={i}>{d}</option>
              ))}
            </SelectField>
            <SelectField label="Technician" value={techId} onChange={setTechId}>
              <option value="">Unassigned</option>
              {team.map((t) => (
                <option key={t.id} value={t.id}>{t.member_name ?? 'Unnamed'}</option>
              ))}
            </SelectField>
            <Input label="Start" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            <Button onClick={create} disabled={busy || !name.trim()}>Add route</Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-sm text-text-secondary">
            <span>{weeklyCount} active weekly plan{weeklyCount === 1 ? '' : 's'} not on a route yet (grouped by technician and visit weekday).</span>
            <Button variant="secondary" size="sm" onClick={buildFromPlans} disabled={busy || weeklyCount === 0}>
              <Wand2 size={14} /> Build routes from plans
            </Button>
          </div>
        </Card>
      )}

      {routes.length === 0 ? (
        <EmptyState icon={RouteIcon} title="No routes yet" description="Group recurring visits into a technician's day. Weekly plans keep the same weekday, so they fit fixed routes; monthly plans stay on the dispatch board." />
      ) : (
        routes.map((r) => {
          const list = stopsOf(r.id);
          const cap = planRouteDay(list.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng, minutes: s.est_minutes })), { workdayMinutes: pack.routes.workdayMinutes, speedKmh: pack.routes.speedKmh });
          const geocoded = list.filter((s) => s.lat !== null).length;
          const free = plans.filter((p) => !usedAgreementIds.has(p.id));
          return (
            <Card key={r.id} className="space-y-3 p-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-base font-semibold text-text-primary">{r.name}</h3>
                  <p className="text-sm text-text-secondary">{WEEKDAY_LABELS[r.weekday]} · {techName(r.technician_id)} · starts {r.start_time.slice(0, 5)}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={cap.overflow.length ? 'danger' : 'success'}>
                    {list.reduce((n, s) => n + s.est_minutes, 0)} min service · {cap.overflow.length ? `${cap.overflow.length} over a ${Math.round(pack.routes.workdayMinutes / 60)} h day` : 'fits the day'}
                  </Pill>
                  {canManage && (
                    <>
                      <Button variant="secondary" size="sm" onClick={() => optimize(r)} disabled={busy || geocoded < 2}>Optimize</Button>
                      <button type="button" aria-label={`Delete ${r.name}`} className="focus-ring rounded p-1 text-text-secondary hover:text-danger" onClick={() => setDeleting(r)}><Trash2 size={16} /></button>
                    </>
                  )}
                </div>
              </div>
              {geocoded < 2 && list.length > 1 && <p className="text-xs text-text-secondary">Add coordinates to at least two stops to enable nearest-neighbour optimization.</p>}

              {list.length === 0 ? (
                <p className="text-sm text-text-secondary">This route has no stops.</p>
              ) : (
                <ol className="space-y-1.5">
                  {list.map((s, i) => (
                    <li key={s.id} className="flex items-center justify-between gap-2 rounded-lg bg-bg-primary px-3 py-2 text-sm">
                      <span className="min-w-0">
                        <span className="mr-2 text-text-secondary">{i + 1}.</span>
                        <span className="font-medium text-text-primary">{s.label}</span>
                        {s.address && <span className="ml-2 truncate text-text-secondary">{s.address}</span>}
                        <span className="ml-2 text-xs text-text-secondary">{s.est_minutes} min</span>
                      </span>
                      {canManage && (
                        <span className="flex shrink-0 gap-1">
                          <button type="button" aria-label="Move up" disabled={busy || i === 0} className="focus-ring rounded p-1 text-text-secondary hover:text-text-primary disabled:opacity-30" onClick={() => move(r.id, i, -1)}><ArrowUp size={14} /></button>
                          <button type="button" aria-label="Move down" disabled={busy || i === list.length - 1} className="focus-ring rounded p-1 text-text-secondary hover:text-text-primary disabled:opacity-30" onClick={() => move(r.id, i, 1)}><ArrowDown size={14} /></button>
                          <button type="button" aria-label={`Remove ${s.label}`} className="focus-ring rounded p-1 text-text-secondary hover:text-danger" onClick={() => run(() => removeStop(ownerId, s.id))}><Trash2 size={14} /></button>
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              )}

              {canManage && (
                <div className="space-y-3 border-t border-border pt-3">
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="min-w-[14rem] flex-1">
                      <SelectField label="Add a recurring plan" value={addPlanId[r.id] ?? ''} onChange={(v) => setAddPlanId((s) => ({ ...s, [r.id]: v }))}>
                        <option value="">Select a plan…</option>
                        {free.map((p) => (
                          <option key={p.id} value={p.id}>{p.customer_name} — {p.address}</option>
                        ))}
                      </SelectField>
                    </div>
                    <Button variant="secondary" size="sm" onClick={() => addFromPlan(r)} disabled={busy || !addPlanId[r.id]}>Add</Button>
                    <Button variant="ghost" size="sm" onClick={() => setCustom({ routeId: r.id, label: '', address: '', lat: '', lng: '', minutes: String(pack.routes.defaultStopMinutes) })}>Custom stop</Button>
                  </div>
                  {custom?.routeId === r.id && (
                    <div className="grid gap-3 sm:grid-cols-5">
                      <div className="sm:col-span-2"><Input label="Name" value={custom.label} onChange={(e) => setCustom({ ...custom, label: e.target.value })} /></div>
                      <Input label="Latitude" inputMode="decimal" value={custom.lat} onChange={(e) => setCustom({ ...custom, lat: e.target.value })} />
                      <Input label="Longitude" inputMode="decimal" value={custom.lng} onChange={(e) => setCustom({ ...custom, lng: e.target.value })} />
                      <Input label="Minutes" type="number" min={5} max={480} value={custom.minutes} onChange={(e) => setCustom({ ...custom, minutes: e.target.value })} />
                      <div className="sm:col-span-4"><Input label="Address" value={custom.address} onChange={(e) => setCustom({ ...custom, address: e.target.value })} /></div>
                      <div className="flex items-end justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setCustom(null)}>Cancel</Button>
                        <Button size="sm" onClick={addCustom} disabled={busy || !custom.label.trim()}>Add stop</Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Card>
          );
        })
      )}

      <ConfirmDialog
        open={!!deleting}
        title="Delete route?"
        description={`“${deleting?.name ?? ''}” and its stops will be removed. Recurring plans and past records are not affected.`}
        confirmLabel="Delete route"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          const r = deleting;
          setDeleting(null);
          if (r) await run(() => deleteRoute(ownerId, r.id), 'Route deleted.');
        }}
      />
    </div>
  );
}
