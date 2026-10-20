import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, FileText, Phone } from 'lucide-react';
import { fetchBusiness, getDocumentUrl, HomeownerApiError } from '@/lib/homeowner/api';
import { formatDate, formatDateTime, formatMoney, invoiceStatusLabel, splitJobs } from '@/lib/homeowner/format';
import type { BusinessDetail, HomeEquipment, HomeInvoice, HomeJob, ScopeKey } from '@/lib/homeowner/types';
import { getPublicOrigin } from '@/lib/appOrigin';
import { passportUrl, warrantyState } from '@/lib/equipmentPassport';
import { GRADE_STYLES, windowLabel } from '@/lib/homeHealth';
import { Badge, Card, cx, ErrorNote, openExternal, PrimaryButton, SecondaryButton, Spinner } from './ui';

const TABS: { key: ScopeKey; label: string }[] = [
  { key: 'jobs', label: 'Appointments' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'equipment', label: 'Equipment' },
  { key: 'documents', label: 'Documents' },
  { key: 'health', label: 'Health' },
];

function JobsPanel({ jobs }: { jobs: HomeJob[] }) {
  const origin = getPublicOrigin();
  const { upcoming, past } = useMemo(() => splitJobs(jobs), [jobs]);
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-text-primary">Upcoming</h3>
      {upcoming.length === 0 && <p className="text-sm text-text-secondary">No upcoming appointments.</p>}
      <ul className="space-y-3">
        {upcoming.map((j) => (
          <li key={j.id}>
            <Card>
              <p className="font-medium text-text-primary">{j.service_type ?? 'Service visit'}</p>
              <p className="text-sm text-text-secondary">{formatDateTime(j.scheduled_datetime)}</p>
              <div className="mt-2 flex items-center gap-2">
                <Badge tone="accent">{j.job_status.replace('_', ' ')}</Badge>
                {j.reschedule_token && (
                  <SecondaryButton className="min-h-[36px] px-3 py-1.5 text-xs" onClick={() => openExternal(`${origin}/reschedule/${j.reschedule_token}`)}>
                    Reschedule
                  </SecondaryButton>
                )}
              </div>
            </Card>
          </li>
        ))}
      </ul>
      <h3 className="text-sm font-semibold text-text-primary">History</h3>
      {past.length === 0 && <p className="text-sm text-text-secondary">No past visits yet.</p>}
      <ul className="divide-y divide-border rounded-2xl border border-border bg-bg-secondary">
        {past.map((j) => (
          <li key={j.id} className="flex items-center justify-between gap-3 p-3 text-sm">
            <span className="min-w-0 truncate text-text-primary">{j.service_type ?? 'Service visit'}</span>
            <span className="shrink-0 text-xs text-text-secondary">
              {j.job_status === 'cancelled' ? 'Cancelled' : formatDate(j.completed_at ?? j.scheduled_datetime)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function InvoicesPanel({ invoices }: { invoices: HomeInvoice[] }) {
  const origin = getPublicOrigin();
  const due = invoices.filter((i) => i.status === 'sent' || i.status === 'viewed' || i.status === 'overdue');
  const dueTotal = due.reduce((s, i) => s + i.total_cents, 0);
  return (
    <div className="space-y-3">
      <Card>
        <p className="text-xs text-text-secondary">Amount due</p>
        <p className="text-2xl font-semibold text-text-primary">{formatMoney(dueTotal)}</p>
      </Card>
      {invoices.length === 0 && <p className="text-sm text-text-secondary">No invoices yet.</p>}
      <ul className="space-y-2">
        {invoices.map((i) => {
          const isDue = i.status !== 'paid' && i.status !== 'void';
          return (
            <li key={i.id}>
              <Card className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-primary">Invoice {i.invoice_number ?? ''}</p>
                  <p className="text-xs text-text-secondary">
                    {i.status === 'paid' ? `Paid ${formatDate(i.paid_at)}` : `Due ${formatDate(i.due_date)}`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <div className="text-right">
                    <p className="text-sm font-semibold text-text-primary">{formatMoney(i.total_cents)}</p>
                    <Badge tone={i.status === 'paid' ? 'good' : i.status === 'overdue' ? 'bad' : 'warn'}>{invoiceStatusLabel(i.status)}</Badge>
                  </div>
                  {i.invoice_token && (
                    <SecondaryButton
                      aria-label={isDue ? 'View and pay invoice' : 'View invoice'}
                      className="min-h-[36px] px-3 py-1.5 text-xs"
                      onClick={() => openExternal(`${origin}/invoice/${i.invoice_token}`)}
                    >
                      {isDue ? 'Pay' : 'View'}
                    </SecondaryButton>
                  )}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function EquipmentPanel({ equipment }: { equipment: HomeEquipment[] }) {
  const origin = getPublicOrigin();
  if (equipment.length === 0) return <p className="text-sm text-text-secondary">No equipment on file yet.</p>;
  return (
    <ul className="space-y-3">
      {equipment.map((e) => {
        const w = warrantyState(e.warranty_expires_at);
        return (
          <li key={e.id}>
            <Card>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium text-text-primary">{[e.make, e.model].filter(Boolean).join(' ') || e.equipment_type}</p>
                  <p className="text-xs text-text-secondary">
                    {e.equipment_type} · Installed {formatDate(e.install_date)} · Last service {formatDate(e.last_service_date)}
                  </p>
                </div>
                <Badge tone={w.state === 'active' ? 'good' : w.state === 'expiring' ? 'warn' : w.state === 'expired' ? 'bad' : 'neutral'}>
                  {w.state === 'unknown' ? 'Warranty unknown' : w.state === 'expired' ? 'Warranty expired' : `Warranty ${w.daysLeft}d left`}
                </Badge>
              </div>
              {e.warranty_expires_at && <p className="mt-1 text-xs text-text-secondary">Warranty ends {formatDate(e.warranty_expires_at)}</p>}
              {e.passport_code && (
                <button
                  type="button"
                  onClick={() => openExternal(passportUrl(e.passport_code ?? '', origin))}
                  className="focus-ring mt-2 inline-flex items-center gap-1 text-xs font-semibold text-accent"
                >
                  Equipment passport <ExternalLink size={12} aria-hidden />
                </button>
              )}
            </Card>
          </li>
        );
      })}
    </ul>
  );
}

function DocumentsPanel({ linkId, documents }: { linkId: string; documents: BusinessDetail['documents'] }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      openExternal(await getDocumentUrl(linkId, id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the document.');
    } finally {
      setBusyId(null);
    }
  };
  if (!documents?.length) return <p className="text-sm text-text-secondary">This provider hasn’t shared any documents with you.</p>;
  return (
    <div className="space-y-3">
      {error && <ErrorNote message={error} />}
      <ul className="space-y-2">
        {documents.map((d) => (
          <li key={d.id}>
            <Card className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <FileText size={20} className="shrink-0 text-accent" aria-hidden />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-primary">{d.title}</p>
                  <p className="text-xs text-text-secondary capitalize">
                    {d.category}{d.expires_on ? ` · Expires ${formatDate(d.expires_on)}` : ''}
                  </p>
                </div>
              </div>
              <SecondaryButton busy={busyId === d.id} className="min-h-[36px] px-3 py-1.5 text-xs" onClick={() => void open(d.id)}>
                Open
              </SecondaryButton>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HealthPanel({ health }: { health: NonNullable<BusinessDetail['health']> }) {
  const risks = [...health.breakdown].filter((b) => b.risk !== 'low').sort((a, b) => a.health - b.health);
  const labelOf = (equipmentId: string) => health.breakdown.find((b) => b.equipment_id === equipmentId)?.label ?? 'Equipment';
  return (
    <div className="space-y-4">
      <Card className="flex items-center gap-4">
        <div className={cx('flex h-20 w-20 shrink-0 flex-col items-center justify-center rounded-full border-4 border-border')}>
          <span className="text-2xl font-bold text-text-primary">{health.score}</span>
          <span className="text-[10px] text-text-secondary">/ 100</span>
        </div>
        <div>
          <span className={cx('rounded-full px-2.5 py-1 text-xs font-semibold', GRADE_STYLES[health.grade])}>Grade {health.grade}</span>
          <p className="mt-1 text-sm text-text-secondary">
            {health.at_risk_count === 0 ? 'Nothing needs attention right now.' : `${health.at_risk_count} item(s) need attention.`}
          </p>
          <p className="text-xs text-text-secondary">Updated {formatDate(health.computed_at)}</p>
        </div>
      </Card>

      {health.actions.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-text-primary">Recommended</h3>
          <ul className="space-y-2">
            {health.actions.map((a) => (
              <li key={a.id}>
                <Card>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-text-primary">
                      {a.action_type === 'replacement_planning' ? 'Plan a replacement' : 'Schedule maintenance'} · {labelOf(a.equipment_id)}
                    </p>
                    <Badge tone={a.urgency === 'high' ? 'bad' : 'warn'}>{a.urgency}</Badge>
                  </div>
                  {a.window_min_months != null && <p className="text-xs text-text-secondary">Suggested window: {windowLabel(a.window_min_months, a.window_max_months)}</p>}
                  {a.explanation && <p className="mt-1 text-xs text-text-secondary">{a.explanation}</p>}
                </Card>
              </li>
            ))}
          </ul>
        </div>
      )}

      {risks.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-text-primary">Equipment to watch</h3>
          <ul className="divide-y divide-border rounded-2xl border border-border bg-bg-secondary">
            {risks.map((r) => (
              <li key={r.equipment_id} className="flex items-center justify-between gap-3 p-3 text-sm">
                <span className="min-w-0 truncate text-text-primary">{r.label}</span>
                <Badge tone={r.risk === 'high' ? 'bad' : 'warn'}>{r.health}/100</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function HomeBusinessPage() {
  const { linkId = '' } = useParams<{ linkId: string }>();
  const [detail, setDetail] = useState<BusinessDetail | null>(null);
  const [error, setError] = useState<{ message: string; gone: boolean } | null>(null);
  const [tab, setTab] = useState<ScopeKey | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await fetchBusiness(linkId);
      setDetail(d);
      setTab((cur) => cur ?? TABS.find((t) => d.scopes[t.key])?.key ?? null);
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'Could not load this provider.',
        gone: err instanceof HomeownerApiError && err.code === 'forbidden',
      });
    }
  }, [linkId]);

  useEffect(() => {
    setDetail(null);
    setTab(null);
    void load();
  }, [load]);

  const origin = getPublicOrigin();

  if (error) {
    return (
      <div className="space-y-4">
        <Link to="/home" className="focus-ring inline-flex items-center gap-1 text-sm text-accent"><ArrowLeft size={16} aria-hidden /> Back</Link>
        <ErrorNote message={error.gone ? 'This provider isn’t shared with you (anymore).' : error.message} onRetry={error.gone ? undefined : () => void load()} />
      </div>
    );
  }
  if (!detail) return <Spinner />;

  const visibleTabs = TABS.filter((t) => detail.scopes[t.key]);

  return (
    <div className="space-y-4">
      <Link to="/home" className="focus-ring inline-flex items-center gap-1 text-sm text-accent"><ArrowLeft size={16} aria-hidden /> Home</Link>
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold text-text-primary">{detail.business_name}</h1>
        <div className="flex flex-wrap gap-2">
          <Link to={`/home/request?link=${detail.link_id}`} className="focus-ring inline-flex min-h-[44px] items-center rounded-xl bg-accent px-4 text-sm font-semibold text-white">
            Request service
          </Link>
          {detail.business_phone && (
            <a href={`tel:${detail.business_phone}`} className="focus-ring inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-border px-4 text-sm font-medium text-text-primary">
              <Phone size={16} aria-hidden /> Call
            </a>
          )}
          {detail.booking_slug && (
            <SecondaryButton onClick={() => openExternal(`${origin}/book/${detail.booking_slug}`)}>Book online</SecondaryButton>
          )}
        </div>
      </header>

      {visibleTabs.length === 0 ? (
        <Card>
          <p className="text-sm text-text-secondary">You’re connected but not sharing anything with this provider yet.</p>
          <Link to="/home/businesses" className="focus-ring mt-2 inline-block text-sm font-semibold text-accent">Choose what to share</Link>
        </Card>
      ) : (
        <>
          <div role="tablist" aria-label="Sections" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
            {visibleTabs.map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={tab === t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={cx(
                  'focus-ring min-h-[40px] shrink-0 rounded-full px-4 text-sm font-medium',
                  tab === t.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div role="tabpanel">
            {tab === 'jobs' && <JobsPanel jobs={detail.jobs ?? []} />}
            {tab === 'invoices' && <InvoicesPanel invoices={detail.invoices ?? []} />}
            {tab === 'equipment' && <EquipmentPanel equipment={detail.equipment ?? []} />}
            {tab === 'documents' && <DocumentsPanel linkId={detail.link_id} documents={detail.documents} />}
            {tab === 'health' &&
              (detail.health ? <HealthPanel health={detail.health} /> : <p className="text-sm text-text-secondary">No home health score has been calculated yet.</p>)}
          </div>
        </>
      )}
      <PrimaryButton className="hidden" aria-hidden tabIndex={-1} />
    </div>
  );
}
