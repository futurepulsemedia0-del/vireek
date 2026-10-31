import { describe, expect, it } from 'vitest';
import {
  MAX_IMPORT_ROWS, autoMapColumns, orderToRow, parseForwardedEmail, parseWorkOrderCsv, rowToOrder, stripBom,
} from './workOrderGuardImport';

const TZ = 'America/New_York';
const parse = (lines: string[], mapping?: Parameters<typeof parseWorkOrderCsv>[1]['mapping']) =>
  parseWorkOrderCsv(lines.join('\n'), { timezone: TZ, mapping });

describe('CSV edge cases', () => {
  it('strips a UTF-8 BOM so the first header still maps', () => {
    const r = parse(['﻿WO Number,Received', '1001,7/1/2026 9:00 AM']);
    expect(r.errors).toEqual([]);
    expect(r.mapping.woNumber).toBe('WO Number');
    expect(r.orders[0].woNumber).toBe('1001');
    expect(stripBom('﻿abc')).toBe('abc');
  });
  it('handles CRLF, quoted commas, escaped quotes and newlines inside quotes', () => {
    const r = parseWorkOrderCsv('WO Number,Location,Received\r\n7,"Store #1, ""North""\nWing",7/1/2026 9:00 AM\r\n', { timezone: TZ });
    expect(r.errors).toEqual([]);
    expect(r.orders[0].location).toBe('Store #1, "North" Wing');
  });
  it('skips a row with a bad date and reports its row number and field', () => {
    const r = parse(['WO Number,Received', '1,7/1/2026 9:00 AM', '2,13/45/2026', '3,not a date', '4,7/2/2026 9:00 AM']);
    expect(r.orders.map((o) => o.woNumber)).toEqual(['1', '4']);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatchObject({ row: 3, field: 'receivedAt' });
    expect(r.errors[0].message).toContain('not a recognised date');
    expect(r.errors[1].row).toBe(4);
  });
  it('a bad OPTIONAL date also skips the row instead of silently dropping the value', () => {
    const r = parse(['WO Number,Received,Accepted', '1,7/1/2026 9:00 AM,tomorrow-ish']);
    expect(r.orders).toHaveLength(0);
    expect(r.errors[0]).toMatchObject({ row: 2, field: 'acceptedAt' });
  });
  it('rejects unparseable and negative money', () => {
    const r = parse(['WO Number,Received,NTE,Invoice Total', '1,7/1/2026 9:00 AM,abc,', '2,7/1/2026 9:00 AM,$100.00,-$5.00', '3,7/1/2026 9:00 AM,"$1,250.50",']);
    expect(r.errors.map((e) => e.field)).toEqual(['nte', 'invoiceTotal']);
    expect(r.orders[0].nteCents).toBe(125050);
  });
  it('reports missing required columns instead of guessing', () => {
    const r = parse(['Foo,Bar', '1,2']);
    expect(r.missingRequired).toEqual(['woNumber', 'receivedAt']);
    expect(r.orders).toEqual([]);
  });
  it('handles an empty file and a header-only file', () => {
    expect(parseWorkOrderCsv('', { timezone: TZ }).errors[0].message).toContain('no rows');
    expect(parseWorkOrderCsv('WO Number,Received\n', { timezone: TZ })).toMatchObject({ orders: [], errors: [], rowCount: 0 });
  });
  it('keeps the first of a duplicate WO number and reports the rest', () => {
    const r = parse(['WO Number,Received', 'A-1,7/1/2026 9:00 AM', 'a-1,7/2/2026 9:00 AM']);
    expect(r.orders).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ row: 3, field: 'woNumber' });
  });
  it('rejects unknown statuses and proposal statuses', () => {
    const r = parse(['WO Number,Received,Final Status,Proposal Status', '1,7/1/2026 9:00 AM,bananas,', '2,7/1/2026 9:00 AM,paid,maybe']);
    expect(r.errors.map((e) => e.field)).toEqual(['outcome', 'proposalStatus']);
  });
  it('accepts ISO, US and text-month dates in the profile timezone', () => {
    const r = parse(['WO Number,Received', '1,2026-07-01T13:00:00Z', '2,7/1/2026 9:00 AM', '3,"Jul 1, 2026 9:00 AM"', '4,2026-07-01']);
    expect(r.orders.map((o) => o.receivedAt)).toEqual([
      '2026-07-01T13:00:00.000Z', '2026-07-01T13:00:00.000Z', '2026-07-01T13:00:00.000Z', '2026-07-01T04:00:00.000Z',
    ]);
  });
  it('converts check-in distances in miles, feet and km', () => {
    const r = parse(['WO Number,Received,Check-in Distance', '1,7/1/2026 9:00 AM,0.2 mi', '2,7/1/2026 9:00 AM,528 ft', '3,7/1/2026 9:00 AM,1 km', '4,7/1/2026 9:00 AM,far']);
    expect(r.orders.map((o) => o.checkInDistanceMiles)).toEqual([0.2, 0.1, 0.621]);
    expect(r.errors[0].field).toBe('checkInDistance');
  });
  it('defaults: invoice count from invoice #, blank priority -> normal, blank status -> open', () => {
    const r = parse(['WO Number,Received,Invoice #', '1,7/1/2026 9:00 AM,INV-1', '2,7/1/2026 9:00 AM,']);
    expect(r.orders.map((o) => [o.invoiceCount, o.priority, o.outcome])).toEqual([[1, 'normal', 'open'], [0, 'normal', 'open']]);
  });
  it('lets the user override the column mapping', () => {
    const r = parse(['ID,When,Notes', 'X9,7/1/2026 9:00 AM,hi'], { woNumber: 'ID', receivedAt: 'When', location: 'Nope' });
    expect(r.orders[0].woNumber).toBe('X9');
    expect(r.orders[0].location).toBeNull();
  });
  it('refuses more rows than the limit', () => {
    const lines = ['WO Number,Received', ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `${i},7/1/2026 9:00 AM`)];
    const r = parse(lines);
    expect(r.orders).toEqual([]);
    expect(r.errors[0].message).toContain('limit');
  });
  it('maps common portal header spellings', () => {
    const m = autoMapColumns(['Work Order #', 'Date Received', 'Store', 'Not To Exceed', 'Invoice Amount', 'Check-In Distance (mi)']);
    expect(m).toMatchObject({ woNumber: 'Work Order #', receivedAt: 'Date Received', location: 'Store', nte: 'Not To Exceed', invoiceTotal: 'Invoice Amount', checkInDistance: 'Check-In Distance (mi)' });
  });
});

