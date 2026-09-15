import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  Search,
  X,
  Mail,
  Phone,
  MapPin,
  Plus,
  Building2,
  Home,
  Trash2,
  Star,
  Tag as TagIcon,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, Customer } from '@/lib/supabase';
import { useKeyboardShortcut } from '@/lib/hooks';
import { TagEditor } from '@/components/TagEditor';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonTable } from '@/components/Skeleton';

// ============================================================
// CONSTANTS
// ============================================================

const LIFECYCLE_STAGES: { key: Customer['lifecycle_stage']; label: string; dotColor: string }[] = [
  { key: 'lead', label: 'Lead', dotColor: 'bg-accent' },
  { key: 'active', label: 'Active', dotColor: 'bg-success-500' },
  { key: 'vip', label: 'VIP', dotColor: 'bg-warning-500' },
  { key: 'inactive', label: 'Inactive', dotColor: 'bg-text-secondary/50' },
];

const TAG_SUGGESTIONS = ['repeat-customer', 'referral', 'financing', 'commercial-account', 'high-value'];

function lifecycleMeta(stage: Customer['lifecycle_stage']) {
  return LIFECYCLE_STAGES.find((s) => s.key === stage) ?? LIFECYCLE_STAGES[0];
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

type DraftCustomer = Pick<
  Customer,
  'name' | 'phone' | 'email' | 'address' | 'customer_type' | 'lifecycle_stage' | 'tags' | 'notes'
>;

const EMPTY_DRAFT: DraftCustomer = {
  name: '',
  phone: '',
  email: '',
  address: '',
  customer_type: 'residential',
  lifecycle_stage: 'lead',
  tags: [],
  notes: '',
};

// ============================================================
// CUSTOMER DRAWER (create / edit)
// ============================================================

function CustomerDrawer({
  open,
  customer,
  onClose,
  onSaved,
  onDeleteRequest,
}: {
  open: boolean;
  customer: Customer | null;
  onClose: () => void;
  onSaved: () => void;
  onDeleteRequest: (customer: Customer) => void;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<DraftCustomer>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (customer) {
      setDraft({
        name: customer.name,
        phone: customer.phone ?? '',
        email: customer.email ?? '',
        address: customer.address ?? '',
        customer_type: customer.customer_type,
        lifecycle_stage: customer.lifecycle_stage,
        tags: customer.tags,
        notes: customer.notes ?? '',
      });
    } else {
      setDraft(EMPTY_DRAFT);
    }
  }, [customer, open]);

  const handleSave = async () => {
    if (!draft.name.trim()) {
      toast('Customer name is required.', 'error');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: draft.name.trim(),
        phone: draft.phone?.trim() || null,
        email: draft.email?.trim() || null,
        address: draft.address?.trim() || null,
        customer_type: draft.customer_type,
        lifecycle_stage: draft.lifecycle_stage,
        tags: draft.tags,
        notes: draft.notes?.trim() || null,
      };
      const { error } = customer
        ? await supabase.from('customers').update(payload).eq('id', customer.id)
        : await supabase.from('customers').insert(payload);
      if (error) {
        if (error.code === '23505') {
          toast('A customer with that phone or email already exists.', 'error');
        } else {
          toast('Could not save this customer.', 'error');
        }
        return;
      }
      toast(customer ? 'Customer updated.' : 'Customer added.', 'success');
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-black/40"
          />
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col overflow-y-auto border-l border-border bg-bg-primary p-6 shadow-2xl"
          >
            <div className="mb-6 flex items-center justify-between">
              <h2 className="text-lg font-bold text-text-primary">
                {customer ? 'Edit Customer' : 'New Customer'}
              </h2>
              <button
                type="button"
                onClick={onClose}
                className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-text-secondary">Name *</label>
                <input
                  type="text"
                  value={draft.name}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  className="focus-ring w-full rounded-xl border border-border bg-bg-secondary px-3.5 py-2.5 text-sm text-text-primary"
                  placeholder="Jane Smith"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-text-secondary">Phone</label>
                  <input
                    type="tel"
                    value={draft.phone ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))}
                    className="focus-ring w-full rounded-xl border border-border bg-bg-secondary px-3.5 py-2.5 text-sm text-text-primary"
                    placeholder="(555) 123-4567"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-text-secondary">Email</label>
                  <input
                    type="email"
                    value={draft.email ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
                    className="focus-ring w-full rounded-xl border border-border bg-bg-secondary px-3.5 py-2.5 text-sm text-text-primary"
                    placeholder="jane@email.com"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-text-secondary">Address</label>
                <input
                  type="text"
                  value={draft.address ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, address: e.target.value }))}
                  className="focus-ring w-full rounded-xl border border-border bg-bg-secondary px-3.5 py-2.5 text-sm text-text-primary"
                  placeholder="123 Main St, Springfield"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-text-secondary">Type</label>
                  <select
                    value={draft.customer_type}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, customer_type: e.target.value as Customer['customer_type'] }))
                    }
                    className="focus-ring w-full rounded-xl border border-border bg-bg-secondary px-3.5 py-2.5 text-sm text-text-primary"
                  >
                    <option value="residential">Residential</option>
                    <option value="commercial">Commercial</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-text-secondary">Stage</label>
                  <select
                    value={draft.lifecycle_stage}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, lifecycle_stage: e.target.value as Customer['lifecycle_stage'] }))
                    }
                    className="focus-ring w-full rounded-xl border border-border bg-bg-secondary px-3.5 py-2.5 text-sm text-text-primary"
                  >
                    {LIFECYCLE_STAGES.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-text-secondary">Tags</label>
                <TagEditor
                  tags={draft.tags}
                  suggestions={TAG_SUGGESTIONS}
                  onChange={(tags) => setDraft((d) => ({ ...d, tags }))}
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-text-secondary">Notes</label>
                <textarea
                  value={draft.notes ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                  rows={4}
                  className="focus-ring w-full resize-none rounded-xl border border-border bg-bg-secondary px-3.5 py-2.5 text-sm text-text-primary"
                  placeholder="Anything worth remembering about this customer…"
                />
              </div>
            </div>

            <div className="mt-6 flex gap-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="focus-ring flex-1 rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {saving ? 'Saving…' : customer ? 'Save changes' : 'Add customer'}
              </button>
              {customer && (
                <button
                  type="button"
                  onClick={() => onDeleteRequest(customer)}
                  className="focus-ring flex h-11 w-11 items-center justify-center rounded-xl border border-border text-text-secondary transition-colors hover:border-danger/40 hover:text-danger"
                  aria-label="Delete customer"
                >
                  <Trash2 size={18} />
                </button>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

// ============================================================
// MAIN CUSTOMERS PAGE
// ============================================================

export function CustomersPage() {
  const navigate = useNavigate();
  const { user, profile, profileLoading } = useAuth();
  const { toast } = useToast();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState<Customer['lifecycle_stage'] | 'all'>('all');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Customer | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);

  const loadData = useCallback(async () => {
    if (!user) return;
    setDataLoading(true);
    try {
      const { data, error } = await supabase
        .from('customers')
        .select('*')
        .order('created_at', { ascending: false });
      if (!error && data) setCustomers(data as Customer[]);
    } finally {
      setDataLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!profileLoading && profile && !profile.onboarding_completed) {
      navigate('/onboarding', { replace: true });
    }
  }, [profile, profileLoading, navigate]);

  useKeyboardShortcut({ key: '/', handler: () => searchRef.current?.focus() });

  const filteredCustomers = useMemo(() => {
    let list = customers;
    if (stageFilter !== 'all') list = list.filter((c) => c.lifecycle_stage === stageFilter);
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.phone?.toLowerCase().includes(q) ?? false) ||
        (c.email?.toLowerCase().includes(q) ?? false) ||
        (c.address?.toLowerCase().includes(q) ?? false) ||
        c.tags.some((t) => t.includes(q))
    );
  }, [customers, search, stageFilter]);

  const openNewDrawer = () => {
    setEditingCustomer(null);
    setDrawerOpen(true);
  };

  const openEditDrawer = (customer: Customer) => {
    setEditingCustomer(customer);
    setDrawerOpen(true);
  };

  const handleSaved = () => {
    setDrawerOpen(false);
    setEditingCustomer(null);
    loadData();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const { error } = await supabase.from('customers').delete().eq('id', deleteTarget.id);
    if (error) {
      toast('Could not delete this customer.', 'error');
      return;
    }
    toast('Customer deleted.', 'success');
    setDeleteTarget(null);
    setDrawerOpen(false);
    loadData();
  };

  return (
    <DashboardLayout activeLabel="Customers">
      {/* Page header */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/dashboard')}
          className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
          aria-label="Back to dashboard"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Customers</h1>
          <p className="mt-1 text-sm text-text-secondary">
            {filteredCustomers.length} {filteredCustomers.length === 1 ? 'customer' : 'customers'}
            {search && ' (filtered)'}
          </p>
        </div>
        <div className="relative max-w-xs flex-1">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-secondary" />
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customers…  (press /)"
            className="focus-ring w-full rounded-xl border border-border bg-bg-secondary py-2.5 pl-10 pr-4 text-sm text-text-primary placeholder:text-text-secondary/60"
          />
        </div>
        <button
          type="button"
          onClick={openNewDrawer}
          className="focus-ring flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
        >
          <Plus size={16} />
          Add customer
        </button>
      </div>

      {/* Stage filter pills */}
      <div className="mb-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setStageFilter('all')}
          className={`focus-ring rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors ${
            stageFilter === 'all'
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border text-text-secondary hover:text-text-primary'
          }`}
        >
          All
        </button>
        {LIFECYCLE_STAGES.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setStageFilter(s.key)}
            className={`focus-ring flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors ${
              stageFilter === s.key
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-border text-text-secondary hover:text-text-primary'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${s.dotColor}`} />
            {s.label}
          </button>
        ))}
      </div>

      {dataLoading ? (
        <SkeletonTable rows={6} columns={5} />
      ) : filteredCustomers.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={search || stageFilter !== 'all' ? 'No customers match your filters' : 'No customers yet'}
          description="Add your first customer, or they'll start showing up here as calls and jobs get linked to them."
          action={{ label: 'Add customer', onClick: openNewDrawer }}
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-text-secondary">
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Contact</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Stage</th>
                <th className="px-4 py-3 font-medium">Last contact</th>
              </tr>
            </thead>
            <tbody>
              {filteredCustomers.map((c) => {
                const meta = lifecycleMeta(c.lifecycle_stage);
                return (
                  <tr
                    key={c.id}
                    onClick={() => openEditDrawer(c)}
                    className="cursor-pointer border-b border-border/60 last:border-0 transition-colors hover:bg-bg-tertiary/60"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-text-primary">{c.name}</div>
                      {c.tags.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {c.tags.slice(0, 3).map((t) => (
                            <span
                              key={t}
                              className="flex items-center gap-1 rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary"
                            >
                              <TagIcon size={10} />
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {c.phone && (
                        <div className="flex items-center gap-1.5">
                          <Phone size={13} /> {c.phone}
                        </div>
                      )}
                      {c.email && (
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <Mail size={13} /> {c.email}
                        </div>
                      )}
                      {c.address && (
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <MapPin size={13} /> {c.address}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      <div className="flex items-center gap-1.5">
                        {c.customer_type === 'commercial' ? <Building2 size={14} /> : <Home size={14} />}
                        {c.customer_type === 'commercial' ? 'Commercial' : 'Residential'}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1.5 text-text-secondary">
                        {c.lifecycle_stage === 'vip' && <Star size={13} className="text-warning-500" />}
                        <span className={`h-1.5 w-1.5 rounded-full ${meta.dotColor}`} />
                        {meta.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{formatDate(c.last_contacted_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <CustomerDrawer
        open={drawerOpen}
        customer={editingCustomer}
        onClose={() => setDrawerOpen(false)}
        onSaved={handleSaved}
        onDeleteRequest={(c) => setDeleteTarget(c)}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete customer?"
        description={`This removes ${deleteTarget?.name ?? 'this customer'} permanently. Linked calls, leads, and jobs are kept — only the customer record is removed.`}
        confirmLabel="Yes, delete this customer"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </DashboardLayout>
  );
}
