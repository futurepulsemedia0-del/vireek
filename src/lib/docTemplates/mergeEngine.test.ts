import { describe, expect, it } from 'vitest';
import {
  extractFieldKeys,
  findTamperedClauses,
  renderTemplate,
  renderTemplateVerified,
  sha256Hex,
  validateTemplate,
  type ClauseSnapshot,
  type FieldDef,
} from './mergeEngine';

const fields: FieldDef[] = [
  { key: 'customer.name', label: 'Customer name', type: 'text', group: 'customer', sample: 'Jordan Rivera' },
  { key: 'customer.type', label: 'Customer type', type: 'text', group: 'customer', sample: 'commercial' },
  { key: 'job.address', label: 'Job address', type: 'text', group: 'job', sample: '48 Oak Ave' },
  { key: 'job.start_date', label: 'Start date', type: 'date', group: 'job', sample: '2026-06-09' },
  { key: 'document.total', label: 'Total', type: 'money_cents', group: 'document', sample: '189.00' },
  { key: 'document.signed', label: 'Signed', type: 'bool', group: 'document', sample: 'true' },
];
const base = { fields, currency: 'USD', locale: 'en-US' };

describe('mergeEngine: merge correctness', () => {
  it('replaces fields and honours fallbacks', () => {
    const r = renderTemplate('Dear {{customer.name}} / {{job.address|TBD}}', { 'customer.name': ' Jordan ' }, base);
    expect(r.text).toBe('Dear Jordan / TBD');
    expect(r.complete).toBe(true);
  });

  it('reports missing values and renders a visible marker', () => {
    const r = renderTemplate('Hi {{customer.name}}', {}, base);
    expect(r.text).toBe('Hi ⟦customer.name⟧');
    expect(r.missing).toEqual(['customer.name']);
    expect(r.complete).toBe(false);
    expect(r.ok).toBe(true);
  });

  it('never re-expands values (single pass, no injection)', () => {
    const r = renderTemplate('{{customer.name}}', { 'customer.name': '{{job.address}}{{#if x}}' }, base);
    expect(r.text).toBe('{{job.address}}{{#if x}}');
    expect(r.ok).toBe(true);
  });

  it('ignores prototype keys', () => {
    const r = renderTemplate('{{constructor}}', {}, base);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.code).toBe('UNKNOWN_FIELD');
  });

  it('flags unknown fields as errors', () => {
    const r = renderTemplate('{{customer.nmae}}', {}, base);
    expect(r.ok).toBe(false);
    expect(r.text).toBe('⟦customer.nmae⟧');
  });

  it('formats money from integer minor units and rejects non-integers', () => {
    expect(renderTemplate('{{document.total}}', { 'document.total': 18900 }, base).text).toBe('$189.00');
    expect(renderTemplate('{{document.total}}', { 'document.total': 189.5 }, base).ok).toBe(false);
    expect(renderTemplate('{{document.total}}', { 'document.total': 18900 }, { fields }).ok).toBe(false);
    expect(renderTemplate('{{document.total}}', { 'document.total': 500 }, { fields, currency: 'JPY', locale: 'en-US' }).text).toContain('500');
  });

  it('formats dates per locale without shifting date-only values', () => {
    const v = { 'job.start_date': '2026-06-09' };
    expect(renderTemplate('{{job.start_date}}', v, { ...base, timeZone: 'Pacific/Kiritimati' }).text).toBe('June 9, 2026');
    expect(renderTemplate('{{job.start_date}}', v, { ...base, locale: 'de-DE' }).text).toBe('9. Juni 2026');
    expect(renderTemplate('{{job.start_date}}', { 'job.start_date': 'nope' }, base).ok).toBe(false);
  });

  it('falls back from an unsupported locale with a warning', () => {
    const r = renderTemplate('x', {}, { ...base, locale: 'not_a_locale' });
    expect(r.ok).toBe(true);
    expect(r.diagnostics.some((d) => d.code === 'LOCALE_FALLBACK')).toBe(true);
  });
});

