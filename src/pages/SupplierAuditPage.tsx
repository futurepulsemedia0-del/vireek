import { useCallback, useEffect, useMemo, useState } from 'react';
import { BadgeDollarSign, RefreshCw, SearchCheck, ShieldAlert } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { supabase } from '@/lib/supabase';
import { browserTimeZone, loadAuditData, runAuditNow, type AuditData, type FindingRecord } from '@/lib/supplierAudit/api';
import { canManageSupplierAudit } from '@/lib/supplierAudit/access';
import { summarize } from '@/lib/supplierAudit/engine';
import { formatMoney } from '@/lib/supplierAudit/money';
import { FindingDrawer } from '@/components/supplierAudit/FindingDrawer';
import { StatementsPanel } from '@/components/supplierAudit/StatementsPanel';
import { MemosPanel } from '@/components/supplierAudit/MemosPanel';
import { ProgramsPanel } from '@/components/supplierAudit/ProgramsPanel';
import { TierTracker } from '@/components/supplierAudit/TierTracker';
import { BandPill, Card, DISCLAIMER, ErrorBox, RiskPill, STATUS_LABELS, Skeleton, TYPE_LABELS, btnGhost, btnPrimary, inputClass, Pill } from '@/components/supplierAudit/shared';

type Tab = 'overview' | 'statements' | 'memos' | 'tiers' | 'programs' | 'activity';
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Findings' }, { key: 'statements', label: 'Statements & review' }, { key: 'memos', label: 'Credit memos' },
  { key: 'tiers', label: 'Tier tracker' }, { key: 'programs', label: 'Programs & rules' }, { key: 'activity', label: 'Activity log' },
];
const OPEN: FindingRecord['status'][] = ['open', 'packet_ready', 'claimed', 'partially_recovered'];

