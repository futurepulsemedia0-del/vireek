import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  BookUser,
  CalendarClock,
  FileText,
  History,
  Lock,
  MapPin,
  MessageSquareText,
  Receipt,
  Wrench,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import {
  analyzeEquipment,
  buildSignals,
  buildSuggestedScript,
  formatMoney,
  formatPhone,
  type DeskCall,
  type ScreenPopData,
  type SignalSeverity,
} from '@/lib/csrScreenPop';

const SEVERITY_STYLE: Record<SignalSeverity, string> = {
  critical: 'bg-danger/10 text-danger',
  warning: 'bg-warning-500/15 text-warning-500',
  info: 'bg-accent/10 text-accent',
  positive: 'bg-success-500/15 text-success-500',
};

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const fmtDateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Unscheduled';

function Section({ icon: Icon, title, children }: { icon: typeof BookUser; title: string; children: React.ReactNode }) {
  return (
    <Card className="!p-4 hover:!translate-y-0">
      <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
        <Icon className="h-4 w-4 text-accent" aria-hidden="true" />
        {title}
      </h3>
      {children}
    </Card>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => <p className="text-sm text-text-secondary">{children}</p>;

export function ScreenPopPanel({
  call,
  data,
  canViewBilling,
  now,
}: {
  call: DeskCall;
  data: ScreenPopData;
  canViewBilling: boolean;
  now: number;
}) {
  const signals = buildSignals(call, data, now);
  const script = buildSuggestedScript(call, data, now);
  const c = data.customer;
  const last = data.last_conversation;

  return (
    <div className="space-y-4" data-testid="screen-pop">
      {/* Identity */}
      <Card className="!p-5 hover:!translate-y-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-xl font-bold text-text-primary">{c?.name ?? call.caller_name ?? 'Unknown caller'}</h2>
            <p className="mt-0.5 text-sm text-text-secondary">{formatPhone(call.caller_phone)}</p>
            {c?.address && (
              <p className="mt-1 flex items-center gap-1.5 text-sm text-text-secondary">
                <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{c.address}</span>
              </p>
            )}
          </div>
          {c && (
            <Link to={`/dashboard/customers/${c.id}`} className="focus-ring rounded-lg text-sm font-semibold text-accent hover:underline">
              Open customer record
            </Link>
          )}
        </div>
        {signals.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2" aria-label="Caller signals">
            {signals.map((s) => (
              <li key={s.key} className={`rounded-full px-2.5 py-1 text-xs font-semibold ${SEVERITY_STYLE[s.severity]}`}>
                {s.label}
              </li>
            ))}
          </ul>
        )}
        {c?.notes && <p className="mt-3 rounded-lg bg-bg-tertiary p-3 text-sm text-text-secondary">{c.notes}</p>}
      </Card>

      {/* Suggested script */}
      <Card className="!p-5 hover:!translate-y-0 border-accent/30" data-testid="suggested-script">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-accent">
          <MessageSquareText className="h-4 w-4" aria-hidden="true" />
          Suggested script
        </h3>
        <p className="mt-2 text-base font-semibold text-text-primary">{script.headline}</p>
        <blockquote className="mt-2 border-l-2 border-accent/40 pl-3 text-sm italic text-text-primary">“{script.opener}”</blockquote>
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-text-secondary">
          {script.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Open jobs */}
        <Section icon={CalendarClock} title="Open jobs">
          {data.open_jobs.length === 0 ? (
            <Empty>No open jobs.</Empty>
          ) : (
            <ul className="space-y-2">
              {data.open_jobs.map((j) => (
                <li key={j.id} className="text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-text-primary">{j.service_type ?? 'Service call'}</span>
                    <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">{j.job_status.replace('_', ' ')}</span>
                  </div>
                  <p className="text-text-secondary">{fmtDateTime(j.scheduled_datetime)}</p>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Balance */}
        <Section icon={Receipt} title="Balance">
          {!canViewBilling ? (
            <p className="flex items-center gap-2 text-sm text-text-secondary">
              <Lock className="h-4 w-4" aria-hidden="true" /> Billing details are restricted for your role.
            </p>
          ) : data.balance.open_invoice_count === 0 ? (
            <Empty>No outstanding invoices.</Empty>
          ) : (
            <div className="text-sm">
              <p className="text-2xl font-bold text-text-primary">{formatMoney(data.balance.outstanding_cents)}</p>
              <p className="text-text-secondary">
                {data.balance.open_invoice_count} open invoice{data.balance.open_invoice_count === 1 ? '' : 's'}
                {data.balance.overdue_cents > 0 && (
                  <span className="font-semibold text-danger"> · {formatMoney(data.balance.overdue_cents)} overdue</span>
                )}
              </p>
            </div>
          )}
        </Section>

        {/* Equipment */}
        <Section icon={Wrench} title="Equipment">
          {data.equipment.length === 0 ? (
            <Empty>No equipment on file.</Empty>
          ) : (
            <ul className="space-y-2">
              {data.equipment.map((e) => {
                const i = analyzeEquipment(e, now);
                return (
                  <li key={e.id} className="text-sm">
                    <p className="font-medium text-text-primary">
                      {i.label} <span className="font-normal text-text-secondary">· {e.equipment_type}</span>
                    </p>
                    <p className="text-text-secondary">
                      {i.ageYears != null ? `${i.ageYears.toFixed(1)} yrs old` : 'Age unknown'}
                      {i.warranty === 'active' || i.warranty === 'expiring' ? ` · warranty ${i.warrantyDaysLeft}d left` : ''}
                      {i.serviceDue === 'overdue' ? ' · service overdue' : ''}
                      {i.nearEndOfLife ? ' · near end of life' : ''}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        {/* Quotes */}
        <Section icon={FileText} title="Open quotes">
          {data.open_quotes.length === 0 ? (
            <Empty>No open quotes.</Empty>
          ) : (
            <ul className="space-y-2">
              {data.open_quotes.map((q) => (
                <li key={q.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-text-primary">{formatMoney(q.total_cents)}</span>
                  <span className="text-text-secondary">{q.status}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {/* Last conversation */}
      <Section icon={History} title="Last conversation">
        {!last ? (
          <Empty>{data.history.total_calls > 0 ? 'Earlier calls exist but none finished with a summary.' : 'First time we have heard from this number.'}</Empty>
        ) : (
          <div className="text-sm">
            <p className="text-text-secondary">
              {fmtDate(last.call_datetime)}
              {last.sentiment && ` · ${last.sentiment}`}
              {data.history.total_calls > 1 && ` · ${data.history.total_calls} calls total`}
            </p>
            <p className="mt-1 text-text-primary">{last.summary ?? 'No summary recorded.'}</p>
            {last.recommended_follow_up && (
              <p className="mt-2 text-text-secondary">
                <span className="font-semibold">Recommended follow-up:</span> {last.recommended_follow_up}
              </p>
            )}
            {last.objections_resolved === false && last.objections_raised.length > 0 && (
              <p className="mt-2 flex items-start gap-1.5 text-warning-500">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                Unresolved: {last.objections_raised.join('; ')}
              </p>
            )}
          </div>
        )}
        {data.memory.length > 0 && (
          <ul className="mt-3 space-y-1 border-t border-border pt-3 text-sm text-text-secondary">
            {data.memory.map((m) => (
              <li key={`${m.category}-${m.fact}`}>
                <span className="font-medium text-text-primary">{m.category.replace('_', ' ')}:</span> {m.fact}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
