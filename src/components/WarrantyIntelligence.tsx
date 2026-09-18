import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';

interface EquipmentRow {
  id: string;
  customer_id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  warranty_expires_at: string;
}

interface WarrantyRow {
  id: string;
  customerId: string;
  customerName: string;
  label: string;
  expiresAt: string;
  daysLeft: number;
}

const WARNING_WINDOW_DAYS = 30;
const MAX_ROWS = 6;

function daysBetween(dateIso: string): number {
  const ms = new Date(dateIso).getTime() - Date.now();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Self-contained on purpose (own fetch) — same idiom as CallSourcesManager /
 * ReworkIntelligence — so it drops into AnalyticsPage.tsx with one line.
 *
 * Reads `equipment.warranty_expires_at` (the same column CustomerDetailPage
 * lets a user set per unit) and surfaces anything expiring within
 * WARNING_WINDOW_DAYS or already expired. The actual outbound alert —
 * inserting into `notifications` and stamping `equipment.warranty_alert_stage`
 * so the same expiry never re-notifies twice — happens server-side, once a
 * day, in the check-warranty-alerts edge function (see
 * 20260928000000_warranty_intelligence.sql). This card is a live read of the
 * same underlying data, not a second detector, so the two can never disagree
 * about which units are at risk.
 */
export function WarrantyIntelligence() {
  const { user } = useAuth();
  const [rows, setRows] = useState<WarrantyRow[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    const { data: equipmentData } = await supabase
      .from('equipment')
      .select('id, customer_id, equipment_type, make, model, warranty_expires_at')
      .eq('status', 'active')
      .not('warranty_expires_at', 'is', null)
      .order('warranty_expires_at', { ascending: true });

    const equipment = (equipmentData as EquipmentRow[] | null) ?? [];
    const atRisk = equipment.filter((eq) => daysBetween(eq.warranty_expires_at) <= WARNING_WINDOW_DAYS);

    if (atRisk.length === 0) {
      setRows([]);
      setLoading(false);
      return;
    }

    const customerIds = Array.from(new Set(atRisk.map((eq) => eq.customer_id)));
    const { data: customerData } = await supabase.from('customers').select('id, name').in('id', customerIds);
    const nameById = new Map((customerData ?? []).map((c) => [c.id as string, c.name as string]));

    setRows(
      atRisk.map((eq) => ({
        id: eq.id,
        customerId: eq.customer_id,
        customerName: nameById.get(eq.customer_id) ?? 'Unknown customer',
        label: [eq.make, eq.model].filter(Boolean).join(' ') || eq.equipment_type,
        expiresAt: eq.warranty_expires_at,
        daysLeft: daysBetween(eq.warranty_expires_at),
      })),
    );
    setLoading(false);
  }, [user]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="animate-pulse rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
        <div className="h-5 w-48 rounded bg-bg-tertiary" />
        <div className="mt-4 h-16 rounded bg-bg-tertiary" />
      </div>
    );
  }

  const expiredCount = rows.filter((r) => r.daysLeft < 0).length;
  const expiringCount = rows.length - expiredCount;

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warning-500/10 text-warning-500">
          <ShieldAlert size={18} />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Warranty Intelligence</h3>
          <p className="text-xs text-text-secondary">Equipment warranties expiring soon or already lapsed, across every customer</p>
        </div>
        {rows.length > 0 && (
          <span className="ml-auto shrink-0 rounded-full bg-danger/10 px-2.5 py-1 text-xs font-semibold text-danger">
            {rows.length} at risk
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="mt-6 flex items-center gap-2 text-sm text-text-secondary">
          <ShieldCheck size={16} className="shrink-0 text-success-500" />
          Nothing expiring in the next {WARNING_WINDOW_DAYS} days — every active unit is covered.
        </div>
      ) : (
        <div className="mt-5 space-y-2">
          {rows.slice(0, MAX_ROWS).map((row) => (
            <Link
              key={row.id}
              to={`/dashboard/customers/${row.customerId}`}
              className="flex items-center justify-between gap-3 rounded-xl bg-bg-primary px-3 py-2 transition-colors hover:bg-bg-tertiary"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-text-primary">{row.label}</p>
                <p className="truncate text-xs text-text-secondary">{row.customerName}</p>
              </div>
              <span className={`shrink-0 text-xs font-medium ${row.daysLeft < 0 ? 'text-danger' : 'text-warning-500'}`}>
                {row.daysLeft < 0 ? `Expired ${formatDate(row.expiresAt)}` : `${row.daysLeft}d left · ${formatDate(row.expiresAt)}`}
              </span>
            </Link>
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <div className="mt-5 flex items-start gap-2 rounded-xl border border-dashed border-border p-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" />
          <p className="text-xs leading-relaxed text-text-secondary">
            {expiringCount > 0 && `${expiringCount} expiring within ${WARNING_WINDOW_DAYS} days`}
            {expiringCount > 0 && expiredCount > 0 && ' · '}
            {expiredCount > 0 && `${expiredCount} already expired`}. A notification is sent automatically the first
            time each unit crosses one of these stages — turn it off in Settings if you don't want it.
          </p>
        </div>
      )}
    </div>
  );
}
