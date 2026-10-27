import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, ChevronDown, Clock, Mail, MapPin, Phone, PauseCircle, Plug, TriangleAlert as AlertTriangle, UserRound } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  ACTION_META,
  AUTH_COLORS,
  AUTH_LABELS,
  availableActions,
  computeSla,
  EVENT_LABELS,
  formatDateTime,
  formatMoney,
  PRIORITY_COLORS,
  PRIORITY_LABELS,
  SLA_STAGE_LABELS,
  SLA_STATE_COLORS,
  STATUS_COLORS,
  STATUS_LABELS,
  type IntakeAction,
  type IntakeEvent,
  type ThirdPartyWorkOrder,
} from '@/lib/thirdPartyIntake';

interface Props {
  row: ThirdPartyWorkOrder;
  nowMs: number;
  expanded: boolean;
  busy: boolean;
  events: IntakeEvent[] | undefined;
  eventsError: boolean;
  rawPayload: string | null | undefined;
  onToggle: () => void;
  onAction: (action: IntakeAction) => void;
  onLoadRaw: () => void;
}

const chip = 'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium';

export function IntakeCard({ row, nowMs, expanded, busy, events, eventsError, rawPayload, onToggle, onAction, onLoadRaw }: Props) {
  const [showRaw, setShowRaw] = useState(false);
  const sla = computeSla(row, nowMs);
  const actions = availableActions(row);
  const [primary, ...rest] = actions;
  const panelId = `intake-${row.id}`;

  return (
    <Card className="!p-0 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="focus-ring flex w-full items-start gap-3 p-4 text-left sm:p-5"
      >
        <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          {row.received_via === 'email' ? <Mail size={18} aria-hidden="true" /> : <Plug size={18} aria-hidden="true" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-text-primary">{row.title}</span>
            {row.priority !== 'standard' && <span className={`${chip} ${PRIORITY_COLORS[row.priority]}`}>{PRIORITY_LABELS[row.priority]}</span>}
          </span>
          <span className="mt-0.5 block truncate text-xs text-text-secondary">
            {row.payer_name}{row.external_ref ? ` · ${row.external_ref}` : ''} · {formatDateTime(row.received_at)}
          </span>
          <span className="mt-2 flex flex-wrap items-center gap-2">
            <span className={`${chip} ${STATUS_COLORS[row.status]}`}>{STATUS_LABELS[row.status]}</span>
            <span className={`${chip} ${AUTH_COLORS[row.authorization_status]}`}>{AUTH_LABELS[row.authorization_status]}</span>
            {sla.state !== 'closed' && (
              <span className={`${chip} ${SLA_STATE_COLORS[sla.state]}`}>
                {sla.state === 'paused' ? <PauseCircle size={12} aria-hidden="true" /> : sla.state === 'breached' ? <AlertTriangle size={12} aria-hidden="true" /> : <Clock size={12} aria-hidden="true" />}
                {sla.stage ? `${SLA_STAGE_LABELS[sla.stage]}: ` : ''}{sla.label}
              </span>
            )}
            {row.needs_review && <span className={`${chip} bg-warning-500/10 text-warning-500`}>Needs review</span>}
          </span>
        </span>
        <ChevronDown size={18} aria-hidden="true" className={`mt-1 shrink-0 text-text-secondary transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && (
        <div id={panelId} className="space-y-4 border-t border-border/70 p-4 sm:p-5">
          {row.needs_review && row.review_reasons.length > 0 && (
            <div role="status" className="rounded-xl border border-warning-500/30 bg-warning-500/5 px-3 py-2.5 text-sm text-text-primary">
              <p className="font-medium">Check these before accepting</p>
              <ul className="mt-1 list-disc pl-5 text-text-secondary">
                {row.review_reasons.map((r) => <li key={r}>{r}</li>)}
              </ul>
            </div>
          )}

          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <Detail icon={UserRound} label="Customer" value={row.customer_name} />
            <Detail icon={Phone} label="Phone" value={row.customer_phone} href={row.customer_phone ? `tel:${row.customer_phone}` : undefined} />
            <Detail icon={Mail} label="Email" value={row.customer_email} href={row.customer_email ? `mailto:${row.customer_email}` : undefined} />
            <Detail icon={MapPin} label="Service address" value={row.service_address} />
            <Detail icon={Building2} label="Policy / service" value={[row.policy_number, row.service_type].filter(Boolean).join(' · ') || null} />
            <Detail icon={Clock} label="Scheduled for" value={row.scheduled_for ? formatDateTime(row.scheduled_for) : null} />
          </dl>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Money label="Not to exceed" cents={row.nte_cents} />
            <Money label="Quoted" cents={row.quoted_cents} />
            <Money label="Authorized" cents={row.authorized_cents} />
            <div>
              <p className="text-xs text-text-secondary">Authorization #</p>
              <p className="mt-0.5 text-sm font-semibold text-text-primary">{row.authorization_ref ?? '—'}</p>
            </div>
          </div>

          {row.description && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">Description</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-text-primary">{row.description}</p>
            </div>
          )}
          {row.decline_reason && <p className="text-sm text-text-secondary">Declined: {row.decline_reason}</p>}
          {row.work_order_id && (
            <Link to="/dashboard/work-orders" className="focus-ring inline-block rounded-lg text-sm font-medium text-accent hover:underline">
              Open in Work Orders
            </Link>
          )}

          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">Timeline</p>
            {eventsError ? (
              <p role="alert" className="mt-1 text-sm text-danger">Couldn’t load the timeline.</p>
            ) : events === undefined ? (
              <p className="mt-1 text-sm text-text-secondary" aria-busy="true">Loading timeline…</p>
            ) : (
              <ol className="mt-2 space-y-2 border-l border-border pl-4">
                {events.map((ev) => (
                  <li key={ev.id} className="text-sm">
                    <span className="font-medium text-text-primary">{EVENT_LABELS[ev.kind] ?? ev.kind}</span>
                    <span className="text-text-secondary"> · {formatDateTime(ev.created_at)}</span>
                    {ev.note && <p className="break-words text-text-secondary">{ev.note}</p>}
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div>
            <button
              type="button"
              className="focus-ring rounded-lg text-xs font-medium text-text-secondary hover:text-text-primary"
              onClick={() => {
                if (!showRaw && rawPayload === undefined) onLoadRaw();
                setShowRaw((v) => !v);
              }}
            >
              {showRaw ? 'Hide original message' : 'View original message'}
            </button>
            {showRaw && (
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-bg-tertiary p-3 text-xs text-text-secondary">
                {rawPayload === undefined ? 'Loading…' : rawPayload ?? 'The original message was removed after 30 days.'}
              </pre>
            )}
          </div>

          {actions.length > 0 && (
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {primary && (
                <Button type="button" size="sm" disabled={busy} className="w-full sm:w-auto" onClick={() => onAction(primary)}>
                  {ACTION_META[primary].label}
                </Button>
              )}
              {rest.map((a) => (
                <Button
                  key={a}
                  type="button"
                  size="sm"
                  variant={ACTION_META[a].tone === 'danger' ? 'ghost' : 'secondary'}
                  disabled={busy}
                  className={`w-full sm:w-auto ${ACTION_META[a].tone === 'danger' ? 'text-danger' : ''}`}
                  onClick={() => onAction(a)}
                >
                  {ACTION_META[a].label}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function Detail({ icon: Icon, label, value, href }: { icon: typeof Mail; label: string; value: string | null; href?: string }) {
  return (
    <div className="flex items-start gap-2">
      <Icon size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-text-secondary" />
      <div className="min-w-0">
        <dt className="text-xs text-text-secondary">{label}</dt>
        <dd className="break-words text-text-primary">
          {value ? (href ? <a href={href} className="focus-ring rounded text-accent hover:underline">{value}</a> : value) : '—'}
        </dd>
      </div>
    </div>
  );
}

function Money({ label, cents }: { label: string; cents: number | null }) {
  return (
    <div>
      <p className="text-xs text-text-secondary">{label}</p>
      <p className="mt-0.5 text-sm font-semibold text-text-primary">{formatMoney(cents)}</p>
    </div>
  );
}
