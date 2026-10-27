// Supabase data access for /dashboard/inventory/rma. Every function throws an Error with a
// user-presentable message. Reads are scoped by RLS; every write goes through a SECURITY DEFINER
// function (save_vendor_rma, ship_vendor_rma, ...) that re-checks permissions and the rules.
import { supabase } from '@/lib/supabase';
import type {
  CreditKind, Rma, RmaCredit, RmaEvent, RmaLine, ReturnablePoLine, ReturnableUsage, SaveRmaPayload, StockLevel,
} from '@/lib/vendorRma';

interface DbError { message?: string; code?: string }

function fail(error: DbError | null | undefined, fallback: string): never {
  if (error?.code === '42501') throw new Error("You don't have permission to manage vendor returns.");
  if (error?.code === '23503') throw new Error('A linked record no longer exists. Refresh and try again.');
  if (error?.code === '23505') throw new Error('That already exists. Refresh and try again.');
  // Messages raised inside the SQL functions are written for users.
  if (error?.code === 'P0002' || error?.code === '22023') throw new Error(error.message || fallback);
  throw new Error(fallback);
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

const RMA_SELECT =
  '*, vendor:inventory_vendors(name), purchase_order:purchase_orders(po_number), ' +
  'lines:vendor_rma_lines(*, part:inventory_parts(name, part_number), location:inventory_locations(name))';

function toLine(r: Record<string, unknown>): RmaLine {
  return {
    ...(r as unknown as RmaLine),
    quantity: num(r.quantity),
    unit_credit_cents: num(r.unit_credit_cents),
    unit_cost_cents: num(r.unit_cost_cents),
    quantity_replaced: num(r.quantity_replaced),
    part: one(r.part as RmaLine['part'] | RmaLine['part'][]),
    location: one(r.location as RmaLine['location'] | RmaLine['location'][]),
  };
}

function toRma(r: Record<string, unknown>): Rma {
  const lines = ((r.lines as Record<string, unknown>[] | null) ?? []).map(toLine).sort((a, b) => a.line_no - b.line_no);
  return {
    ...(r as unknown as Rma),
    restocking_fee_cents: num(r.restocking_fee_cents),
    return_freight_cents: num(r.return_freight_cents),
    credit_expected_cents: num(r.credit_expected_cents),
    credit_received_cents: num(r.credit_received_cents),
    vendor: one(r.vendor as Rma['vendor'] | Rma['vendor'][]),
    purchase_order: one(r.purchase_order as Rma['purchase_order'] | Rma['purchase_order'][]),
    lines,
  };
}

export async function fetchRmas(): Promise<Rma[]> {
  const { data, error } = await supabase
    .from('vendor_rmas')
    .select(RMA_SELECT)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) fail(error, "Couldn't load vendor returns.");
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(toRma);
}

export interface RmaDetail { credits: RmaCredit[]; events: RmaEvent[] }

export async function fetchRmaDetail(rmaId: string): Promise<RmaDetail> {
  const [c, e] = await Promise.all([
    supabase.from('vendor_rma_credits').select('*').eq('rma_id', rmaId).order('created_at', { ascending: true }),
    supabase.from('vendor_rma_events').select('*').eq('rma_id', rmaId).order('created_at', { ascending: false }).limit(100),
  ]);
  if (c.error) fail(c.error, "Couldn't load the credits.");
  if (e.error) fail(e.error, "Couldn't load the history.");
  return {
    credits: ((c.data ?? []) as unknown as RmaCredit[]).map((x) => ({ ...x, amount_cents: num(x.amount_cents) })),
    events: ((e.data ?? []) as unknown as RmaEvent[]).map((x) => ({ ...x, amount_cents: x.amount_cents == null ? null : num(x.amount_cents) })),
  };
}

export async function fetchStockLevels(partIds: string[]): Promise<StockLevel[]> {
  if (partIds.length === 0) return [];
  const { data, error } = await supabase
    .from('inventory_stock_levels')
    .select('part_id, location_id, quantity_on_hand, quantity_reserved')
    .in('part_id', partIds);
  if (error) fail(error, "Couldn't check stock levels.");
  return ((data ?? []) as unknown as StockLevel[]).map((s) => ({
    ...s, quantity_on_hand: num(s.quantity_on_hand), quantity_reserved: num(s.quantity_reserved),
  }));
}

export async function listReturnableLines(vendorId: string): Promise<ReturnablePoLine[]> {
  const { data, error } = await supabase.rpc('list_vendor_returnable_lines', { p_vendor_id: vendorId });
  if (error) fail(error, "Couldn't load this vendor's received purchases.");
  return ((data ?? []) as unknown as ReturnablePoLine[]).map((r) => ({
    ...r, quantity_received: num(r.quantity_received), quantity_committed: num(r.quantity_committed), unit_cost_cents: num(r.unit_cost_cents),
  }));
}

