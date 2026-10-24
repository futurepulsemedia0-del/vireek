/**
 * /dashboard/sales — in-home sales for comfort advisors.
 * Appointments (incl. technician-generated leads) → start a presentation → performance.
 * The tablet presentation itself lives in SalesPresentationPage (full screen).
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarPlus, Handshake, Loader2, MapPin, Phone, Presentation, Wrench } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { AdvisorPerformance } from '@/components/sales/AdvisorPerformance';
import { AdvisorTeamPanel } from '@/components/sales/AdvisorTeamPanel';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import {
  APPOINTMENT_STATUS_LABEL,
  money,
  salesErrorMessage,
  type PresentableQuote,
  type PresentableTemplate,
  type SalesAccess,
  type SalesAppointment,
  type SalesTeamMember,
} from '@/lib/inHomeSales';
import {
  createSalesAppointment,
  getSalesAccess,
  listPresentableQuotes,
  listSalesAppointments,
  listSalesTeam,
  startSalesPresentation,
} from '@/lib/inHomeSalesApi';

const NAV = 'In-Home Sales';
type Tab = 'appointments' | 'performance' | 'advisors';

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not scheduled';
}

function StatusBadge({ row }: { row: SalesAppointment }) {
  const status = row.presentation_status ?? 'none';
  const tone =
    status === 'sold' ? 'bg-success-500/10 text-success-500'
    : status === 'lost' ? 'bg-danger/10 text-danger'
    : status === 'presented' ? 'bg-warning-500/10 text-warning-500'
    : status === 'draft' ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-secondary';
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone}`}>{APPOINTMENT_STATUS_LABEL[status]}</span>;
}

// ------------------------------------------------------------
// Modal shell (focus trap + Esc)
// ------------------------------------------------------------
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useFocusTrap(true);
  useEscapeToClose(true, onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div ref={ref} className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl border border-border bg-bg-primary p-6 sm:rounded-3xl">
        <h2 className="mb-4 text-lg font-bold text-text-primary">{title}</h2>
        {children}
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// New appointment
// ------------------------------------------------------------
function NewAppointmentDialog({ access, onClose, onCreated }: { access: SalesAccess; onClose: () => void; onCreated: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [at, setAt] = useState('');
  const [notes, setNotes] = useState('');
  const [advisor, setAdvisor] = useState('');
  const [team, setTeam] = useState<SalesTeamMember[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const manager = access.role === 'manager';

  useEffect(() => {
    if (!manager) return;
    void listSalesTeam().then((t) => setTeam(t.filter((m) => m.is_comfort_advisor))).catch(() => undefined);
  }, [manager]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await createSalesAppointment({
        customerName: name,
        phone,
        address,
        scheduledAt: at ? new Date(at).toISOString() : null,
        advisorMemberId: manager ? advisor || null : null,
        notes,
      });
      toast('Sales appointment created.', 'success');
      onCreated();
    } catch (e) {
      setError(salesErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New sales appointment" onClose={onClose}>
      <div className="space-y-3">
        <Input label="Customer name" required value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <Input label="Date & time" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </div>
        <Input label="Address" value={address} maxLength={300} onChange={(e) => setAddress(e.target.value)} />
        {manager && (
          <label className="block text-sm font-medium text-text-primary">
            Comfort advisor
            <select className="focus-ring mt-1.5 w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base" value={advisor} onChange={(e) => setAdvisor(e.target.value)}>
              <option value="">Unassigned</option>
              {team.map((m) => <option key={m.member_id} value={m.member_id}>{m.name}</option>)}
            </select>
          </label>
        )}
        <Textarea label="Notes" rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex gap-3 pt-1">
          <Button variant="secondary" className="flex-1" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button className="flex-1" disabled={busy || name.trim() === ''} onClick={() => void submit()}>
            {busy ? <Loader2 className="animate-spin" size={16} aria-hidden="true" /> : null} Create
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------
// Start a presentation: attach an estimate or clone a template
// ------------------------------------------------------------
function StartDialog({ row, onClose }: { row: SalesAppointment; onClose: () => void }) {
  const navigate = useNavigate();
  const [data, setData] = useState<{ quotes: PresentableQuote[]; templates: PresentableTemplate[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listPresentableQuotes(row.job_id)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(salesErrorMessage(e, 'Could not load estimates.')); });
    return () => { cancelled = true; };
  }, [row.job_id]);

  async function start(key: string, source: { quoteId?: string; templateId?: string }) {
    setBusyKey(key);
    setError(null);
    try {
      const id = await startSalesPresentation(row.job_id, source);
      navigate(`/dashboard/sales/present/${id}`);
    } catch (e) {
      setError(salesErrorMessage(e));
      setBusyKey(null);
    }
  }

  const empty = data && data.quotes.length === 0 && data.templates.length === 0;
  return (
    <Modal title={`Present to ${row.customer_name}`} onClose={onClose}>
      {!data && !error && <div className="h-28 animate-pulse rounded-2xl bg-bg-tertiary" aria-busy="true" aria-label="Loading estimates" />}
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      {empty && (
        <p className="text-sm text-text-secondary">
          No Good/Better/Best estimate found for this customer yet. Build one in Quotes (tiered estimate) or save an estimate template, then come back.
        </p>
      )}
      {data && data.quotes.length > 0 && (
        <section aria-label="Existing estimates" className="mb-5">
          <h3 className="mb-2 text-sm font-semibold text-text-primary">Use an existing estimate</h3>
          <ul className="space-y-2">
            {data.quotes.map((q) => (
              <li key={q.id}>
                <button type="button" disabled={busyKey !== null} onClick={() => void start(q.id, { quoteId: q.id })}
                  className="focus-ring flex min-h-[48px] w-full items-center justify-between rounded-xl border border-border px-4 py-2 text-left hover:border-accent/50 disabled:opacity-50">
                  <span className="text-sm text-text-primary">{q.customer_name} · {q.option_count} options<span className="text-text-secondary"> · {new Date(q.created_at).toLocaleDateString()}</span></span>
                  {busyKey === q.id && <Loader2 className="animate-spin" size={16} aria-hidden="true" />}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {data && data.templates.length > 0 && (
        <section aria-label="Templates">
          <h3 className="mb-2 text-sm font-semibold text-text-primary">Start from a template</h3>
          <ul className="space-y-2">
            {data.templates.map((t) => (
              <li key={t.id}>
                <button type="button" disabled={busyKey !== null} onClick={() => void start(t.id, { templateId: t.id })}
                  className="focus-ring flex min-h-[48px] w-full items-center justify-between rounded-xl border border-border px-4 py-2 text-left hover:border-accent/50 disabled:opacity-50">
                  <span className="text-sm text-text-primary">{t.name}{t.category ? <span className="text-text-secondary"> · {t.category}</span> : null}</span>
                  {busyKey === t.id && <Loader2 className="animate-spin" size={16} aria-hidden="true" />}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Button variant="ghost" className="mt-5 w-full" onClick={onClose}>Close</Button>
    </Modal>
  );
}

// ------------------------------------------------------------
// Appointments
// ------------------------------------------------------------
function Appointments({ access }: { access: SalesAccess }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<SalesAppointment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [starting, setStarting] = useState<SalesAppointment | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await listSalesAppointments());
    } catch (e) {
      setError(salesErrorMessage(e, 'Could not load appointments.'));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const { open, closed } = useMemo(() => {
    const all = rows ?? [];
    return {
      open: all.filter((r) => r.presentation_status !== 'sold' && r.presentation_status !== 'lost'),
      closed: all.filter((r) => r.presentation_status === 'sold' || r.presentation_status === 'lost'),
    };
  }, [rows]);

  const renderRow = (r: SalesAppointment) => (
    <li key={r.job_id} className="flex flex-col gap-3 rounded-2xl border border-border bg-bg-secondary p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-semibold text-text-primary">{r.customer_name}</p>
          <StatusBadge row={r} />
          {r.from_technician && (
            <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
              <Wrench size={12} aria-hidden="true" /> From {r.referred_by ?? 'technician'}
            </span>
          )}
        </div>
        <p className="text-sm text-text-secondary">{when(r.scheduled_datetime)}{r.advisor_name ? ` · ${r.advisor_name}` : ' · Unassigned'}</p>
        {r.address && <p className="flex items-center gap-1 text-sm text-text-secondary"><MapPin size={14} aria-hidden="true" /> {r.address}</p>}
        {r.customer_phone && <p className="flex items-center gap-1 text-sm text-text-secondary"><Phone size={14} aria-hidden="true" /> {r.customer_phone}</p>}
        {r.notes && <p className="line-clamp-2 text-xs italic text-text-secondary">{r.notes}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {r.presentation_status === 'sold' && r.sold_total_cents !== null && <span className="text-sm font-semibold text-success-500">{money(r.sold_total_cents)}</span>}
        <Button size="sm" variant={r.presentation_status === 'sold' || r.presentation_status === 'lost' ? 'secondary' : 'primary'}
          onClick={() => (r.presentation_id ? navigate(`/dashboard/sales/present/${r.presentation_id}`) : setStarting(r))}>
          <Presentation size={16} aria-hidden="true" />
          {r.presentation_id ? (r.presentation_status === 'sold' || r.presentation_status === 'lost' ? 'View' : 'Resume') : 'Present'}
        </Button>
      </div>
    </li>
  );

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button size="sm" onClick={() => setCreating(true)}><CalendarPlus size={16} aria-hidden="true" /> New appointment</Button>
      </div>
      {error && <EmptyStateError icon={Handshake} title="Appointments unavailable" description={error} onRetry={() => void load()} />}
      {!error && rows === null && (
        <div className="space-y-3" aria-busy="true" aria-label="Loading appointments">
          {[0, 1, 2].map((i) => <div key={i} className="h-24 animate-pulse rounded-2xl bg-bg-tertiary" />)}
        </div>
      )}
      {!error && rows?.length === 0 && (
        <EmptyState icon={Handshake} title="No sales appointments yet" description="Create one, or let technicians send leads from the field — they land here automatically." action={{ label: 'New appointment', onClick: () => setCreating(true) }} />
      )}
      {open.length > 0 && <ul className="space-y-3" aria-label="Open appointments">{open.map(renderRow)}</ul>}
      {closed.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-text-secondary">Closed</h2>
          <ul className="space-y-3" aria-label="Closed appointments">{closed.map(renderRow)}</ul>
        </>
      )}
      {creating && <NewAppointmentDialog access={access} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void load(); }} />}
      {starting && <StartDialog row={starting} onClose={() => setStarting(null)} />}
    </>
  );
}

// ------------------------------------------------------------
// Page
// ------------------------------------------------------------
export function InHomeSalesPage() {
  const [access, setAccess] = useState<SalesAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('appointments');

  const load = useCallback(async () => {
    setError(null);
    try {
      setAccess(await getSalesAccess());
    } catch (e) {
      setError(salesErrorMessage(e, 'Could not check your access.'));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'appointments', label: 'Appointments' },
    { id: 'performance', label: 'Performance' },
    ...(access?.role === 'manager' ? [{ id: 'advisors' as const, label: 'Advisors' }] : []),
  ];

  return (
    <DashboardLayout activeLabel={NAV}>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">In-Home Sales</h1>
        <p className="text-sm text-text-secondary">Present Good / Better / Best on a tablet, sign, take the deposit, and track every advisor.</p>
      </div>

      {error && <EmptyStateError icon={Handshake} title="Something went wrong" description={error} onRetry={() => void load()} />}
      {!error && access === null && <div className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" aria-busy="true" aria-label="Loading" />}
      {!error && access && access.role === null && (
        <EmptyState icon={Handshake} title="You're not set up as a comfort advisor" description="Ask the account owner to enable you under In-Home Sales → Advisors." />
      )}
      {!error && access && access.role !== null && (
        <>
          <div role="tablist" aria-label="In-home sales sections" className="mb-6 flex gap-1 overflow-x-auto border-b border-border">
            {tabs.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
                className={`focus-ring min-h-[44px] shrink-0 border-b-2 px-4 text-sm font-semibold ${tab === t.id ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
                {t.label}
              </button>
            ))}
          </div>
          {tab === 'appointments' && <Appointments access={access} />}
          {tab === 'performance' && <AdvisorPerformance />}
          {tab === 'advisors' && access.role === 'manager' && <AdvisorTeamPanel />}
        </>
      )}
    </DashboardLayout>
  );
}
