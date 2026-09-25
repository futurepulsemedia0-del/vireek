import { useEffect, useState, useCallback, useMemo } from 'react';
import { DollarSign, RefreshCw, Plus, CheckCircle2, Send, Clock } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import {
  fetchEmployees,
  upsertEmployee,
  fetchTimesheets,
  logTimesheet,
  approveTimesheet,
  fetchPayRuns,
  fetchPayRunItems,
  createPayRun,
  approveAndPostPayRun,
  markPayRunPaid,
  fetchYtdPayroll,
  formatCents,
  type Employee,
  type Timesheet,
  type PayRun,
  type PayRunItem,
  type YtdPayrollRow,
  type PayType,
} from '@/lib/payroll';

type Tab = 'employees' | 'timesheets' | 'pay_runs' | 'ytd';
const TABS: { id: Tab; label: string }[] = [
  { id: 'employees', label: 'Employees' },
  { id: 'timesheets', label: 'Timesheets' },
  { id: 'pay_runs', label: 'Pay Runs' },
  { id: 'ytd', label: 'Year to Date' },
];

const PAY_TYPE_LABELS: Record<PayType, string> = {
  hourly: 'Hourly',
  salary: 'Salary',
  commission_only: 'Commission only',
  salary_plus_commission: 'Salary + commission',
};

const RUN_STATUS_COLORS: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600',
  approved: 'bg-blue-100 text-blue-700',
  paid: 'bg-emerald-100 text-emerald-700',
  void: 'bg-slate-100 text-slate-400',
};

function NewEmployeeForm({ onCreated }: { onCreated: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [payType, setPayType] = useState<PayType>('hourly');
  const [rate, setRate] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast('Enter a name.', 'error');
      return;
    }
    setSaving(true);
    try {
      const cents = Math.round(parseFloat(rate || '0') * 100);
      await upsertEmployee({
        full_name: name,
        pay_type: payType,
        hourly_rate_cents: payType === 'hourly' ? cents : null,
        annual_salary_cents: payType.startsWith('salary') ? cents : null,
        commission_rate_percent: payType.includes('commission') ? cents / 100 : 0,
      } as any);
      toast('Employee added.', 'success');
      setName('');
      setRate('');
      onCreated();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not add employee.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mb-6 grid gap-3 p-4 sm:grid-cols-4">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" className="rounded-lg border border-border-primary bg-bg-primary px-2 py-1.5 text-sm" />
      <select value={payType} onChange={(e) => setPayType(e.target.value as PayType)} className="rounded-lg border border-border-primary bg-bg-primary px-2 py-1.5 text-sm">
        {Object.entries(PAY_TYPE_LABELS).map(([k, v]) => (
          <option key={k} value={k}>{v}</option>
        ))}
      </select>
      <input
        value={rate}
        onChange={(e) => setRate(e.target.value)}
        type="number"
        step="0.01"
        placeholder={payType === 'hourly' ? 'Hourly rate $' : payType.includes('commission') && payType !== 'salary_plus_commission' ? 'Commission %' : 'Annual salary $'}
        className="rounded-lg border border-border-primary bg-bg-primary px-2 py-1.5 text-sm"
      />
      <button type="button" onClick={handleSubmit} disabled={saving} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
        <Plus size={14} /> Add employee
      </button>
    </Card>
  );
}

