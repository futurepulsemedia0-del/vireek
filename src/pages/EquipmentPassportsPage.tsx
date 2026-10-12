/**
 * Equipment Passports — dashboard index: every machine this company is attached to.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { SavedViewsBar, type AppliedViewExtras } from '@/components/SavedViewsBar';
import { SortSelect, type SortOption } from '@/components/SortSelect';
import { coerceSort, sortRows, type SortValue, type ViewSort } from '@/lib/viewSort';
import { Link, useNavigate } from 'react-router-dom';
import { Lock, QrCode, Search, ShieldCheck } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { useToast } from '@/contexts/ToastContext';
import {
  equipmentTitle,
  formatPassportCode,
  isValidPassportCode,
  listPassports,
  normalizePassportCode,
  passportErrorMessage,
  warrantyState,
  type PassportListItem,
} from '@/lib/equipmentPassport';
import { formatDate } from '@/lib/technicianIdentity';

const WARRANTY_DOT = { active: 'bg-success-500', expiring: 'bg-warning-500', expired: 'bg-text-secondary/40', unknown: 'bg-text-secondary/20' } as const;

const WARRANTY_FILTERS = ['all', 'active', 'expiring', 'expired', 'unknown'] as const;
type WarrantyFilter = (typeof WARRANTY_FILTERS)[number];
const VERIFIED_FILTERS = ['all', 'verified', 'unverified'] as const;
type VerifiedFilter = (typeof VERIFIED_FILTERS)[number];
const EQUIPMENT_SORT_OPTIONS: SortOption[] = [
  { key: 'title', label: 'Make / model' },
  { key: 'customer_name', label: 'Customer' },
  { key: 'last_service_at', label: 'Last service', defaultDir: 'desc' },
  { key: 'warranty_expires_at', label: 'Warranty expiry' },
  { key: 'linked_at', label: 'Date added', defaultDir: 'desc' },
];
const EQUIPMENT_SORT_ACCESSORS: Record<string, (i: PassportListItem) => SortValue> = {
  title: (i) => equipmentTitle(i),
  customer_name: (i) => i.customer_name,
  last_service_at: (i) => (i.last_service_at ? new Date(i.last_service_at).getTime() : null),
  warranty_expires_at: (i) => (i.warranty_expires_at ? new Date(i.warranty_expires_at).getTime() : null),
  linked_at: (i) => new Date(i.linked_at).getTime(),
};

export function EquipmentPassportsPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [items, setItems] = useState<PassportListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [codeInput, setCodeInput] = useState('');
    const [warrantyFilter, setWarrantyFilter] = useState<WarrantyFilter>('all');
  const [verifiedFilter, setVerifiedFilter] = useState<VerifiedFilter>('all');
  const [sort, setSort] = useState<ViewSort | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await listPassports());
    } catch (err) {
      toast(passportErrorMessage(err), 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = items.filter((i) => {
      if (warrantyFilter !== 'all' && warrantyState(i.warranty_expires_at).state !== warrantyFilter) return false;
      if (verifiedFilter === 'verified' && !i.verified) return false;
      if (verifiedFilter === 'unverified' && i.verified) return false;
      return (
        !q ||
        [i.make, i.model, i.serial_number, i.equipment_type, i.customer_name, i.code].filter(Boolean).join(' ').toLowerCase().includes(q)
      );
    });
    return sortRows(base, sort, EQUIPMENT_SORT_ACCESSORS);
  }, [items, query, warrantyFilter, verifiedFilter, sort]);

  const currentFilters = { query, warrantyFilter, verifiedFilter };
  const applyView = (f: Record<string, unknown>, extras: AppliedViewExtras) => {
    setQuery(typeof f.query === 'string' ? f.query : '');
    setWarrantyFilter(WARRANTY_FILTERS.includes(f.warrantyFilter as WarrantyFilter) ? (f.warrantyFilter as WarrantyFilter) : 'all');
    setVerifiedFilter(VERIFIED_FILTERS.includes(f.verifiedFilter as VerifiedFilter) ? (f.verifiedFilter as VerifiedFilter) : 'all');
    setSort(coerceSort(extras.sort, EQUIPMENT_SORT_OPTIONS.map((o) => o.key), null));
  };

  const verifiedCount = items.filter((i) => i.verified).length;

  return (
    <DashboardLayout activeLabel="Equipment Passports">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><QrCode size={24} aria-hidden="true" /></span>
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-text-primary">Equipment Passports</h1>
          <p className="text-sm text-text-secondary">A permanent identity for each machine — its history stays with the machine, not with any one company.</p>
        </div>
      </div>

      <section className="mb-6 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark" aria-labelledby="open-by-code">
        <h2 id="open-by-code" className="text-sm font-semibold text-text-primary">On site? Open a machine by its label</h2>
        <p className="mt-0.5 text-xs text-text-secondary">Scan the QR with your phone camera, or type the code printed on the label (VEQ-XXXX-XXXX-XXXX).</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <label className="sr-only" htmlFor="passport-code">Passport code</label>
          <input
            id="passport-code"
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') openCode(); }}
            placeholder="VEQ-ABCD-EFGH-JKMN"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="focus-ring min-w-0 flex-1 rounded-lg border border-border bg-bg-primary px-3 py-2 font-mono text-sm text-text-primary"
          />
          <button type="button" onClick={openCode} className="focus-ring rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90">Open passport</button>
        </div>
      </section>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" aria-hidden="true" />
          <label className="sr-only" htmlFor="passport-search">Search passports</label>
          <input
            id="passport-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search make, model, serial, customer…"
            className="focus-ring w-full rounded-lg border border-border bg-bg-secondary py-2 pl-9 pr-3 text-sm text-text-primary"
          />
        </div>
        <select
          value={warrantyFilter}
          onChange={(e) => setWarrantyFilter(e.target.value as WarrantyFilter)}
          aria-label="Filter by warranty"
          className="focus-ring rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary"
        >
          <option value="all">All warranties</option>
          <option value="active">Active</option>
          <option value="expiring">Expiring soon</option>
          <option value="expired">Expired</option>
          <option value="unknown">No warranty on file</option>
        </select>
        <select
          value={verifiedFilter}
          onChange={(e) => setVerifiedFilter(e.target.value as VerifiedFilter)}
          aria-label="Filter by verification"
          className="focus-ring rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary"
        >
          <option value="all">All machines</option>
          <option value="verified">Verified</option>
          <option value="unverified">Unverified</option>
        </select>
        <SortSelect value={sort} options={EQUIPMENT_SORT_OPTIONS} onChange={setSort} />
        <SavedViewsBar page="equipment" currentFilters={currentFilters} currentSort={sort} onApply={applyView} />
        <p className="text-xs text-text-secondary">{items.length} machine{items.length === 1 ? '' : 's'} · {verifiedCount} verified</p>
      </div>

      {loading ? (
        <div className="space-y-3" aria-busy="true">
          {[0, 1, 2].map((i) => <div key={i} className="h-24 animate-pulse rounded-2xl bg-bg-secondary" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center">
          <p className="text-sm text-text-secondary">
            {items.length === 0
              ? 'No machines yet. Add equipment to a customer and its passport is issued automatically.'
              : 'Nothing matches your search.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {filtered.map((i) => {
            const w = warrantyState(i.warranty_expires_at);
            const inner = (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-text-primary">{equipmentTitle(i)}</p>
                  <p className="truncate text-xs text-text-secondary">
                    {i.equipment_type}
                    {i.customer_name ? ` · ${i.customer_name}` : ''}
                    {i.serial_number ? ` · S/N ${i.serial_number}` : ''}
                  </p>
                  <p className="mt-1 flex items-center gap-1.5 text-[11px] text-text-secondary">
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${WARRANTY_DOT[w.state]}`} aria-hidden="true" />
                    {w.state === 'unknown' ? 'No warranty on file' : w.state === 'expired' ? 'Warranty expired' : `Warranty until ${formatDate(i.warranty_expires_at)}`}
                    {i.status !== 'active' ? ` · ${i.status}` : ''}
                  </p>
                </div>
                <div className="text-right">
                  {i.verified && i.code ? (
                    <>
                      <p className="font-mono text-xs font-semibold text-accent">{formatPassportCode(i.code)}</p>
                      <p className="text-[11px] text-text-secondary">
                        {i.service_count} service{i.service_count === 1 ? '' : 's'}
                        {i.last_service_at ? ` · last ${formatDate(i.last_service_at)}` : ''}
                      </p>
                    </>
                  ) : (
                    <p className="inline-flex items-center gap-1 rounded-full bg-warning-500/10 px-2.5 py-1 text-[11px] font-medium text-warning-500">
                      <Lock size={11} aria-hidden="true" /> Scan the label to verify
                    </p>
                  )}
                </div>
              </div>
            );
            return (
              <li key={`${i.code ?? 'pending'}-${i.equipment_id ?? i.linked_at}`}>
                {i.verified && i.code ? (
                  <Link to={`/dashboard/equipment-passports/${i.code}`} className="focus-ring block rounded-2xl border border-border bg-bg-secondary p-4 shadow-card transition-colors hover:border-accent/40 dark:shadow-card-dark">
                    {inner}
                  </Link>
                ) : (
                  <div className="rounded-2xl border border-dashed border-border bg-bg-secondary p-4">
                    {inner}
                    <p className="mt-2 flex items-start gap-1.5 text-[11px] text-text-secondary">
                      <ShieldCheck size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                      This machine already has a Vireek passport from another company. Scan the QR on the machine to prove you are on site and unlock its history.
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </DashboardLayout>
  );
}
