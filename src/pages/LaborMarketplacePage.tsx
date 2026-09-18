import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  HandHelping,
  Plus,
  Trash2,
  Pencil,
  X,
  Check,
  ChevronDown,
  ChevronUp,
  Send,
  ThumbsUp,
  ThumbsDown,
  MapPin,
  Calendar,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { supabase, LaborMarketplaceListing, LaborMarketplaceMatch } from '@/lib/supabase';
import {
  ListingType,
  TradeCategory,
  ListingStatus,
  MatchStatus,
  LISTING_TYPE_LABELS,
  LISTING_TYPE_COLORS,
  TRADE_CATEGORY_LABELS,
  TRADE_CATEGORY_OPTIONS,
  LISTING_STATUS_LABELS,
  LISTING_STATUS_COLORS,
  MATCH_STATUS_LABELS,
  MATCH_STATUS_COLORS,
  isOpenListing,
  isPendingMatch,
  formatCents,
  formatDateRange,
  formatLocation,
} from '@/lib/laborMarketplace';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

const labelClass = 'mb-1.5 block text-xs font-medium text-text-secondary';

type BrowseFilter = 'all' | 'offering' | 'requesting' | 'mine';

const BROWSE_FILTERS: { key: BrowseFilter; label: string }[] = [
  { key: 'all', label: 'All open listings' },
  { key: 'offering', label: 'Offering technicians' },
  { key: 'requesting', label: 'Requesting technicians' },
  { key: 'mine', label: 'My listings' },
];

interface OwnProfile {
  company_name: string | null;
  phone: string | null;
  email: string;
}

// ============================================================
// LISTING FORM (post / edit)
// ============================================================

interface ListingFormState {
  listing_type: ListingType;
  trade_category: TradeCategory;
  title: string;
  description: string;
  technicians_count: string;
  start_date: string;
  end_date: string;
  hourly_rate: string;
  location_city: string;
  location_region: string;
  business_name: string;
  contact_name: string;
  contact_phone: string;
  contact_email: string;
  status: ListingStatus;
}

function emptyListingForm(profile: OwnProfile | null): ListingFormState {
  return {
    listing_type: 'offering',
    trade_category: 'general',
    title: '',
    description: '',
    technicians_count: '1',
    start_date: '',
    end_date: '',
    hourly_rate: '',
    location_city: '',
    location_region: '',
    business_name: profile?.company_name ?? '',
    contact_name: '',
    contact_phone: profile?.phone ?? '',
    contact_email: profile?.email ?? '',
    status: 'open',
  };
}

function listingToForm(l: LaborMarketplaceListing): ListingFormState {
  return {
    listing_type: l.listing_type,
    trade_category: l.trade_category,
    title: l.title,
    description: l.description ?? '',
    technicians_count: String(l.technicians_count ?? 1),
    start_date: l.start_date ?? '',
    end_date: l.end_date ?? '',
    hourly_rate: l.hourly_rate_cents != null ? String(l.hourly_rate_cents / 100) : '',
    location_city: l.location_city ?? '',
    location_region: l.location_region ?? '',
    business_name: l.business_name,
    contact_name: l.contact_name ?? '',
    contact_phone: l.contact_phone ?? '',
    contact_email: l.contact_email ?? '',
    status: l.status,
  };
}

