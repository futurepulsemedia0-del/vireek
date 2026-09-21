import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: {} }));

import {
  buildStockFitMap,
  recommendedAction,
  stockFitBonus,
  stockFitReason,
  type JobPartSourcing,
} from './truckStock';

const row = (over: Partial<JobPartSourcing>): JobPartSourcing => ({
  requirement_id: 'r1', job_id: 'j1', customer_name: 'A', service_type: null, scheduled_datetime: null,
  assigned_technician_id: 't1', part_id: 'p1', part_name: 'Capacitor', part_number: null,
  quantity_required: 3, van_qty: 1, warehouse_qty: 5, other_van_qty: 0, on_order_qty: 0,
  sourcing_status: 'warehouse_transfer', stock_shortfall: 0, order_shortfall: 0, ...over,
});

describe('recommendedAction', () => {
  it('tells dispatch how many to load from the warehouse', () => {
    expect(recommendedAction(row({}))).toEqual({ kind: 'restock', label: 'Load 2 from warehouse before dispatch' });
  });
  it('flags a must-order part with the shortfall', () => {
    expect(recommendedAction(row({ sourcing_status: 'order_required', order_shortfall: 4 })).label).toBe('Order 4 now');
  });
  it('is silent when the part is on the truck', () => {
    expect(recommendedAction(row({ sourcing_status: 'on_truck' })).kind).toBe('none');
  });
});

describe('stock fit', () => {
  const full = { job_id: 'j1', technician_id: 't1', parts_required: 2, parts_on_van: 2 };
  const half = { job_id: 'j1', technician_id: 't2', parts_required: 2, parts_on_van: 1 };
  it('indexes by job then technician', () => {
    expect(buildStockFitMap([full, half]).j1.t2).toBe(half);
  });
  it('scores a full kit above a partial one and ignores unknowns', () => {
    expect(stockFitBonus(full)).toBeGreaterThan(stockFitBonus(half));
    expect(stockFitBonus(undefined)).toBe(0);
    expect(stockFitReason(half)).toBe('Van has 1/2 required parts');
  });
});
