import { describe, it, expect } from 'vitest';
import {
  STARTER_TEMPLATES,
  analyzeSms,
  availableActions,
  buildPreviewSegments,
  draftsEqual,
  extractVariableKeys,
  filterTemplates,
  lintTemplate,
  normalizeStats,
  normalizeTemplate,
  normalizeTemplates,
  renderTemplate,
  starterToDraft,
  summarizeLint,
  summarizeTemplates,
  toDraft,
  variableSnippet,
  TEMPLATE_VARIABLES,
  DEFAULT_FILTERS,
  type MessageTemplate,
  type TemplateDraft,
} from './messageTemplates';

function draft(over: Partial<TemplateDraft> = {}): TemplateDraft {
  return {
    name: 'Test',
    channel: 'sms',
    category: 'appointment',
    subject: '',
    body: '{{business_name}}: Hi {{first_name|there}}, see you soon. Reply STOP to opt out.',
    ...over,
  };
}

function tpl(over: Partial<MessageTemplate> = {}): MessageTemplate {
  return {
    id: 't1',
    user_id: 'owner',
    name: 'Reminder',
    channel: 'sms',
    category: 'appointment',
    subject: null,
    body: 'hello',
    status: 'draft',
    review_note: null,
    created_by: 'u1',
    submitted_at: null,
    reviewed_by: null,
    reviewed_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    ...over,
  };
}

const codes = (d: TemplateDraft) => lintTemplate(d).map((i) => i.code);

describe('variables', () => {
  it('extracts unique, lower-cased keys with optional spaces and fallbacks', () => {
    expect(extractVariableKeys('Hi {{ First_Name | there }} {{first_name}} {{business_name}}')).toEqual(['first_name', 'business_name']);
  });

  it('renders values, then fallbacks, and reports missing keys', () => {
    const r = renderTemplate('Hi {{first_name|there}}, {{technician_name}} {{service_type|service}}', { service_type: 'AC' });
    expect(r.text).toBe('Hi there,  AC');
    expect(r.missing).toEqual(['technician_name']);
  });

  it('never expands a value that itself contains a variable (single pass)', () => {
    const r = renderTemplate('Hi {{first_name}}', { first_name: '{{payment_link}}', payment_link: 'https://evil' });
    expect(r.text).toBe('Hi {{payment_link}}');
  });

  it('ignores prototype keys safely', () => {
    expect(renderTemplate('{{constructor|x}}', {}).text).toBe('x');
  });

  it('builds preview segments with value, fallback, unknown and missing states', () => {
    const segs = buildPreviewSegments('A {{first_name}} {{nope}} {{technician_name|T}}', { technician_name: '' });
    const states = segs.filter((s) => s.kind === 'variable').map((s) => (s.kind === 'variable' ? s.state : ''));
    expect(states).toEqual(['missing', 'unknown', 'fallback']);
  });

  it('inserts a fallback by default for variables that need one', () => {
    const first = TEMPLATE_VARIABLES.find((v) => v.key === 'first_name')!;
    const phone = TEMPLATE_VARIABLES.find((v) => v.key === 'business_phone')!;
    expect(variableSnippet(first)).toBe('{{first_name|there}}');
    expect(variableSnippet(phone)).toBe('{{business_phone}}');
  });
});

describe('analyzeSms', () => {
  it('counts GSM-7 segments at 160 and 153', () => {
    expect(analyzeSms('a'.repeat(160)).segments).toBe(1);
    expect(analyzeSms('a'.repeat(161)).segments).toBe(2);
    expect(analyzeSms('a'.repeat(306)).segments).toBe(2);
    expect(analyzeSms('a'.repeat(307)).segments).toBe(3);
    expect(analyzeSms('').segments).toBe(0);
  });

  it('counts extended GSM characters as two units', () => {
    expect(analyzeSms('{}').units).toBe(4);
  });

  it('switches to UCS-2 for smart quotes and emoji', () => {
    const a = analyzeSms('It’s ready 🙂');
    expect(a.encoding).toBe('UCS-2');
    expect(a.perSegment).toBe(70);
    expect(analyzeSms('b'.repeat(71).replace(/b/g, 'é') + '—').segments).toBe(2);
  });
});

