import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
const upload = vi.fn();
const remove = vi.fn();
const signInWithOtp = vi.fn();
const verifyOtpMock = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    auth: {
      signInWithOtp: (...a: unknown[]) => signInWithOtp(...a),
      verifyOtp: (...a: unknown[]) => verifyOtpMock(...a),
      signOut: vi.fn(),
    },
    storage: { from: () => ({ upload: (...a: unknown[]) => upload(...a), remove: (...a: unknown[]) => remove(...a) }) },
    functions: { invoke: vi.fn() },
  },
}));

import { fetchOverview, HomeownerApiError, linkByPortalLink, requestOtp, submitServiceRequest, verifyOtp } from './api';

const photo = (name = 'a.jpg', type = 'image/jpeg', size = 1000) => new File([new Uint8Array(size)], name, { type });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('auth', () => {
  it('requests an OTP for the E.164 number', async () => {
    signInWithOtp.mockResolvedValue({ error: null });
    await requestOtp('+15551234567');
    expect(signInWithOtp).toHaveBeenCalledWith({ phone: '+15551234567', options: { shouldCreateUser: true } });
  });
  it('maps rate-limit and bad-code errors', async () => {
    signInWithOtp.mockResolvedValue({ error: { message: 'For security purposes, you can only request this after 30 seconds' } });
    await expect(requestOtp('+15551234567')).rejects.toMatchObject({ code: 'rate_limited' });
    verifyOtpMock.mockResolvedValue({ error: { message: 'Token has expired or is invalid' } });
    await expect(verifyOtp('+15551234567', '000000')).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('rpc error mapping', () => {
  it('turns 42501 into forbidden and network failures into network', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'x' } });
    await expect(fetchOverview()).rejects.toMatchObject({ code: 'forbidden' });
    rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(fetchOverview()).rejects.toBeInstanceOf(HomeownerApiError);
  });
});

describe('linkByPortalLink', () => {
  it('extracts the token from a full link', async () => {
    rpc.mockResolvedValue({ data: 'link-1', error: null });
    const t = '3f2b8c1e-9a4d-4e7b-8c55-1a2b3c4d5e6f';
    await expect(linkByPortalLink(`https://vireek.com/portal/${t}`)).resolves.toBe('link-1');
    expect(rpc).toHaveBeenCalledWith('homeowner_link_by_portal_token', { p_token: t });
  });
  it('rejects input without a token before calling the server', async () => {
    await expect(linkByPortalLink('hello')).rejects.toMatchObject({ code: 'invalid' });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('submitServiceRequest', () => {
  const base = { linkId: 'l1', userId: 'u1', serviceType: 'Plumbing', message: 'Leak' };

  it('uploads photos under the user folder, then submits their paths', async () => {
    upload.mockResolvedValue({ error: null });
    rpc.mockResolvedValue({ data: 'req-1', error: null });
    await expect(submitServiceRequest({ ...base, files: [photo(), photo('b.png', 'image/png')] })).resolves.toBe('req-1');
    expect(upload).toHaveBeenCalledTimes(2);
    const paths = rpc.mock.calls[0][1].p_photo_paths as string[];
    expect(paths).toHaveLength(2);
    paths.forEach((p) => expect(p.startsWith('u1/')).toBe(true));
  });

  it('rejects an invalid file before uploading anything', async () => {
    await expect(submitServiceRequest({ ...base, files: [photo('x.pdf', 'application/pdf')] })).rejects.toMatchObject({ code: 'invalid' });
    expect(upload).not.toHaveBeenCalled();
  });

  it('removes uploaded photos when the submit fails', async () => {
    upload.mockResolvedValue({ error: null });
    rpc.mockResolvedValue({ data: null, error: { code: '54000', message: 'too many' } });
    remove.mockResolvedValue({ error: null });
    await expect(submitServiceRequest({ ...base, files: [photo()] })).rejects.toMatchObject({ code: 'rate_limited' });
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
