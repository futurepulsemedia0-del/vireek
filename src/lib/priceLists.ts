/**
 * Price Lists — client library.
 *
 * A price list overrides the Live Price Book for a specific buyer:
 *   - a customer         (scope 'customer')
 *   - a commercial contract (scope 'contract')
 *   - a tier             (scope 'tier': commercial | membership | contractor)
 * within an effective date window.
 *
 * Resolution (disclosed, deterministic — no AI involved):
 *   1. Only lists that are `active`, inside their effective window on the
 *      pricing date, and that apply to the buyer are considered.
 *   2. Contract beats customer beats tier.
 *   3. Within the same scope: higher priority, then the most recent
 *      effective_from, then the newest list, then id (stable tie-break).
 *   4. The first list that has an override for the service wins; services
 *      with no override fall through to the price book.
 *
 * Everything above `// DATA ACCESS` is pure and unit-tested.
 */

import { supabase } from '@/lib/supabase';
import type { PriceBookItem } from '@/lib/priceBook';

// ============================================================
// TYPES
// ============================================================

export type PriceListScope = 'customer' | 'contract' | 'tier';
export type PriceListTier = 'commercial' | 'membership' | 'contractor';
export type PriceListStatus = 'draft' | 'active' | 'archived';
export type AdjustmentType = 'fixed' | 'percent_off' | 'percent_up' | 'amount_off';
export type PriceListState = 'draft' | 'archived' | 'scheduled' | 'active' | 'expired';

export interface PriceList {
  id: string;
  account_owner_id: string;
  name: string;
  description: string | null;
  scope: PriceListScope;
  tier: PriceListTier | null;
  customer_id: string | null;
  contract_id: string | null;
  membership_plan_id: string | null;
  priority: number;
  status: PriceListStatus;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
  updated_at: string;
}

export interface PriceListItem {
  id: string;
  account_owner_id: string;
  price_list_id: string;
  price_book_item_id: string;
  adjustment_type: AdjustmentType;
  /** cents for fixed / amount_off, percent for percent_off / percent_up */
  value: number;
  created_at: string;
  updated_at: string;
}

export interface PricingContext {
  customerId: string | null;
  customerType: 'residential' | 'commercial' | null;
  customerTags: string[];
  /** Contracts the job/quote is priced under (usually the customer's active contracts). */
  contractIds: string[];
  /** plan_id of each of the customer's active memberships (null = plan unknown). */
  activeMembershipPlanIds: (string | null)[];
}

export const EMPTY_PRICING_CONTEXT: PricingContext = {
  customerId: null,
  customerType: null,
  customerTags: [],
  contractIds: [],
  activeMembershipPlanIds: [],
};

export interface ResolvedPrice {
  price_cents: number;
  price_max_cents: number | null;
  base_price_cents: number;
  base_price_max_cents: number | null;
  source: 'price_book' | 'price_list';
  list: PriceList | null;
  adjustment: PriceListItem | null;
  /** base minus resolved (negative when a list raises the price). */
  savings_cents: number;
  /** True when the resolved price is under the item's recorded cost. */
  below_cost: boolean;
}

// ============================================================
// LABELS
// ============================================================

export const SCOPE_LABELS: Record<PriceListScope, string> = {
  customer: 'Customer',
  contract: 'Contract',
  tier: 'Tier',
};

export const TIER_LABELS: Record<PriceListTier, string> = {
  commercial: 'Commercial',
  membership: 'Membership',
  contractor: 'Contractor',
};

export const ADJUSTMENT_LABELS: Record<AdjustmentType, string> = {
  fixed: 'Fixed price',
  percent_off: '% off',
  percent_up: '% markup',
  amount_off: '$ off',
};

export const STATE_LABELS: Record<PriceListState, string> = {
  draft: 'Draft',
  archived: 'Archived',
  scheduled: 'Scheduled',
  active: 'Active',
  expired: 'Expired',
};

export const PRICE_LIST_ASSUMPTIONS = {
  /** Tier 'contractor' matches customers carrying this tag (case-insensitive). */
  contractorTag: 'contractor',
  /** Lists ending within this many days are flagged "ending soon". */
  endingSoonDays: 30,
  maxPriority: 1000,
  maxMarkupPercent: 500,
} as const;

const SCOPE_RANK: Record<PriceListScope, number> = { tier: 1, customer: 2, contract: 3 };
const FAR_FUTURE = '9999-12-31';

