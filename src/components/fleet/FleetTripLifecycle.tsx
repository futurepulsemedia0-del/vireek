import { CircleCheck, Hammer, MapPinned, Navigation, ShieldQuestion } from 'lucide-react';
import { formatCents, formatMinutes, type FleetTrip } from '@/lib/fleetIntelligence';

function Step({
  icon: Icon,
  title,
  primary,
  secondary,
  tone = 'default',
}: {
  icon: typeof Navigation;
  title: string;
  primary: string;
  secondary: string;
  tone?: 'default' | 'good' | 'bad' | 'muted';
}) {
  const toneClass =
    tone === 'good' ? 'text-success-500' : tone === 'bad' ? 'text-danger' : tone === 'muted' ? 'text-text-secondary' : 'text-text-primary';
  return (
    <div className="min-w-0 flex-1 rounded-xl border border-border bg-bg-primary p-3">
      <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
        <Icon size={12} /> {title}
      </p>
      <p className={`text-sm font-semibold ${toneClass}`}>{primary}</p>
      <p className="text-[11px] text-text-secondary">{secondary}</p>
    </div>
  );
}

/** Drive → Arrival → Work → Outcome for one scored trip. */
export function FleetTripLifecycle({ trip }: { trip: FleetTrip }) {
  const delay = trip.arrival_delay_minutes;
  const late = delay != null && delay > 10;
  return (
    <div className="grid gap-2 sm:grid-cols-4">
      <Step
        icon={Navigation}
        title="Drive"
        primary={formatMinutes(trip.drive_minutes)}
        secondary={`${trip.distance_miles != null ? `${trip.distance_miles.toFixed(1)} mi` : 'distance unknown'} · ${trip.distance_source.replace('_', ' ')}${trip.idle_minutes ? ` · ${formatMinutes(trip.idle_minutes)} idle` : ''}`}
      />
      <Step
        icon={trip.arrival_verified ? MapPinned : ShieldQuestion}
        title="Arrival"
        primary={delay == null ? '—' : delay <= 0 ? `${Math.abs(Math.round(delay))}m early` : `${Math.round(delay)}m late`}
        secondary={trip.arrival_verified ? 'Confirmed by truck GPS' : 'Estimated from work start'}
        tone={delay == null ? 'muted' : late ? 'bad' : 'good'}
      />
      <Step
        icon={Hammer}
        title="Work"
        primary={formatMinutes(trip.on_site_minutes)}
        secondary={trip.service_type ?? 'General service'}
      />
      <Step
        icon={CircleCheck}
        title="Outcome"
        primary={trip.revenue_cents > 0 ? formatCents(trip.contribution_cents) : 'Not invoiced'}
        secondary={
          trip.revenue_cents > 0
            ? `${trip.margin_pct != null ? `${trip.margin_pct.toFixed(1)}% margin · ` : ''}cost ${formatCents(trip.fully_loaded_cost_cents)}`
            : `cost so far ${formatCents(trip.fully_loaded_cost_cents)}`
        }
        tone={trip.revenue_cents > 0 ? (trip.contribution_cents < 0 ? 'bad' : 'good') : 'muted'}
      />
    </div>
  );
}
