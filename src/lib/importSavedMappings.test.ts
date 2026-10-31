// src/lib/importSavedMappings.test.ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: {} }));
import { mergeSavedMapping } from './importSavedMappings';

describe('mergeSavedMapping', () => {
  const headers = ['Invoice #', 'Client', 'Total ($)', 'Amount'];
  const keys = ['invoice_number', 'customer_name', 'total', 'balance'];

  it('returns auto-detection untouched when nothing is saved', () => {
    const r = mergeSavedMapping({ total: 'Total ($)' }, null, headers, keys);
    expect(r).toEqual({ mapping: { total: 'Total ($)' }, auto: ['total'] });
  });
  it('saved columns win and stop being "auto"', () => {
    const r = mergeSavedMapping({ total: 'Total ($)', invoice_number: 'Invoice #' }, { total: 'Amount' }, headers, keys);
    expect(r.mapping).toEqual({ total: 'Amount', invoice_number: 'Invoice #' });
    expect(r.auto).toEqual(['invoice_number']);
  });
  it('drops saved columns that no longer exist or fields that are unknown', () => {
    const r = mergeSavedMapping({ total: 'Total ($)' }, { total: 'Gone', bogus: 'Client' }, headers, keys);
    expect(r.mapping).toEqual({ total: 'Total ($)' });
  });
  it('never maps one column to two fields', () => {
    const r = mergeSavedMapping({ balance: 'Amount' }, { total: 'Amount' }, headers, keys);
    expect(r.mapping).toEqual({ total: 'Amount' });
  });
});
