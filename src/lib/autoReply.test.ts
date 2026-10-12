import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { parseKeywordInput, reasonLabel } from './autoReply';

describe('parseKeywordInput', () => {
  it('splits on lines and commas, trims, de-duplicates and caps', () => {
    expect(parseKeywordInput('Mold, asbestos\n  MOLD \n\ninsurance claim')).toEqual(['Mold', 'asbestos', 'insurance claim']);
    expect(parseKeywordInput(Array.from({ length: 150 }, (_, i) => `k${i}`).join('\n')).length).toBe(100);
    expect(parseKeywordInput('x'.repeat(100))[0].length).toBe(60);
    expect(parseKeywordInput('  ')).toEqual([]);
  });
});

describe('reasonLabel', () => {
  it('maps known codes and humanises unknown ones', () => {
    expect(reasonLabel('below_threshold')).toBe('Below your confidence threshold');
    expect(reasonLabel('some_new_code')).toBe('some new code');
    expect(reasonLabel(null)).toBe('');
  });
});
