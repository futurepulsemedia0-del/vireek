import { describe, it, expect } from 'vitest';
import {
  displayStatus,
  guessStateCode,
  isFinalDraw,
  lienWaiverError,
  longDate,
  needsPaymentProof,
  parsePublicLienWaiver,
  payAppState,
  renderLienWaiver,
  resolveTemplate,
  suggestedType,
  summarize,
  formatUsd,
  type LienWaiver,
  type LienWaiverTemplate,
} from './lienWaivers';

const tpl = (over: Partial<LienWaiverTemplate>): LienWaiverTemplate => ({
  id: 't', user_id: null, state_code: 'US', waiver_type: 'conditional_progress', title: 'T', body: 'b',
  statute_ref: null, is_statutory_form: false, requires_notary: false, version: 1, notes: null, ...over,
});

describe('renderLienWaiver', () => {
  it('fills every placeholder exactly like the SQL renderer', () => {
    const out = renderLienWaiver('{{waiver_number}}|{{claimant_name}}|{{customer_name}}|{{property_address}}|{{project_name}}|{{through_date}}|{{amount}}|{{exceptions}}|{{state}}|{{statute_ref}}', {
      waiver_number: 'LW-0001', claimant_name: 'Acme', customer_name: 'Dana', property_address: '12 Elm', project_name: 'Proj',
      through_date: '2027-01-10', amount_cents: 900000, exceptions: '  ', state_code: 'TX', statute_ref: 'Tex. Prop. Code',
    });
    expect(out).toBe('LW-0001|Acme|Dana|12 Elm|Proj|January 10, 2027|$9,000.00|None|TX|Tex. Prop. Code');
  });

  it('falls back to "Not specified" for empty address, project and statute', () => {
    const out = renderLienWaiver('{{property_address}}/{{project_name}}/{{statute_ref}}', {
      claimant_name: 'A', customer_name: 'B', through_date: '2027-01-10', amount_cents: 0, state_code: 'US',
    });
    expect(out).toBe('Not specified/Not specified/Not specified');
  });
});

describe('formatting', () => {
  it('formats dates without timezone drift and money in cents', () => {
    expect(longDate('2027-12-01')).toBe('December 1, 2027');
    expect(longDate(null)).toBe('—');
    expect(formatUsd(123456)).toBe('$1,234.56');
  });
});

describe('guessStateCode', () => {
  it('reads the state from the address', () => {
    expect(guessStateCode('12 Elm St, Austin, TX 78701')).toBe('TX');
    expect(guessStateCode('9 Pine Rd, Sacramento, CA')).toBe('CA');
    expect(guessStateCode('Somewhere, ZZ 12345')).toBe('US');
    expect(guessStateCode(null)).toBe('US');
  });
});

describe('resolveTemplate', () => {
  const lib = [tpl({ id: 'us' }), tpl({ id: 'tx', state_code: 'TX' }), tpl({ id: 'mine-us', user_id: 'me' }), tpl({ id: 'mine-tx', user_id: 'me', state_code: 'TX' }), tpl({ id: 'other', user_id: 'x', state_code: 'TX' })];
  it('prefers state over generic, then account over library, and ignores other accounts', () => {
    expect(resolveTemplate(lib, 'TX', 'conditional_progress', 'me')?.id).toBe('mine-tx');
    expect(resolveTemplate(lib.filter((t) => t.id !== 'mine-tx'), 'TX', 'conditional_progress', 'me')?.id).toBe('tx');
    expect(resolveTemplate(lib, 'NY', 'conditional_progress', 'me')?.id).toBe('mine-us');
    expect(resolveTemplate(lib, 'NY', 'unconditional_final', 'me')).toBeNull();
  });
});

