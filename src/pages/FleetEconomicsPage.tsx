import { useCallback, useEffect, useMemo, useState } from 'react';
import { Fuel, Plus, RefreshCw, TriangleAlert as AlertTriangle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase } from '@/lib/supabase';

interface Vehicle {
  id: string;
  label: string;
  make: string | null;
  model: string | null;
  status: 'active' | 'in_shop' | 'retired';
  monthly_payment_cost: number;
  monthly_insurance_cost: number;
}

interface ProfitabilityRow {
  id: string;
  job_id: string;
  vehicle_id: string;
  miles_driven: number;
  truck_roll_cost: number;
  revenue: number;
  gross_profit: number;
  margin_pct: number | null;
  computed_at: string;
  jobs: { customer_name: string; service_type: string | null } | null;
}

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-success-500/10 text-success-500',
  in_shop: 'bg-warning-500/10 text-warning-500',
  retired: 'bg-bg-tertiary text-text-secondary',
};

const EXPENSE_TYPES = ['fuel', 'maintenance', 'repair', 'insurance', 'downtime', 'other'] as const;

export function FleetEconomicsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [rows, setRows] = useState<ProfitabilityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [showAddVehicle, setShowAddVehicle] = useState(false);
  const [vehicleLabel, setVehicleLabel] = useState('');
  const [vehicleMake, setVehicleMake] = useState('');
  const [vehicleModel, setVehicleModel] = useState('');
  const [monthlyPayment, setMonthlyPayment] = useState('');
  const [monthlyInsurance, setMonthlyInsurance] = useState('');
  const [savingVehicle, setSavingVehicle] = useState(false);

  const [showLogExpense, setShowLogExpense] = useState(false);
  const [expenseVehicleId, setExpenseVehicleId] = useState('');
  const [expenseType, setExpenseType] = useState<(typeof EXPENSE_TYPES)[number]>('fuel');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [savingExpense, setSavingExpense] = useState(false);

  const fetchData = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [{ data: vehicleData }, { data: profitData }] = await Promise.all([
      supabase.from('vehicles').select('id, label, make, model, status, monthly_payment_cost, monthly_insurance_cost').order('created_at', { ascending: false }),
      supabase
        .from('vehicle_job_profitability')
        .select('id, job_id, vehicle_id, miles_driven, truck_roll_cost, revenue, gross_profit, margin_pct, computed_at, jobs:job_id (customer_name, service_type)')
        .order('margin_pct', { ascending: true, nullsFirst: false })
        .limit(100),
    ]);
    setVehicles((vehicleData as Vehicle[]) ?? []);
    setRows((profitData as unknown as ProfitabilityRow[]) ?? []);
    setLoading(false);
  }, [user]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const vehicleLabelById = useMemo(() => Object.fromEntries(vehicles.map((v) => [v.id, v.label])), [vehicles]);

  const summary = useMemo(() => {
    const totalRevenue = rows.reduce((sum, r) => sum + (r.revenue || 0), 0);
    const totalCost = rows.reduce((sum, r) => sum + (r.truck_roll_cost || 0), 0);
    const totalProfit = rows.reduce((sum, r) => sum + (r.gross_profit || 0), 0);
    const avgMargin = rows.length > 0 ? rows.reduce((sum, r) => sum + (r.margin_pct ?? 0), 0) / rows.length : 0;
    return { totalRevenue, totalCost, totalProfit, avgMargin };
  }, [rows]);

  const refresh = async () => {
    setRefreshing(true);
    const { data, error } = await supabase.functions.invoke('compute-fleet-economics', { body: {} });
    setRefreshing(false);
    if (error || data?.error) {
      toast(data?.error || 'Could not refresh fleet economics.', 'error');
      return;
    }
    toast(`Scored ${data?.jobs_scored ?? 0} jobs across ${data?.vehicles_scanned ?? 0} vehicles.`, 'success');
    fetchData();
  };

  const addVehicle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !vehicleLabel.trim()) return;
    setSavingVehicle(true);
    const { error } = await supabase.from('vehicles').insert({
      user_id: user.id,
      label: vehicleLabel.trim(),
      make: vehicleMake.trim() || null,
      model: vehicleModel.trim() || null,
      monthly_payment_cost: Number(monthlyPayment) || 0,
      monthly_insurance_cost: Number(monthlyInsurance) || 0,
    });
    setSavingVehicle(false);
    if (error) { toast('Could not add the vehicle.', 'error'); return; }
    setVehicleLabel(''); setVehicleMake(''); setVehicleModel(''); setMonthlyPayment(''); setMonthlyInsurance('');
    setShowAddVehicle(false);
    fetchData();
  };

  const logExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !expenseVehicleId || !expenseAmount) return;
    setSavingExpense(true);
    const { error } = await supabase.from('vehicle_expenses').insert({
      user_id: user.id,
      vehicle_id: expenseVehicleId,
      expense_type: expenseType,
      amount: Number(expenseAmount) || 0,
    });
    setSavingExpense(false);
    if (error) { toast('Could not log the expense.', 'error'); return; }
    setExpenseAmount('');
    setShowLogExpense(false);
    toast('Expense logged.', 'success');
  };

  return (
    <DashboardLayout activeLabel="Fleet Economics">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Fuel size={24} /></span>
          <div>
            <h1 className="text-xl font-bold text-text-primary">Fleet Economics</h1>
            <p className="text-sm text-text-secondary">Fuel, mileage, repair, insurance and downtime cost, attributed down to the job.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => setShowLogExpense((v) => !v)} className="focus-ring rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary">
            Log expense
          </button>
          <button type="button" onClick={() => setShowAddVehicle((v) => !v)} className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary">
            <Plus size={14} /> Add vehicle
          </button>
          <button type="button" onClick={refresh} disabled={refreshing} className="focus-ring flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-60">
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {showAddVehicle && (
        <form onSubmit={addVehicle} className="mb-4 grid grid-cols-2 gap-3 rounded-2xl border border-border bg-bg-secondary p-4 sm:grid-cols-5">
          <input value={vehicleLabel} onChange={(e) => setVehicleLabel(e.target.value)} placeholder="Label (e.g. Truck 1)" required className="rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm" />
          <input value={vehicleMake} onChange={(e) => setVehicleMake(e.target.value)} placeholder="Make" className="rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm" />
          <input value={vehicleModel} onChange={(e) => setVehicleModel(e.target.value)} placeholder="Model" className="rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm" />
          <input value={monthlyPayment} onChange={(e) => setMonthlyPayment(e.target.value)} type="number" min="0" step="0.01" placeholder="Monthly payment $" className="rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm" />
          <input value={monthlyInsurance} onChange={(e) => setMonthlyInsurance(e.target.value)} type="number" min="0" step="0.01" placeholder="Monthly insurance $" className="rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm" />
          <button type="submit" disabled={savingVehicle} className="focus-ring col-span-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60 sm:col-span-1">
            {savingVehicle ? 'Saving…' : 'Save vehicle'}
          </button>
        </form>
      )}

      {showLogExpense && (
        <form onSubmit={logExpense} className="mb-4 grid grid-cols-2 gap-3 rounded-2xl border border-border bg-bg-secondary p-4 sm:grid-cols-4">
          <select value={expenseVehicleId} onChange={(e) => setExpenseVehicleId(e.target.value)} required className="rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm">
            <option value="">Vehicle…</option>
            {vehicles.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
          <select value={expenseType} onChange={(e) => setExpenseType(e.target.value as typeof expenseType)} className="rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm capitalize">
            {EXPENSE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input value={expenseAmount} onChange={(e) => setExpenseAmount(e.target.value)} type="number" min="0" step="0.01" placeholder="Amount $" required className="rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm" />
          <button type="submit" disabled={savingExpense} className="focus-ring rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
            {savingExpense ? 'Saving…' : 'Log expense'}
          </button>
        </form>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-2xl border border-border bg-bg-secondary p-4">
          <p className="text-xs text-text-secondary">Attributed revenue (90d)</p>
          <p className="mt-1 text-lg font-bold text-text-primary">${summary.totalRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
        </div>
        <div className="rounded-2xl border border-border bg-bg-secondary p-4">
          <p className="text-xs text-text-secondary">Truck-roll cost (90d)</p>
          <p className="mt-1 text-lg font-bold text-text-primary">${summary.totalCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
        </div>
        <div className="rounded-2xl border border-border bg-bg-secondary p-4">
          <p className="text-xs text-text-secondary">Net fleet profit (90d)</p>
          <p className={`mt-1 text-lg font-bold ${summary.totalProfit >= 0 ? 'text-success-500' : 'text-danger-500'}`}>${summary.totalProfit.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
        </div>
        <div className="rounded-2xl border border-border bg-bg-secondary p-4">
          <p className="text-xs text-text-secondary">Avg. job margin</p>
          <p className="mt-1 text-lg font-bold text-text-primary">{summary.avgMargin.toFixed(1)}%</p>
        </div>
      </div>

      <h2 className="mb-3 text-sm font-semibold text-text-primary">Fleet roster</h2>
      <div className="mb-8 overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border text-xs text-text-secondary">
            <tr>
              <th className="px-4 py-3 font-medium">Vehicle</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Monthly fixed cost</th>
            </tr>
          </thead>
          <tbody>
            {vehicles.map((v) => (
              <tr key={v.id} className="border-b border-border last:border-0">
                <td className="px-4 py-3 font-medium text-text-primary">{v.label}{(v.make || v.model) && <span className="ml-1.5 text-xs font-normal text-text-secondary">{[v.make, v.model].filter(Boolean).join(' ')}</span>}</td>
                <td className="px-4 py-3"><span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[v.status]}`}>{v.status.replace('_', ' ')}</span></td>
                <td className="px-4 py-3 text-text-secondary">${(v.monthly_payment_cost + v.monthly_insurance_cost).toLocaleString()}</td>
              </tr>
            ))}
            {vehicles.length === 0 && <tr><td colSpan={3} className="px-4 py-6 text-center text-text-secondary">No vehicles yet — add your first truck above.</td></tr>}
          </tbody>
        </table>
      </div>

      <h2 className="mb-3 text-sm font-semibold text-text-primary">Vehicle-to-job profitability</h2>
      <p className="mb-3 text-xs text-text-secondary">Lowest margin first — these are the jobs where the truck roll ate the most profit.</p>
      {loading ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center">
          <p className="text-sm text-text-secondary">No scored jobs yet. Log vehicle trips against jobs, then hit Refresh to compute truck-roll cost and margin.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs text-text-secondary">
              <tr>
                <th className="px-4 py-3 font-medium">Job</th>
                <th className="px-4 py-3 font-medium">Vehicle</th>
                <th className="px-4 py-3 font-medium">Miles</th>
                <th className="px-4 py-3 font-medium">Truck-roll cost</th>
                <th className="px-4 py-3 font-medium">Revenue</th>
                <th className="px-4 py-3 font-medium">Margin</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 text-text-primary">{r.jobs?.customer_name ?? 'Job'}<span className="ml-1.5 text-xs text-text-secondary">{r.jobs?.service_type ?? ''}</span></td>
                  <td className="px-4 py-3 text-text-secondary">{vehicleLabelById[r.vehicle_id] ?? '—'}</td>
                  <td className="px-4 py-3 text-text-secondary">{r.miles_driven.toFixed(1)}</td>
                  <td className="px-4 py-3 text-text-secondary">${r.truck_roll_cost.toFixed(2)}</td>
                  <td className="px-4 py-3 text-text-secondary">${r.revenue.toFixed(2)}</td>
                  <td className="px-4 py-3">
                    {r.margin_pct === null ? (
                      <span className="text-xs text-text-secondary">—</span>
                    ) : (
                      <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${r.margin_pct < 0 ? 'bg-danger-500/10 text-danger-500' : r.margin_pct < 20 ? 'bg-warning-500/10 text-warning-500' : 'bg-success-500/10 text-success-500'}`}>
                        {r.margin_pct < 20 && <AlertTriangle size={11} />} {r.margin_pct.toFixed(1)}%
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DashboardLayout>
  );
}