// ============================================================
// DATES
// ============================================================

export function todayIso(d: Date = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function formatDateRange(from: string, to: string | null): string {
  return to ? `${from} → ${to}` : `${from} → open-ended`;
}

// ============================================================
// STATE + APPLICABILITY
// ============================================================

export function isEffective(list: PriceList, on: string): boolean {
  return list.status === 'active' && list.effective_from <= on && (list.effective_to === null || on <= list.effective_to);
}

export function getListState(list: PriceList, on: string): PriceListState {
  if (list.status === 'draft') return 'draft';
  if (list.status === 'archived') return 'archived';
  if (list.effective_from > on) return 'scheduled';
  if (list.effective_to !== null && list.effective_to < on) return 'expired';
  return 'active';
}

export function isEndingSoon(list: PriceList, on: string): boolean {
  if (getListState(list, on) !== 'active' || list.effective_to === null) return false;
  return list.effective_to <= addDaysIso(on, PRICE_LIST_ASSUMPTIONS.endingSoonDays);
}

export function isApplicable(list: PriceList, ctx: PricingContext): boolean {
  switch (list.scope) {
    case 'customer':
      return ctx.customerId !== null && list.customer_id === ctx.customerId;
    case 'contract':
      return list.contract_id !== null && ctx.contractIds.includes(list.contract_id);
    case 'tier':
      if (list.tier === 'commercial') return ctx.customerType === 'commercial';
      if (list.tier === 'contractor') {
        const tag = PRICE_LIST_ASSUMPTIONS.contractorTag;
        return ctx.customerTags.some((t) => t.trim().toLowerCase() === tag);
      }
      if (list.tier === 'membership') {
        if (ctx.activeMembershipPlanIds.length === 0) return false;
        return list.membership_plan_id === null || ctx.activeMembershipPlanIds.includes(list.membership_plan_id);
      }
      return false;
    default:
      return false;
  }
}

export function compareLists(a: PriceList, b: PriceList): number {
  return (
    SCOPE_RANK[b.scope] - SCOPE_RANK[a.scope] ||
    b.priority - a.priority ||
    b.effective_from.localeCompare(a.effective_from) ||
    b.created_at.localeCompare(a.created_at) ||
    a.id.localeCompare(b.id)
  );
}

function targetKey(l: PriceList): string {
  if (l.scope === 'customer') return `customer:${l.customer_id}`;
  if (l.scope === 'contract') return `contract:${l.contract_id}`;
  return `tier:${l.tier}:${l.membership_plan_id ?? 'any'}`;
}

/** Active lists hitting the same target with the same priority and overlapping dates are ambiguous. */
export function findConflictingListIds(lists: PriceList[]): Set<string> {
  const out = new Set<string>();
  const active = lists.filter((l) => l.status === 'active');
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (targetKey(a) !== targetKey(b) || a.priority !== b.priority) continue;
      if (a.effective_from <= (b.effective_to ?? FAR_FUTURE) && b.effective_from <= (a.effective_to ?? FAR_FUTURE)) {
        out.add(a.id);
        out.add(b.id);
      }
    }
  }
  return out;
}

// ============================================================
// PRICING MATH
// ============================================================

export function applyAdjustment(
  base: Pick<PriceBookItem, 'price_cents' | 'price_max_cents'>,
  type: AdjustmentType,
  rawValue: number,
): { price_cents: number; price_max_cents: number | null } {
  const value = Number(rawValue);
  const apply = (n: number): number => {
    switch (type) {
      case 'percent_off':
        return Math.max(0, Math.round(n * (1 - value / 100)));
      case 'percent_up':
        return Math.max(0, Math.round(n * (1 + value / 100)));
      case 'amount_off':
        return Math.max(0, n - Math.round(value));
      default:
        return n;
    }
  };

  if (type === 'fixed') {
    const price = Math.max(0, Math.round(value));
    return { price_cents: price, price_max_cents: base.price_max_cents === null ? null : price };
  }
  return {
    price_cents: apply(base.price_cents),
    price_max_cents: base.price_max_cents === null ? null : apply(base.price_max_cents),
  };
}

