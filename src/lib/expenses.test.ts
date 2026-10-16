import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const calls: Array<[string, unknown[]]> = [];
  const chain: unknown = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
        return (...args: unknown[]) => {
          calls.push([prop, args]);
          return chain;
        };
      },
    },
  );
  return { calls, chain };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(() => h.chain) } }));

import {
  applyExtraction,
  canEditExpense,
  canReviewExpense,
  centsToInput,
  checkAllocations,
  dollarsToCents,
  fetchExpenses,
  findPossibleDuplicate,
  formatMoney,
  isValidISODate,
  monthRange,
  splitEvenly,
  validateExpenseForm,
  validateReceiptFile,
  type ExpenseCategory,
  type ExpenseFormState,
  type ReceiptExtraction,
} from '@/lib/expenses';

const categories: ExpenseCategory[] = [
  { id: 'c-fuel', name: 'Fuel & Vehicle', gl_account_code: '6100', is_system: true, active: true, sort_order: 10 },
  { id: 'c-old', name: 'Retired', gl_account_code: '6900', is_system: false, active: false, sort_order: 20 },
];

const baseForm: ExpenseFormState = {
  vendor_name: 'Shell',
  expense_date: '2027-03-10',
  amount: '42.17',
  tax: '',
  category_id: 'c-fuel',
  payment_method: 'personal_card',
  is_reimbursable: true,
  notes: '',
};
const TODAY = new Date(2027, 2, 10);

describe('money helpers', () => {
  it('parses plain amounts into cents', () => {
    expect(dollarsToCents('42.17')).toBe(4217);
    expect(dollarsToCents('$1,234.5')).toBe(123450);
    expect(dollarsToCents('7')).toBe(700);
  });
  it('rejects anything that is not a plain amount', () => {
    for (const bad of ['', 'abc', '-5', '1.234', '1e3', '1.2.3', '$']) expect(dollarsToCents(bad)).toBeNull();
  });
  it('formats and round-trips', () => {
    expect(formatMoney(123450)).toBe('$1,234.50');
    expect(formatMoney(null)).toBe('$0.00');
    expect(centsToInput(4217)).toBe('42.17');
  });
});

describe('dates', () => {
  it('validates real calendar dates only', () => {
    expect(isValidISODate('2027-02-28')).toBe(true);
    expect(isValidISODate('2027-02-30')).toBe(false);
    expect(isValidISODate('27-02-28')).toBe(false);
  });
  it('builds month ranges including leap years', () => {
    expect(monthRange(new Date(2028, 1, 10))).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(monthRange(new Date(2027, 11, 31))).toEqual({ start: '2027-12-01', end: '2027-12-31' });
  });
});

describe('validateExpenseForm', () => {
  const ok = (over: Partial<ExpenseFormState> = {}, submit = false, hasReceipt = false) =>
    validateExpenseForm({ ...baseForm, ...over }, { categories, submit, hasReceipt, today: TODAY });

  it('accepts a valid expense', () => {
    const v = ok();
    expect(v.errors).toEqual({});
    expect(v.amountCents).toBe(4217);
  });
  it('requires vendor, amount, date and an active category', () => {
    const v = ok({ vendor_name: ' ', amount: '0', expense_date: '', category_id: 'c-old' });
    expect(Object.keys(v.errors).sort()).toEqual(['amount', 'category_id', 'expense_date', 'vendor_name']);
  });
  it('blocks future dates and tax above the total', () => {
    expect(ok({ expense_date: '2027-03-20' }).errors.expense_date).toBeTruthy();
    expect(ok({ tax: '50.00' }).errors.tax).toBeTruthy();
    expect(ok({ tax: '3.10' }).taxCents).toBe(310);
  });
  it('requires a receipt from $75.00 on submit only', () => {
    expect(ok({ amount: '75.00' }, true, false).errors.receipt).toBeTruthy();
    expect(ok({ amount: '74.99' }, true, false).errors.receipt).toBeUndefined();
    expect(ok({ amount: '75.00' }, false, false).errors.receipt).toBeUndefined();
    expect(ok({ amount: '500.00' }, true, true).errors.receipt).toBeUndefined();
  });
});

describe('job allocation', () => {
  it('splits so the parts always add up exactly', () => {
    expect(splitEvenly(1000, 3)).toEqual([334, 333, 333]);
    expect(splitEvenly(1000, 3).reduce((a, b) => a + b, 0)).toBe(1000);
    expect(splitEvenly(1, 3)).toEqual([1, 0, 0]);
    expect(splitEvenly(500, 0)).toEqual([]);
  });
  it('treats no rows as overhead', () => {
    expect(checkAllocations(5000, []).ok).toBe(true);
  });
  it('requires the rows to equal the total', () => {
    expect(checkAllocations(5000, [{ job_id: 'j1', amount: '30.00' }, { job_id: 'j2', amount: '20.00' }]).ok).toBe(true);
    const short = checkAllocations(5000, [{ job_id: 'j1', amount: '30.00' }]);
    expect(short.ok).toBe(false);
    expect(short.remainingCents).toBe(2000);
    expect(checkAllocations(5000, [{ job_id: 'j1', amount: '60.00' }]).message).toContain('exceed');
  });
  it('rejects missing jobs, bad amounts and duplicate jobs', () => {
    expect(checkAllocations(5000, [{ job_id: '', amount: '50.00' }]).ok).toBe(false);
    expect(checkAllocations(5000, [{ job_id: 'j1', amount: 'x' }]).ok).toBe(false);
    expect(checkAllocations(5000, [{ job_id: 'j1', amount: '25.00' }, { job_id: 'j1', amount: '25.00' }]).ok).toBe(false);
  });
});

