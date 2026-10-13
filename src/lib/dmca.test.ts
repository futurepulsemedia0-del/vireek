import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));

import {
  DMCA_STATEMENTS,
  buildDmcaPayload,
  emptyDmcaValues,
  isValidHttpUrl,
  parseUrls,
  submitDmcaNotice,
  validateDmca,
  type DmcaFormValues,
} from './dmca';

function validTakedown(over: Partial<DmcaFormValues> = {}): DmcaFormValues {
  return {
    ...emptyDmcaValues('takedown'),
    fullName: 'Jane Q. Author',
    email: 'jane@example.com',
    address: '1 Main St, Springfield, IL 62701, USA',
    workDescription: 'My photograph "Harbor at Dawn", first published on janeauthor.com in 2022.',
    urlsText: 'https://vireek.com/community/post-1\nhttps://vireek.com/community/post-2',
    statements: DMCA_STATEMENTS.takedown.map((s) => s.id),
    signature: 'jane q.  author',
    ...over,
  };
}

function validCounter(over: Partial<DmcaFormValues> = {}): DmcaFormValues {
  return {
    ...emptyDmcaValues('counter'),
    fullName: 'Sam Customer',
    email: 'sam@example.com',
    phone: '+1 (555) 123-4567',
    address: '9 Elm Road, Austin, TX 78701, USA',
    urlsText: 'https://vireek.com/community/post-1',
    statements: DMCA_STATEMENTS.counter.map((s) => s.id),
    signature: 'Sam Customer',
    ...over,
  };
}

beforeEach(() => rpc.mockReset());

describe('parseUrls', () => {
  it('splits on whitespace, strips trailing punctuation, dedupes, keeps order', () => {
    expect(parseUrls('https://a.com/x,\n https://b.com/y;  https://a.com/x\n\n')).toEqual(['https://a.com/x', 'https://b.com/y']);
    expect(parseUrls('   ')).toEqual([]);
  });
});

describe('isValidHttpUrl', () => {
  it('accepts http(s) URLs with a dotted host only', () => {
    expect(isValidHttpUrl('https://vireek.com/a?b=1')).toBe(true);
    expect(isValidHttpUrl('http://sub.example.org')).toBe(true);
    expect(isValidHttpUrl('ftp://example.com')).toBe(false);
    expect(isValidHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isValidHttpUrl('https://localhost')).toBe(false);
    expect(isValidHttpUrl('vireek.com/a')).toBe(false);
    expect(isValidHttpUrl(`https://a.com/${'x'.repeat(2100)}`)).toBe(false);
  });
});

describe('validateDmca — takedown', () => {
  it('accepts a complete notice (signature matches ignoring case/whitespace)', () => {
    expect(validateDmca(validTakedown())).toEqual({});
  });

  it('flags every missing required field on an empty form', () => {
    const errs = validateDmca(emptyDmcaValues('takedown'));
    expect(Object.keys(errs).sort()).toEqual(['address', 'email', 'fullName', 'signature', 'statements', 'urls', 'workDescription']);
  });

  it('requires every statement', () => {
    const errs = validateDmca(validTakedown({ statements: ['good_faith', 'accuracy_authority'] }));
    expect(errs.statements).toBeTruthy();
  });

  it('rejects a signature that does not match the name', () => {
    expect(validateDmca(validTakedown({ signature: 'Someone Else' })).signature).toMatch(/match/i);
  });

  it('rejects bad emails, short descriptions and invalid links', () => {
    const errs = validateDmca(validTakedown({ email: 'nope', workDescription: 'short', urlsText: 'https://ok.com/a not-a-url' }));
    expect(errs.email).toBeTruthy();
    expect(errs.workDescription).toBeTruthy();
    expect(errs.urls).toMatch(/not-a-url/);
  });

  it('caps the number of links at 20', () => {
    const urls = Array.from({ length: 21 }, (_, i) => `https://a.com/${i}`).join('\n');
    expect(validateDmca(validTakedown({ urlsText: urls })).urls).toMatch(/20/);
  });

  it('treats phone and work link as optional but validates them when present', () => {
    expect(validateDmca(validTakedown({ phone: '', workUrl: '' }))).toEqual({});
    expect(validateDmca(validTakedown({ phone: 'abc' })).phone).toBeTruthy();
    expect(validateDmca(validTakedown({ workUrl: 'not a link' })).workUrl).toBeTruthy();
  });
});

describe('validateDmca — counter-notification', () => {
  it('accepts a complete counter-notification without a work description', () => {
    expect(validateDmca(validCounter())).toEqual({});
  });

  it('requires a phone number', () => {
    expect(validateDmca(validCounter({ phone: '' })).phone).toMatch(/required/i);
  });

  it('does not accept takedown statements', () => {
    const errs = validateDmca(validCounter({ statements: DMCA_STATEMENTS.takedown.map((s) => s.id) }));
    expect(errs.statements).toBeTruthy();
  });
});

describe('buildDmcaPayload', () => {
  it('trims, parses links and only sends statements valid for the type', () => {
    const p = buildDmcaPayload(validTakedown({ fullName: '  Jane Q. Author ', statements: [...DMCA_STATEMENTS.takedown.map((s) => s.id), 'mistake'] }));
    expect(p.full_name).toBe('Jane Q. Author');
    expect(p.urls).toEqual(['https://vireek.com/community/post-1', 'https://vireek.com/community/post-2']);
    expect(p.statements).toEqual(['good_faith', 'accuracy_authority', 'share_with_user']);
    expect(p.notice_type).toBe('takedown');
    expect(p.capacity).toBe('owner');
  });

  it('blanks takedown-only fields for counter-notifications', () => {
    const p = buildDmcaPayload(validCounter({ workUrl: 'https://x.com', originalReference: ' DMCA-2026-000001 ' }));
    expect(p.capacity).toBe('');
    expect(p.work_url).toBe('');
    expect(p.original_reference).toBe('DMCA-2026-000001');
  });
});

describe('submitDmcaNotice', () => {
  it('returns the reference on success', async () => {
    rpc.mockResolvedValue({ data: { ok: true, reference: 'DMCA-2026-000007' }, error: null });
    const res = await submitDmcaNotice(validTakedown());
    expect(res).toEqual({ ok: true, reference: 'DMCA-2026-000007' });
    expect(rpc).toHaveBeenCalledWith('submit_dmca_notice', { p_payload: expect.objectContaining({ notice_type: 'takedown' }) });
  });

  it('maps server error codes', async () => {
    rpc.mockResolvedValue({ data: { ok: false, error: 'rate_limited' }, error: null });
    expect(await submitDmcaNotice(validTakedown())).toEqual({ ok: false, error: 'rate_limited' });
    rpc.mockResolvedValue({ data: { ok: false, error: 'invalid' }, error: null });
    expect(await submitDmcaNotice(validTakedown())).toEqual({ ok: false, error: 'invalid' });
  });

  it('treats transport failures and malformed responses as unavailable', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect(await submitDmcaNotice(validTakedown())).toEqual({ ok: false, error: 'unavailable' });
    rpc.mockResolvedValue({ data: 'weird', error: null });
    expect(await submitDmcaNotice(validTakedown())).toEqual({ ok: false, error: 'unavailable' });
    rpc.mockRejectedValue(new Error('offline'));
    expect(await submitDmcaNotice(validTakedown())).toEqual({ ok: false, error: 'unavailable' });
  });
});
