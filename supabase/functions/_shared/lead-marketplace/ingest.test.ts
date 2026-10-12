import { describe, it, expect } from 'vitest';
import { aiBudgetMs, buildEmailTemplate, buildSmsTemplate, firstNameOf, isQuietHours, validateAiSms } from './autoRespond';
import { ingestParsedLead, sweepPending, MAX_ATTEMPTS, type IngestDeps } from './ingest';
import { handleMarketplaceEmail } from './emailEntry';
import type { EventPatch, EventRow, IngestStore, NewEvent, NewLead, ParsedLead, Responders, SendResult, SourceRow } from './types';

// ---------------------------------------------------------------------
// In-memory fakes
// ---------------------------------------------------------------------
const T0 = Date.parse('2026-10-10T16:00:00.000Z'); // 12:00 in America/New_York (not quiet)
const NIGHT = Date.parse('2026-10-10T05:00:00.000Z'); // 01:00 in America/New_York (quiet)

function makeSource(over: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 's1', user_id: 'u1', provider: 'angi', enabled: true, auto_respond_enabled: true,
    default_cost_cents: 3000, booking_url: null, timezone: 'America/New_York', sms_quiet_hours: true, ...over,
  };
}

function makeParsed(over: Partial<ParsedLead> = {}): ParsedLead {
  return {
    provider: 'angi', externalId: 'E1', name: 'Jane Doe', phone: '+15552345678', email: 'jane@example.com',
    service: 'Plumbing', location: 'Austin, TX', message: 'Leaking heater', costCents: null, warnings: [], ...over,
  };
}

function setup(opts: { now?: number; source?: Partial<SourceRow>; sms?: SendResult; mail?: SendResult; ai?: string | null | 'throw'; withAi?: boolean } = {}) {
  const clock = { t: opts.now ?? T0 };
  const events: Array<EventRow & Record<string, unknown>> = [];
  const failed: unknown[] = [];
  const leads: Array<NewLead & { id: string; first_response_at?: string }> = [];
  const sentSms: Array<{ to: string; body: string }> = [];
  const sentMail: Array<{ to: string; subject: string; text: string; replyTo: string | null }> = [];
  const source = makeSource(opts.source);
  const pending: Promise<unknown>[] = [];
  let failLeadInsert = false;

  const store: IngestStore = {
    async getSourceByToken(token) { return token === 'tok' ? source : null; },
    async getSource(userId, provider) { return userId === source.user_id && provider === source.provider ? source : null; },
    async getTenant() { return { companyName: 'Acme Plumbing', replyToAlias: 'abc123@in.example.com' }; },
    async insertEvent(row: NewEvent) {
      const existing = row.dedupe_key ? events.find((e) => e.dedupe_key === row.dedupe_key && e.user_id === row.user_id) : undefined;
      if (existing) return { created: false, event: existing };
      const ev = { id: `e${events.length + 1}`, lead_id: null, status: 'received' as const, auto_respond_status: 'pending' as const, attempt_count: 0, ...row } as EventRow & Record<string, unknown>;
      events.push(ev);
      return { created: true, event: ev };
    },
    async insertFailedEvent(row) { failed.push(row); },
    async updateEvent(id: string, patch: EventPatch) { Object.assign(events.find((e) => e.id === id)!, patch); },
    async claimEvent(id, expected) {
      const ev = events.find((e) => e.id === id)!;
      if (ev.attempt_count !== expected) return false;
      ev.attempt_count++;
      return true;
    },
    async insertLead(row: NewLead) {
      if (failLeadInsert) throw new Error('db down');
      const id = `l${leads.length + 1}`;
      leads.push({ ...row, id });
      return id;
    },
    async markLeadResponded(id, at) { leads.find((l) => l.id === id)!.first_response_at = at; },
    async listRetryable(nowMs, limit) {
      return events.filter((e) =>
        e.status === 'lead_created' && e.attempt_count < MAX_ATTEMPTS &&
        (e.auto_respond_status === 'failed' || e.auto_respond_status === 'deferred_quiet_hours' ||
          (e.auto_respond_status === 'pending' && Date.parse(e.received_at) < nowMs - 90_000))).slice(0, limit);
    },
    async purgeRawPayloads() {},
  };

  const responders: Responders = {
    async sendSms(_u, to, body) { clock.t += 400; if (opts.sms && !opts.sms.ok) return opts.sms; sentSms.push({ to, body }); return { ok: true }; },
    async sendEmail(a) { clock.t += 300; if (opts.mail && !opts.mail.ok) return opts.mail; sentMail.push({ to: a.to, subject: a.subject, text: a.text, replyTo: a.replyTo }); return { ok: true }; },
    now: () => clock.t,
  };
  if (opts.withAi) {
    responders.composeAiSms = async () => {
      if (opts.ai === 'throw') throw new Error('timeout');
      clock.t += 2000;
      return opts.ai ?? null;
    };
  }

  const deps: IngestDeps = { store, responders, schedule: (p) => { pending.push(p); } };
  const run = async (parsed = makeParsed(), via: 'webhook' | 'email' = 'webhook') => {
    const out = await ingestParsedLead(deps, { source, receivedVia: via, parsed, rawPayload: '{}', receivedAtMs: clock.t });
    await Promise.all(pending.splice(0));
    return out;
  };
  return { deps, run, events, leads, failed, sentSms, sentMail, clock, source, setFailLead: (v: boolean) => { failLeadInsert = v; } };
}

