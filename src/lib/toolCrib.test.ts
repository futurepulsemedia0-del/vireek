import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: {} }));

import {
  alertLoans,
  buildToolCsvColumns,
  buildToolCsvRows,
  cribErrorMessage,
  dueLabel,
  filterTools,
  findToolByCode,
  formatCostCents,
  formatDuration,
  groupLoansByTechnician,
  loanState,
  normalizeScanCode,
  parseDollarsToCents,
  parseWholeNumber,
  summarizeCrib,
  toolToInput,
  type CribLoan,
  type CribTool,
} from './toolCrib';

const H = 3_600_000;
const NOW = Date.parse('2027-12-01T12:00:00Z');
const at = (hoursFromNow: number) => new Date(NOW + hoursFromNow * H).toISOString();

let seq = 0;
const tool = (over: Partial<CribTool> = {}): CribTool => {
  seq += 1;
  return {
    id: `t${seq}`,
    user_id: 'owner',
    tool_number: `T-${seq}`,
    name: `Tool ${seq}`,
    category: null,
    serial_number: null,
    barcode: null,
    purchase_cost_cents: null,
    default_loan_hours: null,
    status: 'available',
    notes: null,
    created_at: at(-100),
    updated_at: at(-100),
    ...over,
  };
};

const loan = (over: Partial<CribLoan> = {}): CribLoan => {
  seq += 1;
  return {
    id: `l${seq}`,
    user_id: 'owner',
    tool_id: `t${seq}`,
    tool_name: `Tool ${seq}`,
    tool_number: `T-${seq}`,
    technician_id: 'tech-a',
    technician_name: 'Ana',
    status: 'out',
    checked_out_at: at(-10),
    due_at: at(10),
    out_condition: 'good',
    out_note: null,
    extended_count: 0,
    returned_at: null,
    return_condition: null,
    return_note: null,
    lost_at: null,
    lost_note: null,
    overdue_alerted_at: null,
    lost_alerted_at: null,
    ...over,
  };
};

describe('loanState', () => {
  it('is on_time well before the due time', () => {
    expect(loanState({ status: 'out', due_at: at(10) }, NOW, 72)).toBe('on_time');
  });
  it('is due_soon inside the 2h window', () => {
    expect(loanState({ status: 'out', due_at: at(1.5) }, NOW, 72)).toBe('due_soon');
    expect(loanState({ status: 'out', due_at: at(2) }, NOW, 72)).toBe('due_soon');
  });
  it('is overdue after the due time, until the lost threshold', () => {
    expect(loanState({ status: 'out', due_at: at(-1) }, NOW, 72)).toBe('overdue');
    expect(loanState({ status: 'out', due_at: at(-72) }, NOW, 72)).toBe('overdue');
  });
  it('is suspected_lost once the threshold passes', () => {
    expect(loanState({ status: 'out', due_at: at(-73) }, NOW, 72)).toBe('suspected_lost');
  });
  it('maps closed loans by status, ignoring dates', () => {
    expect(loanState({ status: 'returned', due_at: at(-500) }, NOW, 72)).toBe('returned');
    expect(loanState({ status: 'lost', due_at: at(-500) }, NOW, 72)).toBe('lost');
  });
  it('treats an unparseable date as on_time instead of crashing', () => {
    expect(loanState({ status: 'out', due_at: 'nope' }, NOW, 72)).toBe('on_time');
  });
});

describe('formatDuration / dueLabel', () => {
  it('formats minutes, hours and days compactly', () => {
    expect(formatDuration(30_000)).toBe('under 1m');
    expect(formatDuration(45 * 60_000)).toBe('45m');
    expect(formatDuration(5 * H + 10 * 60_000)).toBe('5h 10m');
    expect(formatDuration(5 * H)).toBe('5h');
    expect(formatDuration(51 * H)).toBe('2d 3h');
    expect(formatDuration(48 * H)).toBe('2d');
    expect(formatDuration(-5000)).toBe('under 1m');
  });
  it('words upcoming and late loans', () => {
    expect(dueLabel({ status: 'out', due_at: at(3) }, NOW)).toBe('Due in 3h');
    expect(dueLabel({ status: 'out', due_at: at(-26) }, NOW)).toBe('Overdue by 1d 2h');
    expect(dueLabel({ status: 'returned', due_at: at(-26) }, NOW)).toBe('Returned');
    expect(dueLabel({ status: 'lost', due_at: at(-26) }, NOW)).toBe('Marked lost');
  });
});