/** Resolves every given price-book item for one buyer on one date. */
export function resolvePrices(
  items: PriceBookItem[],
  lists: PriceList[],
  listItems: PriceListItem[],
  ctx: PricingContext,
  on: string,
): Map<string, ResolvedPrice> {
  const applicable = lists.filter((l) => isEffective(l, on) && isApplicable(l, ctx)).sort(compareLists);

  const overrides = new Map<string, Map<string, PriceListItem>>();
  for (const li of listItems) {
    let m = overrides.get(li.price_list_id);
    if (!m) overrides.set(li.price_list_id, (m = new Map()));
    m.set(li.price_book_item_id, li);
  }

  const result = new Map<string, ResolvedPrice>();
  for (const item of items) {
    let list: PriceList | null = null;
    let adjustment: PriceListItem | null = null;
    for (const l of applicable) {
      const hit = overrides.get(l.id)?.get(item.id);
      if (hit) {
        list = l;
        adjustment = hit;
        break;
      }
    }

    const adjusted = adjustment ? applyAdjustment(item, adjustment.adjustment_type, adjustment.value) : null;
    const price_cents = adjusted ? adjusted.price_cents : item.price_cents;
    result.set(item.id, {
      price_cents,
      price_max_cents: adjusted ? adjusted.price_max_cents : item.price_max_cents,
      base_price_cents: item.price_cents,
      base_price_max_cents: item.price_max_cents,
      source: adjustment ? 'price_list' : 'price_book',
      list,
      adjustment,
      savings_cents: item.price_cents - price_cents,
      below_cost: item.cost_cents !== null && item.cost_cents !== undefined && price_cents < item.cost_cents,
    });
  }
  return result;
}

export function resolvePrice(
  item: PriceBookItem,
  lists: PriceList[],
  listItems: PriceListItem[],
  ctx: PricingContext,
  on: string,
): ResolvedPrice {
  return resolvePrices([item], lists, listItems, ctx, on).get(item.id) as ResolvedPrice;
}

export function describeAdjustment(type: AdjustmentType, value: number): string {
  const v = Number(value);
  const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
  switch (type) {
    case 'fixed':
      return `Fixed ${dollars(v)}`;
    case 'amount_off':
      return `${dollars(v)} off`;
    case 'percent_off':
      return `${v}% off`;
    default:
      return `${v}% markup`;
  }
}

// ============================================================
// FORMS + VALIDATION
// ============================================================

export interface PriceListFormState {
  name: string;
  description: string;
  scope: PriceListScope;
  tier: PriceListTier;
  customer_id: string;
  contract_id: string;
  membership_plan_id: string;
  priority: string;
  effective_from: string;
  effective_to: string;
}

export function emptyPriceListForm(): PriceListFormState {
  return {
    name: '',
    description: '',
    scope: 'customer',
    tier: 'commercial',
    customer_id: '',
    contract_id: '',
    membership_plan_id: '',
    priority: '0',
    effective_from: todayIso(),
    effective_to: '',
  };
}

export function listToForm(l: PriceList): PriceListFormState {
  return {
    name: l.name,
    description: l.description ?? '',
    scope: l.scope,
    tier: l.tier ?? 'commercial',
    customer_id: l.customer_id ?? '',
    contract_id: l.contract_id ?? '',
    membership_plan_id: l.membership_plan_id ?? '',
    priority: String(l.priority),
    effective_from: l.effective_from,
    effective_to: l.effective_to ?? '',
  };
}

export function formToListPayload(form: PriceListFormState, accountOwnerId: string) {
  const name = form.name.trim();
  if (!name) throw new Error('Give this price list a name.');
  if (name.length > 120) throw new Error('The name is too long (120 characters max).');

  if (form.scope === 'customer' && !form.customer_id) throw new Error('Choose the customer this list is for.');
  if (form.scope === 'contract' && !form.contract_id) throw new Error('Choose the contract this list is for.');

  const priority = Number(form.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > PRICE_LIST_ASSUMPTIONS.maxPriority) {
    throw new Error(`Priority must be a whole number from 0 to ${PRICE_LIST_ASSUMPTIONS.maxPriority}.`);
  }

  if (!isIsoDate(form.effective_from)) throw new Error('Enter a valid start date.');
  const to = form.effective_to.trim();
  if (to && !isIsoDate(to)) throw new Error('Enter a valid end date, or leave it open-ended.');
  if (to && to < form.effective_from) throw new Error('The end date must be on or after the start date.');

  return {
    account_owner_id: accountOwnerId,
    name,
    description: form.description.trim() || null,
    scope: form.scope,
    tier: form.scope === 'tier' ? form.tier : null,
    customer_id: form.scope === 'customer' ? form.customer_id : null,
    contract_id: form.scope === 'contract' ? form.contract_id : null,
    membership_plan_id: form.scope === 'tier' && form.tier === 'membership' && form.membership_plan_id ? form.membership_plan_id : null,
    priority,
    effective_from: form.effective_from,
    effective_to: to || null,
  };
}

