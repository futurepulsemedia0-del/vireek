/**
 * Franchise Governance — /dashboard/franchise/governance
 * Corporate control surface: pricing, territory, brand+compliance,
 * benchmark, royalty, procurement across every branch in the group.
 */

import { useCallback, useEffect, useState } from 'react';
import { DollarSign, MapPin, ShieldCheck, TrendingUp, Landmark, Truck, Loader2, Send, Plus } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase } from '@/lib/supabase';
import {
  createApprovedVendor,
  createPricePolicy,
  createRequirement,
  fetchApprovedVendors,
  fetchBenchmark,
  fetchComplianceSummary,
  fetchPricePolicies,
  fetchRoyaltyStatements,
  generateAndNotifyRoyalty,
  markRoyaltyStatus,
  pushPricePolicy,
  pushVendor,
  upsertTerritory,
  type ApprovedVendor,
  type BenchmarkRow,
  type ComplianceSummary,
  type PricePolicy,
  type RoyaltyStatement,
} from '@/lib/franchiseGovernance';

type Tab = 'pricing' | 'territory' | 'compliance' | 'benchmark' | 'royalty' | 'procurement';

const TABS: { id: Tab; label: string; icon: typeof DollarSign }[] = [
  { id: 'pricing', label: 'Pricing', icon: DollarSign },
  { id: 'territory', label: 'Territory', icon: MapPin },
  { id: 'compliance', label: 'Brand & Compliance', icon: ShieldCheck },
  { id: 'benchmark', label: 'Benchmark', icon: TrendingUp },
  { id: 'royalty', label: 'Royalty', icon: Landmark },
  { id: 'procurement', label: 'Procurement', icon: Truck },
];

const inputClass = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

