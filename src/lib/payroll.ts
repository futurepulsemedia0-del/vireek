import { supabase } from '@/lib/supabase';

/**
 * Payroll — dashboard client library.
 *
 * Thin wrapper over the tables/RPCs in
 * supabase/migrations/20261204000000_payroll.sql. employees/
 * timesheets/commission_records are plain owner-scoped tables (insert/
 * update directly). pay_runs/pay_run_items are read-only from the
 * client — every pay run is created and posted through the RPCs
 * below, which also post the balancing entry into the general ledger
 * from src/lib/accounting.ts.
 */

export type PayType = 'hourly' | 'salary' | 'commission_only' | 'salary_plus_commission';
export type PaySchedule = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';

export interface Employee {
  id: string;
  team_member_id: string | null;
  full_name: string;
  employment_type: 'w2' | '1099';
  pay_type: PayType;
  hourly_rate_cents: number | null;
  annual_salary_cents: number | null;
  commission_rate_percent: number;
  overtime_multiplier: number;
  standard_hours_per_week: number;
  pay_schedule: PaySchedule;
  default_tax_withholding_percent: number;
  active: boolean;
}

export interface Timesheet {
  id: string;
  employee_id: string;
  work_date: string;
  regular_hours: number;
  overtime_hours: number;
  job_id: string | null;
  notes: string | null;
  status: 'pending' | 'approved' | 'rejected';
  pay_run_item_id: string | null;
}

export interface CommissionRecord {
  id: string;
  employee_id: string;
  job_id: string | null;
  basis_amount_cents: number;
  commission_rate_percent: number;
  commission_cents: number;
  status: 'pending' | 'approved' | 'paid';
  pay_run_item_id: string | null;
  created_at: string;
}

export interface PayRun {
  id: string;
  pay_period_start: string;
  pay_period_end: string;
  pay_date: string;
  status: 'draft' | 'approved' | 'paid' | 'void';
  total_gross_cents: number;
  total_tax_cents: number;
  total_net_cents: number;
}

export interface PayRunItem {
  id: string;
  pay_run_id: string;
  employee_id: string;
  regular_hours: number;
  overtime_hours: number;
  regular_pay_cents: number;
  overtime_pay_cents: number;
  salary_pay_cents: number;
  commission_cents: number;
  bonus_cents: number;
  gross_pay_cents: number;
  tax_withholding_cents: number;
  other_deductions_cents: number;
  net_pay_cents: number;
  payment_method: string;
  paid_at: string | null;
}

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '$0.00';
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export async function fetchEmployees(): Promise<Employee[]> {
  const { data, error } = await supabase.from('employees').select('*').order('full_name');
  if (error) throw error;
  return (data as Employee[]) ?? [];
}

export async function upsertEmployee(emp: Partial<Employee> & { full_name: string }): Promise<Employee> {
  const { data, error } = await supabase.from('employees').upsert(emp).select().single();
  if (error) throw error;
  return data as Employee;
}

export async function fetchTimesheets(employeeId?: string): Promise<Timesheet[]> {
  let q = supabase.from('timesheets').select('*').order('work_date', { ascending: false }).limit(200);
  if (employeeId) q = q.eq('employee_id', employeeId);
  const { data, error } = await q;
  if (error) throw error;
  return (data as Timesheet[]) ?? [];
}

export async function logTimesheet(entry: {
  employeeId: string;
  workDate: string;
  regularHours: number;
  overtimeHours: number;
  jobId?: string | null;
  notes?: string;
}): Promise<void> {
  const { error } = await supabase.from('timesheets').insert({
    employee_id: entry.employeeId,
    work_date: entry.workDate,
    regular_hours: entry.regularHours,
    overtime_hours: entry.overtimeHours,
    job_id: entry.jobId ?? null,
    notes: entry.notes ?? null,
  });
  if (error) throw error;
}

export async function approveTimesheet(id: string): Promise<void> {
  const { error } = await supabase.from('timesheets').update({ status: 'approved', approved_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

export async function fetchCommissionRecords(employeeId?: string): Promise<CommissionRecord[]> {
  let q = supabase.from('commission_records').select('*').order('created_at', { ascending: false }).limit(200);
  if (employeeId) q = q.eq('employee_id', employeeId);
  const { data, error } = await q;
  if (error) throw error;
  return (data as CommissionRecord[]) ?? [];
}

export async function recordCommission(entry: {
  employeeId: string;
  jobId?: string | null;
  arInvoiceId?: string | null;
  basisAmountCents: number;
  ratePercent: number;
}): Promise<void> {
  const { error } = await supabase.from('commission_records').insert({
    employee_id: entry.employeeId,
    job_id: entry.jobId ?? null,
    ar_invoice_id: entry.arInvoiceId ?? null,
    basis_amount_cents: entry.basisAmountCents,
    commission_rate_percent: entry.ratePercent,
  });
  if (error) throw error;
}

export async function fetchPayRuns(): Promise<PayRun[]> {
  const { data, error } = await supabase.from('pay_runs').select('*').order('pay_date', { ascending: false });
  if (error) throw error;
  return (data as PayRun[]) ?? [];
}

export async function fetchPayRunItems(payRunId: string): Promise<PayRunItem[]> {
  const { data, error } = await supabase.from('pay_run_items').select('*').eq('pay_run_id', payRunId);
  if (error) throw error;
  return (data as PayRunItem[]) ?? [];
}

export async function createPayRun(periodStart: string, periodEnd: string, payDate: string): Promise<string> {
  const { data, error } = await supabase.rpc('create_pay_run', { p_period_start: periodStart, p_period_end: periodEnd, p_pay_date: payDate });
  if (error) throw error;
  return data as string;
}

export async function approveAndPostPayRun(payRunId: string): Promise<string> {
  const { data, error } = await supabase.rpc('approve_and_post_pay_run', { p_pay_run_id: payRunId });
  if (error) throw error;
  return data as string;
}

export async function markPayRunPaid(payRunId: string): Promise<void> {
  const { error } = await supabase.rpc('mark_pay_run_paid', { p_pay_run_id: payRunId });
  if (error) throw error;
}

export async function voidPayRun(payRunId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('void_pay_run', { p_pay_run_id: payRunId, p_reason: reason });
  if (error) throw error;
}

export interface YtdPayrollRow {
  employee_id: string;
  full_name: string;
  gross_cents: number;
  tax_cents: number;
  net_cents: number;
  commission_cents: number;
}

export async function fetchYtdPayroll(year: number): Promise<YtdPayrollRow[]> {
  const { data, error } = await supabase.rpc('get_ytd_payroll', { p_year: year });
  if (error) throw error;
  return (data as YtdPayrollRow[]) ?? [];
}