/** Dollar/percent text from the form → the stored `value`. */
export function parseAdjustmentValue(type: AdjustmentType, raw: string): number {
  const n = Number(raw);
  if (!raw.trim() || !Number.isFinite(n) || n < 0) throw new Error('Enter a valid amount.');
  if (type === 'percent_off') {
    if (n > 100) throw new Error('A percentage discount can’t exceed 100%.');
    return Math.round(n * 100) / 100;
  }
  if (type === 'percent_up') {
    if (n > PRICE_LIST_ASSUMPTIONS.maxMarkupPercent) throw new Error(`A markup can’t exceed ${PRICE_LIST_ASSUMPTIONS.maxMarkupPercent}%.`);
    return Math.round(n * 100) / 100;
  }
  return Math.round(n * 100); // dollars → cents
}

/** Stored `value` → text for the form input. */
export function adjustmentValueToInput(type: AdjustmentType, value: number): string {
  const v = Number(value);
  return type === 'fixed' || type === 'amount_off' ? String(v / 100) : String(v);
}

// ============================================================
// DATA ACCESS — every query is scoped to the account owner
// (RLS enforces the same boundary server-side).
// ============================================================

function fail(message: string, error: { message?: string } | null): never {
  throw new Error(error?.message ? `${message}: ${error.message}` : message);
}

export async function fetchPriceListData(accountOwnerId: string): Promise<{ lists: PriceList[]; items: PriceListItem[] }> {
  const [listsRes, itemsRes] = await Promise.all([
    supabase.from('price_lists').select('*').eq('account_owner_id', accountOwnerId).order('created_at', { ascending: false }),
    supabase.from('price_list_items').select('*').eq('account_owner_id', accountOwnerId),
  ]);
  if (listsRes.error) fail('Could not load price lists', listsRes.error);
  if (itemsRes.error) fail('Could not load price list items', itemsRes.error);
  return { lists: (listsRes.data as PriceList[]) ?? [], items: (itemsRes.data as PriceListItem[]) ?? [] };
}

export async function fetchPriceBook(accountOwnerId: string): Promise<PriceBookItem[]> {
  const { data, error } = await supabase
    .from('price_book_items')
    .select('*')
    .eq('user_id', accountOwnerId)
    .eq('active', true)
    .order('service_name', { ascending: true });
  if (error) fail('Could not load the price book', error);
  return (data as PriceBookItem[]) ?? [];
}

export interface RefOption {
  id: string;
  label: string;
}

export async function fetchReferenceOptions(accountOwnerId: string): Promise<{ contracts: RefOption[]; plans: RefOption[] }> {
  const [contractsRes, plansRes] = await Promise.all([
    supabase
      .from('commercial_contracts')
      .select('id, contract_name, contract_number')
      .eq('user_id', accountOwnerId)
      .in('status', ['draft', 'active', 'expiring_soon'])
      .order('created_at', { ascending: false })
      .limit(500),
    supabase.from('membership_plans').select('id, name').eq('user_id', accountOwnerId).eq('active', true).order('name'),
  ]);
  if (contractsRes.error) fail('Could not load contracts', contractsRes.error);
  if (plansRes.error) fail('Could not load membership plans', plansRes.error);
  return {
    contracts: (contractsRes.data ?? []).map((c) => ({
      id: c.id as string,
      label: `${c.contract_name as string}${c.contract_number ? ` · ${c.contract_number as string}` : ''}`,
    })),
    plans: (plansRes.data ?? []).map((p) => ({ id: p.id as string, label: p.name as string })),
  };
}

