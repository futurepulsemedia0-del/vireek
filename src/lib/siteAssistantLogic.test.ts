import { describe, it, expect } from 'vitest';
import {
  redactPii,
  detectIntent,
  toSafePath,
  buildSources,
  isGrounded,
  cacheKey,
  buildSiteInstructions,
  GROUNDED_MIN_SIMILARITY,
} from '../../supabase/functions/_shared/ai-core/siteAssistantLogic';

describe('redactPii', () => {
  it('removes emails, phones, cards and ssn', () => {
    const out = redactPii('mail me at jo@acme.com or +1 (650) 910-6703, card 4242 4242 4242 4242, ssn 123-45-6789');
    expect(out).not.toMatch(/jo@acme\.com/);
    expect(out).not.toMatch(/910-6703/);
    expect(out).not.toMatch(/4242/);
    expect(out).not.toMatch(/123-45-6789/);
    expect(out).toContain('[email]');
    expect(out).toContain('[card]');
  });
  it('removes street addresses and long tokens', () => {
    const out = redactPii('I live at 123 Main Street and my key is sk_live_abcdefghijklmnop1234');
    expect(out).toContain('[address]');
    expect(out).not.toContain('abcdefghijklmnop');
  });
  it('caps length and keeps normal text', () => {
    expect(redactPii('How much does Vireek cost?')).toBe('How much does Vireek cost?');
    expect(redactPii('a'.repeat(900)).length).toBeLessThanOrEqual(500);
  });
});

describe('detectIntent', () => {
  it.each([
    ['I want to talk to a real person', 'human'],
    ['Do you have SOC 2?', 'security'],
    ['How much does the Professional plan cost?', 'pricing'],
    ['Do you integrate with ServiceTitan?', 'integration'],
    ['Vireek vs Smith.ai', 'competitor'],
    ['Can I hear a demo?', 'demo'],
    ['How do I get started?', 'signup'],
    ['my calls are not working', 'support'],
    ['What time is it on Mars', 'general'],
    ['قیمت پلن‌ها چقدر است؟', 'pricing'],
    ['¿Cuánto cuesta?', 'pricing'],
  ])('%s -> %s', (q, expected) => {
    expect(detectIntent(q)).toBe(expected);
  });
  it('human beats pricing', () => {
    expect(detectIntent('can I talk to a human about pricing')).toBe('human');
  });
});

describe('toSafePath', () => {
  it('accepts vireek.com and relative paths only', () => {
    expect(toSafePath('https://vireek.com/pricing')).toBe('/pricing');
    expect(toSafePath('https://www.vireek.com/compare/x?y=1')).toBe('/compare/x');
    expect(toSafePath('/faq#a')).toBe('/faq');
  });
  it('rejects foreign hosts, protocol-relative, http and junk', () => {
    expect(toSafePath('https://evil.com/pricing')).toBeNull();
    expect(toSafePath('https://vireek.com.evil.com/x')).toBeNull();
    expect(toSafePath('//evil.com')).toBeNull();
    expect(toSafePath('http://vireek.com/x')).toBeNull();
    expect(toSafePath('javascript:alert(1)')).toBeNull();
    expect(toSafePath(null)).toBeNull();
  });
});

describe('buildSources / isGrounded', () => {
  it('dedupes, caps at 3 and fills from intent links', () => {
    const s = buildSources(
      [
        { title: 'A', url: 'https://vireek.com/pricing', similarity: 0.9 },
        { title: 'A2', url: 'https://vireek.com/pricing', similarity: 0.8 },
        { title: 'Bad', url: 'https://evil.com/x', similarity: 0.7 },
      ],
      'pricing',
    );
    expect(s.map((x) => x.url)).toEqual(['/pricing', '/roi']);
    expect(s.length).toBeLessThanOrEqual(3);
  });
  it('grounded only above threshold or on keyword hit', () => {
    expect(isGrounded([])).toBe(false);
    expect(isGrounded([{ title: null, url: null, similarity: GROUNDED_MIN_SIMILARITY - 0.01 }])).toBe(false);
    expect(isGrounded([{ title: null, url: null, similarity: GROUNDED_MIN_SIMILARITY }])).toBe(true);
    expect(isGrounded([{ title: null, url: null, similarity: 0, keywordHit: true }])).toBe(true);
  });
});

describe('cacheKey / buildSiteInstructions', () => {
  it('normalises case, punctuation and whitespace', () => {
    expect(cacheKey('  How MUCH does it cost?? ')).toBe(cacheKey('how much does it cost'));
  });
  it('adds no-guess clause when ungrounded and human clause for human intent', () => {
    const a = buildSiteInstructions({ coreFacts: 'F', intent: 'general', grounded: false });
    expect(a).toContain('Do NOT guess');
    const b = buildSiteInstructions({ coreFacts: 'F', intent: 'human', grounded: true });
    expect(b).toContain('asked for a human');
    expect(b).not.toContain('Do NOT guess');
  });
});