describe('lintTemplate', () => {
  it('passes a clean SMS', () => {
    expect(summarizeLint(lintTemplate(draft())).canSubmit).toBe(true);
  });

  it('flags unknown and malformed variables', () => {
    expect(codes(draft({ body: '{{business_name}} {{wat}} STOP' }))).toContain('UNKNOWN_VARIABLE');
    expect(codes(draft({ body: '{{business_name}} {{first_name STOP' }))).toContain('BROKEN_VARIABLE');
  });

  it('requires opt-out and sender id on marketing SMS, only hints otherwise', () => {
    const marketing = codes(draft({ category: 'marketing', body: 'Big sale on tune-ups' }));
    expect(marketing).toContain('NO_OPT_OUT');
    expect(marketing).toContain('NO_SENDER_ID');
    const transactional = lintTemplate(draft({ body: '{{business_name}}: your visit is booked' }));
    expect(transactional.find((i) => i.code === 'NO_OPT_OUT_HINT')?.severity).toBe('info');
    expect(summarizeLint(transactional).canSubmit).toBe(true);
  });

  it('blocks URL shorteners and flags multiple links', () => {
    expect(codes(draft({ body: '{{business_name}}: pay at bit.ly/abc STOP' }))).toContain('URL_SHORTENER');
    expect(codes(draft({ body: '{{business_name}}: {{payment_link}} {{review_link}} STOP' }))).toContain('MULTIPLE_LINKS');
  });

  it('warns on missing fallbacks, caps, exclamations and UCS-2', () => {
    expect(codes(draft({ body: '{{business_name}}: Hi {{first_name}} STOP' }))).toContain('NO_FALLBACK');
    expect(codes(draft({ body: '{{business_name}}: HURRY IN FOR YOUR APPOINTMENT TODAY STOP' }))).toContain('ALL_CAPS');
    expect(codes(draft({ body: '{{business_name}}: Wow!!! Great!!! STOP' }))).toContain('EXCLAMATIONS');
    expect(codes(draft({ body: '{{business_name}}: it’s ready STOP' }))).toContain('UCS2_ENCODING');
  });

  it('errors when an SMS exceeds the hard limit', () => {
    expect(codes(draft({ body: `{{business_name}} ${'a'.repeat(1700)} STOP` }))).toContain('TOO_LONG');
  });

  it('validates email subject and marketing compliance', () => {
    expect(codes(draft({ channel: 'email', body: 'Hello' }))).toContain('EMPTY_SUBJECT');
    expect(codes(draft({ channel: 'email', subject: 'Hi\nthere', body: 'Hello' }))).toContain('SUBJECT_NEWLINE');
    const marketing = codes(draft({ channel: 'email', category: 'marketing', subject: 'Offer', body: 'Book now' }));
    expect(marketing).toContain('NO_UNSUBSCRIBE');
    expect(marketing).toContain('NO_POSTAL_ADDRESS');
    const ok = draft({ channel: 'email', category: 'marketing', subject: 'Offer', body: '{{business_address}} {{unsubscribe_link}}' });
    expect(summarizeLint(lintTemplate(ok)).canSubmit).toBe(true);
  });

  it('sorts errors before warnings before info', () => {
    const issues = lintTemplate(draft({ category: 'marketing', body: 'WIN a prize, act now' }));
    const order = issues.map((i) => i.severity);
    expect(order).toEqual([...order].sort((a, b) => ['error', 'warning', 'info'].indexOf(a) - ['error', 'warning', 'info'].indexOf(b)));
  });
});

describe('starter library', () => {
  it('ships unique ids and names per channel', () => {
    expect(new Set(STARTER_TEMPLATES.map((s) => s.id)).size).toBe(STARTER_TEMPLATES.length);
    expect(new Set(STARTER_TEMPLATES.map((s) => `${s.channel}:${s.name.toLowerCase()}`)).size).toBe(STARTER_TEMPLATES.length);
  });

  it('every starter is A2P-safe: no errors and no warnings', () => {
    for (const s of STARTER_TEMPLATES) {
      const bad = lintTemplate(starterToDraft(s)).filter((i) => i.severity !== 'info');
      expect({ id: s.id, bad }).toEqual({ id: s.id, bad: [] });
    }
  });

  it('keeps every SMS starter within three segments when rendered', () => {
    for (const s of STARTER_TEMPLATES.filter((x) => x.channel === 'sms')) {
      expect(analyzeSms(renderTemplate(s.body, { first_name: 'Jordan', business_name: 'Summit Home Services' }).text).segments).toBeLessThan(4);
    }
  });
});