function ListingForm({
  initial,
  editing,
  onCancel,
  onSave,
}: {
  initial: ListingFormState;
  editing: boolean;
  onCancel: () => void;
  onSave: (form: ListingFormState) => Promise<void>;
}) {
  const [form, setForm] = useState<ListingFormState>(initial);
  const [saving, setSaving] = useState(false);

  const update = <K extends keyof ListingFormState>(key: K, value: ListingFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className={labelClass}>Listing type</label>
          <div className="flex gap-2">
            {(['offering', 'requesting'] as ListingType[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => update('listing_type', t)}
                className={`focus-ring flex-1 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                  form.listing_type === t
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border text-text-secondary hover:text-text-primary'
                }`}
              >
                {LISTING_TYPE_LABELS[t]}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className={labelClass}>Trade category</label>
          <select
            className={inputClass}
            value={form.trade_category}
            onChange={(e) => update('trade_category', e.target.value as TradeCategory)}
          >
            {TRADE_CATEGORY_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {TRADE_CATEGORY_LABELS[t]}
              </option>
            ))}
          </select>
        </div>

        <div className="sm:col-span-2">
          <label className={labelClass}>Title *</label>
          <input
            className={inputClass}
            value={form.title}
            onChange={(e) => update('title', e.target.value)}
            placeholder={
              form.listing_type === 'offering'
                ? '2 licensed HVAC techs available, next 2 weeks'
                : 'Need 1 plumber for a 3-day commercial job'
            }
          />
        </div>

        <div>
          <label className={labelClass}># of technicians</label>
          <input
            type="number"
            min={1}
            className={inputClass}
            value={form.technicians_count}
            onChange={(e) => update('technicians_count', e.target.value)}
          />
        </div>

        <div>
          <label className={labelClass}>Rate ($/hr)</label>
          <input
            type="number"
            min={0}
            step="0.01"
            className={inputClass}
            value={form.hourly_rate}
            onChange={(e) => update('hourly_rate', e.target.value)}
          />
        </div>

        <div>
          <label className={labelClass}>Start date</label>
          <input type="date" className={inputClass} value={form.start_date} onChange={(e) => update('start_date', e.target.value)} />
        </div>

        <div>
          <label className={labelClass}>End date</label>
          <input type="date" className={inputClass} value={form.end_date} onChange={(e) => update('end_date', e.target.value)} />
        </div>

        <div>
          <label className={labelClass}>City</label>
          <input className={inputClass} value={form.location_city} onChange={(e) => update('location_city', e.target.value)} />
        </div>

        <div>
          <label className={labelClass}>State / region</label>
          <input className={inputClass} value={form.location_region} onChange={(e) => update('location_region', e.target.value)} />
        </div>

        <div className="sm:col-span-2">
          <label className={labelClass}>Description</label>
          <textarea
            className={inputClass}
            rows={3}
            value={form.description}
            onChange={(e) => update('description', e.target.value)}
            placeholder="Skills required, licensing, equipment provided, anything a matching business should know."
          />
        </div>

        <div className="sm:col-span-2 mt-2 border-t border-border/60 pt-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">
            Shown to other businesses browsing the marketplace
          </p>
        </div>

        <div>
          <label className={labelClass}>Business name *</label>
          <input className={inputClass} value={form.business_name} onChange={(e) => update('business_name', e.target.value)} />
        </div>

        <div>
          <label className={labelClass}>Contact name</label>
          <input className={inputClass} value={form.contact_name} onChange={(e) => update('contact_name', e.target.value)} />
        </div>

        <div>
          <label className={labelClass}>Contact phone</label>
          <input className={inputClass} value={form.contact_phone} onChange={(e) => update('contact_phone', e.target.value)} />
        </div>

        <div>
          <label className={labelClass}>Contact email</label>
          <input className={inputClass} value={form.contact_email} onChange={(e) => update('contact_email', e.target.value)} />
        </div>

        {editing && (
          <div>
            <label className={labelClass}>Status</label>
            <select className={inputClass} value={form.status} onChange={(e) => update('status', e.target.value as ListingStatus)}>
              {(['open', 'matched', 'closed', 'expired'] as ListingStatus[]).map((s) => (
                <option key={s} value={s}>
                  {LISTING_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="mt-4 flex justify-end gap-2 border-t border-border/60 pt-3">
        <button
          type="button"
          onClick={onCancel}
          className="focus-ring flex items-center gap-1 rounded-xl px-3 py-2 text-sm text-text-secondary hover:text-text-primary"
        >
          <X size={14} /> Cancel
        </button>
        <button
          type="button"
          disabled={saving || !form.title.trim() || !form.business_name.trim()}
          onClick={async () => {
            setSaving(true);
            await onSave(form);
            setSaving(false);
          }}
          className="focus-ring flex items-center gap-1 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
        >
          <Check size={14} /> {editing ? 'Save changes' : 'Post listing'}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// MATCH / RESPOND FORM
// ============================================================

interface MatchFormState {
  business_name: string;
  contact_name: string;
  contact_phone: string;
  contact_email: string;
  agreed_technicians_count: string;
  agreed_rate: string;
  message: string;
}

function MatchForm({
  initial,
  onCancel,
  onSave,
}: {
  initial: MatchFormState;
  onCancel: () => void;
  onSave: (form: MatchFormState) => Promise<void>;
}) {
  const [form, setForm] = useState<MatchFormState>(initial);
  const [saving, setSaving] = useState(false);
  const update = <K extends keyof MatchFormState>(key: K, value: MatchFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="mt-3 rounded-xl border border-border bg-bg-primary p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={labelClass}>Your business name *</label>
          <input className={inputClass} value={form.business_name} onChange={(e) => update('business_name', e.target.value)} />
        </div>
        <div>
          <label className={labelClass}>Contact name</label>
          <input className={inputClass} value={form.contact_name} onChange={(e) => update('contact_name', e.target.value)} />
        </div>
        <div>
          <label className={labelClass}>Contact phone</label>
          <input className={inputClass} value={form.contact_phone} onChange={(e) => update('contact_phone', e.target.value)} />
        </div>
        <div>
          <label className={labelClass}>Contact email</label>
          <input className={inputClass} value={form.contact_email} onChange={(e) => update('contact_email', e.target.value)} />
        </div>
        <div>
          <label className={labelClass}># of technicians</label>
          <input
            type="number"
            min={1}
            className={inputClass}
            value={form.agreed_technicians_count}
            onChange={(e) => update('agreed_technicians_count', e.target.value)}
          />
        </div>
        <div>
          <label className={labelClass}>Proposed rate ($/hr)</label>
          <input
            type="number"
            min={0}
            step="0.01"
            className={inputClass}
            value={form.agreed_rate}
            onChange={(e) => update('agreed_rate', e.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass}>Message</label>
          <textarea
            className={inputClass}
            rows={2}
            value={form.message}
            onChange={(e) => update('message', e.target.value)}
            placeholder="Availability, certifications, anything the poster should know."
          />
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="focus-ring rounded-xl px-3 py-2 text-sm text-text-secondary hover:text-text-primary">
          Cancel
        </button>
        <button
          type="button"
          disabled={saving || !form.business_name.trim()}
          onClick={async () => {
            setSaving(true);
            await onSave(form);
            setSaving(false);
          }}
          className="focus-ring flex items-center gap-1 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
        >
          <Send size={14} /> Send response
        </button>
      </div>
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function LaborMarketplacePage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [profile, setProfile] = useState<OwnProfile | null>(null);
  const [listings, setListings] = useState<LaborMarketplaceListing[]>([]);
  const [matchesByListing, setMatchesByListing] = useState<Record<string, LaborMarketplaceMatch[]>>({});
  const [myResponses, setMyResponses] = useState<LaborMarketplaceMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [respondingTo, setRespondingTo] = useState<string | null>(null);
  const [filter, setFilter] = useState<BrowseFilter>('all');
  const [showMyResponses, setShowMyResponses] = useState(false);

  const fetchAll = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [profileRes, listingsRes, myResponsesRes] = await Promise.all([
      supabase.from('profiles').select('company_name, phone, email').eq('id', user.id).maybeSingle(),
      supabase.from('labor_marketplace_listings').select('*').order('created_at', { ascending: false }),
      supabase
        .from('labor_marketplace_matches')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false }),
    ]);

    setProfile((profileRes.data as OwnProfile) || null);
    if (listingsRes.error) {
      toast('Failed to load the marketplace', 'error');
    } else {
      setListings((listingsRes.data as LaborMarketplaceListing[]) || []);
    }
    setMyResponses((myResponsesRes.data as LaborMarketplaceMatch[]) || []);
    setLoading(false);
  }, [user, toast]);

  const fetchMatches = useCallback(async (listingId: string) => {
    const { data, error } = await supabase
      .from('labor_marketplace_matches')
      .select('*')
      .eq('listing_id', listingId)
      .order('created_at', { ascending: false });
    if (!error) {
      setMatchesByListing((prev) => ({ ...prev, [listingId]: (data as LaborMarketplaceMatch[]) || [] }));
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const toggleExpand = (listingId: string) => {
    if (expandedId === listingId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(listingId);
    if (!matchesByListing[listingId]) fetchMatches(listingId);
  };

  const filtered = useMemo(() => {
    const mine = listings.filter((l) => l.user_id === user?.id);
    if (filter === 'mine') return mine;
    const open = listings.filter((l) => isOpenListing(l.status));
    if (filter === 'offering') return open.filter((l) => l.listing_type === 'offering');
    if (filter === 'requesting') return open.filter((l) => l.listing_type === 'requesting');
    return open;
  }, [listings, filter, user]);

  const stats = useMemo(() => {
    const open = listings.filter((l) => isOpenListing(l.status));
    const mine = listings.filter((l) => l.user_id === user?.id);
    const pendingResponses = myResponses.filter((m) => isPendingMatch(m.status)).length;
    return { openCount: open.length, mineCount: mine.length, pendingResponses };
  }, [listings, myResponses, user]);

  const handleSaveListing = async (form: ListingFormState, listingId?: string) => {
    if (!user) return;
    const payload = {
      user_id: user.id,
      listing_type: form.listing_type,
      trade_category: form.trade_category,
      title: form.title.trim(),
      description: form.description.trim() || null,
      technicians_count: Number(form.technicians_count) || 1,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      hourly_rate_cents: form.hourly_rate.trim() ? Math.round(Number(form.hourly_rate) * 100) : null,
      location_city: form.location_city.trim() || null,
      location_region: form.location_region.trim() || null,
      business_name: form.business_name.trim(),
      contact_name: form.contact_name.trim() || null,
      contact_phone: form.contact_phone.trim() || null,
      contact_email: form.contact_email.trim() || null,
      status: form.status,
    };

    const query = listingId
      ? supabase.from('labor_marketplace_listings').update(payload).eq('id', listingId)
      : supabase.from('labor_marketplace_listings').insert(payload);

    const { error } = await query;
    if (error) {
      toast('Could not save this listing', 'error');
      return;
    }

    toast(listingId ? 'Listing updated' : 'Listing posted', 'success');
    setPosting(false);
    setEditingId(null);
    fetchAll();
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    const { error } = await supabase.from('labor_marketplace_listings').delete().eq('id', deletingId);
    if (error) {
      toast('Could not delete this listing', 'error');
    } else {
      setListings((prev) => prev.filter((l) => l.id !== deletingId));
      toast('Listing deleted', 'success');
    }
    setDeletingId(null);
  };

  const handleRespond = async (listingId: string, form: MatchFormState) => {
    if (!user) return;
    const payload = {
      user_id: user.id,
      listing_id: listingId,
      business_name: form.business_name.trim(),
      contact_name: form.contact_name.trim() || null,
      contact_phone: form.contact_phone.trim() || null,
      contact_email: form.contact_email.trim() || null,
      agreed_technicians_count: form.agreed_technicians_count.trim() ? Number(form.agreed_technicians_count) : null,
      agreed_rate_cents: form.agreed_rate.trim() ? Math.round(Number(form.agreed_rate) * 100) : null,
      message: form.message.trim() || null,
    };
    const { error } = await supabase.from('labor_marketplace_matches').insert(payload);
    if (error) {
      toast('Could not send your response', 'error');
      return;
    }
    toast('Response sent', 'success');
    setRespondingTo(null);
    fetchMatches(listingId);
    fetchAll();
  };

  const handleMatchStatus = async (listingId: string, matchId: string, status: MatchStatus) => {
    const { error } = await supabase.from('labor_marketplace_matches').update({ status }).eq('id', matchId);
    if (error) {
      toast('Could not update this response', 'error');
      return;
    }
    if (status === 'accepted') {
      await supabase.from('labor_marketplace_listings').update({ status: 'matched' }).eq('id', listingId);
      fetchAll();
    }
    fetchMatches(listingId);
  };

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <HandHelping size={20} />
            </span>
            <div>
              <h1 className="text-2xl font-bold text-text-primary">Labor-Sharing Marketplace</h1>
              <p className="mt-1 text-sm text-text-secondary">
                Lend out idle technicians when work is slow, or find extra hands nearby when you're slammed —
                across every business on Vireek.
              </p>
            </div>
          </div>
          {!posting && !editingId && (
            <button
              type="button"
              onClick={() => setPosting(true)}
              className="focus-ring flex shrink-0 items-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition-all hover:brightness-110"
            >
              <Plus size={16} /> Post a listing
            </button>
          )}
        </div>

        {posting && (
          <div className="mb-6">
            <ListingForm
              initial={emptyListingForm(profile)}
              editing={false}
              onCancel={() => setPosting(false)}
              onSave={(form) => handleSaveListing(form)}
            />
          </div>
        )}

        {loading ? (
          <div className="space-y-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : (
          <>
            <div className="mb-8 grid grid-cols-3 gap-3">
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-2xl font-bold text-text-primary">{stats.openCount}</p>
                <p className="mt-1 text-xs text-text-secondary">Open listings marketplace-wide</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-2xl font-bold text-text-primary">{stats.mineCount}</p>
                <p className="mt-1 text-xs text-text-secondary">Your listings</p>
              </div>
              <button
                type="button"
                onClick={() => setShowMyResponses((v) => !v)}
                className="focus-ring rounded-2xl border border-border bg-bg-secondary p-4 text-center transition-colors hover:bg-bg-tertiary"
              >
                <p className="text-2xl font-bold text-warning-500">{stats.pendingResponses}</p>
                <p className="mt-1 text-xs text-text-secondary">Your responses awaiting a decision</p>
              </button>
            </div>

            {showMyResponses && (
              <div className="mb-8 rounded-2xl border border-border bg-bg-secondary p-4">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Your responses</p>
                {myResponses.length === 0 ? (
                  <p className="text-sm text-text-secondary">You haven't responded to any listings yet.</p>
                ) : (
                  <div className="space-y-2">
                    {myResponses.map((m) => (
                      <div key={m.id} className="flex items-center justify-between rounded-xl bg-bg-primary px-3 py-2 text-sm">
                        <div>
                          <span className={`mr-2 rounded-full px-2 py-0.5 text-xs font-medium ${MATCH_STATUS_COLORS[m.status]}`}>
                            {MATCH_STATUS_LABELS[m.status]}
                          </span>
                          <span className="text-text-secondary">{formatCents(m.agreed_rate_cents)}</span>
                        </div>
                        {isPendingMatch(m.status) && (
                          <button
                            type="button"
                            onClick={async () => {
                              await supabase.from('labor_marketplace_matches').delete().eq('id', m.id);
                              toast('Response withdrawn', 'success');
                              fetchAll();
                            }}
                            className="focus-ring text-xs font-medium text-danger hover:underline"
                          >
                            Withdraw
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="mb-4 flex flex-wrap gap-2">
              {BROWSE_FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  className={`focus-ring rounded-xl px-3 py-1.5 text-sm font-medium transition-colors ${
                    filter === f.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {filtered.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-text-secondary">
                Nothing here yet.
              </div>
            ) : (
              <div className="space-y-3">
                {filtered.map((listing) => {
                  const isMine = listing.user_id === user?.id;
                  return editingId === listing.id ? (
                    <ListingForm
                      key={listing.id}
                      initial={listingToForm(listing)}
                      editing
                      onCancel={() => setEditingId(null)}
                      onSave={(form) => handleSaveListing(form, listing.id)}
                    />
                  ) : (
                    <motion.div key={listing.id} layout className="rounded-2xl border border-border bg-bg-secondary p-4">
                      <div className="flex items-start justify-between gap-3">
                        <button
                          type="button"
                          onClick={() => toggleExpand(listing.id)}
                          className="focus-ring flex flex-1 items-start gap-2 text-left"
                        >
                          {expandedId === listing.id ? (
                            <ChevronUp size={16} className="mt-0.5 shrink-0 text-text-secondary" />
                          ) : (
                            <ChevronDown size={16} className="mt-0.5 shrink-0 text-text-secondary" />
                          )}
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-medium text-text-primary">{listing.title}</p>
                              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${LISTING_TYPE_COLORS[listing.listing_type]}`}>
                                {LISTING_TYPE_LABELS[listing.listing_type]}
                              </span>
                              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${LISTING_STATUS_COLORS[listing.status]}`}>
                                {LISTING_STATUS_LABELS[listing.status]}
                              </span>
                              {isMine && <span className="text-xs text-text-secondary">· yours</span>}
                            </div>
                            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-text-secondary">
                              <span>{TRADE_CATEGORY_LABELS[listing.trade_category]}</span>
                              <span className="flex items-center gap-1">
                                <MapPin size={12} /> {formatLocation(listing.location_city, listing.location_region)}
                              </span>
                              <span className="flex items-center gap-1">
                                <Calendar size={12} /> {formatDateRange(listing.start_date, listing.end_date)}
                              </span>
                              <span>{formatCents(listing.hourly_rate_cents)}</span>
                              <span>{listing.business_name}</span>
                            </p>
                          </div>
                        </button>
                        <div className="flex items-center gap-1">
                          {isMine ? (
                            <>
                              <button
                                type="button"
                                onClick={() => setEditingId(listing.id)}
                                className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                                aria-label="Edit listing"
                              >
                                <Pencil size={14} />
                              </button>
                              <button
                                type="button"
                                onClick={() => setDeletingId(listing.id)}
                                className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-danger/10 hover:text-danger"
                                aria-label="Delete listing"
                              >
                                <Trash2 size={14} />
                              </button>
                            </>
                          ) : (
                            isOpenListing(listing.status) &&
                            respondingTo !== listing.id && (
                              <button
                                type="button"
                                onClick={() => setRespondingTo(listing.id)}
                                className="focus-ring flex items-center gap-1 rounded-lg bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/20"
                              >
                                <Send size={12} /> Respond
                              </button>
                            )
                          )}
                        </div>
                      </div>

                      {respondingTo === listing.id && (
                        <MatchForm
                          initial={{
                            business_name: profile?.company_name ?? '',
                            contact_name: '',
                            contact_phone: profile?.phone ?? '',
                            contact_email: profile?.email ?? '',
                            agreed_technicians_count: String(listing.technicians_count ?? 1),
                            agreed_rate: listing.hourly_rate_cents != null ? String(listing.hourly_rate_cents / 100) : '',
                            message: '',
                          }}
                          onCancel={() => setRespondingTo(null)}
                          onSave={(form) => handleRespond(listing.id, form)}
                        />
                      )}

                      {expandedId === listing.id && (
                        <div className="mt-4 border-t border-border/60 pt-4">
                          {listing.description && <p className="mb-3 text-sm text-text-secondary">{listing.description}</p>}
                          <p className="mb-3 text-xs text-text-secondary">
                            Contact: {listing.contact_name || listing.business_name}
                            {listing.contact_phone ? ` · ${listing.contact_phone}` : ''}
                            {listing.contact_email ? ` · ${listing.contact_email}` : ''}
                          </p>

                          {isMine && (
                            <>
                              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Responses</p>
                              <div className="space-y-2">
                                {(matchesByListing[listing.id] || []).length === 0 ? (
                                  <p className="text-xs text-text-secondary">No responses yet.</p>
                                ) : (
                                  matchesByListing[listing.id].map((m) => (
                                    <div key={m.id} className="rounded-xl bg-bg-primary p-3 text-xs">
                                      <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div>
                                          <span className="font-medium text-text-primary">{m.business_name}</span>
                                          <span className={`ml-2 rounded-full px-2 py-0.5 font-medium ${MATCH_STATUS_COLORS[m.status]}`}>
                                            {MATCH_STATUS_LABELS[m.status]}
                                          </span>
                                        </div>
                                        <span className="text-text-secondary">
                                          {m.agreed_technicians_count ?? '?'} tech(s) · {formatCents(m.agreed_rate_cents)}
                                        </span>
                                      </div>
                                      {m.message && <p className="mt-1 text-text-secondary">{m.message}</p>}
                                      <p className="mt-1 text-text-secondary">
                                        {m.contact_name || m.business_name}
                                        {m.contact_phone ? ` · ${m.contact_phone}` : ''}
                                        {m.contact_email ? ` · ${m.contact_email}` : ''}
                                      </p>
                                      {isPendingMatch(m.status) && (
                                        <div className="mt-2 flex gap-2">
                                          <button
                                            type="button"
                                            onClick={() => handleMatchStatus(listing.id, m.id, 'accepted')}
                                            className="focus-ring flex items-center gap-1 rounded-lg bg-success-500/10 px-2 py-1 font-medium text-success-500 hover:bg-success-500/20"
                                          >
                                            <ThumbsUp size={12} /> Accept
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => handleMatchStatus(listing.id, m.id, 'declined')}
                                            className="focus-ring flex items-center gap-1 rounded-lg bg-danger/10 px-2 py-1 font-medium text-danger hover:bg-danger/20"
                                          >
                                            <ThumbsDown size={12} /> Decline
                                          </button>
                                        </div>
                                      )}
                                    </div>
                                  ))
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </motion.div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(deletingId)}
        title="Delete this listing?"
        description="This removes the listing and every response to it permanently."
        confirmLabel="Yes, delete this listing"
        onConfirm={handleDelete}
        onCancel={() => setDeletingId(null)}
      />
    </DashboardLayout>
  );
}
