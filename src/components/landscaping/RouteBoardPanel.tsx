import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, CloudRain, SkipForward, Snowflake, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import { Pill, SelectField } from '@/components/tradePacks/shared';
import {
  buildHolidayLookup,
  addDays,
  makeupDate,
  moveStop,
  rerouteDay,
  LANDSCAPING_PACK,
  type DayStop,
} from '@/lib/tradePacks/landscaping/index';
import {
  friendlyLandscapingError,
  generateVisits,
  listCrews,
  listVisits,
  reassignVisits,
  recordSnowEvent,
  reorderDay,
  skipForWeather,
  skipVisit,
  useLandscapeLoader,
  type VisitWithContext,
} from '@/lib/landscapingApi';
import { PanelState, Section, dayLabel, timeLabel, todayISO } from './ui';
import { VisitChecklist } from './VisitChecklist';

const toStop = (v: VisitWithContext): DayStop => ({
  id: v.id,
  lat: v.lat,
  lng: v.lng,
  minutes: v.planned_minutes,
  state: v.status === 'in_progress' ? 'in_progress' : v.status === 'completed' ? 'done' : v.status === 'skipped' ? 'skipped' : 'planned',
});

const statusTone = (s: string) => (s === 'completed' ? 'success' : s === 'skipped' ? 'warning' : s === 'in_progress' ? 'neutral' : 'neutral');

