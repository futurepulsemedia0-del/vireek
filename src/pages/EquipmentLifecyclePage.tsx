import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { HeartPulse, TriangleAlert as AlertTriangle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase } from '@/lib/supabase';

interface AlertRow {
  id: string;
  equipment_id: string;
  risk_level: 'low' | 'medium' | 'high';
  predicted_issue: string;
  recommended_action: string | null;
  predicted_service_due: string | null;
  created_at: string;
  equipment: { equipment_type: string; make: string | null; model: string | null; customer_id: string } | null;
}

const RISK_STYLES: Record<string, string> = {
  high: 'bg-danger-500/10 text-danger-500',
  medium: 'bg-warning-500/10 text-warning-500',
  low: 'bg-success-500/10 text-success-500',
};

export function EquipmentLifecyclePage() {
  const { user } = useAuth();
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [customerNames, setCustomerNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const fetchAlerts = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data } = await supabase
      .from('equipment_maintenance_alerts')
      .select('id, equipment_id, risk_level, predicted_issue, recommended_action, predicted_service_due, created_at, equipment:equipment_id (equipment_type, make, model, customer_id)')
      .eq('is_dismissed', false)
      .order('risk_level', { ascending: true })
      .order('created_at', { ascending: false });

    const rows = (data as unknown as AlertRow[]) ?? [];
    setAlerts(rows);

    const customerIds = Array.from(new Set(rows.map((r) => r.equipment?.customer_id).filter(Boolean))) as string[];
    if (customerIds.length > 0) {
      const { data: customers } = await supabase.from('customers').select('id, name').in('id', customerIds);
      setCustomerNames(Object.fromEntries((customers ?? []).map((c) => [c.id as string, c.name as string])));
    }
    setLoading(false);
  }, [user]);

  useEffect(() => { fetchAlerts(); }, [fetchAlerts]);

  const dismiss = async (id: string) => {
    await supabase.from('equipment_maintenance_alerts').update({ is_dismissed: true }).eq('id', id);
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  };

  return (
    <DashboardLayout activeLabel="Equipment Health">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><HeartPulse size={24} /></span>
        <div>
          <h1 className="text-xl font-bold text-text-primary">Equipment Lifecycle Intelligence</h1>
          <p className="text-sm text-text-secondary">Units flagged for aging out, overdue service, or a repair pattern that predicts failure.</p>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : alerts.length === 0 ? (
        <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center">
          <p className="text-sm text-text-secondary">No equipment is currently flagged — the daily scan will surface units here as they age or fall behind on service.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {alerts.map((a) => (
            <div key={a.id} className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${RISK_STYLES[a.risk_level]}`}>
                      <AlertTriangle size={11} /> {a.risk_level.toUpperCase()}
                    </span>
                    <Link to={`/dashboard/customers/${a.equipment?.customer_id}`} className="text-sm font-semibold text-text-primary hover:text-accent">
                      {customerNames[a.equipment?.customer_id ?? ''] ?? 'Customer'}
                    </Link>
                  </div>
                  <p className="mt-1.5 text-sm text-text-secondary">{a.predicted_issue}</p>
                  {a.recommended_action && <p className="mt-1 text-xs font-medium text-accent">{a.recommended_action}</p>}
                </div>
                <button type="button" onClick={() => dismiss(a.id)} className="focus-ring shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary">
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </DashboardLayout>
  );
}