// ---------------------------------------------------------------------
describe('ingestParsedLead', () => {
  it('creates the lead with source + cost and responds well inside 60 s', async () => {
    const s = setup();
    const out = await s.run();
    expect(out.status).toBe('lead_created');
    expect(s.leads).toHaveLength(1);
    expect(s.leads[0]).toMatchObject({ source: 'angi', source_cost_cents: 3000, name: 'Jane Doe', stage: 'new', source_external_id: 'E1' });
    const ev = s.events[0];
    expect(ev.status).toBe('lead_created');
    expect(ev.cost_source).toBe('default');
    expect(ev.auto_respond_status).toBe('sent');
    expect(ev.auto_respond_channel).toBe('sms+email');
    expect(Number(ev.response_ms)).toBeLessThan(60_000);
    expect(s.leads[0].first_response_at).toBeTruthy();
    expect(s.sentSms).toHaveLength(1);
    expect(s.sentSms[0].body).toContain('STOP');
    expect(s.sentMail[0].replyTo).toBe('abc123@in.example.com');
  });

  it('prefers the parsed cost over the default and records its origin', async () => {
    const s = setup();
    await s.run(makeParsed({ costCents: 4250 }));
    expect(s.leads[0].source_cost_cents).toBe(4250);
    expect(s.events[0].cost_source).toBe('parsed');
  });

  it('keeps cost null (unknown) when neither parsed nor default', async () => {
    const s = setup({ source: { default_cost_cents: null } });
    await s.run();
    expect(s.leads[0].source_cost_cents).toBeNull();
    expect(s.events[0].cost_source).toBeNull();
  });

  it('is idempotent: a duplicate delivery creates no second lead and sends nothing twice', async () => {
    const s = setup();
    await s.run();
    const again = await s.run();
    expect(again.status).toBe('duplicate');
    expect(s.leads).toHaveLength(1);
    expect(s.sentSms).toHaveLength(1);
    expect(s.sentMail).toHaveLength(1);
  });

  it('collapses webhook + email for the same customer into one lead', async () => {
    const s = setup();
    await s.run(makeParsed(), 'webhook');
    const out = await s.run(makeParsed({ externalId: null }), 'email');
    expect(out.status).toBe('duplicate');
    expect(s.leads).toHaveLength(1);
  });

  it('retries a failed first response on duplicate delivery (provider retry), up to the attempt cap', async () => {
    const s = setup({ sms: { ok: false, reason: 'TWILIO_ERROR' }, mail: { ok: false, reason: 'PROVIDER_ERROR' } });
    await s.run();
    expect(s.events[0].auto_respond_status).toBe('failed');
    expect(s.events[0].attempt_count).toBe(1);
    await s.run();
    await s.run();
    expect(s.events[0].attempt_count).toBe(MAX_ATTEMPTS);
    await s.run(); // cap reached: no further attempt
    expect(s.events[0].attempt_count).toBe(MAX_ATTEMPTS);
    expect(s.leads).toHaveLength(1);
  });

  it('falls back to email when SMS is blocked (A2P / opted out)', async () => {
    const s = setup({ sms: { ok: false, reason: 'A2P_NOT_APPROVED' } });
    await s.run();
    expect(s.events[0].auto_respond_status).toBe('sent');
    expect(s.events[0].auto_respond_channel).toBe('email');
    expect(String(s.events[0].auto_respond_error)).toContain('sms:A2P_NOT_APPROVED');
  });

  it('marks failed (not sent) when every channel fails', async () => {
    const s = setup({ sms: { ok: false, reason: 'OPTED_OUT' }, mail: { ok: false, reason: 'NOT_CONFIGURED' } });
    await s.run();
    expect(s.events[0].auto_respond_status).toBe('failed');
    expect(s.events[0].response_ms).toBeUndefined();
    expect(s.leads[0].first_response_at).toBeUndefined();
  });

  it('respects quiet hours: email only; phone-only leads are deferred, then sent by the sweeper after 8am', async () => {
    const s = setup({ now: NIGHT });
    await s.run();
    expect(s.sentSms).toHaveLength(0);
    expect(s.sentMail).toHaveLength(1);

    const p = setup({ now: NIGHT });
    await p.run(makeParsed({ email: null }));
    expect(p.events[0].auto_respond_status).toBe('deferred_quiet_hours');
    expect(p.sentSms).toHaveLength(0);
    p.clock.t = Date.parse('2026-10-10T13:00:00.000Z'); // 09:00 New York
    const swept = await sweepPending(p.deps);
    expect(swept.retried).toBe(1);
    expect(p.events[0].auto_respond_status).toBe('sent');
    expect(p.sentSms).toHaveLength(1);
  });

  it('skips when auto-respond is disabled or there is no contact info', async () => {
    const a = setup({ source: { auto_respond_enabled: false } });
    await a.run();
    expect(a.events[0].auto_respond_status).toBe('skipped_disabled');
    expect(a.leads).toHaveLength(1);
    const b = setup();
    await b.run(makeParsed({ phone: null, email: null }));
    expect(b.events[0].auto_respond_status).toBe('skipped_no_contact');
    expect(b.leads[0].name).toBe('Jane Doe');
  });

  it('uses a provider-labelled placeholder name when the payload has none', async () => {
    const s = setup();
    await s.run(makeParsed({ name: null }));
    expect(s.leads[0].name).toBe('Angi lead');
    expect(s.sentSms[0].body.startsWith('Hi,')).toBe(true);
  });

  it('retries lead creation on redelivery if the first insert failed', async () => {
    const s = setup();
    s.setFailLead(true);
    await expect(s.run()).rejects.toThrow();
    expect(s.events[0].status).toBe('error');
    s.setFailLead(false);
    const out = await s.run();
    expect(out.status).toBe('lead_created');
    expect(s.leads).toHaveLength(1);
  });

  it('sweeper recovers a response lost with a dead worker (pending > 90 s) and never double-sends a fresh one', async () => {
    const s = setup();
    await s.run();
    // simulate a worker that died right after the lead insert (response never recorded)
    Object.assign(s.events[0], { auto_respond_status: 'pending', attempt_count: 0 });
    s.sentSms.length = 0;
    s.sentMail.length = 0;
    expect((await sweepPending(s.deps)).retried).toBe(0); // too fresh
    s.clock.t += 120_000;
    expect((await sweepPending(s.deps)).retried).toBe(1);
    expect(s.events[0].auto_respond_status).toBe('sent');
    expect(s.sentSms).toHaveLength(1);
  });
});

