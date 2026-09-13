import { useMemo } from 'react';
import { Users, Info } from 'lucide-react';
import type { Job } from '@/lib/supabase';

function formatCurrency(amount: number): string {
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function monthKey(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

interface CohortLtvSectionProps {
  jobs: Job[];
}

/**
 * Built entirely from `jobs` (customer_phone/name + invoice_amount/status) —
 * deliberately not a separate billing/subscription system. A customer is
 * identified by phone (falling back to name if no phone on file). Cohort =
 * the month of a customer's first job. LTV = paid invoice total to date.
 * This intentionally covers only *paid* revenue — quoted-but-unpaid or
 * scheduled-but-not-yet-invoiced jobs don't count toward LTV until they do.
 */
export function CohortLtvSection({ jobs }: CohortLtvSectionProps) {
  const data = useMemo(() => {
    type CustomerAgg = { key: string; name: string; firstJobAt: string; paidTotal: number; jobCount: number };
    const byCustomer = new Map<string, CustomerAgg>();

    for (const job of jobs) {
      const key = job.customer_phone?.trim() || job.customer_name.trim();
      if (!key) continue;
      const existing = byCustomer.get(key);
      const paid = job.invoice_status === 'paid' ? job.invoice_amount ?? 0 : 0;
      if (!existing) {
        byCustomer.set(key, { key, name: job.customer_name, firstJobAt: job.created_at, paidTotal: paid, jobCount: 1 });
      } else {
        existing.paidTotal += paid;
        existing.jobCount += 1;
        if (new Date(job.created_at) < new Date(existing.firstJobAt)) existing.firstJobAt = job.created_at;
      }
    }

    const customers = Array.from(byCustomer.values());
    const payingCustomers = customers.filter((c) => c.paidTotal > 0);
    const avgLtv = payingCustomers.length > 0
      ? payingCustomers.reduce((sum, c) => sum + c.paidTotal, 0) / payingCustomers.length
      : 0;

    const topCustomers = [...customers].sort((a, b) => b.paidTotal - a.paidTotal).slice(0, 5);

    // Cohort by month of first job, last 6 months with any activity.
    const cohortMap = new Map<string, { customerCount: number; totalRevenue: number }>();
    for (const c of customers) {
      const key = monthKey(c.firstJobAt);
      const entry = cohortMap.get(key) ?? { customerCount: 0, totalRevenue: 0 };
      entry.customerCount += 1;
      entry.totalRevenue += c.paidTotal;
      cohortMap.set(key, entry);
    }
    const cohorts = Array.from(cohortMap.entries())
      .map(([key, v]) => ({
        key,
        label: monthLabel(key),
        customerCount: v.customerCount,
        totalRevenue: v.totalRevenue,
        avgRevenue: v.customerCount > 0 ? v.totalRevenue / v.customerCount : 0,
      }))
      .sort((a, b) => (a.key < b.key ? 1 : -1))
      .slice(0, 6);

    return { totalCustomers: customers.length, avgLtv, topCustomers, cohorts };
  }, [jobs]);

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Users size={18} />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Customer Value &amp; Cohorts</h3>
          <p className="text-xs text-text-secondary">Based on paid jobs only &mdash; not a billing system</p>
        </div>
      </div>

      {data.totalCustomers === 0 ? (
        <p className="mt-6 text-sm text-text-secondary">No job history yet.</p>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-border bg-bg-primary p-3">
              <p className="text-lg font-bold text-text-primary">{formatCurrency(data.avgLtv)}</p>
              <p className="text-xs text-text-secondary">Avg. lifetime value</p>
            </div>
            <div className="rounded-xl border border-border bg-bg-primary p-3">
              <p className="text-lg font-bold text-text-primary">{data.totalCustomers}</p>
              <p className="text-xs text-text-secondary">Unique customers</p>
            </div>
          </div>

          {data.topCustomers.length > 0 && (
            <div className="mt-5">
              <p className="mb-2 text-xs font-semibold text-text-secondary">Top customers by value</p>
              <div className="space-y-1.5">
                {data.topCustomers.map((c) => (
                  <div key={c.key} className="flex items-center justify-between text-xs">
                    <span className="text-text-primary">{c.name}</span>
                    <span className="font-semibold text-text-primary">
                      {formatCurrency(c.paidTotal)}{' '}
                      <span className="font-normal text-text-secondary">· {c.jobCount} job{c.jobCount === 1 ? '' : 's'}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {data.cohorts.length > 0 && (
            <div className="mt-5">
              <p className="mb-2 text-xs font-semibold text-text-secondary">Cohorts by month acquired</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-text-secondary">
                      <th className="pb-1.5 font-medium">Month</th>
                      <th className="pb-1.5 font-medium">Customers</th>
                      <th className="pb-1.5 font-medium">Revenue to date</th>
                      <th className="pb-1.5 font-medium">Avg. per customer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.cohorts.map((c) => (
                      <tr key={c.key} className="border-t border-border/60">
                        <td className="py-1.5 text-text-primary">{c.label}</td>
                        <td className="py-1.5 text-text-secondary">{c.customerCount}</td>
                        <td className="py-1.5 text-text-secondary">{formatCurrency(c.totalRevenue)}</td>
                        <td className="py-1.5 text-text-secondary">{formatCurrency(c.avgRevenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="mt-5 flex items-start gap-2 rounded-xl border border-dashed border-border p-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" />
            <p className="text-xs leading-relaxed text-text-secondary">
              LTV here only counts jobs marked &ldquo;paid&rdquo; in Invoice Status. If invoices aren&rsquo;t
              being marked paid consistently, these numbers will run low &mdash; this isn&rsquo;t a
              replacement for real accounting, just a directional view.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