describe('mergeEngine: conditional sections', () => {
  const t = '{{#if customer.type == "commercial"}}B2B{{else}}Home{{/if}}|{{#unless job.address}}no-address{{/unless}}';
  it('evaluates eq / else / unless', () => {
    expect(renderTemplate(t, { 'customer.type': 'commercial' }, base).text).toBe('B2B|no-address');
    expect(renderTemplate(t, { 'customer.type': 'residential', 'job.address': 'x' }, base).text).toBe('Home|');
  });
  it('supports != and bool truthiness and nesting', () => {
    const s = '{{#if document.signed}}{{#if customer.type != "x"}}Y{{/if}}{{/if}}';
    expect(renderTemplate(s, { 'document.signed': true }, base).text).toBe('Y');
    expect(renderTemplate(s, { 'document.signed': false }, base).text).toBe('');
  });
  it('detects unbalanced blocks', () => {
    expect(renderTemplate('{{#if job.address}}x', {}, base).diagnostics.some((d) => d.code === 'UNCLOSED_BLOCK')).toBe(true);
    expect(renderTemplate('x{{/if}}', {}, base).diagnostics.some((d) => d.code === 'UNEXPECTED_CLOSE')).toBe(true);
    expect(renderTemplate('{{else}}', {}, base).diagnostics.some((d) => d.code === 'UNEXPECTED_ELSE')).toBe(true);
    expect(renderTemplate('{{#if job.address}}{{/unless}}', {}, base).ok).toBe(false);
  });
  it('caps nesting depth and size', () => {
    const deep = '{{#if job.address}}'.repeat(9) + '{{/if}}'.repeat(9);
    expect(renderTemplate(deep, {}, base).diagnostics.some((d) => d.code === 'TOO_DEEP')).toBe(true);
    expect(renderTemplate('a'.repeat(100_001), {}, base).diagnostics[0]?.code).toBe('TOO_LARGE');
  });
});

describe('mergeEngine: locked clauses', () => {
  const body = 'Liability for {{customer.name|the customer}} is capped.';
  const mk = async (b: string): Promise<ClauseSnapshot> => ({ slug: 'liability', version: 3, body: b, sha256: await sha256Hex(b) });

  it('injects clause bodies, merges inside them and records the pinned version', async () => {
    const c = await mk(body);
    const r = renderTemplate('A. {{clause:liability}}', { 'customer.name': 'Acme' }, { ...base, clauses: [c] });
    expect(r.text).toBe('A. Liability for Acme is capped.');
    expect(r.usedClauses).toEqual([{ slug: 'liability', version: 3, sha256: c.sha256 }]);
  });
  it('rejects unknown and nested clauses', async () => {
    expect(renderTemplate('{{clause:nope}}', {}, base).diagnostics[0]?.code).toBe('UNKNOWN_CLAUSE');
    const c = await mk('see {{clause:liability}}');
    expect(renderTemplate('{{clause:liability}}', {}, { ...base, clauses: [c] }).diagnostics.some((d) => d.code === 'NESTED_CLAUSE')).toBe(true);
  });
  it('detects a clause body that no longer matches its published hash', async () => {
    const c = await mk(body);
    const tampered = { ...c, body: body + ' (edited)' };
    expect(await findTamperedClauses([c])).toEqual([]);
    expect(await findTamperedClauses([tampered])).toEqual(['liability']);
    const r = await renderTemplateVerified('{{clause:liability}}', {}, { ...base, clauses: [tampered] });
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.code === 'CLAUSE_TAMPERED')).toBe(true);
    expect(r.text).not.toContain('edited');
  });
});

describe('mergeEngine: editor helpers', () => {
  it('extracts referenced field keys and validates without values', () => {
    expect(extractFieldKeys('{{customer.name}}{{#if job.address}}{{job.address}}{{/if}}')).toEqual(['customer.name', 'job.address']);
    expect(validateTemplate('{{customer.name}}', base)).toEqual([]);
    expect(validateTemplate('{{bogus}}', base)[0]?.code).toBe('UNKNOWN_FIELD');
  });
});