export function FranchiseGovernancePage() {
  const { toast } = useToast();
  const [groupId, setGroupId] = useState<string | null>(null);
  const [locations, setLocations] = useState<{ id: string; label: string }[]>([]);
  const [tab, setTab] = useState<Tab>('pricing');
  const [loading, setLoading] = useState(true);

  const [policies, setPolicies] = useState<PricePolicy[]>([]);
  const [compliance, setCompliance] = useState<ComplianceSummary[]>([]);
  const [benchmark, setBenchmark] = useState<BenchmarkRow[]>([]);
  const [royalty, setRoyalty] = useState<RoyaltyStatement[]>([]);
  const [vendors, setVendors] = useState<ApprovedVendor[]>([]);

  const [newService, setNewService] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [newEnforcement, setNewEnforcement] = useState<PricePolicy['enforcement']>('recommended');
  const [territoryLocation, setTerritoryLocation] = useState('');
  const [territoryZips, setTerritoryZips] = useState('');
  const [reqTitle, setReqTitle] = useState('');
  const [reqType, setReqType] = useState<'brand' | 'compliance' | 'safety' | 'legal'>('brand');
  const [vendorName, setVendorName] = useState('');
  const [vendorMandatory, setVendorMandatory] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: group } = await supabase.from('franchise_groups').select('id').maybeSingle();
      if (!group) { setLoading(false); return; }
      setGroupId(group.id);

      const { data: locs } = await supabase.from('franchise_locations').select('id, label').eq('franchise_group_id', group.id).eq('status', 'active');
      setLocations(locs ?? []);

      const [p, c, b, r, v] = await Promise.all([
        fetchPricePolicies(group.id),
        fetchComplianceSummary(group.id),
        fetchBenchmark(group.id),
        fetchRoyaltyStatements(group.id),
        fetchApprovedVendors(group.id),
      ]);
      setPolicies(p); setCompliance(c); setBenchmark(b); setRoyalty(r); setVendors(v);
    } catch {
      toast('Could not load governance data.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return <DashboardLayout activeLabel="Franchise Governance"><div className="flex h-64 items-center justify-center"><Loader2 className="animate-spin" /></div></DashboardLayout>;
  }

  if (!groupId) {
    return (
      <DashboardLayout activeLabel="Franchise Governance">
        <div className="p-6 text-sm text-text-secondary">Create a franchise group first in Franchise Command Center.</div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Franchise Governance">
      <div className="space-y-6 p-6">
        <div className="flex flex-wrap gap-2">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setTab(id)}
              className={`focus-ring flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium ${tab === id ? 'bg-cta text-white' : 'bg-bg-tertiary text-text-secondary'}`}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        {tab === 'pricing' && (
          <div className="rounded-2xl border border-border bg-bg-secondary p-5">
            <p className="mb-3 text-sm font-semibold text-text-primary">Corporate price policies</p>
            <div className="mb-4 grid gap-2 sm:grid-cols-4">
              <input className={inputClass} placeholder="Service name" value={newService} onChange={(e) => setNewService(e.target.value)} />
              <input className={inputClass} placeholder="Price ($)" type="number" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} />
              <select className={inputClass} value={newEnforcement} onChange={(e) => setNewEnforcement(e.target.value as PricePolicy['enforcement'])}>
                <option value="recommended">Recommended</option>
                <option value="recommended_floor">Floor price</option>
                <option value="mandatory">Mandatory</option>
              </select>
              <button
                onClick={async () => {
                  if (!newService || !newPrice) return;
                  await createPricePolicy(groupId, { service_name: newService, category: null, pricing_model: 'flat', price_cents: Math.round(Number(newPrice) * 100), price_max_cents: null, unit_label: null, enforcement: newEnforcement });
                  setNewService(''); setNewPrice(''); toast('Policy created.', 'success'); void load();
                }}
                className="focus-ring flex items-center justify-center gap-1 rounded-xl bg-cta px-3 py-2 text-sm font-medium text-white"
              ><Plus size={14} /> Add</button>
            </div>
            <div className="space-y-2">
              {policies.map((p) => (
                <div key={p.id} className="flex items-center justify-between rounded-xl border border-border bg-bg-primary p-3 text-sm">
                  <span>{p.service_name} — ${(p.price_cents / 100).toFixed(2)} <span className="text-xs text-text-secondary">({p.enforcement})</span></span>
                  <button onClick={async () => { const n = await pushPricePolicy(p.id); toast(`Pushed to ${n} branch(es).`, 'success'); }}
                    className="focus-ring flex items-center gap-1 rounded-lg bg-cta/15 px-3 py-1.5 text-xs font-medium text-cta"><Send size={12} /> Push to branches</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'territory' && (
          <div className="rounded-2xl border border-border bg-bg-secondary p-5">
            <p className="mb-3 text-sm font-semibold text-text-primary">Exclusive territories</p>
            <div className="mb-4 grid gap-2 sm:grid-cols-3">
              <select className={inputClass} value={territoryLocation} onChange={(e) => setTerritoryLocation(e.target.value)}>
                <option value="">Select branch...</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
              <input className={inputClass} placeholder="Zip codes, comma-separated" value={territoryZips} onChange={(e) => setTerritoryZips(e.target.value)} />
              <button onClick={async () => {
                if (!territoryLocation || !territoryZips) return;
                try {
                  await upsertTerritory(groupId, territoryLocation, territoryZips.split(',').map((z) => z.trim()).filter(Boolean), true);
                  toast('Territory saved.', 'success'); setTerritoryZips('');
                } catch (e) { toast(e instanceof Error ? e.message : 'Could not save territory.', 'error'); }
              }} className="focus-ring rounded-xl bg-cta px-3 py-2 text-sm font-medium text-white">Save</button>
            </div>
          </div>
        )}

        {tab === 'compliance' && (
          <div className="rounded-2xl border border-border bg-bg-secondary p-5">
            <p className="mb-3 text-sm font-semibold text-text-primary">Brand standards & compliance requirements</p>
            <div className="mb-4 grid gap-2 sm:grid-cols-3">
              <input className={inputClass} placeholder="Requirement title" value={reqTitle} onChange={(e) => setReqTitle(e.target.value)} />
              <select className={inputClass} value={reqType} onChange={(e) => setReqType(e.target.value as typeof reqType)}>
                <option value="brand">Brand</option>
                <option value="compliance">Compliance</option>
                <option value="safety">Safety</option>
                <option value="legal">Legal</option>
              </select>
              <button onClick={async () => {
                if (!reqTitle) return;
                await createRequirement(groupId, { requirement_type: reqType, title: reqTitle, description: null, is_required: true });
                setReqTitle(''); toast('Requirement created.', 'success'); void load();
              }} className="focus-ring flex items-center justify-center gap-1 rounded-xl bg-cta px-3 py-2 text-sm font-medium text-white"><Plus size={14} /> Add</button>
            </div>
            <p className="mb-2 text-xs font-semibold uppercase text-text-secondary">Compliance by branch</p>
            <div className="space-y-2">
              {compliance.map((c) => (
                <div key={c.location_id} className="flex items-center justify-between rounded-xl border border-border bg-bg-primary p-3 text-sm">
                  <span>{c.label}</span>
                  <span className="text-xs text-text-secondary">{c.compliance_pct === null ? 'No reviews yet' : `${c.compliance_pct}% compliant (${c.pending_count} pending)`}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'benchmark' && (
          <div className="rounded-2xl border border-border bg-bg-secondary p-5">
            <p className="mb-3 text-sm font-semibold text-text-primary">Branch benchmark (30 days, percentile within group)</p>
            <div className="space-y-2">
              {benchmark.map((b) => (
                <div key={b.location_id} className="rounded-xl border border-border bg-bg-primary p-3 text-sm">
                  <p className="font-medium text-text-primary">{b.label}</p>
                  <p className="text-xs text-text-secondary">
                    Revenue: ${b.revenue_30d.toLocaleString()} (P{b.revenue_percentile}) · Jobs: {b.jobs_30d} (P{b.jobs_percentile}) · Rating: {b.avg_rating?.toFixed(1) ?? '—'} (P{b.rating_percentile})
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'royalty' && (
          <div className="rounded-2xl border border-border bg-bg-secondary p-5">
            <p className="mb-3 text-sm font-semibold text-text-primary">Royalty statements</p>
            <button onClick={async () => {
              const end = new Date(); const start = new Date(); start.setDate(1);
              try {
                const result = await generateAndNotifyRoyalty(groupId, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
                toast(`Issued ${result.issued} statement(s), notified ${result.notified}.`, 'success'); void load();
              } catch { toast('Could not generate statements.', 'error'); }
            }} className="focus-ring mb-4 rounded-xl bg-cta px-4 py-2 text-sm font-medium text-white">Generate this month & notify</button>
            <div className="space-y-2">
              {royalty.map((r) => (
                <div key={r.id} className="flex items-center justify-between rounded-xl border border-border bg-bg-primary p-3 text-sm">
                  <span>{r.period_start} → {r.period_end}: ${(r.royalty_amount_cents / 100).toFixed(2)} <span className="text-xs text-text-secondary">({r.status})</span></span>
                  {r.status === 'issued' && (
                    <button onClick={async () => { await markRoyaltyStatus(r.id, 'paid'); toast('Marked paid.', 'success'); void load(); }}
                      className="focus-ring rounded-lg bg-success-500/15 px-3 py-1.5 text-xs font-medium text-success-500">Mark paid</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'procurement' && (
          <div className="rounded-2xl border border-border bg-bg-secondary p-5">
            <p className="mb-3 text-sm font-semibold text-text-primary">Corporate-approved vendors</p>
            <div className="mb-4 grid gap-2 sm:grid-cols-3">
              <input className={inputClass} placeholder="Vendor name" value={vendorName} onChange={(e) => setVendorName(e.target.value)} />
              <label className="flex items-center gap-2 text-xs text-text-secondary">
                <input type="checkbox" checked={vendorMandatory} onChange={(e) => setVendorMandatory(e.target.checked)} /> Mandatory for all branches
              </label>
              <button onClick={async () => {
                if (!vendorName) return;
                await createApprovedVendor(groupId, { name: vendorName, category: null, is_mandatory: vendorMandatory, active: true });
                setVendorName(''); toast('Vendor added.', 'success'); void load();
              }} className="focus-ring flex items-center justify-center gap-1 rounded-xl bg-cta px-3 py-2 text-sm font-medium text-white"><Plus size={14} /> Add</button>
            </div>
            <div className="space-y-2">
              {vendors.map((v) => (
                <div key={v.id} className="flex items-center justify-between rounded-xl border border-border bg-bg-primary p-3 text-sm">
                  <span>{v.name} {v.is_mandatory && <span className="ml-1 rounded-full bg-error-500/15 px-2 py-0.5 text-[10px] font-semibold text-error-500">mandatory</span>}</span>
                  <button onClick={async () => { const n = await pushVendor(v.id); toast(`Pushed to ${n} branch(es).`, 'success'); }}
                    className="focus-ring flex items-center gap-1 rounded-lg bg-cta/15 px-3 py-1.5 text-xs font-medium text-cta"><Send size={12} /> Push to branches</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
