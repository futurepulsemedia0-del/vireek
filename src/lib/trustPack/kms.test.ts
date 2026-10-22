// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { toBase64 } from './envelope';
import {
  AwsKmsProvider, KmsError, buildKeyPolicyStatement, parseKmsArn, signAwsRequest, tenantContext, validateKey, type KmsProvider,
} from './kms';

const OWNER = '11111111-1111-4111-8111-111111111111';
const ARN = 'arn:aws:kms:eu-central-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab';

describe('parseKmsArn', () => {
  it('parses key, multi-region key and alias ARNs', () => {
    expect(parseKmsArn(ARN)).toMatchObject({ region: 'eu-central-1', accountId: '123456789012', kind: 'key' });
    expect(parseKmsArn('arn:aws:kms:us-east-1:123456789012:key/mrk-1234567890abcdef1234567890abcdef')?.kind).toBe('key');
    expect(parseKmsArn('arn:aws:kms:ca-central-1:123456789012:alias/vireek-prod')?.kind).toBe('alias');
  });
  it('rejects malformed input', () => {
    for (const bad of ['', 'arn:aws:s3:::bucket', 'arn:aws:kms:eu-central-1:123:key/x', `${ARN}/extra`, `x${ARN}`, 'arn:aws:kms:eu-central-1:123456789012:key/../../x'])
      expect(parseKmsArn(bad)).toBeNull();
  });
});

describe('tenant context + policy', () => {
  it('lowercases the tenant id', () => {
    expect(tenantContext(OWNER.toUpperCase()).vireek_tenant).toBe(OWNER);
  });
  it('pins the key policy to the tenant', () => {
    const s = buildKeyPolicyStatement('arn:aws:iam::999999999999:role/vireek', OWNER) as { Condition: { StringEquals: Record<string, string> } };
    expect(s.Condition.StringEquals['kms:EncryptionContext:vireek_tenant']).toBe(OWNER);
  });
});

describe('SigV4', () => {
  it('matches the AWS "get-vanilla" test vector', async () => {
    const headers = await signAwsRequest({
      method: 'GET', host: 'example.amazonaws.com', region: 'us-east-1', service: 'service', headers: {}, body: '',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
      date: new Date('2015-08-30T12:36:00Z'),
    });
    expect(headers.Authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });
  it('signs the session token header when present', async () => {
    const h = await signAwsRequest({
      method: 'POST', host: 'kms.eu-central-1.amazonaws.com', region: 'eu-central-1', service: 'kms', headers: { 'content-type': 'application/x-amz-json-1.1' }, body: '{}',
      credentials: { accessKeyId: 'A', secretAccessKey: 'S', sessionToken: 'TOKEN' }, date: new Date('2026-01-01T00:00:00Z'),
    });
    expect(h['x-amz-security-token']).toBe('TOKEN');
    expect(h.Authorization).toContain('x-amz-security-token');
  });
});

type Call = { url: string; headers: Record<string, string>; body: string };
function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const impl = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) };
  };
  return { impl: impl as never, calls };
}
const creds = { accessKeyId: 'AKID', secretAccessKey: 'SECRET' };
const noSleep = async () => undefined;

describe('AwsKmsProvider', () => {
  it('generates a data key against the key’s regional endpoint with the tenant context', async () => {
    const dek = new Uint8Array(32).fill(7);
    const f = fakeFetch([{ status: 200, body: { Plaintext: toBase64(dek), CiphertextBlob: 'd3JhcHBlZA==' } }]);
    const kms = new AwsKmsProvider(creds, { fetchImpl: f.impl, sleep: noSleep, now: () => new Date('2026-01-01T00:00:00Z') });
    const dk = await kms.generateDataKey(ARN, tenantContext(OWNER));
    expect(Array.from(dk.plaintext)).toEqual(Array.from(dek));
    expect(dk.wrapped).toBe('d3JhcHBlZA==');
    expect(f.calls[0].url).toBe('https://kms.eu-central-1.amazonaws.com/');
    expect(f.calls[0].headers['x-amz-target']).toBe('TrentService.GenerateDataKey');
    const sent = JSON.parse(f.calls[0].body);
    expect(sent).toMatchObject({ KeyId: ARN, KeySpec: 'AES_256', EncryptionContext: { vireek_tenant: OWNER } });
  });
  it('maps AWS errors to stable codes', async () => {
    const cases: [number, string, string][] = [
      [400, 'AccessDeniedException', 'ACCESS_DENIED'], [400, 'DisabledException', 'KEY_DISABLED'],
      [400, 'KMSInvalidStateException', 'KEY_DISABLED'], [400, 'NotFoundException', 'KEY_NOT_FOUND'],
      [400, 'InvalidCiphertextException', 'INVALID_CIPHERTEXT'], [403, 'x', 'ACCESS_DENIED'],
    ];
    for (const [status, type, code] of cases) {
      const f = fakeFetch([{ status, body: { __type: `com.amazonaws.kms#${type}` } }]);
      const kms = new AwsKmsProvider(creds, { fetchImpl: f.impl, sleep: noSleep });
      await expect(kms.unwrap(ARN, 'x', {})).rejects.toMatchObject({ code });
      expect(f.calls.length).toBe(1); // non-retryable
    }
  });
  it('retries once on throttling, then succeeds', async () => {
    const f = fakeFetch([{ status: 400, body: { __type: 'ThrottlingException' } }, { status: 200, body: { Plaintext: toBase64(new Uint8Array(32)) } }]);
    const kms = new AwsKmsProvider(creds, { fetchImpl: f.impl, sleep: noSleep });
    const out = await kms.unwrap(ARN, 'x', {});
    expect(out.length).toBe(32);
    expect(f.calls.length).toBe(2);
  });
  it('gives up after one retry on 5xx', async () => {
    const f = fakeFetch([{ status: 503, body: {} }]);
    const kms = new AwsKmsProvider(creds, { fetchImpl: f.impl, sleep: noSleep });
    await expect(kms.unwrap(ARN, 'x', {})).rejects.toMatchObject({ code: 'UNREACHABLE' });
    expect(f.calls.length).toBe(2);
  });
  it('refuses an invalid ARN before any network call', async () => {
    const f = fakeFetch([{ status: 200, body: {} }]);
    const kms = new AwsKmsProvider(creds, { fetchImpl: f.impl, sleep: noSleep });
    await expect(kms.unwrap('nope', 'x', {})).rejects.toBeInstanceOf(KmsError);
    expect(f.calls.length).toBe(0);
  });
});

describe('validateKey', () => {
  const good: KmsProvider = {
    async generateDataKey() { return { plaintext: new Uint8Array([1, 2, 3]), wrapped: 'w' }; },
    async unwrap() { return new Uint8Array([1, 2, 3]); },
    async wrap() { return 'w'; },
  };
  it('passes when generate + unwrap agree', async () => {
    expect(await validateKey(good, ARN, OWNER)).toEqual({ ok: true });
  });
  it('fails with the KMS code when access is denied', async () => {
    const denied: KmsProvider = { ...good, async generateDataKey() { throw new KmsError('ACCESS_DENIED', 'no'); } };
    expect(await validateKey(denied, ARN, OWNER)).toEqual({ ok: false, code: 'ACCESS_DENIED' });
  });
  it('fails when the unwrapped key differs', async () => {
    const bad: KmsProvider = { ...good, async unwrap() { return new Uint8Array([9, 9, 9]); } };
    expect(await validateKey(bad, ARN, OWNER)).toEqual({ ok: false, code: 'INVALID_CIPHERTEXT' });
  });
});
