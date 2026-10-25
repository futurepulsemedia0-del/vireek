import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Truck } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { ALERT_TYPE_LABELS, listAlerts, sortBySeverity, type TruckAlert } from '@/lib/truckOps';

const POLL_MS = 120_000;

/**
 * Compact strip for the dispatch board: open truck-stock alerts (stock-outs, jobs that will run short of
 * parts, overdue audits). Updates live when alerts change and shows nothing when everything is fine
 * or the alerts can't be read, so it can never get in the way of dispatching.
 */
export function TruckAlertsBanner() {
  const [alerts, setAlerts] = useState<TruckAlert[]>([]);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      setAlerts(await listAlerts(['open']));
    } catch {
      setAlerts([]);
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = window.setInterval(() => void load(), POLL_MS);
    const channel = supabase
      .channel('truck-stock-alerts-banner')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'truck_stock_alerts' }, () => {
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => void load(), 800);
      })
      .subscribe();
    return () => {
      window.clearInterval(poll);
      if (timer.current) window.clearTimeout(timer.current);
      void supabase.removeChannel(channel);
    };
  }, [load]);

  const important = sortBySeverity(alerts.filter((a) => a.severity !== 'info'));
  if (important.length === 0) return null;

  const critical = important.filter((a) => a.severity === 'critical').length;
  const top = important.slice(0, 2);

  return (
    <div
      role="status"
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-3 py-2 text-sm ${
        critical > 0 ? 'border-danger/30 bg-danger/10 text-danger' : 'border-warning-500/30 bg-warning-500/10 text-warning-500'
      }`}
    >
      <Truck className="h-4 w-4 flex-shrink-0" aria-hidden />
      <span className="font-semibold">
        {important.length} truck stock alert{important.length === 1 ? '' : 's'}
        {critical > 0 ? ` (${critical} critical)` : ''}
      </span>
      <span className="min-w-0 flex-1 truncate text-text-secondary">
        {top.map((a) => `${ALERT_TYPE_LABELS[a.alert_type]}: ${a.message}`).join(' · ')}
      </span>
      <Link to="/dashboard/inventory/trucks?tab=alerts" className="font-semibold underline">
        Review
      </Link>
    </div>
  );
}
