import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { useRealtimeSubscription } from '@/lib/realtime';
import { TRADE_CATEGORY_LABELS } from '@/lib/laborMarketplace';
import { formatMoney } from '@/lib/contractorNetwork';
import {
  MARKET_STATE_COLORS,
  MARKET_STATE_LABELS,
  POSITION_COPY,
  liquidityApi,
  marketState,
  type MarketPulse,
} from '@/lib/capacityLiquidity';

const tradeLabel = (t: string) => (TRADE_CATEGORY_LABELS as Record<string, string>)[t] ?? t;

function formatMinutes(min: number | null): string {
  if (min == null) return '—';
  if (min < 60) return `${Math.round(min)} min`;
  const h = min / 60;
  return `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)} h`;
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-3">
      <p className="text-xl font-bold text-text-primary">{value}</p>
      <p className="text-xs text-text-secondary">{label}</p>
    </div>
  );
}

/** Demand <-> capacity at a glance: my position, network totals, and hot markets. */
export function MarketPulsePanel() {
  const [pulse, setPulse] = useState<MarketPulse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notMember, setNotMember] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const data = await liquidityApi.pulse();
      setPulse(data);
      setNotMember(false);
      setFailed(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('NOT_A_MEMBER')) setNotMember(true);
      else setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 60_000);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(timer.current);
    };
  }, [load]);

  const schedule = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void load(), 500);
  }, [load]);

  useRealtimeSubscription({
    channelName: 'capacity-pulse-handoffs',
    table: 'network_handoffs',
    event: '*',
    onChange: schedule,
    enabled: !!pulse,
  });
  useRealtimeSubscription({
    channelName: 'capacity-pulse-listings',
    table: 'network_capacity_listings',
    event: '*',
    onChange: schedule,
    enabled: !!pulse,
  });

  if (loading && !pulse) return <SkeletonCardList count={1} />;
  if (notMember) {
    return (
      <EmptyState
        icon={Activity}
        title="Join the Contractor Network to see the live market"
        description="Once you're a member you'll see waiting jobs, idle technicians and where demand is outrunning supply."
      />
    );
  }
  if (!pulse) {
    return failed ? (
      <EmptyState
        icon={Activity}
        title="Live market is unavailable"
        description="We couldn't load market data. It will retry automatically."
        action={{ label: 'Retry', onClick: () => void load() }}
      />
    ) : null;
  }

  const { mine, network, markets } = pulse;
  const copy = POSITION_COPY[mine.position];

  return (
    <section className="space-y-4 rounded-xl border border-border bg-bg-secondary p-5" aria-label="Live capacity market">
      <div className="flex items-center gap-2">
        <Activity size={18} className="text-accent" />
        <h2 className="text-base font-semibold text-text-primary">Live capacity market</h2>
      </div>

      <div className="rounded-xl border border-border bg-bg-primary p-4">
        <p className="font-semibold text-text-primary">{copy.title}</p>
        <p className="mt-0.5 text-sm text-text-secondary">{copy.body}</p>
        {mine.open_jobs_for_my_listings > 0 && (
          <p className="mt-2 text-sm text-accent">
            {mine.open_jobs_for_my_listings} open job{mine.open_jobs_for_my_listings === 1 ? '' : 's'} in your area fit your
            listing —{' '}
            <Link to="/dashboard/network/handoffs" className="focus-ring underline">
              browse Job Handoffs
            </Link>
            .
          </p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Your jobs waiting" value={mine.waiting_jobs} />
        <Metric label={`Team load (${mine.active_claimed}/${mine.max_concurrent})`} value={`${mine.load_pct}%`} />
        <Metric label="Your idle technicians" value={mine.idle_technicians} />
        <Metric label="Your idle vans" value={mine.idle_vehicles} />
      </div>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Open jobs (network)" value={network.open_jobs} />
        <Metric label="Open job value" value={formatMoney(network.open_value_cents)} />
        <Metric label="Technicians available" value={network.available_technicians} />
        <Metric label="Idle vans" value={network.idle_vehicles} />
        <Metric label="Median time to accept" value={formatMinutes(network.median_minutes_to_accept_30d)} />
        <Metric label="30-day fill rate" value={network.fill_rate_30d_pct == null ? '—' : `${network.fill_rate_30d_pct}%`} />
      </div>

      {markets.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No live demand or listed capacity yet"
          description="Post a job or publish idle capacity and this market fills in."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead className="bg-bg-tertiary text-xs text-text-secondary">
              <tr>
                <th className="px-3 py-2 font-medium">Region</th>
                <th className="px-3 py-2 font-medium">Trade</th>
                <th className="px-3 py-2 text-right font-medium">Jobs</th>
                <th className="px-3 py-2 text-right font-medium">Techs</th>
                <th className="px-3 py-2 text-right font-medium">Vans</th>
                <th className="px-3 py-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {markets.map((m) => {
                const state = marketState(m.jobs, m.techs);
                return (
                  <tr key={`${m.region}|${m.trade}`}>
                    <td className="px-3 py-2 capitalize text-text-primary">{m.region}</td>
                    <td className="px-3 py-2 text-text-secondary">{tradeLabel(m.trade)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-text-primary">{m.jobs}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-text-primary">{m.techs}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-text-primary">{m.vans}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${MARKET_STATE_COLORS[state]}`}>
                        {MARKET_STATE_LABELS[state]}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
