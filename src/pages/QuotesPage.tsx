import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { FileText, Phone, RefreshCw, Check, X, CreditCard, Pencil } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, Lead, BusinessProfile } from '@/lib/supabase';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

type FilterKey = 'open' | 'won' | 'lost' | 'all';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'open', label: 'Open (needs follow-up)' },
  { key: 'won', label: 'Won' },
  { key: 'lost', label: 'Lost' },
  { key: 'all', label: 'All' },
];

function formatMoney(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return 'No amount set';
  return `$${amount.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function daysSince(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function QuoteAmountEditor({
  lead,
  onSave,
}: {
  lead: Lead;
  onSave: (leadId: string, amount: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(lead.quote_amount != null ? String(lead.quote_amount) : '');
  const [saving, setSaving] = useState(false);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="focus-ring flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-semibold text-text-primary hover:bg-bg-tertiary"
      >
        {formatMoney(lead.quote_amount)}
        <Pencil size={12} className="text-text-secondary" />
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        min={0}
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="0"
        className={`${inputClass} w-28 py-1.5`}
      />
      <button
        type="button"
        disabled={saving || !value.trim()}
        onClick={async () => {
          setSaving(true);
          await onSave(lead.id, Number(value));
          setSaving(false);
          setEditing(false);
        }}
        className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-success-500 hover:bg-success-500/10"
        aria-label="Save amount"
      >
        <Check size={14} />
      </button>
      <button
        type="button"
        onClick={() => setEditing(false)}
        className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary"
        aria-label="Cancel"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function QuotesPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [leads, setLeads] = useState<Lead[]>([]);
  const [financing, setFinancing] = useState<{ name: string | null; note: string | null }>({ name: null, note: null });
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterKey>('open');

  const fetchAll = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [leadsRes, profileRes] = await Promise.all([
      supabase
        .from('leads')
        .select('*')
        .eq('user_id', user.id)
        .in('stage', ['quoted', 'won', 'lost'])
        .order('created_at', { ascending: false })
        .limit(100),
      supabase
        .from('business_profile')
        .select('financing_partner_name, financing_note')
        .eq('user_id', user.id)
        .maybeSingle(),
    ]);

    if (leadsRes.error) {
      toast('Failed to load quotes', 'error');
    } else {
      setLeads((leadsRes.data as Lead[]) || []);
    }
    const bp = profileRes.data as Pick<BusinessProfile, 'financing_partner_name' | 'financing_note'> | null;
    setFinancing({ name: bp?.financing_partner_name ?? null, note: bp?.financing_note ?? null });
    setLoading(false);
  }, [user, toast]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const filtered = useMemo(() => {
    if (filter === 'all') return leads;
    if (filter === 'open') return leads.filter((l) => l.stage === 'quoted');
    return leads.filter((l) => l.stage === filter);
  }, [leads, filter]);

  const stats = useMemo(() => {
    const open = leads.filter((l) => l.stage === 'quoted');
    const openValue = open.reduce((sum, l) => sum + (l.quote_amount ?? 0), 0);
    const needsFollowUp = open.filter((l) => {
      const days = daysSince(l.last_follow_up_at ?? l.quote_sent_at ?? l.created_at);
      return days === null || days >= 3;
    });
    return { openCount: open.length, openValue, needsFollowUpCount: needsFollowUp.length };
  }, [leads]);

  const handleSaveAmount = async (leadId: string, amount: number) => {
    const { error } = await supabase
      .from('leads')
      .update({ quote_amount: amount, quote_sent_at: leads.find((l) => l.id === leadId)?.quote_sent_at ?? new Date().toISOString() })
      .eq('id', leadId);
    if (error) {
      toast('Could not save quote amount', 'error');
      return;
    }
    fetchAll();
  };

  const handleLogFollowUp = async (lead: Lead) => {
    const { error } = await supabase
      .from('leads')
      .update({ follow_up_count: (lead.follow_up_count ?? 0) + 1, last_follow_up_at: new Date().toISOString() })
      .eq('id', lead.id);
    if (error) {
      toast('Could not log follow-up', 'error');
      return;
    }
    toast('Follow-up logged', 'success');
    fetchAll();
  };

  const handleSetOutcome = async (lead: Lead, outcome: 'won' | 'lost') => {
    const { error } = await supabase.from('leads').update({ stage: outcome }).eq('id', lead.id);
    if (error) {
      toast('Could not update this quote', 'error');
      return;
    }
    toast(outcome === 'won' ? 'Marked as won' : 'Marked as lost', 'success');
    fetchAll();
  };

  return (
    <DashboardLayout activeLabel="Quotes">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-text-primary">Quotes &amp; Estimates</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Every lead that reached the &ldquo;Quoted&rdquo; stage lives here until it&rsquo;s won or lost &mdash;
            so nothing sits unconverted without someone noticing.
          </p>
        </div>

        {!financing.name && !financing.note && (
          <div className="mb-6 flex items-start gap-3 rounded-2xl border border-dashed border-border bg-bg-secondary/60 p-4">
            <CreditCard className="mt-0.5 h-5 w-5 shrink-0 text-text-secondary" />
            <p className="text-xs leading-relaxed text-text-secondary">
              No financing option configured. If you offer financing (Wisetack or similar) on larger jobs,
              add it in{' '}
              <a href="/dashboard/business-profile" className="font-semibold text-accent hover:underline">
                Business Profile
              </a>{' '}
              so it shows up here as a reminder when you follow up on a quote.
            </p>
          </div>
        )}
        {(financing.name || financing.note) && (
          <div className="mb-6 flex items-start gap-3 rounded-2xl border border-accent/25 bg-accent/5 p-4">
            <CreditCard className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
            <div className="text-xs leading-relaxed text-text-secondary">
              <span className="font-semibold text-text-primary">
                Financing available{financing.name ? ` via ${financing.name}` : ''}.
              </span>{' '}
              {financing.note || 'Worth mentioning on any follow-up for a quote a customer is hesitating on.'}
            </div>
          </div>
        )}

        <div className="mb-6 grid grid-cols-3 gap-3">
          <div className="rounded-2xl border border-border bg-bg-secondary p-4">
            <p className="text-2xl font-bold text-text-primary">{stats.openCount}</p>
            <p className="text-xs text-text-secondary">Open quotes</p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-secondary p-4">
            <p className="text-2xl font-bold text-text-primary">{formatMoney(stats.openValue)}</p>
            <p className="text-xs text-text-secondary">Open quote value</p>
          </div>
          <div className="rounded-2xl border border-warning-500/30 bg-warning-500/5 p-4">
            <p className="text-2xl font-bold text-warning-500">{stats.needsFollowUpCount}</p>
            <p className="text-xs text-text-secondary">Need a follow-up</p>
          </div>
        </div>

        <div className="mb-4 flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                filter === f.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-10 text-center">
            <FileText className="mx-auto mb-2 h-6 w-6 text-text-secondary/50" />
            <p className="text-sm text-text-secondary">
              {filter === 'open'
                ? 'No open quotes right now — quoted leads will show up here.'
                : 'Nothing here yet.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((lead) => {
              const days = daysSince(lead.last_follow_up_at ?? lead.quote_sent_at ?? lead.created_at);
              const stale = lead.stage === 'quoted' && (days === null || days >= 3);
              return (
                <motion.div
                  key={lead.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`rounded-2xl border p-4 ${
                    stale ? 'border-warning-500/30 bg-warning-500/[0.04]' : 'border-border bg-bg-secondary'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-text-primary">{lead.name}</p>
                      <p className="text-xs text-text-secondary">
                        {lead.service_interested || 'Service not specified'}
                        {lead.phone ? ` · ${lead.phone}` : ''}
                      </p>
                    </div>
                    <QuoteAmountEditor lead={lead} onSave={handleSaveAmount} />
                  </div>

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
                    <p className="text-xs text-text-secondary">
                      {lead.follow_up_count > 0
                        ? `Followed up ${lead.follow_up_count}\u00d7 \u2014 last ${days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days ?? '?'} days ago`}`
                        : days === null
                          ? 'No follow-up logged yet'
                          : `No follow-up yet \u2014 quoted ${days} day${days === 1 ? '' : 's'} ago`}
                    </p>
                    {lead.stage === 'quoted' && (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleLogFollowUp(lead)}
                          className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
                        >
                          <Phone size={12} /> Log follow-up
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSetOutcome(lead, 'won')}
                          className="focus-ring rounded-lg px-2.5 py-1.5 text-xs font-medium text-success-500 hover:bg-success-500/10"
                        >
                          Won
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSetOutcome(lead, 'lost')}
                          className="focus-ring rounded-lg px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-danger/10 hover:text-danger"
                        >
                          Lost
                        </button>
                      </div>
                    )}
                    {lead.stage !== 'quoted' && (
                      <span
                        className={`rounded-full px-3 py-1 text-xs font-medium ${
                          lead.stage === 'won' ? 'bg-success-500/10 text-success-500' : 'bg-danger/10 text-danger'
                        }`}
                      >
                        {lead.stage === 'won' ? 'Won' : 'Lost'}
                      </span>
                    )}
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}

        <p className="mt-6 flex items-center gap-1.5 text-xs text-text-secondary/70">
          <RefreshCw size={12} />
          This tracks follow-ups on quotes &mdash; it isn&rsquo;t a full estimating or invoicing system. For
          line-item estimates and invoicing, keep using whatever field-service tool you already run.
        </p>
      </div>
    </DashboardLayout>
  );
}