describe('workflow rules', () => {
  const sub = { submitted_by: 'u1', status: 'submitted' as const };
  it('lets only the submitter edit drafts and rejected claims', () => {
    expect(canEditExpense({ submitted_by: 'u1', status: 'draft' }, 'u1')).toBe(true);
    expect(canEditExpense({ submitted_by: 'u1', status: 'rejected' }, 'u1')).toBe(true);
    expect(canEditExpense({ submitted_by: 'u1', status: 'submitted' }, 'u1')).toBe(false);
    expect(canEditExpense({ submitted_by: 'u1', status: 'draft' }, 'u2')).toBe(false);
  });
  it('enforces segregation of duties for reviewers', () => {
    expect(canReviewExpense(sub, { uid: 'u2', ownerId: 'owner', isManager: true })).toBe(true);
    expect(canReviewExpense(sub, { uid: 'u1', ownerId: 'owner', isManager: true })).toBe(false); // own claim, not the owner
    expect(canReviewExpense({ ...sub, submitted_by: 'owner' }, { uid: 'owner', ownerId: 'owner', isManager: true })).toBe(true);
    expect(canReviewExpense(sub, { uid: 'u2', ownerId: 'owner', isManager: false })).toBe(false);
    expect(canReviewExpense({ ...sub, status: 'approved' }, { uid: 'u2', ownerId: 'owner', isManager: true })).toBe(false);
  });
  it('detects likely duplicates but ignores rejected claims and the claim being edited', () => {
    const existing = [{ id: 'e1', vendor_name: 'Shell ', expense_date: '2027-03-10', amount_cents: 4217, status: 'submitted' as const }];
    const cand = { vendor_name: 'shell', expense_date: '2027-03-10', amount_cents: 4217 };
    expect(findPossibleDuplicate(cand, existing)?.id).toBe('e1');
    expect(findPossibleDuplicate(cand, existing, 'e1')).toBeNull();
    expect(findPossibleDuplicate(cand, [{ ...existing[0], status: 'rejected' as const }])).toBeNull();
    expect(findPossibleDuplicate({ ...cand, amount_cents: 4218 }, existing)).toBeNull();
  });
});

describe('receipt scanning helpers', () => {
  const ex: ReceiptExtraction = {
    is_receipt: true,
    vendor_name: 'Home Depot',
    expense_date: '2027-03-09',
    total_cents: 8899,
    tax_cents: 612,
    suggested_category: 'fuel & vehicle',
    confidence: 0.9,
    warnings: [],
  };
  it('fills untouched fields and never overwrites what the user typed', () => {
    const blank = { ...baseForm, vendor_name: '', amount: '', category_id: '' };
    const filled = applyExtraction(blank, ex, categories, new Set());
    expect(filled).toMatchObject({ vendor_name: 'Home Depot', expense_date: '2027-03-09', amount: '88.99', tax: '6.12', category_id: 'c-fuel' });

    const typed = applyExtraction({ ...baseForm, vendor_name: 'My vendor' }, ex, categories, new Set(['vendor_name', 'amount'] as const));
    expect(typed.vendor_name).toBe('My vendor');
    expect(typed.amount).toBe('42.17');
  });
  it('never picks an archived category', () => {
    const out = applyExtraction({ ...baseForm, category_id: '' }, { ...ex, suggested_category: 'Retired' }, categories, new Set());
    expect(out.category_id).toBe('');
  });
  it('validates receipt files', () => {
    expect(validateReceiptFile({ name: 'a.jpg', type: 'image/jpeg', size: 1000 })).toBeNull();
    expect(validateReceiptFile({ name: 'IMG_1.HEIC', type: '', size: 1000 })).toBeNull();
    expect(validateReceiptFile({ name: 'a.pdf', type: 'application/pdf', size: 11 * 1024 * 1024 })).toContain('10 MB');
    expect(validateReceiptFile({ name: 'a.exe', type: 'application/x-msdownload', size: 10 })).toBeTruthy();
    expect(validateReceiptFile({ name: 'a.jpg', type: 'image/jpeg', size: 0 })).toBeTruthy();
  });
});

describe('fetchExpenses account scoping', () => {
  beforeEach(() => {
    h.calls.length = 0;
  });
  const has = (name: string, ...args: unknown[]) => h.calls.some(([n, a]) => n === name && JSON.stringify(a) === JSON.stringify(args));
  const base = { ownerId: 'owner-1', userId: 'user-9', from: 0, pageSize: 25 };

  it('always scopes by the account owner and limits members to their own claims', async () => {
    await fetchExpenses({ ...base, view: 'mine' });
    expect(has('eq', 'user_id', 'owner-1')).toBe(true);
    expect(has('eq', 'submitted_by', 'user-9')).toBe(true);
    expect(has('range', 0, 25)).toBe(true);
  });
  it('does not filter by submitter for the manager views', async () => {
    await fetchExpenses({ ...base, view: 'review' });
    expect(has('eq', 'user_id', 'owner-1')).toBe(true);
    expect(has('eq', 'status', 'submitted')).toBe(true);
    expect(h.calls.some(([n, a]) => n === 'eq' && a[0] === 'submitted_by')).toBe(false);
  });
  it('queues only reimbursable approved claims for payment and escapes search wildcards', async () => {
    await fetchExpenses({ ...base, view: 'reimburse', search: '50%_off' });
    expect(has('eq', 'status', 'approved')).toBe(true);
    expect(has('eq', 'is_reimbursable', true)).toBe(true);
    expect(has('ilike', 'vendor_name', '%50  off%')).toBe(true);
  });
});
