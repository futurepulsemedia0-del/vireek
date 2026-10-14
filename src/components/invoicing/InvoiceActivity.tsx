import { AlertTriangle, BellRing, CheckCircle2, Eye, FilePlus2, Send, Undo2, Wallet, Ban, type LucideIcon } from 'lucide-react';
import { formatCents } from '@/lib/invoices';
import { auditActionLabel, type InvoiceAuditEntry, type TimelineEvent, type TimelineKind } from '@/lib/invoiceDetail';

export const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const ICONS: Record<TimelineKind, LucideIcon> = {
  created: FilePlus2,
  sent: Send,
  viewed: Eye,
  payment: Wallet,
  refund: Undo2,
  reminder: BellRing,
  paid: CheckCircle2,
  void: Ban,
};

const TONES: Record<TimelineEvent['tone'], string> = {
  neutral: 'bg-bg-tertiary text-text-secondary',
  success: 'bg-success-500/15 text-success-500',
  warning: 'bg-warning-500/15 text-warning-500',
  danger: 'bg-danger-500/15 text-danger-500',
};

export function InvoiceTimeline({ events }: { events: TimelineEvent[] }) {
  return (
    <ol className="space-y-4" aria-label="Invoice activity">
      {events.map((e, i) => {
        const Icon = ICONS[e.kind];
        return (
          <li key={e.id} className="relative flex gap-3">
            {i < events.length - 1 && <span aria-hidden className="absolute left-[15px] top-8 h-[calc(100%-8px)] w-px bg-border" />}
            <span className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${TONES[e.tone]}`}>
              <Icon size={14} />
            </span>
            <div className="min-w-0 flex-1 pb-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className="text-sm font-medium text-text-primary">{e.title}</p>
                {e.amountCents !== undefined && (
                  <p className={`text-sm font-semibold tabular-nums ${e.kind === 'refund' ? 'text-danger-500' : 'text-success-500'}`}>
                    {e.kind === 'refund' ? '−' : '+'}{formatCents(e.amountCents)}
                  </p>
                )}
              </div>
              <p className="text-xs text-text-secondary">{fmtDateTime(e.at)}</p>
              {e.detail && <p className="mt-0.5 break-words text-xs text-text-secondary">{e.detail}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function describeDetails(d: InvoiceAuditEntry['details']): string | null {
  if (!d) return null;
  const parts: string[] = [];
  if (typeof d.amount_cents === 'number') parts.push(formatCents(d.amount_cents));
  if (typeof d.method === 'string') parts.push(d.method.replace(/_/g, ' '));
  if (typeof d.recipient === 'string') parts.push(d.recipient);
  if (typeof d.reason === 'string') parts.push(`“${d.reason}”`);
  return parts.length ? parts.join(' · ') : null;
}

export function InvoiceAuditTrail({ entries, error, onRetry }: { entries: InvoiceAuditEntry[] | null; error: boolean; onRetry: () => void }) {
  if (error) {
    return (
      <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger-500/10 p-3 text-xs text-danger-500">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span>Couldn’t load the audit trail. <button type="button" onClick={onRetry} className="focus-ring font-semibold underline">Retry</button></span>
      </div>
    );
  }
  if (entries === null) {
    return <div className="space-y-2" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="h-9 animate-pulse rounded-lg bg-bg-tertiary" />)}</div>;
  }
  if (entries.length === 0) return <p className="text-xs text-text-secondary">Nothing has been audited on this invoice so far.</p>;
  return (
    <ul className="divide-y divide-border">
      {entries.map((a) => {
        const detail = describeDetails(a.details);
        return (
          <li key={a.id} className="py-2.5">
            <p className="text-sm font-medium text-text-primary">{auditActionLabel(a.action)}</p>
            <p className="text-xs text-text-secondary">{a.actor_email ?? 'System'} · {fmtDateTime(a.created_at)}</p>
            {detail && <p className="mt-0.5 break-words text-xs text-text-secondary">{detail}</p>}
          </li>
        );
      })}
    </ul>
  );
}
