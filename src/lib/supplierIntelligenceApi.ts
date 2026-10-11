/**
 * Supplier Intelligence — data access
 *
 * Gathers everything the pure engine (supplierIntelligence.ts) needs from the
 * tables Vireek already has: Vendor & Procurement, Parts & Inventory and the
 * AI Parts Market. No new tables or migrations are required.
 *
 * Every source is fetched independently. If one fails (e.g. a migration has
 * not been applied on this environment) the page still renders with the data
 * that DID load, and the failed source is reported in `warnings` so the UI can
 * say exactly what is missing instead of failing silently or blanking out.
 */

import { supabase } from './supabase';
import { createPurchaseRequest, fetchPurchaseRequests, fetchVendors } from './procurement';
import {
  listInventoryForecast,
  listInventoryParts,
  listInventoryVendors,
  listPartVendorCatalog,
} from './inventory';
import { fetchLiveOffers, fetchMarketSources, fetchPriceHistory } from './partsMarket';
import type { MarketOfferRow, PriceHistoryRow } from './partsMarket';
import type {
  GoodsReceiptWithItems,
  PurchaseOrderWithItems,
  RecommendationAction,
  SupplierInput,
} from './supplierIntelligence';
import type { RfqVendor, VendorEvaluation } from './procurement';

/** How far back purchasing history is read. */
const HISTORY_DAYS = 540;
/** How far back price observations are read for trend/volatility. */
const PRICE_HISTORY_DAYS = 120;
/** Hard cap per query so one huge account cannot freeze the browser. */
const ROW_LIMIT = 5000;
/** Part ids per `in (...)` query, to keep request URLs short. */
const CHUNK = 100;
const MAX_CHUNKS = 20;

export interface SupplierDataResult {
  input: SupplierInput;
  /** Human-readable names of data sources that could not be loaded. */
  warnings: string[];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function load<T>(label: string, run: () => Promise<T>, fallback: T, warnings: string[]): Promise<T> {
  try {
    return await run();
  } catch {
    warnings.push(label);
    return fallback;
  }
}

export async function gatherSupplierIntelligenceInput(): Promise<SupplierDataResult> {
  const warnings: string[] = [];
  const now = new Date();
  const since = new Date(now.getTime() - HISTORY_DAYS * 86_400_000).toISOString();

  const [
    vendors,
    inventoryVendors,
    evaluations,
    purchaseOrders,
    receipts,
    rfqVendors,
    quotes,
    purchaseRequests,
    catalog,
    parts,
    marketSources,
    forecast,
  ] = await Promise.all([
    load('Vendors', () => fetchVendors(false), [], warnings),
    load('Inventory vendors', () => listInventoryVendors(false), [], warnings),
    load(
      'Vendor evaluations',
      async () => {
        const { data, error } = await supabase
          .from('vendor_evaluations')
          .select('*')
          .gte('evaluated_at', since)
          .limit(ROW_LIMIT);
        if (error) throw error;
        return (data ?? []) as VendorEvaluation[];
      },
      [],
      warnings,
    ),
    load(
      'Purchase orders',
      async () => {
        const { data, error } = await supabase
          .from('purchase_orders')
          .select('*, items:purchase_order_items(*)')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(ROW_LIMIT);
        if (error) throw error;
        return (data ?? []) as PurchaseOrderWithItems[];
      },
      [],
      warnings,
    ),
    load(
      'Goods receipts',
      async () => {
        const { data, error } = await supabase
          .from('goods_receipts')
          .select('*, items:goods_receipt_items(*)')
          .gte('received_at', since)
          .limit(ROW_LIMIT);
        if (error) throw error;
        return (data ?? []) as GoodsReceiptWithItems[];
      },
      [],
      warnings,
    ),
    load(
      'RFQ invitations',
      async () => {
        const { data, error } = await supabase.from('rfq_vendors').select('*').limit(ROW_LIMIT);
        if (error) throw error;
        return (data ?? []) as RfqVendor[];
      },
      [],
      warnings,
    ),
    load(
      'Vendor quotes',
      async () => {
        const { data, error } = await supabase
          .from('vendor_quotes')
          .select('id, rfq_id, vendor_id, status, lead_time_days, submitted_at, created_at')
          .gte('created_at', since)
          .limit(ROW_LIMIT);
        if (error) throw error;
        return (data ?? []) as SupplierInput['quotes'];
      },
      [],
      warnings,
    ),
    load('Purchase requests', () => fetchPurchaseRequests(), [], warnings),
    load('Part vendor catalog', () => listPartVendorCatalog(), [], warnings),
    load('Inventory parts', () => listInventoryParts(false), [], warnings),
    load('Parts Market sources', () => fetchMarketSources(), [], warnings),
    load('Inventory forecast', () => listInventoryForecast(), [], warnings),
  ]);

  // Market offers + price history are keyed by part, so they come second.
  const partIds = [...new Set(parts.map((p) => p.id))];
  const idChunks = chunk(partIds, CHUNK).slice(0, MAX_CHUNKS);
  if (partIds.length > CHUNK * MAX_CHUNKS) warnings.push(`Market data (first ${CHUNK * MAX_CHUNKS} parts only)`);

  const [offers, priceHistory] = await Promise.all([
    load(
      'Parts Market offers',
      async () => (await Promise.all(idChunks.map((ids) => fetchLiveOffers(ids)))).flat() as MarketOfferRow[],
      [],
      warnings,
    ),
    load(
      'Price history',
      async () =>
        (await Promise.all(idChunks.map((ids) => fetchPriceHistory(ids, PRICE_HISTORY_DAYS)))).flat() as PriceHistoryRow[],
      [],
      warnings,
    ),
  ]);

  return {
    input: {
      now,
      vendors,
      inventoryVendors,
      evaluations,
      purchaseOrders,
      receipts,
      rfqVendors,
      quotes,
      purchaseRequests,
      catalog,
      parts: parts.map((p) => ({
        id: p.id,
        name: p.name,
        part_number: p.part_number,
        category: p.category,
        unit_cost_cents: p.unit_cost_cents,
        reorder_point: p.reorder_point,
        reorder_quantity: p.reorder_quantity,
      })),
      marketSources,
      offers,
      priceHistory,
      forecast,
    },
    warnings,
  };
}

/** Turns a "create purchase request" recommendation into a real draft request in Procurement. */
export async function createRequestFromRecommendation(
  action: Extract<RecommendationAction, { type: 'create_purchase_request' }>,
): Promise<void> {
  await createPurchaseRequest({
    part_id: action.partId,
    quantity_requested: action.quantity,
    reason: 'low_stock',
    needed_by: action.neededBy,
    notes: action.note,
  });
}

/** Fires (debounced) whenever purchasing, receiving, evaluation or market data changes. */
export function subscribeToSupplierData(onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 800);
  };
  const tables = [
    'purchase_orders',
    'goods_receipts',
    'vendor_evaluations',
    'purchase_requests',
    'parts_market_offers',
  ];
  let channel = supabase.channel('supplier-intelligence-live');
  for (const table of tables) {
    channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, fire);
  }
  channel.subscribe();
  return () => {
    if (timer) clearTimeout(timer);
    void supabase.removeChannel(channel);
  };
}
