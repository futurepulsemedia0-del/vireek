/**
 * Vireek Home Passport Network — /dashboard/homes/:siteId/passport
 *
 * A permanent property identity that survives owner, tenant and contractor
 * changes. This page is a read model: it owns no data and composes the Home
 * Lifetime Graph, Property Intelligence, Digital Twin, Equipment Passport
 * ledgers, Evidence Chain, Warranty claims and AI predictions. Every record
 * shows its source, timestamp, confidence and verification status.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertTriangle, ArrowLeft, BadgeCheck, BrainCircuit, Check, Copy, Download, FileSearch, Fingerprint, History,
  Link2, QrCode, RefreshCw, ShieldCheck, Users, Wrench, Landmark, Radar, Building2, Sparkles, ListChecks,
} from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { EmptyState, EmptyStateInline } from '@/components/EmptyState';
import { sha256Hex } from '@/lib/jobEvidenceChain';
import { formatHomeDate, humanize } from '@/lib/homeLifetimeGraph';
import {
  DOMAIN_LABELS, SOURCE_LABELS, VERIFICATION_LABELS, buildHomePassport, confidenceLabel, filterRecords, toPassportExport,
  type HomePassport, type PassportDomain, type PassportGap, type PassportRecord, type Verification,
} from '@/lib/homePassport';
import { loadHomePassport, type LoadedPassport } from '@/lib/homePassportApi';

// ------------------------------------------------------------------ styling

const cardClass = 'rounded-2xl border border-border bg-bg-secondary p-5';
const chipBase = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium';
const linkBtn =
  'focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-accent/50 hover:text-accent';
const selectClass =
  'focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

const VERIFICATION_STYLE: Record<Verification, string> = {
  verified: 'bg-success-500/10 text-success-500',
  system: 'bg-accent/10 text-accent',
  human: 'bg-bg-primary text-text-secondary',
  inferred: 'bg-warning-500/10 text-warning-500',
  unverified: 'bg-danger-500/10 text-danger-500',
};

const SEVERITY_STYLE = {
  high: 'bg-danger-500/10 text-danger-500',
  medium: 'bg-warning-500/10 text-warning-500',
  low: 'bg-bg-primary text-text-secondary',
} as const;

type TabKey = 'overview' | 'ledger' | 'systems' | 'continuity' | 'risks' | 'gaps';

// --------------------------------------------------------------- primitives

function Panel({ title, action, children }: { title?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className={cardClass}>
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-sm font-semibold text-text-primary">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

function Stat({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <div className={cardClass}>
      <div className="mb-2 flex items-center gap-2 text-text-secondary">{icon}<span className="text-xs font-medium">{label}</span></div>
      <p className="text-2xl font-semibold text-text-primary">{value}</p>
      {hint && <p className="mt-1 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

function Bar({ pct, tone }: { pct: number; tone: 'ok' | 'warn' | 'bad' }) {
  const color = tone === 'ok' ? 'bg-success-500' : tone === 'warn' ? 'bg-warning-500' : 'bg-danger-500';
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-primary" role="presentation">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

function VerificationChip({ v }: { v: Verification }) {
  return <span className={`${chipBase} ${VERIFICATION_STYLE[v]}`}>{v === 'verified' && <BadgeCheck size={11} />}{VERIFICATION_LABELS[v]}</span>;
}

function fmtDateTime(value: string | null): string {
  return value ? formatHomeDate(value) : 'Date unknown';
}

// ------------------------------------------------------------------ record

function RecordRow({ r, equipmentName }: { r: PassportRecord; equipmentName?: string }) {
  return (
    <li className="rounded-xl border border-border bg-bg-primary p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary">{r.title}</p>
          {r.detail && <p className="mt-0.5 text-xs text-text-secondary">{r.detail}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`${chipBase} bg-bg-secondary text-text-secondary`}>{DOMAIN_LABELS[r.domain]}</span>
          <VerificationChip v={r.verification} />
          <span className={`${chipBase} bg-bg-secondary text-text-secondary`} title={`${Math.round(r.confidence * 100)}% confidence`}>
            {confidenceLabel(r.confidence)} · {Math.round(r.confidence * 100)}%
          </span>
        </div>
      </div>
      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-secondary">
        <div className="flex gap-1"><dt className="opacity-70">Source</dt><dd>{SOURCE_LABELS[r.source]}{r.sourceDetail ? ` · ${r.sourceDetail}` : ''}</dd></div>
        <div className="flex gap-1"><dt className="opacity-70">Occurred</dt><dd>{fmtDateTime(r.occurredAt)}</dd></div>
        {r.recordedAt && <div className="flex gap-1"><dt className="opacity-70">Recorded</dt><dd>{formatHomeDate(r.recordedAt)}</dd></div>}
        {equipmentName && <div className="flex gap-1"><dt className="opacity-70">Equipment</dt><dd>{equipmentName}</dd></div>}
        {r.proof && <div className="flex gap-1"><dt className="opacity-70">Seal</dt><dd className="font-mono">{r.proof}…</dd></div>}
      </dl>
    </li>
  );
}

// -------------------------------------------------------------------- tabs

function OverviewTab({ p, onDomain }: { p: HomePassport; onDomain: (d: PassportDomain) => void }) {
  const mix = (['verified', 'system', 'human', 'inferred', 'unverified'] as Verification[]);
  const total = Math.max(1, p.records.length);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Permanent identity">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <div><dt className="text-xs text-text-secondary">Home ID</dt><dd className="font-mono text-text-primary">{p.homeId}</dd></div>
          <div><dt className="text-xs text-text-secondary">Built</dt><dd className="text-text-primary">{p.yearBuilt ?? 'Unknown'}</dd></div>
          <div className="col-span-2"><dt className="text-xs text-text-secondary">Address</dt><dd className="text-text-primary">{p.address ?? 'Not verified'}</dd></div>
          <div><dt className="text-xs text-text-secondary">First record</dt><dd className="text-text-primary">{fmtDateTime(p.firstRecordAt)}</dd></div>
          <div><dt className="text-xs text-text-secondary">Years of history</dt><dd className="text-text-primary">{p.view.costs.yearsTracked}</dd></div>
          <div><dt className="text-xs text-text-secondary">Owners on record</dt><dd className="text-text-primary">{p.owners}</dd></div>
          <div><dt className="text-xs text-text-secondary">Contributors</dt><dd className="text-text-primary">{p.contributors.technicians} technicians · {p.contributors.contractors} contractors</dd></div>
        </dl>
        <p className="mt-4 text-xs text-text-secondary">
          This identity is anchored to the property itself. Owner, tenant and contractor changes never reset it.
        </p>
      </Panel>

      <Panel title="Trust breakdown">
        <ul className="space-y-3">
          {p.trust.factors.map((f) => (
            <li key={f.key}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="font-medium text-text-primary">{f.label}</span>
                <span className="text-text-secondary">{f.earned}/{f.max}</span>
              </div>
              <Bar pct={(f.earned / f.max) * 100} tone={f.earned / f.max >= 0.7 ? 'ok' : f.earned / f.max >= 0.35 ? 'warn' : 'bad'} />
              <p className="mt-1 text-[11px] text-text-secondary">{f.hint}</p>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Verification mix">
        {p.records.length === 0 ? <EmptyStateInline text="Records appear here as the home accumulates history." /> : (
          <ul className="space-y-2.5">
            {mix.map((v) => (
              <li key={v} className="flex items-center gap-3 text-xs">
                <span className="w-24 shrink-0"><VerificationChip v={v} /></span>
                <div className="flex-1"><Bar pct={(p.trust.byVerification[v] / total) * 100} tone={v === 'unverified' ? 'bad' : v === 'inferred' ? 'warn' : 'ok'} /></div>
                <span className="w-8 text-right text-text-secondary">{p.trust.byVerification[v]}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Coverage">
        <div className="flex flex-wrap gap-2">
          {(Object.keys(DOMAIN_LABELS) as PassportDomain[]).map((d) => (
            <button key={d} type="button" onClick={() => onDomain(d)} className={linkBtn} aria-label={`Show ${DOMAIN_LABELS[d]} records`}>
              {DOMAIN_LABELS[d]} <span className="opacity-70">({p.domainCounts[d]})</span>
            </button>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function LedgerTab({ p, domain, setDomain, eqName }: {
  p: HomePassport; domain: PassportDomain | 'all'; setDomain: (d: PassportDomain | 'all') => void; eqName: Map<string, string>;
}) {
  const [verification, setVerification] = useState<Verification | 'all'>('all');
  const [query, setQuery] = useState('');
  const rows = useMemo(() => filterRecords(p.records, { domain, verification, query }), [p.records, domain, verification, query]);
  const shown = rows.slice(0, 200);
  return (
    <Panel title={`Passport ledger (${rows.length})`}>
      <div className="mb-4 flex flex-wrap gap-2">
        <input
          type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search records…" aria-label="Search records"
          className="focus-ring min-w-[12rem] flex-1 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60"
        />
        <select className={selectClass} value={domain} onChange={(e) => setDomain(e.target.value as PassportDomain | 'all')} aria-label="Filter by type">
          <option value="all">All types</option>
          {(Object.keys(DOMAIN_LABELS) as PassportDomain[]).map((d) => <option key={d} value={d}>{DOMAIN_LABELS[d]}</option>)}
        </select>
        <select className={selectClass} value={verification} onChange={(e) => setVerification(e.target.value as Verification | 'all')} aria-label="Filter by verification">
          <option value="all">Any verification</option>
          {(Object.keys(VERIFICATION_LABELS) as Verification[]).map((v) => <option key={v} value={v}>{VERIFICATION_LABELS[v]}</option>)}
        </select>
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={FileSearch} title="No matching records" description="Adjust the filters, or add history to this home." />
      ) : (
        <>
          <ul className="space-y-2">{shown.map((r) => <RecordRow key={r.id} r={r} equipmentName={r.equipmentId ? eqName.get(r.equipmentId) : undefined} />)}</ul>
          {rows.length > shown.length && <p className="mt-3 text-center text-xs text-text-secondary">Showing the newest {shown.length} of {rows.length}. Narrow the filters to see more.</p>}
        </>
      )}
    </Panel>
  );
}

function SystemsTab({ p, codes }: { p: HomePassport; codes: Record<string, string> }) {
  if (p.view.systems.length === 0) {
    return <EmptyState icon={Wrench} title="No active equipment" description="Add equipment to the home's rooms to start its passport chain." />;
  }
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {p.view.systems.map((s) => {
        const code = codes[s.equipment.id];
        const tone = (s.lifeUsedPct ?? 0) >= 100 ? 'bad' : (s.lifeUsedPct ?? 0) >= 75 ? 'warn' : 'ok';
        return (
          <section key={s.equipment.id} className={cardClass}>
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold text-text-primary">{s.label}</p>
              {code
                ? <Link to={`/dashboard/equipment-passports/${code}`} className={linkBtn}><QrCode size={12} /> Passport</Link>
                : <span className={`${chipBase} bg-warning-500/10 text-warning-500`}>No passport</span>}
            </div>
            <p className="mt-1 text-xs text-text-secondary">
              {s.ageYears !== null ? `${s.ageYears} yrs old` : 'Age unknown'} · {s.completedVisits} visit{s.completedVisits === 1 ? '' : 's'} · {s.repairVisits} repair{s.repairVisits === 1 ? '' : 's'}
              {s.lineage.length ? ` · ${s.lineage.length} earlier unit${s.lineage.length === 1 ? '' : 's'} here` : ''}
            </p>
            {s.lifeUsedPct !== null && (
              <div className="mt-3">
                <div className="mb-1 flex justify-between text-[11px] text-text-secondary"><span>Life used</span><span>{s.lifeUsedPct}%</span></div>
                <Bar pct={s.lifeUsedPct} tone={tone} />
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {s.recurring && <span className={`${chipBase} ${SEVERITY_STYLE.high}`}>Recurring failures</span>}
              {s.overdue && <span className={`${chipBase} ${SEVERITY_STYLE.medium}`}>Service overdue</span>}
              {s.nearingEol && <span className={`${chipBase} ${SEVERITY_STYLE.medium}`}>Near end of life</span>}
              {s.warranty !== 'none' && <span className={`${chipBase} ${SEVERITY_STYLE.low}`}>Warranty {s.warranty}</span>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ContinuityTab({ p }: { p: HomePassport }) {
  if (p.continuity.length === 0) return <EmptyState icon={Users} title="No ownership history yet" description="Ownership periods are recorded automatically when a home is created or transferred." />;
  const max = Math.max(1, ...p.continuity.map((c) => c.records));
  return (
    <Panel title="History that outlived each owner">
      <ol className="space-y-3">
        {p.continuity.map((c) => (
          <li key={c.id} className="rounded-xl border border-border bg-bg-primary p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-text-primary">{c.label}{c.isCurrent ? ' · current' : ''}</p>
              <p className="text-xs text-text-secondary">{formatHomeDate(c.startedAt)} → {c.endedAt ? formatHomeDate(c.endedAt) : 'present'}{c.reason ? ` · ${c.reason}` : ''}</p>
            </div>
            <div className="mt-2"><Bar pct={(c.records / max) * 100} tone="ok" /></div>
            <p className="mt-1 text-[11px] text-text-secondary">{c.records} record{c.records === 1 ? '' : 's'} · {c.repairs} service/repair</p>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-xs text-text-secondary">Owner names are not shown here and are never included in the shareable export.</p>
    </Panel>
  );
}

function RisksTab({ p, eqName }: { p: HomePassport; eqName: Map<string, string> }) {
  const groups: Array<{ title: string; icon: React.ReactNode; domains: PassportDomain[] }> = [
    { title: 'Risks & predictions', icon: <BrainCircuit size={14} />, domains: ['risk'] },
    { title: 'Failures', icon: <AlertTriangle size={14} />, domains: ['failure'] },
    { title: 'Outcomes', icon: <ShieldCheck size={14} />, domains: ['outcome'] },
  ];
  return (
    <div className="space-y-4">
      {groups.map((g) => {
        const rows = p.records.filter((r) => g.domains.includes(r.domain)).slice(0, 50);
        return (
          <Panel key={g.title} title={`${g.title} (${rows.length})`}>
            {rows.length === 0
              ? <EmptyStateInline text={`No ${g.title.toLowerCase()} on record.`} />
              : <ul className="space-y-2">{rows.map((r) => <RecordRow key={r.id} r={r} equipmentName={r.equipmentId ? eqName.get(r.equipmentId) : undefined} />)}</ul>}
          </Panel>
        );
      })}
      <p className="text-xs text-text-secondary">AI-inferred items are predictions, not facts. They are capped at 85% confidence and never counted toward the verified share.</p>
    </div>
  );
}

function GapAction({ gap, customerId, siteId }: { gap: PassportGap; customerId: string; siteId: string }) {
  const to =
    gap.action === 'passport' ? '/dashboard/equipment-passports'
      : gap.action === 'evidence' || gap.action === 'integrity' ? '/dashboard/evidence-chain'
        : gap.action === 'permit' ? `/dashboard/homes/${siteId}`
          : gap.action === 'equipment' ? `/dashboard/customers/${customerId}/sites/${siteId}/twin`
            : `/dashboard/customers/${customerId}/sites/${siteId}/intelligence`;
  const label =
    gap.action === 'passport' ? 'Open passports' : gap.action === 'evidence' ? 'Add evidence' : gap.action === 'integrity' ? 'Review chain'
      : gap.action === 'permit' ? 'Open permits' : gap.action === 'equipment' ? 'Edit equipment' : 'Verify address';
  return <Link to={to} className={linkBtn}>{label}</Link>;
}

function GapsTab({ p, customerId }: { p: HomePassport; customerId: string }) {
  if (p.gaps.length === 0) return <EmptyState icon={BadgeCheck} title="No gaps found" description="Every system, job and permit on this home is documented and verifiable." />;
  return (
    <Panel title={`Ways to strengthen this passport (${p.gaps.length})`}>
      <ul className="space-y-2">
        {p.gaps.slice(0, 100).map((g) => (
          <li key={g.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary p-3.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-primary"><span className={`${chipBase} mr-2 ${SEVERITY_STYLE[g.severity]}`}>{humanize(g.severity)}</span>{g.title}</p>
              <p className="mt-0.5 text-xs text-text-secondary">{g.detail}</p>
            </div>
            <GapAction gap={g} customerId={customerId} siteId={p.siteId} />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// -------------------------------------------------------------------- page

export function HomePassportNetworkPage() {
  const { siteId } = useParams<{ siteId: string }>();
  const { toast } = useToast();
  const [loaded, setLoaded] = useState<LoadedPassport | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<TabKey>('overview');
  const [domain, setDomain] = useState<PassportDomain | 'all'>('all');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!siteId) return;
    setRefreshing(true);
    try {
      setLoaded(await loadHomePassport(siteId));
      setFailed(false);
    } catch {
      setFailed(true);
      setLoaded((cur) => cur ?? null);
      toast('Could not load the Home Passport.', 'error');
    } finally {
      setRefreshing(false);
    }
  }, [siteId, toast]);

  useEffect(() => { void load(); }, [load]);

  const passport = useMemo(() => (loaded ? buildHomePassport(loaded.inputs) : null), [loaded]);
  const eqName = useMemo(() => new Map((passport?.view.systems ?? []).map((s) => [s.equipment.id, s.label])), [passport]);
  const codes = useMemo(() => {
    const out: Record<string, string> = {};
    Object.entries(loaded?.inputs.passports ?? {}).forEach(([id, l]) => { out[id] = l.code; });
    return out;
  }, [loaded]);

  const copyId = async () => {
    if (!passport) return;
    try {
      await navigator.clipboard.writeText(passport.homeId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast('Could not copy to the clipboard.', 'error');
    }
  };

  const exportPassport = async () => {
    if (!passport) return;
    try {
      const body = toPassportExport(passport);
      const bodyJson = JSON.stringify(body, null, 2);
      const digest = await sha256Hex(new Blob([bodyJson], { type: 'application/json' }));
      const file = JSON.stringify({ digest: { algorithm: 'sha256', value: digest, covers: 'passport' }, passport: body }, null, 2);
      const url = URL.createObjectURL(new Blob([file], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${passport.homeId}.home-passport.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('Redacted passport exported with a SHA-256 seal.', 'success');
    } catch {
      toast('Export failed.', 'error');
    }
  };

  const openDomain = (d: PassportDomain) => { setDomain(d); setTab('ledger'); };

  if (loaded === undefined) {
    return (
      <DashboardLayout activeLabel="Sites">
        <div className="space-y-6 p-6" aria-busy="true"><SkeletonStatGrid count={4} /><SkeletonCardList count={3} rows={3} /></div>
      </DashboardLayout>
    );
  }
  if (!loaded || !passport || !siteId) {
    return (
      <DashboardLayout activeLabel="Sites">
        <div className="p-6">
          <EmptyState
            icon={Building2}
            title={failed ? 'Could not load this passport' : 'Home not found'}
            description={failed ? 'Check your connection and try again.' : 'This home does not exist or you do not have access to it.'}
            action={failed ? { label: 'Try again', onClick: () => void load() } : undefined}
          />
        </div>
      </DashboardLayout>
    );
  }

  const customerId = loaded.inputs.graph.currentCustomerId;
  const t = passport.trust;
  const tabs: Array<{ key: TabKey; label: string; icon: React.ReactNode; count?: number }> = [
    { key: 'overview', label: 'Overview', icon: <Fingerprint size={14} /> },
    { key: 'ledger', label: 'Ledger', icon: <History size={14} />, count: passport.records.length },
    { key: 'systems', label: 'Systems', icon: <Wrench size={14} />, count: passport.view.systems.length },
    { key: 'continuity', label: 'Continuity', icon: <Users size={14} />, count: passport.continuity.length },
    { key: 'risks', label: 'Risks & failures', icon: <AlertTriangle size={14} />, count: passport.domainCounts.risk + passport.domainCounts.failure },
    { key: 'gaps', label: 'Gaps', icon: <ListChecks size={14} />, count: passport.gaps.length },
  ];
  const connected: Array<{ to: string; label: string; icon: React.ReactNode }> = [
    { to: `/dashboard/homes/${siteId}`, label: 'Home Lifetime Graph', icon: <Landmark size={12} /> },
    { to: `/dashboard/customers/${customerId}/sites/${siteId}/twin`, label: 'Digital Twin', icon: <Building2 size={12} /> },
    { to: `/dashboard/customers/${customerId}/sites/${siteId}/intelligence`, label: 'Property Intelligence', icon: <Radar size={12} /> },
    { to: '/dashboard/equipment-passports', label: 'Equipment Passports', icon: <QrCode size={12} /> },
    { to: '/dashboard/evidence-chain', label: 'Evidence Chain', icon: <Link2 size={12} /> },
    { to: '/dashboard/warranty-claims', label: 'Warranty', icon: <ShieldCheck size={12} /> },
    { to: '/dashboard/event-bus', label: 'Events', icon: <Sparkles size={12} /> },
    { to: '/dashboard/ask-vireek', label: 'Ask Vireek', icon: <BrainCircuit size={12} /> },
  ];

  return (
    <DashboardLayout activeLabel="Sites">
      <div className="space-y-6 p-6">
        <Link to={`/dashboard/customers/${customerId}/sites`} className="focus-ring flex w-fit items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text-primary">
          <ArrowLeft size={12} /> Back to sites
        </Link>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Fingerprint className="text-cta" size={22} />
            <div>
              <h1 className="text-base font-semibold text-text-primary">{passport.name} — Home Passport</h1>
              <p className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                <span className="font-mono">{passport.homeId}</span>
                <button type="button" onClick={() => void copyId()} className="focus-ring inline-flex items-center gap-1 rounded text-text-secondary hover:text-text-primary" aria-label="Copy Home ID">
                  {copied ? <Check size={12} /> : <Copy size={12} />}{copied ? 'Copied' : 'Copy'}
                </button>
                {passport.address && <span>· {passport.address}</span>}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void load()} disabled={refreshing} aria-label="Refresh passport">
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
            </Button>
            <Button variant="primary" size="sm" onClick={() => void exportPassport()}>
              <Download size={14} /> Export sealed copy
            </Button>
          </div>
        </div>

        {loaded.warnings.sources.length > 0 && (
          <div role="status" className="rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-xs text-warning-500">
            Some sources could not be read ({loaded.warnings.sources.join(', ')}). The passport is shown without them, so its trust score may be understated.
          </div>
        )}
        {!loaded.inputs.graph.schemaReady && (
          <div role="status" className="rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-xs text-warning-500">
            The Home Lifetime Graph migration has not been applied, so permits, contractors and ownership history are unavailable.
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat icon={<ShieldCheck size={14} />} label="Passport trust" value={`${t.score}/100`} hint={t.level} />
          <Stat icon={<BadgeCheck size={14} />} label="Verified share" value={`${Math.round(t.verifiedShare * 100)}%`} hint={`Avg. confidence ${Math.round(t.avgConfidence * 100)}%`} />
          <Stat icon={<History size={14} />} label="Records" value={String(passport.records.length)} hint={`${passport.view.costs.yearsTracked} yrs of history`} />
          <Stat icon={<Users size={14} />} label="Owners survived" value={String(Math.max(0, passport.owners - 1))} hint="History kept across transfers" />
        </div>

        <nav aria-label="Connected systems" className="flex flex-wrap gap-2">
          {connected.map((c) => <Link key={c.label} to={c.to} className={linkBtn}>{c.icon}{c.label}</Link>)}
        </nav>

        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Passport sections">
          {tabs.map((x) => (
            <button
              key={x.key} type="button" role="tab" aria-selected={tab === x.key} onClick={() => setTab(x.key)}
              className={`${linkBtn} ${tab === x.key ? 'border-accent/60 text-accent' : ''}`}
            >
              {x.icon}{x.label}{x.count ? <span className="opacity-70">({x.count})</span> : null}
            </button>
          ))}
        </div>

        {tab === 'overview' && <OverviewTab p={passport} onDomain={openDomain} />}
        {tab === 'ledger' && <LedgerTab p={passport} domain={domain} setDomain={setDomain} eqName={eqName} />}
        {tab === 'systems' && <SystemsTab p={passport} codes={codes} />}
        {tab === 'continuity' && <ContinuityTab p={passport} />}
        {tab === 'risks' && <RisksTab p={passport} eqName={eqName} />}
        {tab === 'gaps' && <GapsTab p={passport} customerId={customerId} />}
      </div>
    </DashboardLayout>
  );
}