function NewTimesheetForm({ employees, onCreated }: { employees: Employee[]; onCreated: () => void }) {
  const { toast } = useToast();
  const [employeeId, setEmployeeId] = useState('');
  const [workDate, setWorkDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [regular, setRegular] = useState('8');
  const [overtime, setOvertime] = useState('0');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (!employeeId) {
      toast('Pick an employee.', 'error');
      return;
    }
    setSaving(true);
    try {
      await logTimesheet({ employeeId, workDate, regularHours: parseFloat(regular) || 0, overtimeHours: parseFloat(overtime) || 0 });
      toast('Hours logged.', 'success');
      onCreated();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not log hours.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mb-6 grid gap-3 p-4 sm:grid-cols-5">
      <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="rounded-lg border border-border-primary bg-bg-primary px-2 py-1.5 text-sm">
        <option value="">Employee</option>
        {employees.map((e) => (
          <option key={e.id} value={e.id}>{e.full_name}</option>
        ))}
      </select>
      <input value={workDate} onChange={(e) => setWorkDate(e.target.value)} type="date" className="rounded-lg border border-border-primary bg-bg-primary px-2 py-1.5 text-sm" />
      <input value={regular} onChange={(e) => setRegular(e.target.value)} type="number" step="0.25" placeholder="Regular hrs" className="rounded-lg border border-border-primary bg-bg-primary px-2 py-1.5 text-sm" />
      <input value={overtime} onChange={(e) => setOvertime(e.target.value)} type="number" step="0.25" placeholder="OT hrs" className="rounded-lg border border-border-primary bg-bg-primary px-2 py-1.5 text-sm" />
      <button type="button" onClick={handleSubmit} disabled={saving} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
        <Clock size={14} /> Log hours
      </button>
    </Card>
  );
}

function PayRunDetail({ run, employees }: { run: PayRun; employees: Employee[] }) {
  const { toast } = useToast();
  const [items, setItems] = useState<PayRunItem[]>([]);
  const [busy, setBusy] = useState(false);
  const nameFor = (id: string) => employees.find((e) => e.id === id)?.full_name ?? 'Unknown';

  const load = useCallback(() => {
    fetchPayRunItems(run.id).then(setItems).catch(() => toast('Could not load pay run detail.', 'error'));
  }, [run.id, toast]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="border-t border-border-primary bg-bg-secondary/40 px-4 py-3">
      <div className="space-y-1">
        {items.map((i) => (
          <div key={i.id} className="flex justify-between text-xs">
            <span className="text-text-primary">{nameFor(i.employee_id)}</span>
            <span className="text-text-secondary">
              gross {formatCents(i.gross_pay_cents)} &middot; tax {formatCents(i.tax_withholding_cents)} &middot; net {formatCents(i.net_pay_cents)}
            </span>
          </div>
        ))}
        {items.length === 0 && <p className="text-xs text-text-secondary">No pay lines for this run.</p>}
      </div>
      {run.status === 'draft' && (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await approveAndPostPayRun(run.id);
              toast('Pay run approved and posted to the ledger.', 'success');
              load();
            } catch (e) {
              toast(e instanceof Error ? e.message : 'Could not post pay run.', 'error');
            } finally {
              setBusy(false);
            }
          }}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          <Send size={12} /> Approve & post to GL
        </button>
      )}
      {run.status === 'approved' && (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await markPayRunPaid(run.id);
              toast('Marked paid.', 'success');
            } catch (e) {
              toast(e instanceof Error ? e.message : 'Could not update.', 'error');
            } finally {
              setBusy(false);
            }
          }}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border-primary px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-secondary disabled:opacity-50"
        >
          <CheckCircle2 size={12} /> Mark disbursed
        </button>
      )}
    </div>
  );
}

