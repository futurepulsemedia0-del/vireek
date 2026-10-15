import { describe, it, expect } from 'vitest';
import {
  applyUnsubscribeAll,
  describeOutcome,
  formFromRow,
  isDirty,
  isUuid,
  isValidForm,
  resubscribe,
  summarize,
  type PreferenceForm,
  type PreferenceRow,
} from './communicationPreferences';

const row: PreferenceRow = {
  business_name: 'Cool Air',
  customer_first_name: 'Ada',
  masked_phone: '•••• 4567',
  masked_email: 'a***@x.com',
  sms_enabled: true,
  email_enabled: true,
  voice_enabled: false,
  reminders_enabled: true,
  surveys_enabled: true,
  marketing_enabled: false,
  language: 'es',
  frequency: 'weekly',
  unsubscribed_all: false,
  sms_blocked_by_stop: false,
};

describe('formFromRow / isDirty', () => {
  it('maps the RPC row to the form', () => {
    expect(formFromRow(row)).toEqual({
      sms: true, email: true, voice: false, reminders: true, surveys: true, marketing: false,
      language: 'es', frequency: 'weekly', unsubscribeAll: false,
    });
  });
  it('detects any single change', () => {
    const f = formFromRow(row);
    expect(isDirty(f, { ...f })).toBe(false);
    expect(isDirty(f, { ...f, language: 'en' })).toBe(true);
    expect(isDirty(f, { ...f, marketing: true })).toBe(true);
  });
});

describe('applyUnsubscribeAll / resubscribe', () => {
  it('switches off every optional channel and category, keeps language', () => {
    const f = applyUnsubscribeAll(formFromRow(row));
    expect(f).toMatchObject({
      sms: false, email: false, voice: false, reminders: false, surveys: false, marketing: false,
      frequency: 'essential', unsubscribeAll: true, language: 'es',
    });
  });
  it('re-subscribing only enables channels the customer actually has', () => {
    const muted = applyUnsubscribeAll(formFromRow(row));
    const f = resubscribe(muted, { phone: false, email: true });
    expect(f).toMatchObject({ sms: false, voice: false, email: true, reminders: true, frequency: 'all', unsubscribeAll: false });
  });
});

describe('isValidForm', () => {
  const f = formFromRow(row);
  it('accepts a good form and rejects bad language/frequency', () => {
    expect(isValidForm(f)).toBe(true);
    expect(isValidForm({ ...f, language: 'xx' as PreferenceForm['language'] })).toBe(false);
    expect(isValidForm({ ...f, frequency: 'daily' as PreferenceForm['frequency'] })).toBe(false);
  });
});

describe('summarize', () => {
  const f = formFromRow(row);
  it('describes what will be received in plain language', () => {
    expect(summarize({ ...f, marketing: false, surveys: false })).toBe('You will get reminders by text and email, at most weekly.');
    expect(summarize({ ...f, frequency: 'all' })).toBe('You will get reminders and feedback requests by text and email.');
  });
  it('falls back to essential-only when nothing optional is reachable', () => {
    const essential = 'You will only receive essential messages (appointments, invoices and safety notices).';
    expect(summarize(applyUnsubscribeAll(f))).toBe(essential);
    expect(summarize({ ...f, sms: false, email: false, voice: false })).toBe(essential);
    expect(summarize({ ...f, reminders: false, surveys: false, marketing: false })).toBe(essential);
  });
});

describe('token + outcome helpers', () => {
  it('validates uuid tokens', () => {
    expect(isUuid('11111111-1111-1111-1111-111111111111')).toBe(true);
    expect(isUuid('not-a-token')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
  it('maps outcomes to messages', () => {
    expect(describeOutcome('ok')).toBe('');
    expect(describeOutcome('not_found')).toMatch(/no longer valid/);
    expect(describeOutcome('invalid')).toMatch(/could not be saved/);
  });
});
