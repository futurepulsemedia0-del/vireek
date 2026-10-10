import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Copy, DollarSign, Receipt } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import type { Job } from '@/lib/supabase';
import { COST_CATEGORY_COLORS, COST_CATEGORY_LABELS, formatCents, formatMargin, marginBadgeColor } from '@/lib/jobCosting';
import type { JobCostEntry } from '@/lib/jobCosting';
import { getInvoiceLink, isOverdue } from '@/lib/invoices';
import type { Invoice, InvoiceStatus } from '@/lib/invoices';
import { formatWhen, invoiceTotals, jobRevenueCents, primaryInvoice, summarizeCosts } from '@/lib/jobDetail';
import { JobSection, Pill, Row, SectionError, SectionSkeleton } from './JobSection';
import type { SectionState } from './JobSection';

const RECENT_COST_ROWS = 8;

// ============================================================
// COSTS & PROFIT
// ============================================================

function Tile({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-3">
      <p className="text-xs text-text-secondary">{label}</p>
      <p className={`mt-1 text-lg font-bold ${tone ?? 'text-text-primary'}`}>{value}</p>
    </div>
  );
}

export function JobCostsCard({
  job,
  costs,
  invoices,
}: {
  job: Job;
  costs: SectionState<JobCostEntry[]>;
  invoices: SectionState<Invoice[]>;
}) {
  const revenue = jobRevenueCents(job, invoices.data);
  const summary = summarizeCosts(costs.data, revenue);
  const loading = (costs.loading && costs.data.length === 0) || (invoices.loading && invoices.data.length === 0);

  let body: ReactNode;
  if (loading) {
    body = <SectionSkeleton />;
  } else if (costs.error) {
    body = <SectionError onRetry={costs.reload} />;
  } else {
    body = (
      <div className="space-y-4">
        {invoices.error && <SectionError message="Could not load invoices, so revenue may be understated." onRetry={invoices.reload} />}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile label="Revenue" value={revenue > 0 ? formatCents(revenue) : '—'} />
          <Tile label="Cost" value={formatCents(summary.totalCostCents)} />
          <Tile
            label="Gross profit"
            value={revenue > 0 || summary.totalCostCents > 0 ? formatCents(summary.grossProfitCents) : '—'}
            tone={summary.grossProfitCents < 0 ? 'text-danger' : undefined}
          />
          <div className="rounded-xl border border-border bg-bg-primary p-3">
            <p className="text-xs text-text-secondary">Margin</p>
            <p className="mt-1.5">
              <Pill className={marginBadgeColor(summary.marginPct)}>{formatMargin(summary.marginPct)}</Pill>
            </p>
          </div>
        </div>

        {summary.marginPct === null && summary.totalCostCents > 0 && (
          <p className="text-xs text-text-secondary">Margin appears once this job has revenue (an invoice or an invoice amount).</p>
        )}

        {costs.data.length === 0 ? (
          <EmptyState
            icon={DollarSign}
            title="No costs recorded"
            description="Labor, materials, equipment and subcontractor costs added to this job show up here."
          />
        ) : (
          <>
            <ul className="space-y-2" aria-label="Cost breakdown by category">
              {summary.rows.map((r) => (
                <li key={r.category}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="font-medium text-text-primary">
                      {COST_CATEGORY_LABELS[r.category]} <span className="text-text-secondary">· {r.count}</span>
                    </span>
                    <span className="text-text-secondary">{formatCents(r.totalCents)}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-bg-tertiary">
                    <div className="h-full rounded-full" style={{ width: `${Math.max(2, Math.round(r.share * 100))}%`, backgroundColor: COST_CATEGORY_COLORS[r.category] }} />
                  </div>
                </li>
              ))}
            </ul>

            <div>
              <h3 className="mb-2 text-xs font-medium text-text-secondary">Latest entries</h3>
              <ul className="space-y-2">
                {costs.data.slice(0, RECENT_COST_ROWS).map((c) => (
                  <li key={c.id}>
                    <Row>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-text-primary">{c.description}</span>
                        <span className="block text-xs text-text-secondary">
                          {COST_CATEGORY_LABELS[c.category]} · {c.quantity} × {formatCents(c.unit_cost_cents)}
                        </span>
                      </span>
                      <span className="text-sm font-semibold text-text-primary">{formatCents(c.total_cost_cents)}</span>
                    </Row>
                  </li>
                ))}
              </ul>
              {costs.data.length > RECENT_COST_ROWS && (
                <p className="mt-2 text-xs text-text-secondary">
                  Showing {RECENT_COST_ROWS} of {costs.data.length} entries.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <JobSection
      title="Costs & profit"
      icon={DollarSign}
      action={
        <Link to="/dashboard/profitability" className="focus-ring text-xs font-medium text-accent hover:underline">
          Manage costs
        </Link>
      }
    >
      {body}
    </JobSection>
  );
}

// ============================================================
// INVOICE
// ============================================================

const INVOICE_STATUS_CLASS: Record<InvoiceStatus, string> = {
  draft: 'bg-bg-tertiary text-text-secondary',
  sent: 'bg-blue-500/10 text-blue-500',
  viewed: 'bg-blue-500/10 text-blue-500',
  paid: 'bg-success-500/10 text-success-500',
  void: 'bg-bg-tertiary text-text-secondary',
};

const QUICK_INVOICE_LABEL: Record<Job['invoice_status'], string> = { not_sent: 'Not sent', sent: 'Sent', paid: 'Paid' };

function formatDue(date: string | null): string {
  if (!date) return '—';
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '—';
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function JobInvoiceCard({
  job,
  invoices,
  canEdit,
  creating,
  onCreateFromQuote,
}: {
  job: Job;
  invoices: SectionState<Invoice[]>;
  canEdit: boolean;
  creating: boolean;
  onCreateFromQuote: () => void;
}) {
  const { toast } = useToast();
  const [copying, setCopying] = useState(false);
  const main = primaryInvoice(invoices.data);
  const others = invoices.data.filter((i) => i.id !== main?.id);

  const copyLink = async (token: string) => {
    if (copying) return;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(getInvoiceLink(token));
      toast('Invoice link copied', 'success');
    } catch {
      toast('Could not copy the link', 'error');
    } finally {
      setCopying(false);
    }
  };

  let body: ReactNode;
  if (invoices.loading && invoices.data.length === 0) {
    body = <SectionSkeleton rows={2} />;
  } else if (invoices.error && invoices.data.length === 0) {
    body = <SectionError onRetry={invoices.reload} />;
  } else if (!main) {
    body = (
      <div className="space-y-3">
        <EmptyState icon={Receipt} title="No invoice for this job" description="Create one from the accepted quote, or in Invoicing." />
        <div className="flex flex-wrap items-center justify-center gap-2">
          {canEdit && job.quote_id && (
            <Button size="sm" disabled={creating} onClick={onCreateFromQuote}>
              {creating ? 'Creating…' : 'Create invoice from quote'}
            </Button>
          )}
          <Link to="/dashboard/invoicing" className="focus-ring text-sm font-medium text-accent hover:underline">
            Open Invoicing
          </Link>
        </div>
        {job.invoice_amount !== null && job.invoice_amount > 0 && (
          <p className="text-center text-xs text-text-secondary">
            Quick invoice on the job: {new Intl.NumberFormat('en-US', { style: 'currency', currency: job.invoice_currency || 'USD' }).format(job.invoice_amount)} ·{' '}
            {QUICK_INVOICE_LABEL[job.invoice_status]}
          </p>
        )}
      </div>
    );
  } else {
    const totals = invoiceTotals(main);
    const overdue = isOverdue(main);
    body = (
      <div className="space-y-3">
        {invoices.error && <SectionError message="Could not refresh invoices." onRetry={invoices.reload} />}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-base font-bold text-text-primary">{main.invoice_number ?? 'Draft invoice'}</p>
            <p className="text-xs text-text-secondary">{main.customer_name}</p>
          </div>
          <span className="flex items-center gap-1.5">
            {overdue && <Pill className="bg-danger/10 text-danger">Overdue</Pill>}
            <Pill className={INVOICE_STATUS_CLASS[main.status]}>{main.status}</Pill>
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Subtotal" value={formatCents(totals.subtotalCents)} />
          <Tile label={`Tax (${Number(main.tax_percent) || 0}%)`} value={formatCents(totals.taxCents)} />
          <Tile label="Total" value={formatCents(totals.totalCents)} />
          <Tile label="Due" value={formatDue(main.due_date)} tone={overdue ? 'text-danger' : undefined} />
        </div>

        <p className="text-xs text-text-secondary">
          {main.paid_at
            ? `Paid ${formatWhen(main.paid_at)}${main.payment_method ? ` via ${main.payment_method}` : ''}`
            : main.viewed_at
              ? `Viewed by customer ${formatWhen(main.viewed_at)}`
              : main.sent_at
                ? `Sent ${formatWhen(main.sent_at)}`
                : 'Not sent to the customer'}
        </p>

        <div className="flex flex-wrap gap-2">
          {main.status !== 'void' && (
            <Button variant="secondary" size="sm" disabled={copying} onClick={() => void copyLink(main.invoice_token)}>
              <Copy size={14} /> Copy customer link
            </Button>
          )}
          <Link
            to="/dashboard/invoicing"
            className="focus-ring inline-flex min-h-[36px] items-center rounded-xl px-3 text-sm font-semibold text-accent hover:underline"
          >
            Open Invoicing
          </Link>
        </div>

        {others.length > 0 && (
          <div>
            <h3 className="mb-2 text-xs font-medium text-text-secondary">Other invoices on this job</h3>
            <ul className="space-y-2">
              {others.map((i) => (
                <li key={i.id}>
                  <Row>
                    <span className="text-sm text-text-primary">{i.invoice_number ?? 'Draft'}</span>
                    <span className="flex items-center gap-2 text-sm">
                      <span className="text-text-secondary">{formatCents(invoiceTotals(i).totalCents)}</span>
                      <Pill className={INVOICE_STATUS_CLASS[i.status]}>{i.status}</Pill>
                    </span>
                  </Row>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  return (
    <JobSection title="Invoice" icon={Receipt}>
      {body}
    </JobSection>
  );
}
