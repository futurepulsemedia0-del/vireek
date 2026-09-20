import { supabase } from './supabase';

// ============================================================
// TYPES — mirror the vendor_procurement_os migration.
// ============================================================

export type PurchaseRequestReason = 'low_stock' | 'job_shortage' | 'manual';
export type PurchaseRequestStatus =
  'draft' | 'rfq_sent' | 'quotes_received' | 'approved' | 'ordered' | 'received' | 'cancelled';
export type RfqStatus = 'draft' | 'sent' | 'quotes_in' | 'awarded' | 'cancelled';
export type VendorQuoteStatus = 'draft' | 'submitted' | 'selected' | 'rejected';
export type PurchaseOrderStatus =
  | 'pending_approval'
  | 'approved'
  | 'sent'
  | 'partially_received'
  | 'received'
  | 'closed'
  | 'cancelled';
export type ReceiptCondition = 'good' | 'damaged' | 'partial';

export interface Vendor {
  id: string;
  user_id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  category: string | null;
  payment_terms: string | null;
  notes: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PurchaseRequest {
  id: string;
  user_id: string;
  part_id: string | null;
  description: string | null;
  quantity_requested: number;
  reason: PurchaseRequestReason;
  job_id: string | null;
  requested_by: string | null;
  needed_by: string | null;
  status: PurchaseRequestStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Rfq {
  id: string;
  user_id: string;
  rfq_number: string;
  title: string;
  status: RfqStatus;
  due_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface RfqItem {
  id: string;
  user_id: string;
  rfq_id: string;
  purchase_request_id: string | null;
  part_id: string | null;
  description: string;
  quantity: number;
  created_at: string;
}

export interface RfqVendor {
  id: string;
  rfq_id: string;
  vendor_id: string;
  status: 'invited' | 'responded' | 'declined';
  sent_at: string | null;
}

export interface VendorQuote {
  id: string;
  user_id: string;
  rfq_id: string;
  vendor_id: string;
  status: VendorQuoteStatus;
  lead_time_days: number | null;
  shipping_cents: number;
  valid_until: string | null;
  notes: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface VendorQuoteItem {
  id: string;
  vendor_quote_id: string;
  rfq_item_id: string;
  unit_price_cents: number;
  quantity_offered: number | null;
  notes: string | null;
}

export interface PurchaseOrder {
  id: string;
  user_id: string;
  po_number: string;
  vendor_id: string;
  rfq_id: string | null;
  vendor_quote_id: string | null;
  purchase_request_id: string | null;
  status: PurchaseOrderStatus;
  subtotal_cents: number;
  shipping_cents: number;
  tax_cents: number;
  total_cents: number;
  expected_delivery_date: string | null;
  approved_by: string | null;
  approved_at: string | null;
  sent_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PurchaseOrderItem {
  id: string;
  po_id: string;
  part_id: string | null;
  description: string;
  quantity_ordered: number;
  unit_price_cents: number;
  quantity_received: number;
}

export interface GoodsReceipt {
  id: string;
  po_id: string;
  received_by: string | null;
  received_at: string;
  notes: string | null;
}

export interface GoodsReceiptItem {
  id: string;
  goods_receipt_id: string;
  po_item_id: string;
  quantity_received: number;
  location_id: string | null;
  condition: ReceiptCondition;
  notes: string | null;
}

export interface VendorEvaluation {
  id: string;
  vendor_id: string;
  po_id: string | null;
  on_time: boolean | null;
  quality_score: number | null;
  price_score: number | null;
  communication_score: number | null;
  overall_score: number | null;
  notes: string | null;
  evaluated_at: string;
}

export interface RfqQuoteComparisonRow {
  rfq_id: string;
  rfq_item_id: string;
  item_description: string;
  quantity_requested: number;
  vendor_quote_id: string;
  vendor_id: string;
  vendor_name: string;
  quote_status: VendorQuoteStatus;
  lead_time_days: number | null;
  valid_until: string | null;
  unit_price_cents: number;
  quantity_offered: number;
  line_total_cents: number;
  price_rank: number;
}

export interface VendorScorecardRow {
  vendor_id: string;
  vendor_name: string;
  category: string | null;
  active: boolean;
  total_orders: number;
  total_spend_cents: number;
  last_order_at: string | null;
  avg_quality_score: number | null;
  avg_price_score: number | null;
  avg_communication_score: number | null;
  avg_overall_score: number | null;
  on_time_rate: number | null;
  evaluation_count: number;
}

export interface ProcurementPipelineRow {
  purchase_request_id: string;
  description: string | null;
  part_name: string | null;
  quantity_requested: number;
  reason: PurchaseRequestReason;
  needed_by: string | null;
  request_status: PurchaseRequestStatus;
  rfq_id: string | null;
  rfq_number: string | null;
  rfq_status: RfqStatus | null;
  po_id: string | null;
  po_number: string | null;
  po_status: PurchaseOrderStatus | null;
  po_total_cents: number | null;
  awarded_vendor_name: string | null;
}

// ============================================================
// FORMATTING HELPERS
// ============================================================

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '$0.00';
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export const REQUEST_STATUS_LABELS: Record<PurchaseRequestStatus, string> = {
  draft: 'Draft',
  rfq_sent: 'RFQ sent',
  quotes_received: 'Quotes in',
  approved: 'Approved',
  ordered: 'Ordered',
  received: 'Received',
  cancelled: 'Cancelled',
};

export const RFQ_STATUS_LABELS: Record<RfqStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  quotes_in: 'Quotes in',
  awarded: 'Awarded',
  cancelled: 'Cancelled',
};

export const PO_STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  pending_approval: 'Pending approval',
  approved: 'Approved',
  sent: 'Sent to vendor',
  partially_received: 'Partially received',
  received: 'Received',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

export const PO_STATUS_COLORS: Record<PurchaseOrderStatus, string> = {
  pending_approval: 'bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-400',
  approved: 'bg-sky-100 text-sky-800 dark:bg-sky-500/10 dark:text-sky-400',
  sent: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/10 dark:text-indigo-400',
  partially_received: 'bg-orange-100 text-orange-800 dark:bg-orange-500/10 dark:text-orange-400',
  received: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-400',
  closed: 'bg-slate-100 text-slate-700 dark:bg-slate-500/10 dark:text-slate-400',
  cancelled: 'bg-rose-100 text-rose-800 dark:bg-rose-500/10 dark:text-rose-400',
};

// ============================================================
// VENDORS
// ============================================================

export async function fetchVendors(activeOnly = false): Promise<Vendor[]> {
  let query = supabase.from('vendors').select('*').order('name', { ascending: true });
  if (activeOnly) query = query.eq('active', true);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function createVendor(input: Partial<Vendor> & { name: string }): Promise<Vendor> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('vendors')
    .insert({ ...input, user_id: user?.id })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateVendor(id: string, patch: Partial<Vendor>): Promise<void> {
  const { error } = await supabase.from('vendors').update(patch).eq('id', id);
  if (error) throw error;
}

export async function fetchVendorScorecard(): Promise<VendorScorecardRow[]> {
  const { data, error } = await supabase
    .from('vendor_scorecard')
    .select('*')
    .order('avg_overall_score', { ascending: false, nullsFirst: false });
  if (error) throw error;
  return data ?? [];
}

// ============================================================
// PURCHASE REQUESTS ("part need")
// ============================================================

export async function fetchPurchaseRequests(
  status?: PurchaseRequestStatus,
): Promise<PurchaseRequest[]> {
  let query = supabase
    .from('purchase_requests')
    .select('*')
    .order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function createPurchaseRequest(
  input: Pick<PurchaseRequest, 'quantity_requested' | 'reason'> &
    Partial<Pick<PurchaseRequest, 'part_id' | 'description' | 'job_id' | 'needed_by' | 'notes'>>,
): Promise<PurchaseRequest> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('purchase_requests')
    .insert({ ...input, user_id: user?.id })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updatePurchaseRequestStatus(
  id: string,
  status: PurchaseRequestStatus,
): Promise<void> {
  const { error } = await supabase.from('purchase_requests').update({ status }).eq('id', id);
  if (error) throw error;
}

export async function fetchProcurementPipeline(): Promise<ProcurementPipelineRow[]> {
  const { data, error } = await supabase
    .from('procurement_pipeline')
    .select('*')
    .order('needed_by', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return data ?? [];
}

// ============================================================
// RFQS
// ============================================================

export async function fetchRfqs(): Promise<Rfq[]> {
  const { data, error } = await supabase
    .from('rfqs')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function createRfq(
  title: string,
  dueDate: string | null,
  items: Array<{
    description: string;
    quantity: number;
    part_id?: string | null;
    purchase_request_id?: string | null;
  }>,
  vendorIds: string[],
): Promise<Rfq> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: rfq, error: rfqError } = await supabase
    .from('rfqs')
    .insert({ title, due_date: dueDate, user_id: user?.id })
    .select()
    .single();
  if (rfqError) throw rfqError;

  if (items.length > 0) {
    const { error: itemsError } = await supabase
      .from('rfq_items')
      .insert(items.map((item) => ({ ...item, rfq_id: rfq.id, user_id: user?.id })));
    if (itemsError) throw itemsError;
  }

  if (vendorIds.length > 0) {
    const { error: vendorsError } = await supabase.from('rfq_vendors').insert(
      vendorIds.map((vendor_id) => ({
        rfq_id: rfq.id,
        vendor_id,
        user_id: user?.id,
        status: 'invited' as const,
        sent_at: new Date().toISOString(),
      })),
    );
    if (vendorsError) throw vendorsError;

    // Every invited vendor needs a quote shell to fill in.
    const { error: quotesError } = await supabase
      .from('vendor_quotes')
      .insert(
        vendorIds.map((vendor_id) => ({
          rfq_id: rfq.id,
          vendor_id,
          user_id: user?.id,
          status: 'draft' as const,
        })),
      );
    if (quotesError) throw quotesError;
  }

  await supabase.from('rfqs').update({ status: 'sent' }).eq('id', rfq.id);

  // Purchase requests behind this RFQ move to "rfq_sent".
  const purchaseRequestIds = items.map((i) => i.purchase_request_id).filter(Boolean) as string[];
  if (purchaseRequestIds.length > 0) {
    await supabase
      .from('purchase_requests')
      .update({ status: 'rfq_sent' })
      .in('id', purchaseRequestIds);
  }

  return { ...rfq, status: 'sent' };
}

export async function fetchRfqItems(rfqId: string): Promise<RfqItem[]> {
  const { data, error } = await supabase.from('rfq_items').select('*').eq('rfq_id', rfqId);
  if (error) throw error;
  return data ?? [];
}

export async function fetchRfqVendors(rfqId: string): Promise<(RfqVendor & { vendor: Vendor })[]> {
  const { data, error } = await supabase
    .from('rfq_vendors')
    .select('*, vendor:vendors(*)')
    .eq('rfq_id', rfqId);
  if (error) throw error;
  return (data ?? []) as (RfqVendor & { vendor: Vendor })[];
}

// ============================================================
// VENDOR QUOTES
// ============================================================

export async function fetchVendorQuotes(
  rfqId: string,
): Promise<(VendorQuote & { vendor: Vendor })[]> {
  const { data, error } = await supabase
    .from('vendor_quotes')
    .select('*, vendor:vendors(*)')
    .eq('rfq_id', rfqId);
  if (error) throw error;
  return (data ?? []) as (VendorQuote & { vendor: Vendor })[];
}

export async function submitVendorQuote(
  quoteId: string,
  header: {
    lead_time_days: number | null;
    shipping_cents: number;
    valid_until: string | null;
    notes: string | null;
  },
  lineItems: Array<{
    rfq_item_id: string;
    unit_price_cents: number;
    quantity_offered?: number | null;
  }>,
): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error: headerError } = await supabase
    .from('vendor_quotes')
    .update({ ...header, status: 'submitted', submitted_at: new Date().toISOString() })
    .eq('id', quoteId);
  if (headerError) throw headerError;

  const { error: deleteError } = await supabase
    .from('vendor_quote_items')
    .delete()
    .eq('vendor_quote_id', quoteId);
  if (deleteError) throw deleteError;

  if (lineItems.length > 0) {
    const { error: insertError } = await supabase
      .from('vendor_quote_items')
      .insert(lineItems.map((li) => ({ ...li, vendor_quote_id: quoteId, user_id: user?.id })));
    if (insertError) throw insertError;
  }

  const { data: quote } = await supabase
    .from('vendor_quotes')
    .select('rfq_id')
    .eq('id', quoteId)
    .single();
  if (quote) {
    await supabase.from('rfqs').update({ status: 'quotes_in' }).eq('id', quote.rfq_id);
    const { data: pr } = await supabase
      .from('rfq_items')
      .select('purchase_request_id')
      .eq('rfq_id', quote.rfq_id);
    const ids = (pr ?? []).map((r) => r.purchase_request_id).filter(Boolean) as string[];
    if (ids.length > 0)
      await supabase.from('purchase_requests').update({ status: 'quotes_received' }).in('id', ids);
  }
}

export async function fetchRfqComparison(rfqId: string): Promise<RfqQuoteComparisonRow[]> {
  const { data, error } = await supabase
    .from('rfq_quote_comparison')
    .select('*')
    .eq('rfq_id', rfqId)
    .order('rfq_item_id', { ascending: true })
    .order('price_rank', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/**
 * Awards the RFQ to one vendor: marks that quote selected (and the rest
 * rejected), marks the RFQ awarded, and creates a purchase order pre-filled
 * from the winning quote's line items — the "approval -> PO" handoff.
 */
export async function awardRfqAndCreatePO(
  rfqId: string,
  winningQuoteId: string,
): Promise<PurchaseOrder> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: quote, error: quoteError } = await supabase
    .from('vendor_quotes')
    .select('*, vendor_quote_items(*, rfq_item:rfq_items(*))')
    .eq('id', winningQuoteId)
    .single();
  if (quoteError) throw quoteError;

  await supabase.from('vendor_quotes').update({ status: 'selected' }).eq('id', winningQuoteId);
  await supabase
    .from('vendor_quotes')
    .update({ status: 'rejected' })
    .eq('rfq_id', rfqId)
    .neq('id', winningQuoteId);
  await supabase.from('rfqs').update({ status: 'awarded' }).eq('id', rfqId);

  const rfqItems = (
    quote as VendorQuote & {
      vendor_quote_items: Array<{
        rfq_item_id: string;
        unit_price_cents: number;
        quantity_offered: number | null;
        rfq_item: RfqItem;
      }>;
    }
  ).vendor_quote_items;
  const firstPurchaseRequestId =
    rfqItems.find((i) => i.rfq_item?.purchase_request_id)?.rfq_item.purchase_request_id ?? null;

  const { data: po, error: poError } = await supabase
    .from('purchase_orders')
    .insert({
      vendor_id: quote.vendor_id,
      rfq_id: rfqId,
      vendor_quote_id: winningQuoteId,
      purchase_request_id: firstPurchaseRequestId,
      shipping_cents: quote.shipping_cents ?? 0,
      status: 'pending_approval',
      user_id: user?.id,
    })
    .select()
    .single();
  if (poError) throw poError;

  const items = rfqItems.map((li) => ({
    po_id: po.id,
    part_id: li.rfq_item?.part_id ?? null,
    description: li.rfq_item?.description ?? 'Item',
    quantity_ordered: li.quantity_offered ?? li.rfq_item?.quantity ?? 1,
    unit_price_cents: li.unit_price_cents,
    user_id: user?.id,
  }));
  if (items.length > 0) {
    const { error: itemsError } = await supabase.from('purchase_order_items').insert(items);
    if (itemsError) throw itemsError;
  }

  return po;
}

// ============================================================
// PURCHASE ORDERS
// ============================================================

export async function fetchPurchaseOrders(
  status?: PurchaseOrderStatus,
): Promise<(PurchaseOrder & { vendor: Vendor })[]> {
  let query = supabase
    .from('purchase_orders')
    .select('*, vendor:vendors(*)')
    .order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as (PurchaseOrder & { vendor: Vendor })[];
}

export async function fetchPurchaseOrderItems(poId: string): Promise<PurchaseOrderItem[]> {
  const { data, error } = await supabase.from('purchase_order_items').select('*').eq('po_id', poId);
  if (error) throw error;
  return data ?? [];
}

export async function createManualPurchaseOrder(
  vendorId: string,
  items: Array<{
    description: string;
    quantity_ordered: number;
    unit_price_cents: number;
    part_id?: string | null;
  }>,
  extra?: {
    shipping_cents?: number;
    tax_cents?: number;
    expected_delivery_date?: string | null;
    notes?: string | null;
  },
): Promise<PurchaseOrder> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: po, error: poError } = await supabase
    .from('purchase_orders')
    .insert({ vendor_id: vendorId, user_id: user?.id, status: 'pending_approval', ...extra })
    .select()
    .single();
  if (poError) throw poError;

  const { error: itemsError } = await supabase
    .from('purchase_order_items')
    .insert(items.map((item) => ({ ...item, po_id: po.id, user_id: user?.id })));
  if (itemsError) throw itemsError;

  return po;
}

export async function approvePurchaseOrder(
  poId: string,
  approverTeamMemberId: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('purchase_orders')
    .update({
      status: 'approved',
      approved_by: approverTeamMemberId,
      approved_at: new Date().toISOString(),
    })
    .eq('id', poId);
  if (error) throw error;
}

export async function markPurchaseOrderSent(poId: string): Promise<void> {
  const { error } = await supabase
    .from('purchase_orders')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', poId);
  if (error) throw error;
}

export async function cancelPurchaseOrder(poId: string): Promise<void> {
  const { error } = await supabase
    .from('purchase_orders')
    .update({ status: 'cancelled' })
    .eq('id', poId);
  if (error) throw error;
}

// ============================================================
// RECEIVING
// ============================================================

/**
 * Records a goods receipt. The apply_goods_receipt_item() DB trigger
 * bumps quantity_received on each PO item, recomputes the PO's status,
 * and — for catalog parts received to a real location — writes an
 * inventory_transactions 'receipt' row so stock levels update themselves.
 */
export async function receivePurchaseOrder(
  poId: string,
  receivedBy: string | null,
  lines: Array<{
    po_item_id: string;
    quantity_received: number;
    location_id: string | null;
    condition: ReceiptCondition;
    notes?: string | null;
  }>,
  notes?: string | null,
): Promise<GoodsReceipt> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: receipt, error: receiptError } = await supabase
    .from('goods_receipts')
    .insert({ po_id: poId, received_by: receivedBy, notes, user_id: user?.id })
    .select()
    .single();
  if (receiptError) throw receiptError;

  const { error: linesError } = await supabase
    .from('goods_receipt_items')
    .insert(lines.map((line) => ({ ...line, goods_receipt_id: receipt.id, user_id: user?.id })));
  if (linesError) throw linesError;

  return receipt;
}

export async function fetchGoodsReceipts(poId: string): Promise<GoodsReceipt[]> {
  const { data, error } = await supabase
    .from('goods_receipts')
    .select('*')
    .eq('po_id', poId)
    .order('received_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

// ============================================================
// VENDOR EVALUATION
// ============================================================

export async function submitVendorEvaluation(
  input: Pick<VendorEvaluation, 'vendor_id'> &
    Partial
      Pick
        VendorEvaluation,
        'po_id' | 'on_time' | 'quality_score' | 'price_score' | 'communication_score' | 'notes'
      >
    >,
): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('vendor_evaluations')
    .insert({ ...input, user_id: user?.id });
  if (error) throw error;
}

export async function fetchVendorEvaluations(vendorId: string): Promise<VendorEvaluation[]> {
  const { data, error } = await supabase
    .from('vendor_evaluations')
    .select('*')
    .eq('vendor_id', vendorId)
    .order('evaluated_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}