export function PayrollPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('employees');
  const [loading, setLoading] = useState(true);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [timesheets, setTimesheets] = useState<Timesheet[]>([]);
  const [payRuns, setPayRuns] = useState<PayRun[]>([]);
  const [ytd, setYtd] = useState<YtdPayrollRow[]>([]);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [periodStart, setPeriodStart] = useState(() => new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10));
  const [periodEnd, setPeriodEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [payDate, setPayDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [creatingRun, setCreatingRun] = useState(false);

  const load = useCallback(async () => {
    try {
      const [e, t, r, y] = await Promise.all([
        fetchEmployees(),
        fetchTimesheets(),
        fetchPayRuns(),
        fetchYtdPayroll(new Date().getFullYear()),
      ]);
      setEmployees(e);
      setTimesheets(t);
      setPayRuns(r);
      setYtd(y);
    } catch {
      toast('Could not load payroll data.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const nameFor = useCallback((id: string) => employees.find((e) => e.id === id)?.full_name ?? 'Unknown', [employees]);

  const handleCreateRun = async () => {
    setCreatingRun(true);
    try {
      const id = await createPayRun(periodStart, periodEnd, payDate);
      toast('Pay run created from approved hours and commission.', 'success');
      setExpandedRun(id);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create pay run.', 'error');
    } finally {
      setCreatingRun(false);
    }
  };

  if (loading) {
    return (
      <DashboardLayout activeLabel="Payroll">
        <p className="text-sm text-text-secondary">Loading...</p>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Payroll">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
            <DollarSign size={22} /> Payroll
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">
            Hourly, salary and commission pay, approved timesheets, and pay runs that post straight to the general
            ledger. Tax withholding is an internal estimate, not a substitute for a licensed payroll provider.
          </p>
        </div>
        <button type="button" onClick={load} className="inline-flex items-center gap-1.5 rounded-lg border border-border-primary bg-bg-primary px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-secondary">
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      <div className="mb-6 flex gap-1 border-b border-border-primary">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === t.id ? 'border-brand-500 text-brand-600' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'employees' && (
        <>
          <NewEmployeeForm onCreated={load} />
          {employees.length === 0 ? (
            <EmptyState icon={DollarSign} title="No employees yet" description="Add your first employee above to start tracking hours and pay." />
          ) : (
            <Card className="p-0">
              {employees.map((e) => (
                <div key={e.id} className="flex items-center justify-between border-b border-border-primary px-4 py-3 text-sm last:border-b-0">
                  <span className="text-text-primary">{e.full_name}</span>
                  <span className="text-xs text-text-secondary">
                    {PAY_TYPE_LABELS[e.pay_type]}
                    {e.pay_type === 'hourly' && ` \u00b7 ${formatCents(e.hourly_rate_cents)}/hr`}
                    {e.pay_type.startsWith('salary') && ` \u00b7 ${formatCents(e.annual_salary_cents)}/yr`}
                    {e.pay_type.includes('commission') && ` \u00b7 ${e.commission_rate_percent}% commission`}
                  </span>
                </div>
              ))}
            </Card>
          )}
        </>
      )}

      {tab === 'timesheets' && (
        <>
          <NewTimesheetForm employees={employees} onCreated={load} />
          {timesheets.length === 0 ? (
            <EmptyState icon={Clock} title="No hours logged" description="Log hours above; approve them before they can be pulled into a pay run." />
          ) : (
            <Card className="p-0">
              {timesheets.map((t) => (
                <div key={t.id} className="flex items-center justify-between border-b border-border-primary px-4 py-2 text-sm last:border-b-0">
                  <span className="text-text-primary">{nameFor(t.employee_id)} &middot; {t.work_date}</span>
                  <span className="flex items-center gap-3 text-xs text-text-secondary">
                    {t.regular_hours}h reg / {t.overtime_hours}h OT
                    <span className={`rounded-full px-2 py-0.5 ${t.status === 'approved' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{t.status}</span>
                    {t.status === 'pending' && (
                      <button type="button" onClick={async () => { await approveTimesheet(t.id); load(); }} className="text-brand-600 hover:underline">
                        Approve
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </Card>
          )}
        </>
      )}

      {tab === 'pay_runs' && (
        <>
          <Card className="mb-6 grid gap-3 p-4 sm:grid-cols-4">
            <input value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} type="date" className="rounded-lg border border-border-primary bg-bg-primary px-2 py-1.5 text-sm" />
            <input value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} type="date" className="rounded-lg border border-border-primary bg-bg-primary px-2 py-1.5 text-sm" />
            <input value={payDate} onChange={(e) => setPayDate(e.target.value)} type="date" className="rounded-lg border border-border-primary bg-bg-primary px-2 py-1.5 text-sm" />
            <button type="button" onClick={handleCreateRun} disabled={creatingRun} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
              <Plus size={14} /> Create pay run
            </button>
          </Card>
          {payRuns.length === 0 ? (
            <EmptyState icon={DollarSign} title="No pay runs yet" description="Create one above — it pulls in every approved timesheet and commission in the period." />
          ) : (
            <Card className="p-0">
              {payRuns.map((r) => (
                <div key={r.id}>
                  <button type="button" onClick={() => setExpandedRun(expandedRun === r.id ? null : r.id)} className="flex w-full items-center justify-between border-b border-border-primary px-4 py-3 text-left last:border-b-0 hover:bg-bg-secondary/50">
                    <span className="text-sm text-text-primary">{r.pay_period_start} &rarr; {r.pay_period_end}</span>
                    <span className="flex items-center gap-3">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${RUN_STATUS_COLORS[r.status]}`}>{r.status}</span>
                      <span className="text-sm font-semibold text-text-primary">{formatCents(r.total_net_cents)} net</span>
                    </span>
                  </button>
                  {expandedRun === r.id && <PayRunDetail run={r} employees={employees} />}
                </div>
              ))}
            </Card>
          )}
        </>
      )}

      {tab === 'ytd' && (
        <Card className="p-0">
          {ytd.map((row) => (
            <div key={row.employee_id} className="flex items-center justify-between border-b border-border-primary px-4 py-2 text-sm last:border-b-0">
              <span className="text-text-primary">{row.full_name}</span>
              <span className="text-xs text-text-secondary">
                gross {formatCents(row.gross_cents)} &middot; commission {formatCents(row.commission_cents)} &middot; tax {formatCents(row.tax_cents)} &middot; net {formatCents(row.net_cents)}
              </span>
            </div>
          ))}
          {ytd.length === 0 && <p className="px-4 py-6 text-sm text-text-secondary">No payroll activity this year yet.</p>}
        </Card>
      )}
    </DashboardLayout>
  );
}