describe('AI personalization is optional and can never hurt the SLA', () => {
  const ok = 'Hi Jane, this is Acme Plumbing — sorry about the leaking water heater! A team member will call shortly. What time works best today? (Automated reply) Reply STOP to opt out.';
  it('uses a valid AI message', async () => {
    const s = setup({ withAi: true, ai: ok });
    await s.run();
    expect(s.sentSms[0].body).toContain('leaking water heater');
    expect(s.events[0].auto_respond_ai).toBe(true);
  });
  it('falls back to the template when AI throws, returns junk, or promises prices', async () => {
    for (const ai of ['throw', null, 'Hi from Acme Plumbing, we will fix it for $99 guaranteed'] as const) {
      const s = setup({ withAi: true, ai });
      await s.run();
      expect(s.sentSms).toHaveLength(1);
      expect(s.sentSms[0].body).toContain('Automated first reply');
      expect(s.events[0].auto_respond_ai).toBeFalsy();
    }
  });
});

describe('autoRespond helpers', () => {
  it('quiet hours honor the tenant timezone and fall back on a bad one', () => {
    expect(isQuietHours(T0, 'America/New_York')).toBe(false);
    expect(isQuietHours(NIGHT, 'America/New_York')).toBe(true);
    expect(isQuietHours(T0, 'America/Los_Angeles')).toBe(false); // 09:00
    expect(isQuietHours(Date.parse('2026-10-10T14:30:00Z'), 'America/Los_Angeles')).toBe(true); // 07:30 PT is still before 08:00
  });
  it('AI budget shrinks as the SLA is consumed', () => {
    expect(aiBudgetMs(0)).toBe(6000);
    expect(aiBudgetMs(35_000)).toBe(5000);
    expect(aiBudgetMs(45_000)).toBe(0);
  });
  it('validateAiSms enforces link safety and identity', () => {
    const ctx = { bookingUrl: 'https://book.acme.com/x', businessName: 'Acme Plumbing' };
    expect(validateAiSms('Hi, Acme Plumbing here — call you soon', ctx)).toContain('STOP');
    expect(validateAiSms('Acme Plumbing: see http://evil.example', ctx)).toBeNull();
    expect(validateAiSms('Acme Plumbing: book https://book.acme.com/x', ctx)).toContain('https://book.acme.com/x');
    expect(validateAiSms('Hello there, we will call', ctx)).toBeNull(); // does not name the business
    expect(validateAiSms('As an AI language model, Acme Plumbing...', ctx)).toBeNull();
    expect(validateAiSms('x'.repeat(900), ctx)).toBeNull();
  });
  it('templates include opt-out, business name and the booking link when set', () => {
    const t = { firstName: 'Jane', businessName: 'Acme', provider: 'thumbtack' as const, service: 'Roofing', bookingUrl: 'https://b.co/x' };
    const sms = buildSmsTemplate(t);
    expect(sms).toContain('Thumbtack');
    expect(sms).toContain('https://b.co/x');
    expect(sms).toContain('STOP');
    const mail = buildEmailTemplate(t);
    expect(mail.subject).toBe('Re: your roofing request — Acme');
    expect(mail.text).toContain('automated');
  });
  it('firstNameOf ignores placeholder names', () => {
    expect(firstNameOf('Angi lead', 'angi')).toBeNull();
    expect(firstNameOf('Jane Doe', 'angi')).toBe('Jane');
    expect(firstNameOf(null, 'angi')).toBeNull();
  });
});