describe('availableActions', () => {
  const base = { canReview: true, isOwner: false, isAuthor: false };
  it('maps each status to its actions', () => {
    expect(availableActions({ ...base, status: 'draft' })).toEqual(['submit', 'archive']);
    expect(availableActions({ ...base, status: 'rejected' })).toEqual(['submit', 'archive']);
    expect(availableActions({ ...base, status: 'approved' })).toEqual(['archive']);
    expect(availableActions({ ...base, status: 'archived' })).toEqual(['restore']);
  });

  it('enforces four-eyes review for non-owners', () => {
    expect(availableActions({ ...base, status: 'pending_review', isAuthor: true })).toEqual(['archive']);
    expect(availableActions({ ...base, status: 'pending_review', isAuthor: true, isOwner: true })).toEqual(['approve', 'reject', 'archive']);
    expect(availableActions({ ...base, status: 'pending_review', canReview: false })).toEqual(['archive']);
  });
});

describe('list helpers', () => {
  const list = [
    tpl({ id: 'a', name: 'Alpha', status: 'approved', updated_at: '2026-02-01T00:00:00Z' }),
    tpl({ id: 'b', name: 'Beta', channel: 'email', subject: 'Invoice ready', status: 'draft', updated_at: '2026-03-01T00:00:00Z' }),
    tpl({ id: 'c', name: 'Gamma', status: 'archived' }),
    tpl({ id: 'd', name: 'Delta', status: 'pending_review' }),
  ];

  it('hides archived by default and sorts newest first', () => {
    expect(filterTemplates(list, DEFAULT_FILTERS).map((t) => t.id)).toEqual(['b', 'a', 'd']);
  });

  it('filters by channel, status and text (including subject)', () => {
    expect(filterTemplates(list, { channel: 'email', status: 'all', query: '' }).map((t) => t.id)).toEqual(['b']);
    expect(filterTemplates(list, { channel: 'all', status: 'archived', query: '' }).map((t) => t.id)).toEqual(['c']);
    expect(filterTemplates(list, { channel: 'all', status: 'active', query: 'invoice' }).map((t) => t.id)).toEqual(['b']);
  });

  it('summarises counts and 30-day usage', () => {
    const s = summarizeTemplates(list, { a: { template_id: 'a', total_uses: 9, uses_30d: 4, last_used_at: null } });
    expect(s).toEqual({ active: 3, approved: 1, pendingReview: 1, uses30d: 4 });
  });

  it('compares drafts ignoring surrounding whitespace and sms subject', () => {
    const t = tpl({ name: 'X', body: 'hi' });
    expect(draftsEqual(toDraft(t), { ...toDraft(t), name: ' X ', subject: 'ignored' })).toBe(true);
    expect(draftsEqual(toDraft(t), { ...toDraft(t), body: 'hi!' })).toBe(false);
  });
});

describe('normalisers', () => {
  it('drops malformed rows instead of throwing', () => {
    expect(normalizeTemplate(null)).toBeNull();
    expect(normalizeTemplate({ id: 'x', user_id: 'u', channel: 'fax', category: 'marketing', status: 'draft' })).toBeNull();
    expect(normalizeTemplates('nope')).toEqual([]);
    const good = normalizeTemplates([tpl(), { junk: true }]);
    expect(good).toHaveLength(1);
  });

  it('coerces stats from numbers or numeric strings', () => {
    const s = normalizeStats([{ template_id: 'a', total_uses: '12', uses_30d: 3, last_used_at: null }, { nope: 1 }]);
    expect(s).toEqual({ a: { template_id: 'a', total_uses: 12, uses_30d: 3, last_used_at: null } });
  });
});