export async function searchCustomers(accountOwnerId: string, term: string): Promise<RefOption[]> {
  const clean = term.trim().replace(/[%_,()"\\]/g, ' ');
  let q = supabase.from('customers').select('id, name, phone').eq('user_id', accountOwnerId).order('name').limit(8);
  if (clean) q = q.or(`name.ilike.%${clean}%,phone.ilike.%${clean}%`);
  const { data, error } = await q;
  if (error) fail('Could not search customers', error);
  return (data ?? []).map((c) => ({ id: c.id as string, label: `${c.name as string}${c.phone ? ` · ${c.phone as string}` : ''}` }));
}

export async function fetchCustomerNames(accountOwnerId: string, ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const { data, error } = await supabase.from('customers').select('id, name').eq('user_id', accountOwnerId).in('id', ids);
  if (error) fail('Could not load customers', error);
  return Object.fromEntries((data ?? []).map((c) => [c.id as string, c.name as string]));
}

/** Creates (returns the new id) or updates a list. account_owner_id is never rewritten on edit. */
export async function savePriceList(payload: ReturnType<typeof formToListPayload>, id?: string): Promise<string> {
  if (id) {
    const { account_owner_id: ownerId, ...rest } = payload;
    const { error } = await supabase.from('price_lists').update(rest).eq('id', id).eq('account_owner_id', ownerId);
    if (error) fail('Could not save this price list', error);
    return id;
  }
  const { data, error } = await supabase.from('price_lists').insert(payload).select('id').single();
  if (error || !data) fail('Could not create this price list', error);
  return (data as { id: string }).id;
}

export async function setPriceListStatus(id: string, accountOwnerId: string, status: PriceListStatus): Promise<void> {
  const { error } = await supabase.from('price_lists').update({ status }).eq('id', id).eq('account_owner_id', accountOwnerId);
  if (error) fail('Could not update this price list', error);
}

export async function deletePriceList(id: string, accountOwnerId: string): Promise<void> {
  const { error } = await supabase.from('price_lists').delete().eq('id', id).eq('account_owner_id', accountOwnerId);
  if (error) fail('Could not delete this price list', error);
}

export async function upsertPriceListItem(input: {
  accountOwnerId: string;
  priceListId: string;
  priceBookItemId: string;
  adjustmentType: AdjustmentType;
  value: number;
}): Promise<void> {
  const { error } = await supabase.from('price_list_items').upsert(
    {
      account_owner_id: input.accountOwnerId,
      price_list_id: input.priceListId,
      price_book_item_id: input.priceBookItemId,
      adjustment_type: input.adjustmentType,
      value: input.value,
    },
    { onConflict: 'price_list_id,price_book_item_id' },
  );
  if (error) fail('Could not save this override', error);
}

export async function deletePriceListItem(id: string, accountOwnerId: string): Promise<void> {
  const { error } = await supabase.from('price_list_items').delete().eq('id', id).eq('account_owner_id', accountOwnerId);
  if (error) fail('Could not remove this override', error);
}

/**
 * Builds the pricing context for one customer on one date. This is the single
 * entry point other flows (quotes, invoices, the voice price lookup) should
 * call before `resolvePrices`.
 */
export async function buildPricingContext(accountOwnerId: string, customerId: string, on: string): Promise<PricingContext> {
  const [custRes, contractsRes, membershipsRes] = await Promise.all([
    supabase.from('customers').select('id, customer_type, tags').eq('user_id', accountOwnerId).eq('id', customerId).maybeSingle(),
    supabase
      .from('commercial_contracts')
      .select('id, start_date, end_date')
      .eq('user_id', accountOwnerId)
      .eq('customer_id', customerId)
      .in('status', ['active', 'expiring_soon']),
    supabase.from('memberships').select('plan_id').eq('user_id', accountOwnerId).eq('customer_id', customerId).eq('status', 'active'),
  ]);
  if (custRes.error) fail('Could not load the customer', custRes.error);
  if (contractsRes.error) fail('Could not load contracts', contractsRes.error);
  if (membershipsRes.error) fail('Could not load memberships', membershipsRes.error);

  const cust = custRes.data as { customer_type: 'residential' | 'commercial'; tags: string[] | null } | null;
  return {
    customerId,
    customerType: cust?.customer_type ?? null,
    customerTags: cust?.tags ?? [],
    contractIds: (contractsRes.data ?? [])
      .filter((c) => (!c.start_date || (c.start_date as string) <= on) && (!c.end_date || (c.end_date as string) >= on))
      .map((c) => c.id as string),
    activeMembershipPlanIds: (membershipsRes.data ?? []).map((m) => (m.plan_id as string | null) ?? null),
  };
}