describe('RPC payload round trip', () => {
  it('orderToRow / rowToOrder are inverse for parsed orders', () => {
    const r = parse(['WO Number,Received,Accepted,NTE,Invoice #,Labor,Technicians,Invoice Total,Final Status', '1,7/1/2026 9:00 AM,7/1/2026 9:10 AM,$500.00,INV-1,$400.00,2,$400.00,Paid']);
    const o = r.orders[0];
    expect(rowToOrder({ id: 'abc', ...orderToRow(o) })).toEqual({ ...o, id: 'abc' });
  });
});

describe('forwarded email', () => {
  const email = [
    'From: notifications@portal.example', 'Subject: New Work Order #WO-77812', '',
    'Work Order: WO-77812', 'Priority: Emergency', 'Location: Store #12, Main St', 'NTE: $450.00', 'Date Received: 9/2/2026 7:15 AM',
  ].join('\n');
  it('extracts a work order from "Label: value" lines', () => {
    const r = parseForwardedEmail(email, { timezone: TZ });
    expect(r.errors).toEqual([]);
    expect(r.orders[0]).toMatchObject({ woNumber: 'WO-77812', priority: 'emergency', nteCents: 45000, location: 'Store #12, Main St', receivedAt: '2026-09-02T11:15:00.000Z' });
  });
  it('falls back to the subject line for the WO number and to a Sent/Date header for the received time', () => {
    const r = parseForwardedEmail('Subject: Fwd: Work Order #WO-9001 assigned\nSent: 9/3/2026 8:00 AM\nNTE: $100', { timezone: TZ });
    expect(r.orders[0]).toMatchObject({ woNumber: 'WO-9001', receivedAt: '2026-09-03T12:00:00.000Z' });
  });
  it('reports what is missing instead of guessing', () => {
    const r = parseForwardedEmail('Work Order: WO-1\nNTE: $50.00', { timezone: TZ });
    expect(r.orders).toEqual([]);
    expect(r.missingRequired).toEqual(['receivedAt']);
    expect(r.errors[0].field).toBe('receivedAt');
    expect(parseForwardedEmail('hello there', { timezone: TZ }).missingRequired).toEqual(['woNumber', 'receivedAt']);
  });
  it('ignores HTML tags from rich-text forwards', () => {
    const r = parseForwardedEmail('<div>Work Order: WO-5</div>\n<div>Date Received: 9/2/2026 7:15 AM</div>', { timezone: TZ });
    expect(r.orders[0].woNumber).toBe('WO-5');
  });
});