describe('handleMarketplaceEmail', () => {
  const mail = (over = {}) => ({
    userId: 'u1', toLocalPart: 'abc123', from: 'Angi <leads@angi.com>', subject: 'New lead',
    text: 'Name: Jane Doe\nPhone: 555-234-5678\nService: Plumbing', html: null, receivedAtMs: T0, ...over,
  });
  it('ingests a marketplace email and reports handled', async () => {
    const s = setup();
    const r = await handleMarketplaceEmail(s.deps, mail());
    await Promise.resolve();
    expect(r.handled).toBe(true);
    expect(s.leads).toHaveLength(1);
  });
  it('lets non-marketplace mail fall through to the inbox', async () => {
    const s = setup();
    expect((await handleMarketplaceEmail(s.deps, mail({ from: 'customer@gmail.com' }))).handled).toBe(false);
    expect(s.leads).toHaveLength(0);
  });
  it('lets the email through to the inbox AND logs a parse failure when unparseable', async () => {
    const s = setup();
    const r = await handleMarketplaceEmail(s.deps, mail({ text: 'Your monthly newsletter is here.' }));
    expect(r.handled).toBe(false);
    expect(s.failed).toHaveLength(1);
    expect(s.leads).toHaveLength(0);
  });
  it('does nothing for a provider the tenant has not enabled', async () => {
    const s = setup({ source: { enabled: false } });
    expect((await handleMarketplaceEmail(s.deps, mail())).handled).toBe(false);
  });
  it('uses the +tag alias when the sender is a plain forwarder', async () => {
    const s = setup();
    const r = await handleMarketplaceEmail(s.deps, mail({ toLocalPart: 'abc123+angi', from: 'owner@gmail.com' }));
    expect(r.handled).toBe(true);
  });
});