describe('summarizeCrib', () => {
  it('counts tool statuses (retired excluded) and late loans', () => {
    const tools = [
      tool({ status: 'available' }),
      tool({ status: 'available' }),
      tool({ status: 'checked_out' }),
      tool({ status: 'checked_out' }),
      tool({ status: 'checked_out' }),
      tool({ status: 'maintenance' }),
      tool({ status: 'lost' }),
      tool({ status: 'retired' }),
    ];
    const loans = [
      loan({ due_at: at(10) }),
      loan({ due_at: at(1) }),
      loan({ due_at: at(-5) }),
      loan({ due_at: at(-100) }),
      loan({ status: 'lost', due_at: at(-200) }),
    ];
    const s = summarizeCrib(tools, loans, NOW, 72);
    expect(s).toEqual({ total: 7, available: 2, out: 3, dueSoon: 1, overdue: 1, suspectedLost: 1, lost: 1, maintenance: 1 });
  });
});

describe('alertLoans', () => {
  it('returns only overdue / possibly-lost open loans, most overdue first', () => {
    const a = loan({ due_at: at(-5) });
    const b = loan({ due_at: at(-100) });
    const c = loan({ due_at: at(5) });
    const d = loan({ status: 'returned', due_at: at(-50) });
    const e = loan({ status: 'lost', due_at: at(-300) });
    expect(alertLoans([a, c, d, b, e], NOW, 72).map((l) => l.id)).toEqual([b.id, a.id]);
  });
});

describe('filterTools', () => {
  const tools = [
    tool({ name: 'Hilti Drill', tool_number: 'DR-01', category: 'Power', barcode: '111' }),
    tool({ name: 'Manifold Gauge', tool_number: 'MG-02', serial_number: 'SN-9', status: 'checked_out' }),
    tool({ name: 'Old Ladder', tool_number: 'LD-03', status: 'retired' }),
  ];
  it('hides retired tools under "all"', () => {
    expect(filterTools(tools, '', 'all').map((t) => t.tool_number)).toEqual(['DR-01', 'MG-02']);
  });
  it('shows retired tools only when asked', () => {
    expect(filterTools(tools, '', 'retired').map((t) => t.tool_number)).toEqual(['LD-03']);
  });
  it('searches name, tag, category, serial and barcode case-insensitively', () => {
    expect(filterTools(tools, 'drill', 'all')).toHaveLength(1);
    expect(filterTools(tools, 'mg-02', 'all')).toHaveLength(1);
    expect(filterTools(tools, 'POWER', 'all')).toHaveLength(1);
    expect(filterTools(tools, 'sn-9', 'all')).toHaveLength(1);
    expect(filterTools(tools, '111', 'all')).toHaveLength(1);
    expect(filterTools(tools, 'zzz', 'all')).toHaveLength(0);
  });
  it('combines a status filter with a search', () => {
    expect(filterTools(tools, 'gauge', 'available')).toHaveLength(0);
    expect(filterTools(tools, 'gauge', 'checked_out')).toHaveLength(1);
  });
});

describe('findToolByCode / normalizeScanCode', () => {
  const tools = [
    tool({ tool_number: 'DR-01', barcode: 'ABC123' }),
    tool({ tool_number: 'ABC123', barcode: null }),
    tool({ tool_number: 'MG-02', barcode: null }),
  ];
  it('strips scanner control characters', () => {
    expect(normalizeScanCode('  AB\r\n12\t')).toBe('AB12');
    expect(normalizeScanCode('x'.repeat(300))).toHaveLength(128);
  });
  it('prefers an exact barcode over a tag number', () => {
    expect(findToolByCode(tools, 'abc123\n')?.tool_number).toBe('DR-01');
  });
  it('falls back to the tag number, case-insensitively', () => {
    expect(findToolByCode(tools, 'mg-02')?.tool_number).toBe('MG-02');
  });
  it('returns null for blank or unknown codes', () => {
    expect(findToolByCode(tools, '   ')).toBeNull();
    expect(findToolByCode(tools, 'nope')).toBeNull();
  });
});

