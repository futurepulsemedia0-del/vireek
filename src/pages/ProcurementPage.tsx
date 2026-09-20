/**
 * Vendor & Procurement OS — /dashboard/procurement
 *
 * Connects a part need straight through to a paid, evaluated purchase:
 *   Requests (a part need) -> RFQ (ask vendors) -> Compare quotes -> Award
 *   -> Purchase Order (approve) -> Receiving (updates inventory automatically)
 *   -> Vendor scorecard (rate the vendor).
 *
 * All data access lives in src/lib/procurement.ts; this file is purely
 * the worklist UI, same shape as every other ledger-style page here.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Award,
  Check,
  ClipboardList,
  FileText,
  Loader2,
  Package,
  Plus,
  Send,
  ShieldCheck,
  Star,
  Truck,
  X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  approvePurchaseOrder,
  awardRfqAndCreatePO,
  createPurchaseRequest,
  createRfq,
  createVendor,
  fetchProcurementPipeline,
  fetchPurchaseOrderItems,
  fetchPurchaseOrders,
  fetchRfqComparison,
  fetchRfqItems,
  fetchRfqs,
  fetchVendorQuotes,
  fetchVendorScorecard,
  fetchVendors,
  formatCents,
  markPurchaseOrderSent,
  PO_STATUS_COLORS,
  PO_STATUS_LABELS,
  receivePurchaseOrder,
  REQUEST_STATUS_LABELS,
  RFQ_STATUS_LABELS,
  submitVendorEvaluation,
  submitVendorQuote,
} from '@/lib/procurement';
import type {
  ProcurementPipelineRow,
  PurchaseOrder,
  PurchaseOrderItem,
  Rfq,
  RfqItem,
  RfqQuoteComparisonRow,
  Vendor,
  VendorQuote,
  VendorScorecardRow,
} from '@/lib/procurement';

type TabKey = 'pipeline' | 'rfqs' | 'orders' | 'vendors';

const TABS: { key: TabKey; label: string; icon: typeof ClipboardList }[] = [
  { key: 'pipeline', label: 'Requests', icon: ClipboardList },
  { key: 'rfqs', label: 'RFQs & Quotes', icon: FileText },
  { key: 'orders', label: 'Purchase Orders', icon: Truck },
  { key: 'vendors', label: 'Vendors', icon: ShieldCheck },
];

function ModalShell({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        className={`max-h-[85vh] w-full overflow-y-auto rounded-2xl border border-border bg-bg-primary p-5 shadow-xl ${wide ? 'max-w-3xl' : 'max-w-md'}`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-text-primary">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </motion.div>
    </div>
  );
}

function fieldClass() {
  return 'w-full rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary focus-ring';
}

function primaryBtn() {
  return 'focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-40';
}

function secondaryBtn() {
  return 'focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-40';
}

// ============================================================
// NEW REQUEST MODAL
// ============================================================

function NewRequestModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { toast } = useToast();
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [neededBy, setNeededBy] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!description.trim()) return;
    setSaving(true);
    try {
      await createPurchaseRequest({
        description: description.trim(),
        quantity_requested: Math.max(1, Number(quantity) || 1),
        reason: 'manual',
        needed_by: neededBy || null,
        notes: notes || null,
      });
      toast('Request created', 'success');
      onCreated();
      onClose();
    } catch {
      toast('Could not create the request', 'error');
    }
    setSaving(false);
  };

  return (
    <ModalShell title="New purchase request" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-text-secondary">
            What's needed
          </label>
          <input
            className={fieldClass()}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. 2-ton condenser coil"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">Quantity</label>
            <input
              type="number"
              min={1}
              className={fieldClass()}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">Needed by</label>
            <input
              type="date"
              className={fieldClass()}
              value={neededBy}
              onChange={(e) => setNeededBy(e.target.value)}
            />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-text-secondary">Notes</label>
          <textarea
            className={fieldClass()}
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className={secondaryBtn()} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={primaryBtn()}
            disabled={saving || !description.trim()}
            onClick={() => void submit()}
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Create
            request
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ============================================================
// NEW VENDOR MODAL
// ============================================================

function NewVendorModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [category, setCategory] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await createVendor({
        name: name.trim(),
        email: email || null,
        phone: phone || null,
        category: category || null,
      });
      toast('Vendor added', 'success');
      onCreated();
      onClose();
    } catch {
      toast('Could not add this vendor', 'error');
    }
    setSaving(false);
  };

  return (
    <ModalShell title="New vendor" onClose={onClose}>
      <div className="space-y-3">
        <input
          className={fieldClass()}
          placeholder="Vendor name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className={fieldClass()}
          placeholder="Category (e.g. HVAC parts)"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <div className="grid grid-cols-2 gap-3">
          <input
            className={fieldClass()}
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            className={fieldClass()}
            placeholder="Phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className={secondaryBtn()} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={primaryBtn()}
            disabled={saving || !name.trim()}
            onClick={() => void submit()}
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Add
            vendor
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ============================================================
// NEW RFQ MODAL
// ============================================================

function NewRfqModal({
  vendors,
  pipeline,
  onClose,
  onCreated,
}: {
  vendors: Vendor[];
  pipeline: ProcurementPipelineRow[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { toast } = useToast();
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [itemDescription, setItemDescription] = useState('');
  const [itemQuantity, setItemQuantity] = useState('1');
  const [linkedRequestId, setLinkedRequestId] = useState('');
  const [selectedVendors, setSelectedVendors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const openRequests = pipeline.filter((p) => p.request_status === 'draft');

  const toggleVendor = (id: string) =>
    setSelectedVendors((prev) =>
      prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id],
    );

  const submit = async () => {
    if (!title.trim() || !itemDescription.trim() || selectedVendors.length === 0) return;
    setSaving(true);
    try {
      await createRfq(
        title.trim(),
        dueDate || null,
        [
          {
            description: itemDescription.trim(),
            quantity: Number(itemQuantity) || 1,
            purchase_request_id: linkedRequestId || null,
          },
        ],
        selectedVendors,
      );
      toast('RFQ sent to vendors', 'success');
      onCreated();
      onClose();
    } catch {
      toast('Could not create the RFQ', 'error');
    }
    setSaving(false);
  };

  return (
    <ModalShell title="New RFQ" onClose={onClose} wide>
      <div className="space-y-3">
        <input
          className={fieldClass()}
          placeholder="RFQ title (e.g. Condenser coils — October)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="grid grid-cols-2 gap-3">
          <input
            type="date"
            className={fieldClass()}
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            placeholder="Quotes due by"
          />
          <select
            className={fieldClass()}
            value={linkedRequestId}
            onChange={(e) => setLinkedRequestId(e.target.value)}
          >
            <option value="">Not linked to a request</option>
            {openRequests.map((r) => (
              <option key={r.purchase_request_id} value={r.purchase_request_id}>
                {r.part_name ?? r.description} × {r.quantity_requested}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <input
            className={`col-span-2 ${fieldClass()}`}
            placeholder="Item description"
            value={itemDescription}
            onChange={(e) => setItemDescription(e.target.value)}
          />
          <input
            type="number"
            min={1}
            className={fieldClass()}
            value={itemQuantity}
            onChange={(e) => setItemQuantity(e.target.value)}
          />
        </div>
        <div>
          <p className="mb-1.5 text-xs font-medium text-text-secondary">Invite vendors to bid</p>
          <div className="flex flex-wrap gap-2">
            {vendors.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => toggleVendor(v.id)}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
                  selectedVendors.includes(v.id)
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border text-text-secondary'
                }`}
              >
                {v.name}
              </button>
            ))}
            {vendors.length === 0 && (
              <p className="text-xs text-text-secondary">Add a vendor first.</p>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className={secondaryBtn()} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={primaryBtn()}
            disabled={
              saving || !title.trim() || !itemDescription.trim() || selectedVendors.length === 0
            }
            onClick={() => void submit()}
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Send RFQ
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ============================================================
// RFQ DETAIL — invited vendors, quote entry, comparison, award
// ============================================================

function RfqDetailModal({
  rfq,
  onClose,
  onChanged,
}: {
  rfq: Rfq;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [items, setItems] = useState<RfqItem[]>([]);
  const [quotes, setQuotes] = useState<(VendorQuote & { vendor: Vendor })[]>([]);
  const [comparison, setComparison] = useState<RfqQuoteComparisonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [quoteDraft, setQuoteDraft] = useState<Record<string, string>>({});
  const [editingQuoteId, setEditingQuoteId] = useState<string | null>(null);
  const [awarding, setAwarding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [i, q, c] = await Promise.all([
      fetchRfqItems(rfq.id),
      fetchVendorQuotes(rfq.id),
      fetchRfqComparison(rfq.id),
    ]);
    setItems(i);
    setQuotes(q);
    setComparison(c);
    setLoading(false);
  }, [rfq.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitQuote = async (quoteId: string) => {
    const lineItems = items
      .map((item) => ({
        rfq_item_id: item.id,
        unit_price_cents: Math.round(Number(quoteDraft[item.id] || 0) * 100),
      }))
      .filter((li) => li.unit_price_cents > 0);
    if (lineItems.length === 0) return;
    try {
      await submitVendorQuote(
        quoteId,
        { lead_time_days: null, shipping_cents: 0, valid_until: null, notes: null },
        lineItems,
      );
      toast('Quote recorded', 'success');
      setEditingQuoteId(null);
      await load();
      onChanged();
    } catch {
      toast('Could not save this quote', 'error');
    }
  };

  const award = async (quoteId: string) => {
    setAwarding(true);
    try {
      await awardRfqAndCreatePO(rfq.id, quoteId);
      toast('Awarded — purchase order created', 'success');
      onChanged();
      onClose();
    } catch {
      toast('Could not award this RFQ', 'error');
    }
    setAwarding(false);
  };

  const cheapestByItem = useMemo(() => {
    const map = new Map<string, number>();
    comparison.forEach((row) => {
      if (row.price_rank === 1) map.set(row.rfq_item_id, row.vendor_quote_id);
    });
    return map;
  }, [comparison]);

  return (
    <ModalShell title={`${rfq.rfq_number} — ${rfq.title}`} onClose={onClose} wide>
      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="animate-spin text-text-secondary" size={20} />
        </div>
      ) : (
        <div className="space-y-5">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
              Items requested
            </p>
            <ul className="space-y-1 text-sm text-text-primary">
              {items.map((item) => (
                <li key={item.id} className="rounded-lg border border-border px-3 py-2">
                  {item.description} <span className="text-text-secondary">× {item.quantity}</span>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
              Vendor quotes
            </p>
            <div className="space-y-2">
              {quotes.map((q) => {
                const submitted = q.status !== 'draft';
                const isCheapestOnAnyItem = comparison.some(
                  (r) => r.vendor_quote_id === q.id && r.price_rank === 1,
                );
                return (
                  <div
                    key={q.id}
                    className={`rounded-xl border p-3 ${q.status === 'selected' ? 'border-emerald-400/50 bg-emerald-500/[0.06]' : 'border-border'}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-text-primary">
                          {q.vendor.name}
                        </span>
                        {isCheapestOnAnyItem && (
                          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-500">
                            Best price
                          </span>
                        )}
                        {q.status === 'selected' && (
                          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-600">
                            Awarded
                          </span>
                        )}
                      </div>
                      {!submitted && editingQuoteId !== q.id && (
                        <button
                          type="button"
                          className={secondaryBtn()}
                          onClick={() => setEditingQuoteId(q.id)}
                        >
                          Enter their quote
                        </button>
                      )}
                      {submitted && rfq.status !== 'awarded' && (
                        <button
                          type="button"
                          className={primaryBtn()}
                          disabled={awarding}
                          onClick={() => void award(q.id)}
                        >
                          <Award size={13} /> Award to this vendor
                        </button>
                      )}
                    </div>

                    {editingQuoteId === q.id && (
                      <div className="mt-2 space-y-2 border-t border-border pt-2">
                        {items.map((item) => (
                          <div key={item.id} className="flex items-center gap-2">
                            <span className="flex-1 text-xs text-text-secondary">
                              {item.description}
                            </span>
                            <input
                              type="number"
                              step="0.01"
                              placeholder="Unit price $"
                              className={`w-32 ${fieldClass()}`}
                              value={quoteDraft[item.id] ?? ''}
                              onChange={(e) =>
                                setQuoteDraft((prev) => ({ ...prev, [item.id]: e.target.value }))
                              }
                            />
                          </div>
                        ))}
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            className={secondaryBtn()}
                            onClick={() => setEditingQuoteId(null)}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className={primaryBtn()}
                            onClick={() => void submitQuote(q.id)}
                          >
                            <Check size={13} /> Save quote
                          </button>
                        </div>
                      </div>
                    )}

                    {submitted && editingQuoteId !== q.id && (
                      <div className="mt-2 grid grid-cols-2 gap-1 text-xs text-text-secondary sm:grid-cols-3">
                        {comparison
                          .filter((r) => r.vendor_quote_id === q.id)
                          .map((r) => (
                            <span key={r.rfq_item_id}>
                              {r.item_description}:{' '}
                              <span className="font-semibold text-text-primary">
                                {formatCents(r.unit_price_cents)}
                              </span>
                              {cheapestByItem.get(r.rfq_item_id) === q.id && (
                                <span className="text-emerald-500"> ✓ lowest</span>
                              )}
                            </span>
                          ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

// ============================================================
// RECEIVE PO MODAL
// ============================================================

function ReceivePOModal({
  po,
  onClose,
  onReceived,
}: {
  po: PurchaseOrder & { vendor: Vendor };
  onClose: () => void;
  onReceived: () => void;
}) {
  const { teamMember } = useAuth();
  const { toast } = useToast();
  const [items, setItems] = useState<PurchaseOrderItem[]>([]);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      const rows = await fetchPurchaseOrderItems(po.id);
      setItems(rows);
      const remaining: Record<string, string> = {};
      rows.forEach((r) => {
        remaining[r.id] = String(Math.max(0, r.quantity_ordered - r.quantity_received));
      });
      setQuantities(remaining);
      setLoading(false);
    })();
  }, [po.id]);

  const submit = async () => {
    const lines = items
      .map((item) => ({
        po_item_id: item.id,
        quantity_received: Number(quantities[item.id] || 0),
        location_id: null,
        condition: 'good' as const,
      }))
      .filter((l) => l.quantity_received > 0);
    if (lines.length === 0) return;
    setSaving(true);
    try {
      await receivePurchaseOrder(po.id, teamMember?.id ?? null, lines);
      toast('Receipt recorded', 'success');
      onReceived();
      onClose();
    } catch {
      toast('Could not record this receipt', 'error');
    }
    setSaving(false);
  };

  return (
    <ModalShell title={`Receive ${po.po_number}`} onClose={onClose}>
      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="animate-spin text-text-secondary" size={18} />
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-text-secondary">
            Set the quantity that actually arrived for each line. Parts linked to your catalog will
            restock automatically.
          </p>
          {items.map((item) => (
            <div key={item.id} className="flex items-center gap-2">
              <span className="flex-1 text-sm text-text-primary">
                {item.description}
                <span className="ml-1 text-xs text-text-secondary">
                  (ordered {item.quantity_ordered}, received {item.quantity_received})
                </span>
              </span>
              <input
                type="number"
                min={0}
                className={`w-24 ${fieldClass()}`}
                value={quantities[item.id] ?? ''}
                onChange={(e) => setQuantities((prev) => ({ ...prev, [item.id]: e.target.value }))}
              />
            </div>
          ))}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className={secondaryBtn()} onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className={primaryBtn()}
              disabled={saving}
              onClick={() => void submit()}
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Package size={13} />}{' '}
              Record receipt
            </button>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

// ============================================================
// EVALUATE VENDOR MODAL
// ============================================================

function EvaluateVendorModal({
  vendor,
  onClose,
  onSaved,
}: {
  vendor: VendorScorecardRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [quality, setQuality] = useState(4);
  const [price, setPrice] = useState(4);
  const [communication, setCommunication] = useState(4);
  const [onTime, setOnTime] = useState(true);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      await submitVendorEvaluation({
        vendor_id: vendor.vendor_id,
        quality_score: quality,
        price_score: price,
        communication_score: communication,
        on_time: onTime,
        notes: notes || null,
      });
      toast('Evaluation saved', 'success');
      onSaved();
      onClose();
    } catch {
      toast('Could not save this evaluation', 'error');
    }
    setSaving(false);
  };

  const ScoreRow = ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: number;
    onChange: (v: number) => void;
  }) => (
    <div className="flex items-center justify-between">
      <span className="text-sm text-text-primary">{label}</span>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" onClick={() => onChange(n)} className="focus-ring">
            <Star
              size={16}
              className={n <= value ? 'fill-amber-400 text-amber-400' : 'text-border'}
            />
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <ModalShell title={`Evaluate ${vendor.vendor_name}`} onClose={onClose}>
      <div className="space-y-3">
        <ScoreRow label="Quality" value={quality} onChange={setQuality} />
        <ScoreRow label="Price competitiveness" value={price} onChange={setPrice} />
        <ScoreRow label="Communication" value={communication} onChange={setCommunication} />
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input type="checkbox" checked={onTime} onChange={(e) => setOnTime(e.target.checked)} />{' '}
          Delivered on time
        </label>
        <textarea
          className={fieldClass()}
          rows={2}
          placeholder="Notes (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className={secondaryBtn()} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={primaryBtn()}
            disabled={saving}
            onClick={() => void submit()}
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Star size={13} />} Save
            evaluation
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ============================================================
// PAGE
// ============================================================

export function ProcurementPage() {
  const { teamMember } = useAuth();
  const { toast } = useToast();

  const [tab, setTab] = useState<TabKey>('pipeline');
  const [loading, setLoading] = useState(true);
  const [pipeline, setPipeline] = useState<ProcurementPipelineRow[]>([]);
  const [rfqs, setRfqs] = useState<Rfq[]>([]);
  const [orders, setOrders] = useState<(PurchaseOrder & { vendor: Vendor })[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [scorecard, setScorecard] = useState<VendorScorecardRow[]>([]);

  const [showNewRequest, setShowNewRequest] = useState(false);
  const [showNewVendor, setShowNewVendor] = useState(false);
  const [showNewRfq, setShowNewRfq] = useState(false);
  const [openRfq, setOpenRfq] = useState<Rfq | null>(null);
  const [receivingPO, setReceivingPO] = useState<(PurchaseOrder & { vendor: Vendor }) | null>(null);
  const [evaluatingVendor, setEvaluatingVendor] = useState<VendorScorecardRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, r, o, v, s] = await Promise.all([
        fetchProcurementPipeline(),
        fetchRfqs(),
        fetchPurchaseOrders(),
        fetchVendors(),
        fetchVendorScorecard(),
      ]);
      setPipeline(p);
      setRfqs(r);
      setOrders(o);
      setVendors(v);
      setScorecard(s);
    } catch {
      toast('Could not load procurement data', 'error');
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleApprove = async (po: PurchaseOrder) => {
    try {
      await approvePurchaseOrder(po.id, teamMember?.id ?? null);
      toast('Purchase order approved', 'success');
      await load();
    } catch {
      toast('Could not approve this PO', 'error');
    }
  };

  const handleMarkSent = async (po: PurchaseOrder) => {
    try {
      await markPurchaseOrderSent(po.id);
      toast('Marked as sent to vendor', 'success');
      await load();
    } catch {
      toast('Could not update this PO', 'error');
    }
  };

  return (
    <DashboardLayout activeLabel="Vendor & Procurement">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Vendor & Procurement OS</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
              Part need → RFQ → vendor comparison → approval → purchase order → receiving → vendor
              evaluation, all in one place.
            </p>
          </div>
          <div className="flex gap-2">
            <button type="button" className={secondaryBtn()} onClick={() => setShowNewVendor(true)}>
              <Plus size={13} /> Vendor
            </button>
            <button
              type="button"
              className={secondaryBtn()}
              onClick={() => setShowNewRequest(true)}
            >
              <Plus size={13} /> Request
            </button>
            <button type="button" className={primaryBtn()} onClick={() => setShowNewRfq(true)}>
              <Send size={13} /> New RFQ
            </button>
          </div>
        </div>

        <div className="mb-4 flex flex-wrap gap-1.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`focus-ring flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium ${
                tab === t.key
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border text-text-secondary hover:text-text-primary'
              }`}
            >
              <t.icon size={13} /> {t.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="animate-spin text-text-secondary" size={22} />
          </div>
        ) : (
          <>
            {tab === 'pipeline' && (
              <div className="space-y-2">
                {pipeline.length === 0 && (
                  <p className="py-10 text-center text-sm text-text-secondary">
                    No purchase requests yet. Create one, or they'll appear automatically from
                    low-stock alerts.
                  </p>
                )}
                {pipeline.map((row) => (
                  <div
                    key={row.purchase_request_id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg-secondary p-3"
                  >
                    <div>
                      <p className="text-sm font-semibold text-text-primary">
                        {row.part_name ?? row.description}
                      </p>
                      <p className="text-xs text-text-secondary">
                        Qty {row.quantity_requested} ·{' '}
                        {row.reason === 'low_stock'
                          ? 'Low stock'
                          : row.reason === 'job_shortage'
                            ? 'Job shortage'
                            : 'Manual'}
                        {row.needed_by ? ` · needed by ${row.needed_by}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="rounded-full border border-border px-2 py-1 font-medium text-text-secondary">
                        {REQUEST_STATUS_LABELS[row.request_status]}
                      </span>
                      {row.rfq_number && (
                        <span className="rounded-full border border-border px-2 py-1 font-medium text-text-secondary">
                          {row.rfq_number}
                        </span>
                      )}
                      {row.po_number && (
                        <span
                          className={`rounded-full px-2 py-1 font-medium ${row.po_status ? PO_STATUS_COLORS[row.po_status] : ''}`}
                        >
                          {row.po_number} · {row.awarded_vendor_name}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === 'rfqs' && (
              <div className="space-y-2">
                {rfqs.length === 0 && (
                  <p className="py-10 text-center text-sm text-text-secondary">No RFQs yet.</p>
                )}
                {rfqs.map((rfq) => (
                  <button
                    key={rfq.id}
                    type="button"
                    onClick={() => setOpenRfq(rfq)}
                    className="flex w-full flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg-secondary p-3 text-left hover:border-accent/40"
                  >
                    <div>
                      <p className="text-sm font-semibold text-text-primary">
                        {rfq.rfq_number} — {rfq.title}
                      </p>
                      <p className="text-xs text-text-secondary">
                        {rfq.due_date ? `Quotes due ${rfq.due_date}` : 'No due date set'}
                      </p>
                    </div>
                    <span className="rounded-full border border-border px-2 py-1 text-xs font-medium text-text-secondary">
                      {RFQ_STATUS_LABELS[rfq.status]}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {tab === 'orders' && (
              <div className="space-y-2">
                {orders.length === 0 && (
                  <p className="py-10 text-center text-sm text-text-secondary">
                    No purchase orders yet.
                  </p>
                )}
                {orders.map((po) => (
                  <div
                    key={po.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg-secondary p-3"
                  >
                    <div>
                      <p className="text-sm font-semibold text-text-primary">
                        {po.po_number} — {po.vendor.name}
                      </p>
                      <p className="text-xs text-text-secondary">
                        {formatCents(po.total_cents)}
                        {po.expected_delivery_date
                          ? ` · expected ${po.expected_delivery_date}`
                          : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-1 text-xs font-medium ${PO_STATUS_COLORS[po.status]}`}
                      >
                        {PO_STATUS_LABELS[po.status]}
                      </span>
                      {po.status === 'pending_approval' && (
                        <button
                          type="button"
                          className={secondaryBtn()}
                          onClick={() => void handleApprove(po)}
                        >
                          <Check size={13} /> Approve
                        </button>
                      )}
                      {po.status === 'approved' && (
                        <button
                          type="button"
                          className={secondaryBtn()}
                          onClick={() => void handleMarkSent(po)}
                        >
                          <Send size={13} /> Mark sent
                        </button>
                      )}
                      {(po.status === 'sent' || po.status === 'partially_received') && (
                        <button
                          type="button"
                          className={primaryBtn()}
                          onClick={() => setReceivingPO(po)}
                        >
                          <Package size={13} /> Receive
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === 'vendors' && (
              <div className="space-y-2">
                {scorecard.length === 0 && (
                  <p className="py-10 text-center text-sm text-text-secondary">
                    No vendors yet — add one to get started.
                  </p>
                )}
                {scorecard.map((v) => (
                  <div
                    key={v.vendor_id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg-secondary p-3"
                  >
                    <div>
                      <p className="text-sm font-semibold text-text-primary">{v.vendor_name}</p>
                      <p className="text-xs text-text-secondary">
                        {v.category ?? 'Uncategorized'} · {v.total_orders} orders ·{' '}
                        {formatCents(v.total_spend_cents)} total
                        {v.on_time_rate !== null
                          ? ` · ${Math.round(v.on_time_rate * 100)}% on-time`
                          : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {v.avg_overall_score !== null && (
                        <span className="flex items-center gap-1 text-xs font-semibold text-amber-500">
                          <Star size={13} className="fill-amber-400" />{' '}
                          {v.avg_overall_score.toFixed(1)}
                        </span>
                      )}
                      <button
                        type="button"
                        className={secondaryBtn()}
                        onClick={() => setEvaluatingVendor(v)}
                      >
                        Evaluate
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {showNewRequest && (
        <NewRequestModal onClose={() => setShowNewRequest(false)} onCreated={() => void load()} />
      )}
      {showNewVendor && (
        <NewVendorModal onClose={() => setShowNewVendor(false)} onCreated={() => void load()} />
      )}
      {showNewRfq && (
        <NewRfqModal
          vendors={vendors}
          pipeline={pipeline}
          onClose={() => setShowNewRfq(false)}
          onCreated={() => void load()}
        />
      )}
      {openRfq && (
        <RfqDetailModal
          rfq={openRfq}
          onClose={() => setOpenRfq(null)}
          onChanged={() => void load()}
        />
      )}
      {receivingPO && (
        <ReceivePOModal
          po={receivingPO}
          onClose={() => setReceivingPO(null)}
          onReceived={() => void load()}
        />
      )}
      {evaluatingVendor && (
        <EvaluateVendorModal
          vendor={evaluatingVendor}
          onClose={() => setEvaluatingVendor(null)}
          onSaved={() => void load()}
        />
      )}
    </DashboardLayout>
  );
}
