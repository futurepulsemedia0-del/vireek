/**
 * Vireek Home Lifetime Graph — /dashboard/homes/:siteId
 *
 * The home is the permanent entity. Owners come and go; the home keeps its
 * Equipment, Repairs, Replacements, Permits, Contractors, Warranty, Costs,
 * Risks and Future interventions.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Home, Wrench, FileText, HardHat, ShieldCheck, DollarSign, AlertTriangle, CalendarClock, Users,
  History, Loader2, ArrowLeft, Plus, Trash2, Network, KeyRound, Sparkles,
} from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { HomeHealthScoreCard } from '@/components/HomeHealthScoreCard';
import { LifetimeServicePlanCard } from '@/components/LifetimeServicePlanCard';
import { formatCents } from '@/lib/agentGovernance';
import { formatSiteLocationLine, SITE_TYPE_LABELS } from '@/lib/siteHierarchy';
import {
  CONTRACTOR_ROLES, CONTRACTOR_ROLE_LABELS, INTERVENTION_TYPES, PERMIT_STATUSES, PERMIT_STATUS_LABELS,
  PERMIT_TYPES, PERMIT_TYPE_LABELS, TRANSFER_REASONS, TRANSFER_REASON_LABELS,
  deriveHomeView, formatHomeDate, humanize, openInterventions, suggestInterventions,
  type ContractorRole, type HomeLifetimeGraph, type HomeView, type InterventionType, type Level,
  type PermitStatus, type PermitType, type RiskSeverity, type TimelineKind, type TransferReason,
} from '@/lib/homeLifetimeGraph';
import {
  createContractor, createInterventions, createPermit, deleteContractor, deleteIntervention, deletePermit,
  errorMessage, fetchHomeLifetimeGraph, fetchTransferCandidates, setInterventionStatus, setPermitStatus,
  transferHomeOwnership,
} from '@/lib/homeLifetimeGraphApi';

// ------------------------------------------------------------------ styling

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';
const labelClass = 'mb-1.5 block text-xs font-medium text-text-secondary';
const primaryBtn =
  'focus-ring flex items-center gap-1.5 rounded-xl bg-cta px-3.5 py-2 text-xs font-semibold text-white disabled:opacity-50';
const smallBtn =
  'focus-ring flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:border-accent/50 hover:text-accent transition-colors';

const SEVERITY_STYLES: Record<RiskSeverity, string> = {
  critical: 'bg-danger-500/10 text-danger-500',
  high: 'bg-danger-500/10 text-danger-500',
  medium: 'bg-warning-500/10 text-warning-500',
  low: 'bg-bg-primary text-text-secondary',
};

const KIND_LABELS: Partial<Record<TimelineKind, string>> = {
  installation: 'Installation', replacement: 'Replacement', repair: 'Repair', maintenance: 'Maintenance',
  inspection: 'Inspection', service: 'Service', permit: 'Permit', warranty: 'Warranty',
  ownership: 'Ownership', intervention: 'Planned work',
};

type TabKey = 'overview' | 'equipment' | 'history' | 'permits' | 'contractors' | 'warranty' | 'costs' | 'risks' | 'future' | 'ownership';
type Act = (fn: () => Promise<unknown>, success: string) => Promise<void>;

// --------------------------------------------------------------- primitives

function Card({ title, children, action }: { title?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <p className="text-sm font-semibold text-text-primary">{title}</p>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="mb-2 flex items-center gap-2 text-text-secondary">{icon}<span className="text-xs font-medium">{label}</span></div>
      <p className="text-2xl font-semibold text-text-primary">{value}</p>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-text-secondary">{text}</p>;
}

function Chip({ children, tone = 'low' }: { children: React.ReactNode; tone?: RiskSeverity }) {
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${SEVERITY_STYLES[tone]}`}>{children}</span>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className={labelClass}>{label}</label>{children}</div>;
}

function Bar({ pct, tone }: { pct: number; tone: 'ok' | 'warn' | 'bad' }) {
  const color = tone === 'ok' ? 'bg-success-500' : tone === 'warn' ? 'bg-warning-500' : 'bg-danger-500';
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-primary">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

const dollarsToCents = (v: string): number | null => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};
const orNull = (v: string): string | null => (v.trim() ? v.trim() : null);

// ------------------------------------------------------------------- tabs

function OverviewTab({ g, v }: { g: HomeLifetimeGraph; v: HomeView }) {
  const i = v.intelligence;
  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Home Service Intelligence">
          <div className="mb-4 flex items-end gap-3">
            <p className="text-4xl font-semibold text-text-primary">{i.score}<span className="text-lg text-text-secondary">/100</span></p>
            <Chip tone={i.score >= 55 ? 'low' : 'medium'}>{i.tier}</Chip>
          </div>
          <p className="mb-4 text-xs text-text-secondary">
            This knowledge belongs to the home, not the owner
            {i.previousOwners > 0 ? ` — retained across ${i.previousOwners} previous owner${i.previousOwners > 1 ? 's' : ''}.` : '. It stays if the owner changes.'}
          </p>
          <div className="space-y-3">
            {i.factors.map((f) => (
              <div key={f.key} title={f.hint}>
                <div className="mb-1 flex justify-between text-xs text-text-secondary"><span>{f.label}</span><span>{f.earned}/{f.max}</span></div>
                <Bar pct={(f.earned / f.max) * 100} tone={f.earned / f.max >= 0.7 ? 'ok' : f.earned / f.max >= 0.35 ? 'warn' : 'bad'} />
              </div>
            ))}
          </div>
        </Card>
        <HomeHealthScoreCard twin={g.twin} />
      </div>
      <Card title="Lifetime timeline">
        <Timeline events={v.timeline.slice(0, 10)} />
      </Card>
    </div>
  );
}

function Timeline({ events }: { events: HomeView['timeline'] }) {
  if (events.length === 0) return <Empty text="No history recorded for this home yet." />;
  return (
    <ol className="space-y-3">
      {events.map((e) => (
        <li key={e.id} className="flex items-start gap-3 rounded-xl border border-border bg-bg-primary p-3">
          <div className="w-24 shrink-0 text-xs text-text-secondary">{formatHomeDate(e.date)}</div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-text-primary">{e.title}</p>
            {e.detail && <p className="truncate text-xs text-text-secondary">{e.detail}</p>}
          </div>
          <Chip>{KIND_LABELS[e.kind] ?? humanize(e.kind)}</Chip>
          {e.costCents ? <span className="text-xs font-medium text-text-primary">{formatCents(e.costCents)}</span> : null}
        </li>
      ))}
    </ol>
  );
}

function EquipmentTab({ v }: { v: HomeView }) {
  if (v.systems.length === 0) return <Empty text="No active equipment is assigned to a room in this home." />;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {v.systems.map((s) => (
        <Card key={s.equipment.id}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-text-primary">{s.label}</p>
            {s.overdue && <Chip tone="medium">Service overdue</Chip>}
            {s.nearingEol && <Chip tone="high">Near end of life</Chip>}
            {s.recurring && <Chip tone="high">Recurring failures</Chip>}
            {s.warranty === 'active' && <Chip>Under warranty</Chip>}
            {s.warranty === 'expiring' && <Chip tone="medium">Warranty ending</Chip>}
          </div>
          <div className="mb-1 flex justify-between text-xs text-text-secondary">
            <span>{s.ageYears !== null ? `${s.ageYears} yrs old` : 'Install date unknown'}</span>
            <span>{s.equipment.expected_lifespan_years} yr expected life</span>
          </div>
          {s.lifeUsedPct !== null && <Bar pct={s.lifeUsedPct} tone={s.lifeUsedPct >= 100 ? 'bad' : s.lifeUsedPct >= 80 ? 'warn' : 'ok'} />}
          <dl className="mt-4 grid grid-cols-3 gap-3 text-xs">
            <div><dt className="text-text-secondary">Visits</dt><dd className="font-medium text-text-primary">{s.completedVisits}</dd></div>
            <div><dt className="text-text-secondary">Repairs</dt><dd className="font-medium text-text-primary">{s.repairVisits}</dd></div>
            <div><dt className="text-text-secondary">Last service</dt><dd className="font-medium text-text-primary">{formatHomeDate(s.lastServiceDate)}</dd></div>
          </dl>
          {s.lineage.length > 0 && (
            <p className="mt-3 text-xs text-text-secondary">
              Replaced: {s.lineage.map((o) => `${[o.make, o.model].filter(Boolean).join(' ') || humanize(o.equipment_type)} (${o.install_date?.slice(0, 4) ?? '?'})`).join(' → ')}
            </p>
          )}
        </Card>
      ))}
    </div>
  );
}

const HISTORY_FILTERS: Array<{ key: string; label: string; kinds: TimelineKind[] | null }> = [
  { key: 'all', label: 'All', kinds: null },
  { key: 'repairs', label: 'Repairs', kinds: ['repair'] },
  { key: 'replacements', label: 'Replacements', kinds: ['replacement', 'installation'] },
  { key: 'maintenance', label: 'Maintenance', kinds: ['maintenance', 'inspection', 'service'] },
];

function HistoryTab({ v }: { v: HomeView }) {
  const [filter, setFilter] = useState('all');
  const kinds = HISTORY_FILTERS.find((f) => f.key === filter)?.kinds ?? null;
  const events = kinds ? v.timeline.filter((e) => kinds.includes(e.kind)) : v.timeline;
  return (
    <Card title="Repairs & replacements">
      <div className="mb-4 flex flex-wrap gap-2">
        {HISTORY_FILTERS.map((f) => (
          <button key={f.key} type="button" onClick={() => setFilter(f.key)}
            className={`${smallBtn} ${filter === f.key ? 'border-accent/60 text-accent' : ''}`}>{f.label}</button>
        ))}
      </div>
      <Timeline events={events} />
    </Card>
  );
}

function PermitsTab({ g, act }: { g: HomeLifetimeGraph; act: Act }) {
  const [f, setF] = useState({ type: 'building' as PermitType, number: '', jurisdiction: '', status: 'issued' as PermitStatus, issued: '', expires: '', cost: '', description: '' });
  const submit = () => act(async () => {
    await createPermit({
      site_id: g.siteId, job_id: null, contractor_id: null, permit_type: f.type, permit_number: orNull(f.number),
      jurisdiction: orNull(f.jurisdiction), description: orNull(f.description), status: f.status, applied_on: null,
      issued_on: orNull(f.issued), expires_on: orNull(f.expires), final_inspection_on: null,
      cost_cents: f.cost ? dollarsToCents(f.cost) : null, document_url: null, notes: null,
    });
    setF({ ...f, number: '', cost: '', description: '' });
  }, 'Permit recorded.');
  return (
    <div className="space-y-6">
      <Card title="Record a permit">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Type"><select className={inputClass} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as PermitType })}>
            {PERMIT_TYPES.map((t) => <option key={t} value={t}>{PERMIT_TYPE_LABELS[t]}</option>)}</select></Field>
          <Field label="Permit number"><input className={inputClass} value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} /></Field>
          <Field label="Jurisdiction"><input className={inputClass} value={f.jurisdiction} onChange={(e) => setF({ ...f, jurisdiction: e.target.value })} /></Field>
          <Field label="Status"><select className={inputClass} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as PermitStatus })}>
            {PERMIT_STATUSES.map((s) => <option key={s} value={s}>{PERMIT_STATUS_LABELS[s]}</option>)}</select></Field>
          <Field label="Issued on"><input type="date" className={inputClass} value={f.issued} onChange={(e) => setF({ ...f, issued: e.target.value })} /></Field>
          <Field label="Expires on"><input type="date" className={inputClass} value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} /></Field>
          <Field label="Fee ($)"><input type="number" min="0" step="0.01" className={inputClass} value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} /></Field>
          <Field label="Work covered"><input className={inputClass} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        </div>
        <button type="button" className={`${primaryBtn} mt-4`} onClick={submit}><Plus size={12} /> Add permit</button>
      </Card>
      <Card title="Permits on this home">
        {g.permits.length === 0 ? <Empty text="No permits recorded." /> : (
          <ul className="space-y-3">
            {g.permits.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-bg-primary p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary">{PERMIT_TYPE_LABELS[p.permit_type]}{p.permit_number ? ` #${p.permit_number}` : ''}</p>
                  <p className="truncate text-xs text-text-secondary">
                    {[p.jurisdiction, p.description, p.issued_on ? `issued ${formatHomeDate(p.issued_on)}` : null, p.cost_cents ? formatCents(p.cost_cents) : null].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <select className={`${inputClass} !w-44`} value={p.status}
                  onChange={(e) => void act(() => setPermitStatus(p.id, e.target.value as PermitStatus), 'Permit updated.')}>
                  {PERMIT_STATUSES.map((s) => <option key={s} value={s}>{PERMIT_STATUS_LABELS[s]}</option>)}
                </select>
                <button type="button" className={smallBtn} aria-label="Delete permit" onClick={() => void act(() => deletePermit(p.id), 'Permit removed.')}><Trash2 size={12} /></button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function ContractorsTab({ g, v, act }: { g: HomeLifetimeGraph; v: HomeView; act: Act }) {
  const [f, setF] = useState({ name: '', trade: '', role: 'primary' as ContractorRole, license: '', phone: '' });
  const submit = () => {
    if (!f.name.trim()) return Promise.resolve();
    return act(async () => {
      await createContractor({
        site_id: g.siteId, vendor_id: null, name: f.name.trim(), trade: orNull(f.trade), license_number: orNull(f.license),
        phone: orNull(f.phone), email: null, role: f.role, first_worked_on: null, last_worked_on: null, insured: false, notes: null,
      });
      setF({ ...f, name: '', trade: '', license: '', phone: '' });
    }, 'Contractor recorded.');
  };
  return (
    <div className="space-y-6">
      <Card title="Vireek technicians who serviced this home">
        {v.technicians.length === 0 ? <Empty text="No completed visits with an assigned technician yet." /> : (
          <ul className="space-y-2">
            {v.technicians.map((t) => (
              <li key={t.id} className="flex items-center justify-between rounded-xl border border-border bg-bg-primary p-3 text-sm">
                <span className="font-medium text-text-primary">{t.name}</span>
                <span className="text-xs text-text-secondary">{t.visits} visit{t.visits > 1 ? 's' : ''} · last {formatHomeDate(t.lastVisit)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Add an external contractor or previous provider">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Name"><input className={inputClass} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Trade"><input className={inputClass} value={f.trade} onChange={(e) => setF({ ...f, trade: e.target.value })} /></Field>
          <Field label="Role"><select className={inputClass} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as ContractorRole })}>
            {CONTRACTOR_ROLES.map((r) => <option key={r} value={r}>{CONTRACTOR_ROLE_LABELS[r]}</option>)}</select></Field>
          <Field label="License #"><input className={inputClass} value={f.license} onChange={(e) => setF({ ...f, license: e.target.value })} /></Field>
          <Field label="Phone"><input className={inputClass} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        </div>
        <button type="button" className={`${primaryBtn} mt-4`} onClick={() => void submit()}><Plus size={12} /> Add contractor</button>
      </Card>
      <Card title="External contractors">
        {g.contractors.length === 0 ? <Empty text="No external contractors recorded." /> : (
          <ul className="space-y-2">
            {g.contractors.map((c) => (
              <li key={c.id} className="flex items-center gap-3 rounded-xl border border-border bg-bg-primary p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary">{c.name}</p>
                  <p className="truncate text-xs text-text-secondary">{[c.trade, CONTRACTOR_ROLE_LABELS[c.role], c.license_number ? `Lic. ${c.license_number}` : null, c.phone].filter(Boolean).join(' · ')}</p>
                </div>
                <button type="button" className={smallBtn} aria-label="Delete contractor" onClick={() => void act(() => deleteContractor(c.id), 'Contractor removed.')}><Trash2 size={12} /></button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function WarrantyTab({ g, v }: { g: HomeLifetimeGraph; v: HomeView }) {
  const stateTone: Record<string, RiskSeverity> = { active: 'low', expiring: 'medium', expired: 'high', none: 'low' };
  const stateLabel: Record<string, string> = { active: 'Active', expiring: 'Ending soon', expired: 'Expired', none: 'No warranty on record' };
  return (
    <div className="space-y-6">
      <Card title="Coverage by system">
        {v.systems.length === 0 ? <Empty text="No active equipment." /> : (
          <ul className="space-y-2">
            {v.systems.map((s) => (
              <li key={s.equipment.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-bg-primary p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary">{s.label}</p>
                  <p className="text-xs text-text-secondary">
                    {s.equipment.warranty_expires_at ? `Expires ${formatHomeDate(s.equipment.warranty_expires_at)}` : 'Add a warranty date on the equipment record'}
                    {s.claimsCount ? ` · ${s.claimsCount} claim${s.claimsCount > 1 ? 's' : ''}` : ''}
                    {s.recoveredCents ? ` · ${formatCents(s.recoveredCents)} recovered` : ''}
                  </p>
                </div>
                <Chip tone={stateTone[s.warranty]}>{stateLabel[s.warranty]}</Chip>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Warranty claims">
        {g.warrantyClaims.length === 0 ? <Empty text="No warranty claims for this home." /> : (
          <ul className="space-y-2">
            {g.warrantyClaims.map((c) => (
              <li key={c.id} className="flex items-center justify-between rounded-xl border border-border bg-bg-primary p-3 text-sm">
                <span className="text-text-primary">{c.manufacturer ?? 'Manufacturer'} · {humanize(c.status)}</span>
                <span className="text-xs text-text-secondary">{formatHomeDate(c.failure_date ?? c.created_at)} · {formatCents(c.credit_received_cents ?? c.claimed_amount_cents)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function CostsTab({ v }: { v: HomeView }) {
  const c = v.costs;
  const maxYear = Math.max(1, ...c.byYear.map((y) => y.cents));
  const cats = (Object.entries(c.byCategory) as Array<[string, number]>).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={<DollarSign size={14} />} label="Net lifetime cost" value={formatCents(c.netCents)} />
        <Stat icon={<Wrench size={14} />} label="Service & repairs" value={formatCents(c.serviceCents)} />
        <Stat icon={<FileText size={14} />} label="Permit fees" value={formatCents(c.permitFeesCents)} />
        <Stat icon={<ShieldCheck size={14} />} label="Warranty recovered" value={formatCents(c.warrantyRecoveredCents)} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={`Cost per year (avg ${formatCents(c.avgPerYearCents)} over ${c.yearsTracked} yrs)`}>
          {c.byYear.length === 0 ? <Empty text="No costs recorded." /> : (
            <div className="space-y-3">
              {c.byYear.map((y) => (
                <div key={y.year}>
                  <div className="mb-1 flex justify-between text-xs text-text-secondary"><span>{y.year}</span><span>{formatCents(y.cents)}</span></div>
                  <Bar pct={(y.cents / maxYear) * 100} tone="ok" />
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title="By type of work">
          {cats.length === 0 ? <Empty text="No invoiced work yet." /> : (
            <div className="space-y-3">
              {cats.map(([k, n]) => (
                <div key={k}>
                  <div className="mb-1 flex justify-between text-xs text-text-secondary"><span>{humanize(k)}</span><span>{formatCents(n)}</span></div>
                  <Bar pct={(n / Math.max(1, c.serviceCents)) * 100} tone="warn" />
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function RisksTab({ v }: { v: HomeView }) {
  if (v.risks.length === 0) return <Empty text="No open risks detected for this home." />;
  return (
    <ul className="space-y-3">
      {v.risks.map((r) => (
        <li key={r.id} className="flex items-start gap-3 rounded-2xl border border-border bg-bg-secondary p-4">
          <AlertTriangle size={16} className={r.severity === 'low' ? 'text-text-secondary' : r.severity === 'medium' ? 'text-warning-500' : 'text-danger-500'} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-text-primary">{r.title}</p>
            <p className="text-xs text-text-secondary">{r.detail}</p>
          </div>
          <Chip tone={r.severity}>{humanize(r.severity)}</Chip>
        </li>
      ))}
    </ul>
  );
}

function FutureTab({ g, v, act }: { g: HomeLifetimeGraph; v: HomeView; act: Act }) {
  const [f, setF] = useState({ title: '', type: 'maintenance' as InterventionType, target: '', risk: 'medium' as Level, low: '', high: '' });
  const open = openInterventions(g.interventions);
  const suggestions = useMemo(() => suggestInterventions(v.systems, g.interventions, g.siteId), [v.systems, g.interventions, g.siteId]);
  const submit = () => {
    if (!f.title.trim()) return Promise.resolve();
    const low = f.low ? dollarsToCents(f.low) : null;
    const high = f.high ? dollarsToCents(f.high) : null;
    if (low !== null && high !== null && low > high) return act(async () => { throw new Error('Low estimate cannot exceed high estimate.'); }, '');
    return act(async () => {
      await createInterventions([{
        site_id: g.siteId, equipment_id: null, job_id: null, title: f.title.trim(), rationale: null, intervention_type: f.type,
        target_date: orNull(f.target), est_cost_low_cents: low, est_cost_high_cents: high, risk_level: f.risk,
        status: 'proposed', source: 'staff', completed_on: null,
      }]);
      setF({ ...f, title: '', low: '', high: '' });
    }, 'Intervention added.');
  };
  return (
    <div className="space-y-6">
      <Card title="Planned & predicted interventions"
        action={suggestions.length > 0 ? (
          <button type="button" className={smallBtn} onClick={() => void act(() => createInterventions(suggestions), `${suggestions.length} suggestion(s) added.`)}>
            <Sparkles size={12} /> Generate from home data ({suggestions.length})
          </button>
        ) : undefined}>
        {open.length === 0 ? <Empty text="No future interventions yet." /> : (
          <ul className="space-y-3">
            {open.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-bg-primary p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary">{i.title}</p>
                  <p className="truncate text-xs text-text-secondary">
                    {[humanize(i.intervention_type), i.target_date ? `target ${formatHomeDate(i.target_date)}` : null,
                      i.est_cost_low_cents != null || i.est_cost_high_cents != null ? `${formatCents(i.est_cost_low_cents)}–${formatCents(i.est_cost_high_cents)}` : null,
                      i.rationale].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <Chip tone={i.risk_level}>{humanize(i.risk_level)} risk</Chip>
                <Chip>{humanize(i.status)}</Chip>
                {i.status !== 'scheduled' && <button type="button" className={smallBtn} onClick={() => void act(() => setInterventionStatus(i.id, 'scheduled'), 'Marked scheduled.')}>Schedule</button>}
                <button type="button" className={smallBtn} onClick={() => void act(() => setInterventionStatus(i.id, 'completed'), 'Marked completed.')}>Done</button>
                <button type="button" className={smallBtn} onClick={() => void act(() => setInterventionStatus(i.id, 'dismissed'), 'Dismissed.')}>Dismiss</button>
                <button type="button" className={smallBtn} aria-label="Delete intervention" onClick={() => void act(() => deleteIntervention(i.id), 'Removed.')}><Trash2 size={12} /></button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Add an intervention">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div className="lg:col-span-2"><Field label="Title"><input className={inputClass} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field></div>
          <Field label="Type"><select className={inputClass} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as InterventionType })}>
            {INTERVENTION_TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</select></Field>
          <Field label="Target date"><input type="date" className={inputClass} value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} /></Field>
          <Field label="Risk"><select className={inputClass} value={f.risk} onChange={(e) => setF({ ...f, risk: e.target.value as Level })}>
            {(['low', 'medium', 'high'] as Level[]).map((r) => <option key={r} value={r}>{humanize(r)}</option>)}</select></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Low ($)"><input type="number" min="0" className={inputClass} value={f.low} onChange={(e) => setF({ ...f, low: e.target.value })} /></Field>
            <Field label="High ($)"><input type="number" min="0" className={inputClass} value={f.high} onChange={(e) => setF({ ...f, high: e.target.value })} /></Field>
          </div>
        </div>
        <button type="button" className={`${primaryBtn} mt-4`} onClick={() => void submit()}><Plus size={12} /> Add</button>
      </Card>
      <LifetimeServicePlanCard twin={g.twin} />
    </div>
  );
}

function OwnershipTab({ g, onTransfer }: { g: HomeLifetimeGraph; onTransfer: () => void }) {
  return (
    <div className="space-y-6">
      <Card title="Ownership history" action={<button type="button" className={smallBtn} onClick={onTransfer}><KeyRound size={12} /> Transfer ownership</button>}>
        <p className="mb-4 text-xs text-text-secondary">
          Owners are periods in the life of the home. When ownership changes, equipment moves to the new owner and the whole service record
          stays with the home. Previous owners’ invoices and personal details remain with their own customer record.
        </p>
        {g.ownership.length === 0 ? <Empty text="Ownership history is not available yet." /> : (
          <ol className="space-y-3">
            {g.ownership.map((p, idx) => (
              <li key={p.id} className="flex items-center gap-3 rounded-xl border border-border bg-bg-primary p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary">{p.ownerName ?? 'Former customer'}{idx === 0 ? ' (current)' : ''}</p>
                  <p className="text-xs text-text-secondary">
                    {formatHomeDate(p.started_at)} → {p.ended_at ? formatHomeDate(p.ended_at) : 'present'}
                    {p.transfer_reason ? ` · ${TRANSFER_REASON_LABELS[p.transfer_reason]}` : ''}
                  </p>
                </div>
                {idx === 0 && <Chip>Current owner</Chip>}
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------- transfer dialog

function TransferDialog({ g, onClose, act }: { g: HomeLifetimeGraph; onClose: () => void; act: Act }) {
  const { toast } = useToast();
  const [candidates, setCandidates] = useState<Array<{ id: string; name: string; phone: string | null }>>([]);
  const [loading, setLoading] = useState(true);
  const [customerId, setCustomerId] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState<TransferReason>('sale');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchTransferCandidates(g.currentCustomerId)
      .then((rows) => { if (!cancelled) setCandidates(rows); })
      .catch(() => toast('Could not load customers.', 'error'))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [g.currentCustomerId, toast]);

  const submit = async () => {
    if (!customerId) return;
    setBusy(true);
    await act(async () => {
      const r = await transferHomeOwnership({ siteId: g.siteId, newCustomerId: customerId, effectiveDate: date, reason, notes });
      onClose();
      return r;
    }, 'Ownership transferred. The home’s service intelligence was kept.');
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Transfer ownership">
      <div className="w-full max-w-lg rounded-2xl border border-border bg-bg-secondary p-6">
        <p className="mb-1 text-sm font-semibold text-text-primary">Transfer home ownership</p>
        <p className="mb-4 text-xs text-text-secondary">The home keeps its full history. Equipment moves to the new owner; past jobs and invoices stay with the previous owner’s record.</p>
        <div className="space-y-3">
          <Field label="New owner">
            {loading ? <Loader2 className="animate-spin" size={16} /> : (
              <select className={inputClass} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">Select a customer…</option>
                {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ''}</option>)}
              </select>
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Effective date"><input type="date" max={new Date().toISOString().slice(0, 10)} className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="Reason"><select className={inputClass} value={reason} onChange={(e) => setReason(e.target.value as TransferReason)}>
              {TRANSFER_REASONS.map((r) => <option key={r} value={r}>{TRANSFER_REASON_LABELS[r]}</option>)}</select></Field>
          </div>
          <Field label="Notes (optional)"><input className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={smallBtn} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={primaryBtn} onClick={() => void submit()} disabled={!customerId || busy}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />} Transfer
          </button>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- page

export function HomeLifetimeGraphPage() {
  const { siteId } = useParams<{ siteId: string }>();
  const { toast } = useToast();
  const [graph, setGraph] = useState<HomeLifetimeGraph | null | undefined>(undefined);
  const [tab, setTab] = useState<TabKey>('overview');
  const [transferOpen, setTransferOpen] = useState(false);

  const load = useCallback(async () => {
    if (!siteId) return;
    try {
      setGraph(await fetchHomeLifetimeGraph(siteId));
    } catch {
      toast('Could not load the Home Lifetime Graph.', 'error');
      setGraph((g) => g ?? null);
    }
  }, [siteId, toast]);

  useEffect(() => { void load(); }, [load]);

  const view = useMemo(() => (graph ? deriveHomeView(graph) : null), [graph]);

  const act: Act = useCallback(async (fn, success) => {
    try {
      await fn();
      if (success) toast(success, 'success');
      await load();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }, [load, toast]);

  if (graph === undefined) {
    return <DashboardLayout activeLabel="Sites"><div className="flex h-64 items-center justify-center"><Loader2 className="animate-spin" /></div></DashboardLayout>;
  }
  if (!graph || !view) {
    return <DashboardLayout activeLabel="Sites"><div className="p-6"><p className="text-sm text-text-secondary">This home could not be found.</p></div></DashboardLayout>;
  }

  const site = graph.twin.site;
  const current = graph.ownership[0];
  const tabs: Array<{ key: TabKey; label: string; icon: React.ReactNode; count?: number }> = [
    { key: 'overview', label: 'Overview', icon: <Home size={14} /> },
    { key: 'equipment', label: 'Equipment', icon: <Wrench size={14} />, count: view.systems.length },
    { key: 'history', label: 'Repairs & Replacements', icon: <History size={14} />, count: view.history.length },
    { key: 'permits', label: 'Permits', icon: <FileText size={14} />, count: graph.permits.length },
    { key: 'contractors', label: 'Contractors', icon: <HardHat size={14} />, count: graph.contractors.length + view.technicians.length },
    { key: 'warranty', label: 'Warranty', icon: <ShieldCheck size={14} />, count: graph.warrantyClaims.length },
    { key: 'costs', label: 'Costs', icon: <DollarSign size={14} /> },
    { key: 'risks', label: 'Risks', icon: <AlertTriangle size={14} />, count: view.risks.length },
    { key: 'future', label: 'Future', icon: <CalendarClock size={14} />, count: openInterventions(graph.interventions).length },
    { key: 'ownership', label: 'Ownership', icon: <Users size={14} />, count: graph.ownership.length },
  ];

  return (
    <DashboardLayout activeLabel="Sites">
      <div className="space-y-6 p-6">
        <Link to={`/dashboard/customers/${graph.currentCustomerId}/sites`} className="focus-ring flex w-fit items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text-primary">
          <ArrowLeft size={12} /> Back to sites
        </Link>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Network className="text-cta" size={20} />
            <div>
              <p className="text-sm font-semibold text-text-primary">{site?.name ?? 'Home'} — Home Lifetime Graph</p>
              <p className="text-xs text-text-secondary">
                {site ? SITE_TYPE_LABELS[site.site_type] : ''}
                {site && formatSiteLocationLine(site) ? ` · ${formatSiteLocationLine(site)}` : ''}
                {site?.address ? ` · ${site.address}` : ''}
                {graph.yearBuilt ? ` · built ${graph.yearBuilt}` : ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {current && <Chip>Owner: {current.ownerName ?? 'Customer'}</Chip>}
            {graph.schemaReady && <button type="button" className={smallBtn} onClick={() => setTransferOpen(true)}><KeyRound size={12} /> Transfer ownership</button>}
          </div>
        </div>

        {!graph.schemaReady && (
          <div className="rounded-xl border border-warning-500/40 bg-warning-500/10 p-4 text-sm text-warning-500">
            The Home Lifetime Graph migration has not been applied yet. Run the 20270210000000_home_lifetime_graph migration to enable permits, contractors, future interventions and ownership history.
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat icon={<Network size={14} />} label="Service intelligence" value={`${view.intelligence.score}/100`} />
          <Stat icon={<Wrench size={14} />} label="Systems tracked" value={String(view.systems.length)} />
          <Stat icon={<DollarSign size={14} />} label="Net lifetime cost" value={formatCents(view.costs.netCents)} />
          <Stat icon={<Users size={14} />} label="Owners on record" value={String(Math.max(1, graph.ownership.length))} />
        </div>

        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Home sections">
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
              className={`${smallBtn} ${tab === t.key ? 'border-accent/60 text-accent' : ''}`}>
              {t.icon}{t.label}{t.count ? <span className="opacity-70">({t.count})</span> : null}
            </button>
          ))}
        </div>

        {tab === 'overview' && <OverviewTab g={graph} v={view} />}
        {tab === 'equipment' && <EquipmentTab v={view} />}
        {tab === 'history' && <HistoryTab v={view} />}
        {tab === 'permits' && <PermitsTab g={graph} act={act} />}
        {tab === 'contractors' && <ContractorsTab g={graph} v={view} act={act} />}
        {tab === 'warranty' && <WarrantyTab g={graph} v={view} />}
        {tab === 'costs' && <CostsTab v={view} />}
        {tab === 'risks' && <RisksTab v={view} />}
        {tab === 'future' && <FutureTab g={graph} v={view} act={act} />}
        {tab === 'ownership' && <OwnershipTab g={graph} onTransfer={() => setTransferOpen(true)} />}

        {transferOpen && <TransferDialog g={graph} act={act} onClose={() => setTransferOpen(false)} />}
      </div>
    </DashboardLayout>
  );
}