export function SupplierAuditPage() {
  const { isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const allowed = canManageSupplierAudit(isOwner, permissions);
  const timeZone = useMemo(browserTimeZone, []);
  const [data, setData] = useState<AuditData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  const [businessName, setBusinessName] = useState('Our company');
  const [selected, setSelected] = useState<string | null>(null);
  const [fVendor, setFVendor] = useState(''); const [fType, setFType] = useState(''); const [fRisk, setFRisk] = useState(''); const [fStatus, setFStatus] = useState('active');

  const load = useCallback(async () => {
    try { setError(null); const d = await loadAuditData(); setData(d); const p = await supabase.from('profiles').select('company_name').eq('id', d.ownerId).maybeSingle(); if (p.data?.company_name) setBusinessName(p.data.company_name as string); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load supplier audit data.'); } finally { setLoading(false); }
  }, []);
  useEffect(() => { if (allowed) void load(); else setLoading(false); }, [allowed, load]);

  const runAudit = async () => {
    if (!data) return;
    setRunning(true);
    try {
      const r = await runAuditNow(data);
      toast(`Audit complete: ${r.inserted} new, ${r.updated} updated, ${r.superseded} no longer apply${r.warrantyRecovered ? `, ${r.warrantyRecovered} warranty credit(s) confirmed` : ''}.`, 'success');
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : 'The audit failed', 'error'); } finally { setRunning(false); }
  };

  const summary = useMemo(() => (data ? summarize(data.findings.map((f) => ({ status: f.status, is_opportunity: f.is_opportunity, low_cents: f.low_cents, likely_cents: f.likely_cents, high_cents: f.high_cents, recovered_cents: f.recovered_cents, currency: f.currency }))) : null), [data]);
  const atRisk = useMemo(() => (data ? data.findings.filter((f) => OPEN.includes(f.status) && !f.is_opportunity && ['critical', 'soon'].includes(f.deadline_risk)).length : 0), [data]);
  const vendorName = (id: string) => data?.vendors.find((v) => v.id === id)?.name ?? 'Supplier';
  const filtered = useMemo(() => (data?.findings ?? []).filter((f) => (fStatus === 'active' ? OPEN.includes(f.status) : fStatus === 'all' ? true : f.status === fStatus)
    && (!fVendor || f.vendor_id === fVendor) && (!fType || f.finding_type === fType) && (!fRisk || f.deadline_risk === fRisk))
    .sort((a, b) => (a.is_opportunity === b.is_opportunity ? b.likely_cents - a.likely_cents : a.is_opportunity ? 1 : -1)), [data, fVendor, fType, fRisk, fStatus]);
  const selectedFinding = data?.findings.find((f) => f.id === selected) ?? null;
  const pendingReview = data?.lineRows.filter((l) => l.review_status === 'needs_review').length ?? 0;
  const mixedCurrency = summary?.byCurrency;
  const cur = data?.findings[0]?.currency ?? 'USD';

  const header = (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"><SearchCheck size={20} /></span>
        <div><h1 className="text-2xl font-bold text-text-primary">Supplier Entitlement Audit</h1>
          <p className="mt-1 text-sm text-text-secondary">Find money your distributors and manufacturers may owe you — every number is a conservative, traceable estimate until a receipt confirms it.</p></div>
      </div>
      {allowed && <button type="button" className={btnPrimary} onClick={runAudit} disabled={running || loading || !data}><RefreshCw size={16} className={running ? 'animate-spin' : ''} />{running ? 'Auditing…' : 'Run audit'}</button>}
    </div>
  );

  if (!allowed) return (
    <DashboardLayout activeLabel="Supplier Audit"><div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">{header}
      <EmptyState icon={ShieldAlert} title="Owner and office access only" description="Supplier audit shows vendor pricing and money owed, so it is limited to the account owner and staff with billing access." /></div></DashboardLayout>);

  return (
    <DashboardLayout activeLabel="Supplier Audit">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {header}
        {error && <div className="mb-4"><ErrorBox message={error} onRetry={() => { setLoading(true); void load(); }} /></div>}
        {loading ? <Skeleton rows={4} /> : data && summary && (
          <>
            <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <div className="rounded-2xl border border-border bg-bg-secondary p-4"><p className="text-xs font-medium text-text-secondary">Estimated owed <Pill cls="bg-warning-500/10 text-warning-500">estimate</Pill></p>
                <p className="mt-1 text-2xl font-bold text-text-primary">{formatMoney(summary.estimatedLikelyCents, cur)}</p><p className="text-xs text-text-secondary">range {formatMoney(summary.estimatedLowCents, cur)} – {formatMoney(summary.estimatedHighCents, cur)} · {summary.openCount} open</p></div>
              <div className="rounded-2xl border border-success-500/30 bg-success-500/5 p-4"><p className="text-xs font-medium text-text-secondary">Confirmed recovered <Pill cls="bg-success-500/10 text-success-500">measured</Pill></p>
                <p className="mt-1 text-2xl font-bold text-success-500">{formatMoney(summary.recoveredCents, cur)}</p><p className="text-xs text-text-secondary">only counts confirmed receipts</p></div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4"><p className="text-xs font-medium text-text-secondary">Opportunities <span className="font-normal">(not money owed)</span></p>
                <p className="mt-1 text-2xl font-bold text-text-primary">{formatMoney(summary.opportunityCents, cur)}</p><p className="text-xs text-text-secondary">accruing rebates &amp; tier upgrades</p></div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4"><p className="text-xs font-medium text-text-secondary">Deadlines within 30 days</p>
                <p className={`mt-1 text-2xl font-bold ${atRisk ? 'text-danger' : 'text-text-primary'}`}>{atRisk}</p><p className="text-xs text-text-secondary">{pendingReview} statement line(s) awaiting review</p></div>
            </div>
            {mixedCurrency && <p className="mb-4 text-xs text-warning-500">Findings exist in more than one currency; totals above mix them — filter by vendor for exact figures.</p>}

            <nav className="mb-5 flex gap-1 overflow-x-auto border-b border-border" aria-label="Supplier audit sections">
              {TABS.map((t) => <button key={t.key} type="button" onClick={() => setTab(t.key)} aria-current={tab === t.key ? 'page' : undefined} className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${tab === t.key ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>{t.label}{t.key === 'statements' && pendingReview ? ` (${pendingReview})` : ''}</button>)}
            </nav>

            {tab === 'overview' && (
              <div className="space-y-4">
                <div className="grid gap-2 sm:grid-cols-4">
                  <select className={inputClass} value={fVendor} onChange={(e) => setFVendor(e.target.value)} aria-label="Vendor"><option value="">All vendors</option>{data.vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
                  <select className={inputClass} value={fType} onChange={(e) => setFType(e.target.value)} aria-label="Type"><option value="">All types</option>{Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                  <select className={inputClass} value={fRisk} onChange={(e) => setFRisk(e.target.value)} aria-label="Deadline risk"><option value="">Any deadline</option><option value="critical">Due within 7 days</option><option value="soon">Due within 30 days</option><option value="ok">On track</option><option value="expired">Passed</option><option value="none">No deadline</option></select>
                  <select className={inputClass} value={fStatus} onChange={(e) => setFStatus(e.target.value)} aria-label="Status"><option value="active">Active</option><option value="all">All</option>{Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                </div>
                {data.findings.length === 0 ? (
                  <EmptyState icon={BadgeDollarSign} title="No findings yet" description={data.statements.length === 0 && data.programRows.length === 0 ? 'Upload a supplier statement and add your rebate or pricing programs, then run the audit.' : 'Run the audit to check your statements, credit memos, programs and warranty claims.'}
                    action={{ label: data.statements.length === 0 ? 'Upload a statement' : 'Run audit', onClick: () => (data.statements.length === 0 ? setTab('statements') : void runAudit()) }} />
                ) : filtered.length === 0 ? <p className="rounded-2xl border border-border bg-bg-secondary p-6 text-center text-sm text-text-secondary">No findings match these filters.</p> : (
                  <ul className="space-y-2">{filtered.map((f) => (
                    <li key={f.id}><button type="button" onClick={() => setSelected(f.id)} className="focus-ring grid w-full gap-2 rounded-2xl border border-border bg-bg-secondary p-4 text-left transition-colors hover:bg-bg-tertiary sm:grid-cols-[1fr_auto] sm:items-center">
                      <span className="min-w-0"><span className="mb-1 flex flex-wrap items-center gap-2"><Pill cls="bg-accent/10 text-accent">{TYPE_LABELS[f.finding_type]}</Pill><Pill cls="bg-bg-tertiary text-text-secondary">{STATUS_LABELS[f.status]}</Pill>{f.is_opportunity && <Pill cls="bg-bg-tertiary text-text-secondary">opportunity</Pill>}</span>
                        <span className="block truncate text-sm font-semibold text-text-primary">{f.title}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-2"><span className="text-xs text-text-secondary">{vendorName(f.vendor_id)}</span><BandPill band={f.confidence_band} value={f.confidence} /><RiskPill risk={f.deadline_risk} /></span></span>
                      <span className="text-left sm:text-right"><span className="block text-lg font-bold text-text-primary">{formatMoney(f.likely_cents, f.currency)}</span><span className="block text-xs text-text-secondary">{formatMoney(f.low_cents, f.currency)} – {formatMoney(f.high_cents, f.currency)} · estimate</span>{f.recovered_cents > 0 && <span className="block text-xs font-medium text-success-500">{formatMoney(f.recovered_cents, f.currency)} confirmed</span>}</span>
                    </button></li>))}</ul>)}
                <p className="text-xs text-text-secondary">{DISCLAIMER}</p>
              </div>)}
            {tab === 'statements' && <StatementsPanel data={data} reload={load} />}
            {tab === 'memos' && <MemosPanel data={data} reload={load} />}
            {tab === 'tiers' && <TierTracker data={data} timeZone={timeZone} />}
            {tab === 'programs' && <ProgramsPanel data={data} reload={load} timeZone={timeZone} />}
            {tab === 'activity' && (
              <Card title="Audit log (append-only)">
                {data.log.length === 0 ? <p className="text-sm text-text-secondary">No activity yet.</p> : (
                  <ul className="divide-y divide-border text-sm">{data.log.map((l) => <li key={l.id} className="flex flex-wrap justify-between gap-2 py-2"><span className="text-text-primary">{l.action.replace(/_/g, ' ')} <span className="text-text-secondary">· {l.entity_type}</span></span><span className="text-xs text-text-secondary">{l.actor_email ?? 'system'} · {new Date(l.created_at).toLocaleString()}</span></li>)}</ul>)}
                <button type="button" className={`${btnGhost} mt-3`} onClick={() => void load()}>Refresh</button>
              </Card>)}
          </>)}
        {selectedFinding && data && <FindingDrawer finding={selectedFinding} data={data} businessName={businessName} timeZone={timeZone} onClose={() => setSelected(null)} onChanged={load} />}
      </div>
    </DashboardLayout>
  );
}

export default SupplierAuditPage;