export function RouteBoardPanel({ ownerId, canManage }: { ownerId: string; canManage: boolean }) {
  const { toast } = useToast();
  const [date, setDate] = useState(todayISO());
  const [crewId, setCrewId] = useState('');
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmRoute, setConfirmRoute] = useState<{ order: string[]; overflow: number; moved: boolean } | null>(null);
  const [weatherFor, setWeatherFor] = useState<VisitWithContext | null>(null);
  const [wxReason, setWxReason] = useState('');
  const [wxMakeup, setWxMakeup] = useState('');
  const [snowCm, setSnowCm] = useState('');

  const crews = useLandscapeLoader((o) => listCrews(o), []);
  const visits = useLandscapeLoader((o) => listVisits(o, date, date), [date]);

  const activeCrews = (crews.data ?? []).filter((c) => c.active);
  const crew = crewId || activeCrews[0]?.id || '';
  const day = useMemo(
    () =>
      (visits.data ?? [])
        .filter((v) => v.status !== 'cancelled' && v.crew_id === crew)
        .sort((a, b) => (a.route_position ?? 1e9) - (b.route_position ?? 1e9) || a.scheduled_at.localeCompare(b.scheduled_at)),
    [visits.data, crew],
  );
  const unassigned = (visits.data ?? []).filter((v) => v.status !== 'cancelled' && !v.crew_id);
  const stops = useMemo(() => day.map(toStop), [day]);
  const routeCfg = LANDSCAPING_PACK.routes;

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok, 'success');
      visits.reload();
    } catch (e) {
      toast(friendlyLandscapingError(e), 'error');
      visits.reload(); // the day may have changed under us
    } finally {
      setBusy(false);
    }
  };

  const move = (id: string, delta: -1 | 1) => {
    const from = day.findIndex((v) => v.id === id);
    try {
      const order = moveStop(stops, id, from + delta);
      void act(() => reorderDay(crew, date, order, 'Manual re-order'), 'Route updated');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const optimize = () => {
    const r = rerouteDay(stops, { workdayMinutes: routeCfg.workdayMinutes, speedKmh: routeCfg.speedKmh });
    if (!r.changed && r.overflow.length === 0) {
      toast('The route is already in the best order.', 'success');
      return;
    }
    setConfirmRoute({ order: r.order, overflow: r.overflow.length, moved: r.changed });
  };

  const openWeather = (v: VisitWithContext) => {
    const hol = buildHolidayLookup(v.visit_date, addDays(v.visit_date, 14), 'us_core');
    setWeatherFor(v);
    setWxReason('');
    setWxMakeup(makeupDate(v.visit_date, 'next_workday', [1, 2, 3, 4, 5], hol) ?? '');
  };

  return (
    <div className="space-y-4">
      <Section
        title="Route board"
        description="Today's stops per crew. Finished and in-progress stops never move; re-order the rest by hand or let Vireek re-optimize."
        actions={canManage && <Button size="sm" variant="secondary" loading={busy} onClick={() => void act(async () => { const n = await generateVisits(undefined, 28); toast(`${n} new visit(s) generated`, 'success'); }, 'Schedule up to date')}>Generate schedule</Button>}
      >
        <div className="mb-3 grid gap-3 sm:grid-cols-3">
          <Input label="Date" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <SelectField label="Crew" value={crew} onChange={setCrewId} disabled={activeCrews.length === 0}>
            {activeCrews.length === 0 && <option value="">No crews yet</option>}
            {activeCrews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </SelectField>
          <div className="flex items-end">
            <Button variant="secondary" size="sm" disabled={busy || day.filter((v) => v.status === 'scheduled').length < 2} onClick={optimize}>
              <Wand2 className="mr-1 h-4 w-4" aria-hidden="true" />Re-route remaining
            </Button>
          </div>
        </div>

        {crews.data && activeCrews.length === 0 ? (
          <p className="text-sm text-text-secondary">Create a crew in “Crews &amp; equipment” first.</p>
        ) : (
          <PanelState loading={visits.loading} error={visits.error} empty={day.length === 0} emptyTitle={`No stops for ${dayLabel(date)}`} emptyDescription="Visits appear once a contract is active and the schedule has been generated." onRetry={visits.reload}>
            <ol className="space-y-2" aria-label={`Stops for ${dayLabel(date)}`}>
              {day.map((v, i) => {
                const locked = v.status !== 'scheduled';
                return (
                  <li key={v.id} className="rounded-xl border border-border bg-bg-secondary p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <button className="min-w-0 flex-1 text-left" aria-expanded={openId === v.id} onClick={() => setOpenId(openId === v.id ? null : v.id)}>
                        <span className="text-sm font-medium text-text-primary">{i + 1}. {v.customer_name}</span>
                        <span className="ml-2 text-xs text-text-secondary">{timeLabel(v.scheduled_at)} · {v.planned_minutes} min</span>
                        <span className="block truncate text-xs text-text-secondary">{v.title}{v.address ? ` — ${v.address}` : ''}</span>
                      </button>
                      <div className="flex flex-wrap items-center gap-1">
                        <Pill tone={statusTone(v.status)}>{v.status.replace('_', ' ')}</Pill>
                        {v.kind !== 'maintenance' && <Pill>{v.kind}</Pill>}
                        {v.skip_reason && <Pill tone="warning">{v.skip_reason.replace('_', ' ')}</Pill>}
                        {v.attention && <Pill tone="danger">needs attention</Pill>}
                      </div>
                    </div>
                    {v.attention && <p className="mt-1 text-xs text-danger">{v.attention}</p>}
                    {v.weather?.reasons?.length ? <p className="mt-1 text-xs text-text-secondary">Weather: {v.weather.reasons.join(', ')}</p> : null}
                    {!locked && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        <Button size="xs" variant="ghost" aria-label={`Move ${v.customer_name} up`} disabled={busy || i === 0 || day[i - 1].status !== 'scheduled'} onClick={() => move(v.id, -1)}><ArrowUp className="h-4 w-4" /></Button>
                        <Button size="xs" variant="ghost" aria-label={`Move ${v.customer_name} down`} disabled={busy || i === day.length - 1} onClick={() => move(v.id, 1)}><ArrowDown className="h-4 w-4" /></Button>
                        <Button size="xs" variant="ghost" disabled={busy} onClick={() => openWeather(v)}><CloudRain className="mr-1 h-4 w-4" />Weather skip</Button>
                        <Button size="xs" variant="ghost" disabled={busy} onClick={() => void act(() => skipVisit(v.id, 'manual', null), 'Visit skipped')}><SkipForward className="mr-1 h-4 w-4" />Skip</Button>
                        {activeCrews.length > 1 && (
                          <select aria-label={`Move ${v.customer_name} to another crew`} className="focus-ring rounded-lg border border-border bg-bg-primary px-2 py-1 text-xs" value="" disabled={busy} onChange={(e) => e.target.value && void act(() => reassignVisits([v.id], e.target.value, 'Crew change'), 'Moved to the other crew')}>
                            <option value="">Move to crew…</option>
                            {activeCrews.filter((c) => c.id !== crew).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                          </select>
                        )}
                      </div>
                    )}
                    {openId === v.id && <VisitChecklist ownerId={ownerId} visit={v} onChanged={visits.reload} />}
                  </li>
                );
              })}
            </ol>
          </PanelState>
        )}
        {unassigned.length > 0 && <p className="mt-3 text-sm text-warning">{unassigned.length} visit(s) on this day have no crew. Assign a default crew on the contract.</p>}
      </Section>

      {canManage && (
        <Section title="Snow event" description="Record a snowfall: one visit is created for every contract whose snow add-on triggers at or below this depth. Recording the same day twice changes nothing.">
          <div className="flex flex-wrap items-end gap-3">
            <Input label="Snowfall (cm)" type="number" min={0.5} max={200} step={0.5} value={snowCm} onChange={(e) => setSnowCm(e.target.value)} />
            <Button size="sm" disabled={busy || !(Number(snowCm) >= 0.5)} onClick={() => void act(async () => { const n = await recordSnowEvent(date, Number(snowCm)); toast(n === 0 ? 'No new snow visits (already recorded or no add-on triggers).' : `${n} snow visit(s) created`, 'success'); }, 'Snow event recorded')}>
              <Snowflake className="mr-1 h-4 w-4" aria-hidden="true" />Record for {dayLabel(date)}
            </Button>
          </div>
        </Section>
      )}

      <ConfirmDialog
        open={confirmRoute !== null}
        title="Re-route the remaining stops?"
        description={confirmRoute ? `${confirmRoute.moved ? 'The unfinished stops will be re-ordered to cut driving time. ' : ''}${confirmRoute.overflow > 0 ? `${confirmRoute.overflow} stop(s) no longer fit in the workday and stay at the end — move them to another day or crew.` : 'Everything still fits in the workday.'}` : ''}
        confirmLabel="Re-route"
        onCancel={() => setConfirmRoute(null)}
        onConfirm={async () => {
          const c = confirmRoute;
          setConfirmRoute(null);
          if (c) await act(() => reorderDay(crew, date, c.order, 'Re-optimized'), 'Route updated');
        }}
      />

      {weatherFor && (
        <div role="dialog" aria-modal="true" aria-label="Weather skip" onKeyDown={(e) => e.key === 'Escape' && setWeatherFor(null)} className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
          <div className="w-full max-w-md space-y-3 rounded-2xl bg-bg-secondary p-4 shadow-xl">
            <h3 className="text-base font-semibold text-text-primary">Skip {weatherFor.customer_name} for weather</h3>
            <Input label="What happened?" autoFocus value={wxReason} onChange={(e) => setWxReason(e.target.value)} maxLength={200} helperText="e.g. Heavy rain, ground saturated" />
            <Input label="Make-up date (optional)" type="date" min={addDays(weatherFor.visit_date, 1)} max={addDays(weatherFor.visit_date, 14)} value={wxMakeup} onChange={(e) => setWxMakeup(e.target.value)} helperText="Leave empty to skip without a make-up visit." />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setWeatherFor(null)}>Cancel</Button>
              <Button size="sm" loading={busy} onClick={() => { const v = weatherFor; setWeatherFor(null); void act(() => skipForWeather(v.id, wxReason.trim() || null, wxMakeup || null), 'Visit skipped for weather'); }}>Skip visit</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
