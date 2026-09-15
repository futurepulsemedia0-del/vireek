import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { FileText, Phone, RefreshCw, Check, X, CreditCard, Pencil, Plus, Trash2, Send, Copy, Eye, Images } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, Lead, BusinessProfile, Quote } from '@/lib/supabase';
import {
  QuoteLineItem,
  calculateQuoteTotals,
  formatCents,
  getQuoteLink,
  QUOTE_STATUS_LABELS,
  QUOTE_STATUS_COLORS,
} from '@/lib/quotes';
import {
  TieredEstimateBuilder,
  emptyTieredDraft,
  quoteToTieredDraft,
  draftToQuotePayload,
} from '@/components/quotes/TieredEstimateBuilder';
import type { TieredEstimateDraft } from '@/components/quotes/TieredEstimateBuilder';
import { describeEngagement, isTieredQuote } from '@/lib/estimates';

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

// ============================================================
// ITEMIZED QUOTE BUILDER — build a real line-item estimate, send a link,
// let the customer accept/decline it themselves (writes to the `quotes`
// table; see src/lib/quotes.ts)
// ============================================================

const EMPTY_LINE_ITEM: QuoteLineItem = { description: '', quantity: 1, unit_price_cents: 0 };

interface QuoteFormState {
  lead_id: string | null;
  customer_name: string;
  customer_phone: string;
  customer_email: string;
  tax_percent: string;
  valid_until: string;
  line_items: QuoteLineItem[];
}

const EMPTY_FORM: QuoteFormState = {
  lead_id: null,
  customer_name: '',
  customer_phone: '',
  customer_email: '',
  tax_percent: '0',
  valid_until: '',
  line_items: [{ ...EMPTY_LINE_ITEM }],
};

