import { describe, expect, it, vi } from 'vitest';
import { disconnectProvider, followUpNote, type InvokeFn } from './providerDisconnect';

const invokeWith = (result: { data: unknown; error: unknown } | Error): InvokeFn =>
  vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });

describe('disconnectProvider', () => {
  it('sends provider and delete_imported_data to the edge function', async () => {
    const invoke = invokeWith({ data: { ok: true, revoked: null }, error: null });
    await disconnectProvider(invoke, 'jobber', true);
    expect(invoke).toHaveBeenCalledWith('provider-disconnect', { body: { provider: 'jobber', delete_imported_data: true } });
  });
  it('maps success, preserving the revoked flag', async () => {
    expect(await disconnectProvider(invokeWith({ data: { ok: true, revoked: true }, error: null }), 'google_calendar')).toEqual({ ok: true, revoked: true });
    expect(await disconnectProvider(invokeWith({ data: { ok: true }, error: null }), 'jobber')).toEqual({ ok: true, revoked: null });
  });
  it('surfaces the server message from data.error', async () => {
    const r = await disconnectProvider(invokeWith({ data: { error: "You don't have permission to manage integrations." }, error: null }), 'jobber');
    expect(r).toEqual({ ok: false, message: "You don't have permission to manage integrations." });
  });
  it('reads the message from a non-2xx Response context', async () => {
    const error = { context: { json: async () => ({ error: 'Unknown provider.' }) } };
    expect(await disconnectProvider(invokeWith({ data: null, error }), 'jobber')).toEqual({ ok: false, message: 'Unknown provider.' });
  });
  it('falls back to a generic message and never throws', async () => {
    const generic = { ok: false, message: 'Could not disconnect. Please try again.' };
    expect(await disconnectProvider(invokeWith({ data: null, error: new Error('x') }), 'jobber')).toEqual(generic);
    expect(await disconnectProvider(invokeWith(new Error('network')), 'jobber')).toEqual(generic);
    expect(await disconnectProvider(invokeWith({ data: { ok: false }, error: null }), 'jobber')).toEqual(generic);
  });
});

describe('followUpNote', () => {
  it('asks the user to remove the app at non-Google providers', () => {
    expect(followUpNote('Jobber', 'jobber', null)).toContain('connected apps');
  });
  it('is silent when Google confirmed revocation, helpful when it did not', () => {
    expect(followUpNote('Google Calendar', 'google_calendar', true)).toBeNull();
    expect(followUpNote('Google Calendar', 'google_calendar', false)).toContain('myaccount.google.com/permissions');
  });
});