export async function listReturnableUsage(vendorId: string): Promise<ReturnableUsage[]> {
  const { data, error } = await supabase.rpc('list_vendor_returnable_usage', { p_vendor_id: vendorId });
  if (error) fail(error, "Couldn't load recent part usage.");
  return ((data ?? []) as unknown as ReturnableUsage[]).map((r) => ({
    ...r, quantity_used: num(r.quantity_used), quantity_committed: num(r.quantity_committed), unit_cost_cents: num(r.unit_cost_cents),
  }));
}

// ---------------------------------------------------------------- writes

export async function saveRma(payload: SaveRmaPayload, rmaId: string | null): Promise<string> {
  const { data, error } = await supabase.rpc('save_vendor_rma', {
    p_rma_id: rmaId,
    p_vendor_id: payload.vendor_id,
    p_purchase_order_id: payload.purchase_order_id,
    p_reason_code: payload.reason_code,
    p_reason_notes: payload.reason_notes,
    p_resolution: payload.resolution,
    p_restocking_fee_cents: payload.restocking_fee_cents,
    p_vendor_rma_number: payload.vendor_rma_number,
    p_lines: payload.lines,
  });
  if (error) fail(error, "Couldn't save the return.");
  return data as string;
}

export async function authorizeRma(rmaId: string, vendorRmaNumber: string): Promise<void> {
  const { error } = await supabase.rpc('authorize_vendor_rma', { p_rma_id: rmaId, p_vendor_rma_number: vendorRmaNumber });
  if (error) fail(error, "Couldn't authorize the return.");
}

/** Returns the number of units removed from stock. */
export async function shipRma(
  rmaId: string,
  input: { carrier: string; tracking_number: string; tracking_url: string; return_freight_cents: number },
): Promise<number> {
  const { data, error } = await supabase.rpc('ship_vendor_rma', {
    p_rma_id: rmaId,
    p_carrier: input.carrier,
    p_tracking_number: input.tracking_number,
    p_tracking_url: input.tracking_url,
    p_return_freight_cents: input.return_freight_cents,
  });
  if (error) fail(error, "Couldn't ship the return.");
  return num(data);
}

export async function updateRmaShipment(
  rmaId: string,
  input: { ship_status: string; carrier: string; tracking_number: string; tracking_url: string },
): Promise<void> {
  const { error } = await supabase.rpc('update_vendor_rma_shipment', {
    p_rma_id: rmaId,
    p_ship_status: input.ship_status,
    p_carrier: input.carrier,
    p_tracking_number: input.tracking_number,
    p_tracking_url: input.tracking_url,
  });
  if (error) fail(error, "Couldn't update the shipment.");
}

export async function recordRmaCredit(
  rmaId: string,
  input: { amount_cents: number; kind: CreditKind; reference: string; received_on: string; note: string },
): Promise<void> {
  const { error } = await supabase.rpc('record_vendor_rma_credit', {
    p_rma_id: rmaId,
    p_amount_cents: input.amount_cents,
    p_kind: input.kind,
    p_reference: input.reference,
    p_received_on: input.received_on || null,
    p_note: input.note,
  });
  if (error) fail(error, "Couldn't record the credit.");
}

export async function voidRmaCredit(creditId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('void_vendor_rma_credit', { p_credit_id: creditId, p_reason: reason });
  if (error) fail(error, "Couldn't void the credit.");
}

/** Receives every open replacement unit. Returns the number of units added to stock. */
export async function receiveRmaReplacement(rmaId: string): Promise<number> {
  const { data, error } = await supabase.rpc('receive_vendor_rma_replacement', { p_rma_id: rmaId, p_lines: null });
  if (error) fail(error, "Couldn't receive the replacement.");
  return num(data);
}

/** Returns the number of units put back into stock. */
export async function rejectRma(rmaId: string, restock: boolean, note: string): Promise<number> {
  const { data, error } = await supabase.rpc('reject_vendor_rma', { p_rma_id: rmaId, p_restock: restock, p_note: note });
  if (error) fail(error, "Couldn't reject the return.");
  return num(data);
}

export async function cancelRma(rmaId: string, note: string): Promise<void> {
  const { error } = await supabase.rpc('cancel_vendor_rma', { p_rma_id: rmaId, p_note: note });
  if (error) fail(error, "Couldn't cancel the return.");
}

export async function closeRma(rmaId: string, acceptShortfall: boolean): Promise<void> {
  const { error } = await supabase.rpc('close_vendor_rma', { p_rma_id: rmaId, p_accept_shortfall: acceptShortfall });
  if (error) fail(error, "Couldn't close the return.");
}