describe('groupLoansByTechnician', () => {
  it('groups open loans per technician, late people first, then by name', () => {
    const loans = [
      loan({ technician_id: 'b', technician_name: 'Ben', due_at: at(5) }),
      loan({ technician_id: 'a', technician_name: 'Ana', due_at: at(6) }),
      loan({ technician_id: 'c', technician_name: 'Cy', due_at: at(-3) }),
      loan({ technician_id: 'c', technician_name: 'Cy', due_at: at(-9) }),
      loan({ technician_id: 'a', technician_name: 'Ana', status: 'returned' }),
    ];
    const groups = groupLoansByTechnician(loans, NOW, 72);
    expect(groups.map((g) => g.name)).toEqual(['Cy', 'Ana', 'Ben']);
    expect(groups[0].late).toBe(2);
    expect(groups[0].loans.map((l) => l.due_at)).toEqual([at(-9), at(-3)]);
    expect(groups[1].loans).toHaveLength(1);
  });
  it('keeps loans whose technician was removed, grouped by saved name', () => {
    const loans = [loan({ technician_id: null, technician_name: 'Former Tech' }), loan({ technician_id: null, technician_name: 'Former Tech' })];
    const groups = groupLoansByTechnician(loans, NOW, 72);
    expect(groups).toHaveLength(1);
    expect(groups[0].loans).toHaveLength(2);
  });
});

describe('number parsing', () => {
  it('accepts whole numbers inside the range only', () => {
    expect(parseWholeNumber('24', 1, 720, 'Loan length')).toEqual({ ok: true, value: 24 });
    expect(parseWholeNumber(' 720 ', 1, 720, 'Loan length')).toEqual({ ok: true, value: 720 });
    expect(parseWholeNumber('0', 1, 720, 'Loan length').ok).toBe(false);
    expect(parseWholeNumber('721', 1, 720, 'Loan length').ok).toBe(false);
    expect(parseWholeNumber('1.5', 1, 720, 'Loan length').ok).toBe(false);
    expect(parseWholeNumber('', 1, 720, 'Loan length').ok).toBe(false);
  });
  it('converts dollars to cents, blank to null, rejects junk', () => {
    expect(parseDollarsToCents('49.99')).toEqual({ ok: true, value: 4999 });
    expect(parseDollarsToCents('$1,250')).toEqual({ ok: true, value: 125000 });
    expect(parseDollarsToCents('  ')).toEqual({ ok: true, value: null });
    expect(parseDollarsToCents('12.345').ok).toBe(false);
    expect(parseDollarsToCents('abc').ok).toBe(false);
    expect(parseDollarsToCents('2000000').ok).toBe(false);
  });
  it('formats cost', () => {
    expect(formatCostCents(null)).toBe('—');
    expect(formatCostCents(4900)).toBe('$49');
    expect(formatCostCents(4999)).toBe('$49.99');
  });
});

describe('toolToInput', () => {
  it('round-trips nullable fields into editable strings', () => {
    const input = toolToInput(tool({ category: 'Power', purchase_cost_cents: 12950, default_loan_hours: 48 }));
    expect(input.category).toBe('Power');
    expect(input.cost).toBe('129.50');
    expect(input.loan_hours).toBe('48');
    expect(input.barcode).toBe('');
  });
});

describe('CSV', () => {
  it('joins each tool to its open loan and hides cost without billing access', () => {
    const t1 = tool({ purchase_cost_cents: 5000, status: 'checked_out' });
    const t2 = tool();
    const rows = buildToolCsvRows([t1, t2], [loan({ tool_id: t1.id, technician_name: 'Ana', due_at: at(4) })]);
    expect(rows[0].loan?.technician_name).toBe('Ana');
    expect(rows[1].loan).toBeNull();
    expect(buildToolCsvColumns(false).map((c) => c.header)).not.toContain('Purchase cost');
    expect(buildToolCsvColumns(true).map((c) => c.header)).toContain('Purchase cost');
    const held = buildToolCsvColumns(false).find((c) => c.header === 'Held by');
    expect(held?.accessor(rows[0])).toBe('Ana');
    expect(held?.accessor(rows[1])).toBe('');
  });
});

describe('cribErrorMessage', () => {
  it('passes through human-written database messages', () => {
    expect(cribErrorMessage({ code: 'P0004', message: 'This tool is already checked out' })).toBe('This tool is already checked out');
    expect(cribErrorMessage({ code: 'P0001', message: 'Give the tool a name (max 120 characters)' })).toContain('Give the tool a name');
  });
  it('hides the generic authorisation error but keeps specific ones', () => {
    expect(cribErrorMessage({ code: '42501', message: 'Not authorised' })).toBe("You don't have permission to do that.");
    expect(cribErrorMessage({ code: '42501', message: 'You can only check tools out to yourself' })).toBe('You can only check tools out to yourself');
  });
  it('explains network failures and falls back otherwise', () => {
    expect(cribErrorMessage({ message: 'Failed to fetch' })).toMatch(/offline/i);
    expect(cribErrorMessage({ code: '57014', message: 'canceling statement' })).toBe('Something went wrong. Please try again.');
    expect(cribErrorMessage(null)).toBe('Something went wrong. Please try again.');
  });
});
