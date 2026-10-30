import { useCallback, useEffect, useMemo, useState } from 'react';
import { Snowflake, Download, AlertTriangle, Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { exportToCsv } from '@/lib/csvExport';
import { Link } from 'react-router-dom';
import { useToast } from '@/contexts/ToastContext';
import {
  EXPORT_COLUMNS,
  RECORD_RETENTION_YEARS,
  CATEGORY_LABELS,
  computeLeakRate,
  exportFilename,
  fetchLogRange,
  totalsFor,
  type ApplianceCategory,
  type RefrigerantEntry,
} from '@/lib/refrigerantCompliance';

interface UnitRow {
  id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  refrigerant_type: string | null;
  refrigerant_charge_lbs: number | null;
  appliance_category: ApplianceCategory | null;
  install_date: string | null;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const inputClass =
  'focus-ring rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

/** Compliance Center section: leak-rate watchlist + date-ranged CSV export of the refrigerant ledger. */
export function RefrigerantComplianceSection() {
  const { toast } = useToast();
  const today = useMemo(() => new Date(), []);
  const [from, setFrom] = useState(() => isoDay(new Date(today.getFullYear(), 0, 1)));
  const [to, setTo] = useState(() => isoDay(today));
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [yearLog, setYearLog] = useState<RefrigerantEntry[]>([]);

  const load = useCallback(async () => {
    try {
      const yearAgo = new Date(Date.now() - 366 * 86_400_000);
      const [log, unitsRes] = await Promise.all([
        fetchLogRange(isoDay(yearAgo), ''),
        supabase
          .from('equipment')
          .select(
            'id, equipment_type, make, model, serial_number, refrigerant_type, refrigerant_charge_lbs, appliance_category, install_date',
          )
          .not('refrigerant_charge_lbs', 'is', null)
          .eq('status', 'active'),
      ]);
      setYearLog(log);
      setUnits(
        ((unitsRes.data ?? []) as UnitRow[]).map((u) => ({
          ...u,
          refrigerant_charge_lbs: Number(u.refrigerant_charge_lbs),
        })),
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not load refrigerant records.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const watchlist = useMemo(
    () =>
      units
        .map((u) => ({
          unit: u,
          leak: computeLeakRate({
            entries: yearLog.filter((e) => e.equipment_id === u.id),
            fullChargeLbs: u.refrigerant_charge_lbs,
            category: u.appliance_category,
            baselineDate: u.install_date,
          }),
        }))
        .filter((r) => r.leak.poundsAdded365 > 0)
        .sort((a, b) => (b.leak.ratePct ?? -1) - (a.leak.ratePct ?? -1)),
    [units, yearLog],
  );

  const totals = useMemo(() => totalsFor(yearLog), [yearLog]);
  const overLimit = watchlist.filter((r) => r.leak.exceeds).length;
  const rangeInvalid = Boolean(from && to && from > to);

  const handleExport = async () => {
    if (rangeInvalid) return;
    setExporting(true);
    try {
      const rows = await fetchLogRange(from, to);
      if (rows.length === 0) {
        toast('No refrigerant entries in that date range.', 'info');
        return;
      }
      exportToCsv(rows, EXPORT_COLUMNS, exportFilename(from, to));
      toast(`Exported ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}.`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Export failed.', 'error');
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="mt-10" aria-label="Refrigerant compliance">
      <div className="mb-4 flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Snowflake size={18} />
        </span>
        <div>
          <h2 className="text-lg font-bold text-text-primary">Refrigerant compliance</h2>
          <p className="text-sm text-text-secondary">
            Leak-rate watchlist and audit-ready export. Records are kept for at least{' '}
            {RECORD_RETENTION_YEARS} years.
            <Link to="/dashboard/refrigerant-leaks" className="font-medium text-accent underline">Leak repair cases →</Link>
          </p>
        </div>
      </div>

      {loading ? (
        <div className="h-24 animate-pulse rounded-2xl bg-bg-tertiary" />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-3 gap-3">
            <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
              <p className="text-xl font-bold text-text-primary">{totals.added}</p>
              <p className="text-xs text-text-secondary">lb added (12 mo)</p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
              <p className="text-xl font-bold text-text-primary">{totals.recovered}</p>
              <p className="text-xs text-text-secondary">lb recovered (12 mo)</p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
              <p className={`text-xl font-bold ${overLimit ? 'text-danger' : 'text-text-primary'}`}>
                {overLimit}
              </p>
              <p className="text-xs text-text-secondary">units over leak limit</p>
            </div>
          </div>

          {watchlist.length > 0 && (
            <ul className="mb-4 space-y-2">
              {watchlist.map(({ unit, leak }) => (
                <li
                  key={unit.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-secondary p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text-primary">
                      {[unit.make, unit.model, unit.equipment_type].filter(Boolean).join(' ')}
                      {unit.serial_number ? ` · S/N ${unit.serial_number}` : ''}
                    </p>
                    <p className="text-xs text-text-secondary">
                      {unit.refrigerant_type ?? 'Refrigerant n/a'} · {unit.refrigerant_charge_lbs}{' '}
                      lb · {CATEGORY_LABELS[unit.appliance_category ?? 'other']} ·{' '}
                      {leak.poundsAdded365} lb added
                    </p>
                    {leak.exceeds && leak.repairDeadline && (
                      <p className="text-xs font-medium text-danger">
                        Repair due by {new Date(leak.repairDeadline).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                  <span
                    className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${leak.exceeds ? 'bg-danger/10 text-danger' : 'bg-success-500/10 text-success-500'}`}
                  >
                    {leak.exceeds && <AlertTriangle size={11} />}
                    {leak.ratePct === null ? 'n/a' : `${leak.ratePct}% / ${leak.threshold}%`}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-border bg-bg-secondary p-4">
            <label className="text-xs text-text-secondary">
              From
              <input
                type="date"
                className={`${inputClass} mt-1 block`}
                value={from}
                max={to || undefined}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label className="text-xs text-text-secondary">
              To
              <input
                type="date"
                className={`${inputClass} mt-1 block`}
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
            <button
              type="button"
              onClick={handleExport}
              disabled={exporting || rangeInvalid}
              className="focus-ring ml-auto inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}{' '}
              Export CSV
            </button>
            {rangeInvalid && (
              <p className="w-full text-xs text-danger">“From” must be on or before “To”.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