describe('pay-app coverage', () => {
  const w = (waiver_type: LienWaiver['waiver_type'], status: LienWaiver['status'], direction: LienWaiver['direction'] = 'given') => ({ waiver_type, status, direction });
  it('tracks what each draw still needs', () => {
    expect(payAppState(null, [])).toBe('not_invoiced');
    expect(payAppState({ status: 'sent' }, [])).toBe('needs_conditional');
    expect(payAppState({ status: 'sent' }, [w('conditional_progress', 'draft')])).toBe('needs_conditional');
    expect(payAppState({ status: 'sent' }, [w('conditional_progress', 'signed')])).toBe('conditional_signed');
    expect(payAppState({ status: 'paid' }, [w('conditional_progress', 'signed')])).toBe('needs_unconditional');
    expect(payAppState({ status: 'paid' }, [w('unconditional_final', 'signed')])).toBe('complete');
  });
  it('ignores void, declined and received waivers', () => {
    expect(payAppState({ status: 'paid' }, [w('unconditional_progress', 'void'), w('unconditional_progress', 'declined')])).toBe('needs_unconditional');
    expect(payAppState({ status: 'paid' }, [w('unconditional_progress', 'signed', 'received')])).toBe('needs_unconditional');
  });
  it('suggests conditional until paid, unconditional after, final for the last draw', () => {
    expect(suggestedType({ status: 'sent' }, false)).toBe('conditional_progress');
    expect(suggestedType({ status: 'paid' }, false)).toBe('unconditional_progress');
    expect(suggestedType({ status: 'sent' }, true)).toBe('conditional_final');
    expect(suggestedType({ status: 'paid' }, true)).toBe('unconditional_final');
  });
  it('detects the final draw only when the schedule covers 100%', () => {
    const draws = [{ id: 'a', sort_order: 0, percent_of_contract: 50 }, { id: 'b', sort_order: 1, percent_of_contract: 50 }];
    expect(isFinalDraw(draws[1], draws)).toBe(true);
    expect(isFinalDraw(draws[0], draws)).toBe(false);
    expect(isFinalDraw(draws[1], [draws[0], { ...draws[1], percent_of_contract: 20 }])).toBe(false);
    expect(isFinalDraw(draws[0], [draws[0]])).toBe(false);
  });
  it('requires payment proof only for unconditional waivers we give', () => {
    expect(needsPaymentProof({ direction: 'given', waiver_type: 'unconditional_final' })).toBe(true);
    expect(needsPaymentProof({ direction: 'given', waiver_type: 'conditional_final' })).toBe(false);
    expect(needsPaymentProof({ direction: 'received', waiver_type: 'unconditional_final' })).toBe(false);
  });
});

describe('status + summary', () => {
  const base = { status: 'sent' as const, expires_at: '2027-01-01T00:00:00Z' };
  it('derives expiry', () => {
    expect(displayStatus(base, Date.parse('2026-12-31T00:00:00Z'))).toBe('sent');
    expect(displayStatus(base, Date.parse('2027-01-02T00:00:00Z'))).toBe('expired');
    expect(displayStatus({ status: 'signed', expires_at: base.expires_at }, Date.parse('2030-01-01T00:00:00Z'))).toBe('signed');
  });
  it('summarizes', () => {
    const mk = (status: LienWaiver['status'], amount_cents = 100) => ({ status, amount_cents, expires_at: null }) as LienWaiver;
    expect(summarize([mk('signed', 500), mk('sent'), mk('draft'), mk('void')], ['needs_conditional', 'complete'])).toEqual({ signed: 1, awaiting: 1, drafts: 1, signedCents: 500, needsAction: 1 });
  });
});

describe('errors + public parsing', () => {
  it('maps database error codes to friendly copy', () => {
    expect(lienWaiverError({ message: 'payment_not_confirmed' }, 'x')).toMatch(/Confirm that payment/);
    expect(lienWaiverError(new Error('boom'), 'fallback')).toBe('fallback');
  });
  it('parses the public payload and rejects junk', () => {
    expect(parsePublicLienWaiver(null)).toBeNull();
    expect(parsePublicLienWaiver({ waiver_type: 'nope', body: 'x', claimant_name: 'A' })).toBeNull();
    const p = parsePublicLienWaiver({ waiver_type: 'conditional_final', body: 'Body', claimant_name: 'Acme', amount_cents: 500, status: 'sent', requires_notary: true });
    expect(p?.amountCents).toBe(500);
    expect(p?.requiresNotary).toBe(true);
    expect(p?.status).toBe('sent');
  });
});
