import { describe, expect, it } from 'vitest';
import { formatConsequences } from './consequences';

const t = (k: string, v: Record<string, string | number> = {}) => (k === 'confirm.lineDelete' ? `Delete ${v.count} ${v.noun}` : `and ${v.count} ${v.noun}`);
const noun = (n: string, c: number) => (c === 1 ? n : `${n}s`);

describe('formatConsequences', () => {
  it('builds "Delete 12 jobs" / "and 4 invoices" and drops zero lines', () => {
    expect(formatConsequences(t, noun, { count: 12, nounKey: 'job' }, [{ count: 4, nounKey: 'invoice' }, { count: 0, nounKey: 'payment' }])).toEqual(['Delete 12 jobs', 'and 4 invoices']);
    expect(formatConsequences(t, noun, { count: 1, nounKey: 'job' })).toEqual(['Delete 1 job']);
  });
});
