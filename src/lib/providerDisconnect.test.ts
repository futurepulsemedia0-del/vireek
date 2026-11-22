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
  it('maps the new response contract (revocation + manual_action_required)', async () => {
    const r = await disconnectProvider(
      invokeWith({ data: { ok: true, revoked: true, revocation: 'revoked', manual_action_required: true }, error: null }),
      'hubspot',
    );
    expect(r).toEqual({ ok: true, revoked: true, revocation: 'revoked', manualActionRequired: true });
    const u = await disconnectProvider(
      invokeWith({ data: { ok: true, revoked: null, revocation: 'unsupported', manual_action_required: true }, error: null }),
      'service_titan',
    );
    expect(u).toEqual({ ok: true, revoked: null, revocation: 'unsupported', manualActionRequired: true });
  });
  it('derives the new fields from an older server response that only returns `revoked`', async () => {
    expect(await disconnectProvider(invokeWith({ data: { ok: true, revoked: true }, error: null }), 'google_calendar')).toEqual({
      ok: true, revoked: true, revocation: 'revoked', manualActionRequired: false,
    });
    expect(await disconnectProvider(invokeWith({ data: { ok: true, revoked: false }, error: null }), 'google_calendar')).toEqual({
      ok: true, revoked: false, revocation: 'failed', manualActionRequired: true,
    });
    expect(await disconnectProvider(invokeWith({ data: { ok: true }, error: null }), 'jobber')).toEqual({
      ok: true, revoked: null, revocation: 'unsupported', manualActionRequired: true,
    });
  });
  it('ignores an unknown revocation value instead of trusting it', async () => {
    const r = await disconnectProvider(invokeWith({ data: { ok: true, revoked: null, revocation: 'weird' }, error: null }), 'jobber');
    expect(r).toMatchObject({ ok: true, revocation: 'unsupported' });
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
  const out = (revocation: 'revoked' | 'failed' | 'unsupported' | 'no_credentials', manualActionRequired = true) => ({
    revoked: revocation === 'revoked' ? true : revocation === 'failed' ? false : null,
    revocation,
    manualActionRequired,
  });

  it('is silent when Google or Jobber confirmed the revocation', () => {
    expect(followUpNote('Google Calendar', 'google_calendar', out('revoked', false))).toBeNull();
    expect(followUpNote('Jobber', 'jobber', out('revoked', false))).toBeNull();
  });
  it('points to the provider when Google or Jobber did not confirm', () => {
    expect(followUpNote('Google Calendar', 'google_calendar', out('failed', false))).toContain('myaccount.google.com/permissions');
    expect(followUpNote('Jobber', 'jobber', out('failed', false))).toContain('connected apps');
  });
  it('tells the truth about HubSpot: only the refresh token is removed, the app stays installed', () => {
    const ok = followUpNote('HubSpot', 'hubspot', out('revoked'));
    expect(ok).toContain('refresh token');
    expect(ok).toContain('uninstall');
    expect(followUpNote('HubSpot', 'hubspot', out('failed'))).toContain('did not confirm');
  });
  it('says there is no remote revocation for ServiceTitan and Housecall Pro and where to remove the credential', () => {
    expect(followUpNote('ServiceTitan', 'service_titan', out('unsupported'))).toContain('no remote revocation');
    const hcp = followUpNote('Housecall Pro', 'housecall_pro', out('unsupported'));
    expect(hcp).toContain('no remote revocation');
    expect(hcp).toContain('API Key Management');
  });
  it('never claims a revocation that did not happen', () => {
    for (const p of ['service_titan', 'housecall_pro'] as const) {
      expect(followUpNote('X', p, out('unsupported'))).not.toMatch(/revoked|invalidated/);
    }
  });
});
