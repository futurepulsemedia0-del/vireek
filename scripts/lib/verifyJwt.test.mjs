import { describe, it, expect } from 'vitest';
import { parseConfig, declaresNoVerifyJwt, hasSelfAuthEvidence, computePlan, renderConfig } from './verifyJwt.mjs';

const hdr = (n) => `// ${n}\n// Deploy: supabase functions deploy ${n} --no-verify-jwt\n`;
const authed = 'const s = req.headers.get("Stripe-Signature");';

describe('parseConfig', () => {
  it('reads indented headers and verify_jwt values', () => {
    const { entries } = parseConfig('  [functions.a]\n  verify_jwt = false\n[functions.b]\nverify_jwt = true\n');
    expect(entries.get('a')).toBe(false);
    expect(entries.get('b')).toBe(true);
  });
  it('reports duplicate tables', () => {
    expect(parseConfig('[functions.a]\nverify_jwt = false\n[functions.a]\nverify_jwt = false\n').duplicates).toEqual(['a']);
  });
});

describe('declaresNoVerifyJwt / hasSelfAuthEvidence', () => {
  it('detects the header declaration only in leading comments', () => {
    expect(declaresNoVerifyJwt(hdr('x'))).toBe(true);
    expect(declaresNoVerifyJwt('const a = 1;\n'.repeat(90) + '// --no-verify-jwt')).toBe(false);
  });
  it('detects self-auth', () => {
    expect(hasSelfAuthEvidence(authed)).toBe(true);
    expect(hasSelfAuthEvidence('return new Response("hi")')).toBe(false);
  });
});

describe('computePlan', () => {
  const fns = [
    { name: 'hook', src: hdr('hook') + authed },
    { name: 'open', src: hdr('open') + 'return new Response("x")' },
    { name: 'plain', src: 'Deno.serve(() => new Response("x"))' },
    { name: 'done', src: hdr('done') + authed },
  ];
  const cfg = '[functions.done]\nverify_jwt = false\n[functions.ghost]\nverify_jwt = false\n';
  it('adds authed functions, flags unauthenticated ones for review, never touches undeclared ones', () => {
    const p = computePlan(cfg, fns);
    expect(p.toAdd).toEqual(['hook']);
    expect(p.needsReview).toEqual(['open']);
    expect(p.orphans).toEqual(['ghost']);
  });
});

describe('renderConfig', () => {
  it('dedupes, sorts and is idempotent', () => {
    const cfg = '[functions.b]\nverify_jwt = false\n[functions.b]\nverify_jwt = false\n';
    const once = renderConfig(cfg, ['a']);
    expect(once).toBe('[functions.a]\nverify_jwt = false\n\n[functions.b]\nverify_jwt = false\n');
    expect(renderConfig(once, [])).toBe(once);
  });
});