function QuoteBuilderForm({
  initial,
  leadOptions,
  onCancel,
  onSave,
}: {
  initial: QuoteFormState;
  leadOptions: Lead[];
  onCancel: () => void;
  onSave: (form: QuoteFormState) => Promise<void>;
}) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const totals = calculateQuoteTotals(form.line_items, Number(form.tax_percent) || 0);

  const updateLineItem = (index: number, patch: Partial<QuoteLineItem>) => {
    setForm((f) => ({ ...f, line_items: f.line_items.map((li, i) => (i === index ? { ...li, ...patch } : li)) }));
  };
  const addLineItem = () => setForm((f) => ({ ...f, line_items: [...f.line_items, { ...EMPTY_LINE_ITEM }] }));
  const removeLineItem = (index: number) =>
    setForm((f) => ({ ...f, line_items: f.line_items.filter((_, i) => i !== index) }));

  const handleLeadPick = (leadId: string) => {
    const lead = leadOptions.find((l) => l.id === leadId);
    setForm((f) => ({
      ...f,
      lead_id: leadId || null,
      customer_name: lead ? lead.name : f.customer_name,
      customer_phone: lead?.phone ?? f.customer_phone,
    }));
  };

  const handleSave = async () => {
    if (!form.customer_name.trim() || form.line_items.length === 0) return;
    setSaving(true);
    await onSave(form);
    setSaving(false);
  };

  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      {leadOptions.length > 0 && (
        <div className="mb-3">
          <label className="mb-1 block text-xs text-text-secondary">Link to an existing lead (optional)</label>
          <select value={form.lead_id ?? ''} onChange={(e) => handleLeadPick(e.target.value)} className={inputClass}>
            <option value="">Not linked to a lead</option>
            {leadOptions.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} {l.service_interested ? `— ${l.service_interested}` : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <input
          type="text"
          value={form.customer_name}
          onChange={(e) => setForm((f) => ({ ...f, customer_name: e.target.value }))}
          placeholder="Customer name"
          className={inputClass}
        />
        <input
          type="tel"
          value={form.customer_phone}
          onChange={(e) => setForm((f) => ({ ...f, customer_phone: e.target.value }))}
          placeholder="Phone"
          className={inputClass}
        />
        <input
          type="email"
          value={form.customer_email}
          onChange={(e) => setForm((f) => ({ ...f, customer_email: e.target.value }))}
          placeholder="Email"
          className={inputClass}
        />
      </div>

      <div className="mt-4 space-y-2">
        <p className="text-xs font-medium text-text-secondary">Line items</p>
        {form.line_items.map((li, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              type="text"
              value={li.description}
              onChange={(e) => updateLineItem(i, { description: e.target.value })}
              placeholder="Description"
              className={`${inputClass} flex-1`}
            />
            <input
              type="number"
              min={1}
              value={li.quantity}
              onChange={(e) => updateLineItem(i, { quantity: Number(e.target.value) })}
              className={`${inputClass} w-16 text-center`}
            />
            <input
              type="number"
              min={0}
              step="0.01"
              value={li.unit_price_cents / 100}
              onChange={(e) => updateLineItem(i, { unit_price_cents: Math.round(Number(e.target.value) * 100) })}
              placeholder="$0.00"
              className={`${inputClass} w-24`}
            />
            <button
              type="button"
              onClick={() => removeLineItem(i)}
              disabled={form.line_items.length === 1}
              className="focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-30"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addLineItem}
          className="focus-ring flex items-center gap-1 text-xs font-medium text-accent hover:underline"
        >
          <Plus size={12} /> Add line item
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Tax %</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={form.tax_percent}
            onChange={(e) => setForm((f) => ({ ...f, tax_percent: e.target.value }))}
            className={inputClass}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Valid until</label>
          <input
            type="date"
            value={form.valid_until}
            onChange={(e) => setForm((f) => ({ ...f, valid_until: e.target.value }))}
            className={inputClass}
          />
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-border/60 pt-3">
        <p className="text-sm font-semibold text-text-primary">Total: {formatCents(totals.totalCents)}</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="focus-ring rounded-xl px-3 py-2 text-sm text-text-secondary hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !form.customer_name.trim()}
            className="focus-ring rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
          >
            Save quote
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function QuotesPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [leads, setLeads] = useState<Lead[]>([]);
  const [allLeads, setAllLeads] = useState<Lead[]>([]); // for the "link to a lead" picker on the builder
  const [financing, setFinancing] = useState<{ name: string | null; note: string | null }>({ name: null, note: null });
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterKey>('open');

  const [itemizedQuotes, setItemizedQuotes] = useState<Quote[]>([]);
  const [quotesLoading, setQuotesLoading] = useState(true);
  const [creatingQuote, setCreatingQuote] = useState(false);
  const [editingQuoteId, setEditingQuoteId] = useState<string | null>(null);
  // Visual + tiered estimates: null = builder closed. Holds the draft being
  // edited, and `tieredQuoteId` the row it maps to (null for a new one).
  const [tieredDraft, setTieredDraft] = useState<TieredEstimateDraft | null>(null);
  const [tieredQuoteId, setTieredQuoteId] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [leadsRes, profileRes, pickerLeadsRes] = await Promise.all([
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
      supabase.from('leads').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(100),
    ]);

    if (leadsRes.error) {
      toast('Failed to load quotes', 'error');
    } else {
      setLeads((leadsRes.data as Lead[]) || []);
    }
    const bp = profileRes.data as Pick<BusinessProfile, 'financing_partner_name' | 'financing_note'> | null;
    setFinancing({ name: bp?.financing_partner_name ?? null, note: bp?.financing_note ?? null });
    setAllLeads((pickerLeadsRes.data as Lead[]) || []);
    setLoading(false);
  }, [user, toast]);

  const fetchItemizedQuotes = useCallback(async () => {
    setQuotesLoading(true);
    const { data, error } = await supabase.from('quotes').select('*').order('created_at', { ascending: false });
    if (error) {
      toast('Failed to load itemized quotes', 'error');
    } else {
      setItemizedQuotes((data as Quote[]) || []);
    }
    setQuotesLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchAll();
    fetchItemizedQuotes();
  }, [fetchAll, fetchItemizedQuotes]);

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
      .update({
        quote_amount: amount,
        quote_sent_at: leads.find((l) => l.id === leadId)?.quote_sent_at ?? new Date().toISOString(),
      })
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

  const handleSaveItemizedQuote = async (form: QuoteFormState, quoteId?: string) => {
    if (!user) return;
    const totals = calculateQuoteTotals(form.line_items, Number(form.tax_percent) || 0);
    const payload = {
      user_id: user.id,
      lead_id: form.lead_id,
      customer_name: form.customer_name.trim(),
      customer_phone: form.customer_phone.trim() || null,
      customer_email: form.customer_email.trim() || null,
      line_items: form.line_items.filter((li) => li.description.trim()),
      tax_percent: Number(form.tax_percent) || 0,
      valid_until: form.valid_until || null,
    };

    const query = quoteId
      ? supabase.from('quotes').update(payload).eq('id', quoteId)
      : supabase.from('quotes').insert(payload);

    const { error } = await query;
    if (error) {
      toast('Could not save the quote', 'error');
      return;
    }

    // Keep the follow-up tracker below in sync: an itemized quote linked to
    // a lead marks that lead "quoted" with this total.
    if (form.lead_id) {
      await supabase
        .from('leads')
        .update({
          stage: 'quoted',
          quote_amount: Math.round(totals.totalCents / 100),
          quote_sent_at: new Date().toISOString(),
        })
        .eq('id', form.lead_id);
    }

    toast('Quote saved', 'success');
    setCreatingQuote(false);
    setEditingQuoteId(null);
    fetchItemizedQuotes();
    fetchAll();
  };
  
    const handleSaveTieredEstimate = async (draft: TieredEstimateDraft) => {
    if (!user) return;
    const payload = draftToQuotePayload(draft, user.id);

    const { error } = tieredQuoteId
      ? await supabase.from('quotes').update(payload).eq('id', tieredQuoteId)
      : await supabase.from('quotes').insert(payload);

    if (error) {
      toast('Could not save the estimate', 'error');
      return;
    }

    // Mirror into the follow-up tracker, same as the flat builder does.
    if (draft.lead_id) {
      const recommended = payload.options.find((o) => o.recommended) ?? payload.options[0];
      const totalCents = recommended
        ? calculateQuoteTotals(recommended.line_items, payload.tax_percent).totalCents
        : 0;
      await supabase
        .from('leads')
        .update({
          stage: 'quoted',
          quote_amount: Math.round(totalCents / 100),
          quote_sent_at: new Date().toISOString(),
        })
        .eq('id', draft.lead_id);
    }

    toast('Estimate saved', 'success');
    setTieredDraft(null);
    setTieredQuoteId(null);
    fetchItemizedQuotes();
    fetchAll();
  };
  const handleSendItemizedQuote = async (quote: Quote) => {
    const { error } = await supabase
      .from('quotes')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', quote.id);
    if (error) {
      toast('Could not send the quote', 'error');
      return;
    }
    await navigator.clipboard.writeText(getQuoteLink(quote.quote_token));
    setItemizedQuotes((prev) => prev.map((q) => (q.id === quote.id ? { ...q, status: 'sent' as const } : q)));
    toast('Quote marked sent — link copied to send to the customer', 'success');
  };

  const handleCopyQuoteLink = async (quote: Quote) => {
    await navigator.clipboard.writeText(getQuoteLink(quote.quote_token));
    toast('Quote link copied', 'success');
  };

  return (
    <DashboardLayout activeLabel="Quotes">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-text-primary">Quotes &amp; Estimates</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Build and send an itemized quote below, or track follow-ups on any lead you&rsquo;ve already quoted.
          </p>
        </div>

        {/* ================= Itemized quote builder ================= */}
        <div className="mb-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-primary">Itemized quotes</h2>
            {!creatingQuote && !tieredDraft && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setCreatingQuote(true)}
                  className="focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary"
                >
                  <Plus size={14} /> Simple quote
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTieredQuoteId(null);
                    setTieredDraft(emptyTieredDraft());
                  }}
                  className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-medium text-white transition-all hover:brightness-110"
                >
                  <Images size={14} /> New visual estimate
                </button>
              </div>
            )}
          </div>

                     {tieredDraft && user && (
            <div className="mb-3">
              <TieredEstimateBuilder
                userId={user.id}
                initial={tieredDraft}
                leadOptions={allLeads}
                onCancel={() => {
                  setTieredDraft(null);
                  setTieredQuoteId(null);
                }}
                onSave={handleSaveTieredEstimate}
              />
            </div>
          )}
          {creatingQuote && (
            <div className="mb-3">
              <QuoteBuilderForm
                initial={EMPTY_FORM}
                leadOptions={allLeads}
                onCancel={() => setCreatingQuote(false)}
                onSave={(form) => handleSaveItemizedQuote(form)}
              />
            </div>
          )}

          {quotesLoading ? (
            <div className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />
          ) : itemizedQuotes.length === 0 && !creatingQuote ? (
            <div className="rounded-2xl border border-dashed border-border py-8 text-center">
              <p className="text-sm text-text-secondary">
                No itemized quotes yet — build one above to send a real line-item estimate with a link the
                customer can accept or decline themselves.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {itemizedQuotes.map((quote) =>
                editingQuoteId === quote.id ? (
                  <QuoteBuilderForm
                    key={quote.id}
                    initial={{
                      lead_id: quote.lead_id,
                      customer_name: quote.customer_name,
                      customer_phone: quote.customer_phone ?? '',
                      customer_email: quote.customer_email ?? '',
                      tax_percent: String(quote.tax_percent),
                      valid_until: quote.valid_until ?? '',
                      line_items: quote.line_items.length > 0 ? quote.line_items : [{ ...EMPTY_LINE_ITEM }],
                    }}
                    leadOptions={allLeads}
                    onCancel={() => setEditingQuoteId(null)}
                    onSave={(form) => handleSaveItemizedQuote(form, quote.id)}
                  />
                ) : (
                  <motion.div
                    key={quote.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-2xl border border-border bg-bg-secondary p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-text-primary">{quote.customer_name}</p>
                        <p className="text-xs text-text-secondary">
                          {formatCents(calculateQuoteTotals(quote.line_items, quote.tax_percent).totalCents)} ·{' '}
                          {isTieredQuote(quote)
                            ? `${quote.options.length} options · ${quote.photos.length} photo${quote.photos.length === 1 ? '' : 's'}`
                            : `${quote.line_items.length} item${quote.line_items.length === 1 ? '' : 's'}`}
                        </p>
                        {describeEngagement(quote) && (
                          <p className="mt-0.5 flex items-center gap-1 text-xs text-text-secondary/80">
                            <Eye size={11} /> {describeEngagement(quote)}
                          </p>
                        )}
                      </div>
                      <span className={`rounded-full px-3 py-1 text-xs font-medium ${QUOTE_STATUS_COLORS[quote.status]}`}>
                        {QUOTE_STATUS_LABELS[quote.status]}
                      </span>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      {quote.status === 'draft' && (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              if (isTieredQuote(quote)) {
                                setTieredQuoteId(quote.id);
                                setTieredDraft(quoteToTieredDraft(quote));
                              } else {
                                setEditingQuoteId(quote.id);
                              }
                            }}
                            className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => handleSendItemizedQuote(quote)}
                            className="focus-ring flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:brightness-110"
                          >
                            <Send size={12} /> Send
                          </button>
                        </>
                      )}
                      {quote.status !== 'draft' && (
                        <button
                          type="button"
                          onClick={() => handleCopyQuoteLink(quote)}
                          className="focus-ring flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
                        >
                          <Copy size={12} /> Copy link
                        </button>
                      )}
                    </div>
                  </motion.div>
                )
              )}
            </div>
          )}
        </div>

        {/* ================= Follow-up tracker (leads at "quoted") ================= */}
        <h2 className="mb-3 text-sm font-semibold text-text-primary">Quote follow-ups</h2>

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
          Itemized quotes above create a real link the customer can accept or decline. This lower section
          tracks follow-ups on any lead you&rsquo;ve quoted &mdash; itemized or not &mdash; so nothing sits
          unconverted without someone noticing.
        </p>
      </div>
    </DashboardLayout>
  );
}
