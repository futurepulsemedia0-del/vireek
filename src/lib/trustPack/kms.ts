// Enterprise Trust Pack — customer-managed key (CMEK) access via AWS KMS.
//
// ISOMORPHIC (Deno edge functions + tests). Uses fetch + WebCrypto only — no AWS SDK.
//
// The customer creates a KMS key in THEIR AWS account and grants Vireek's IAM principal
// kms:GenerateDataKey / Decrypt / Encrypt / DescribeKey, conditioned on the encryption
// context `vireek_tenant = <their account id>`. Vireek never sees the key itself; it only
// asks KMS to generate/unwrap per-item data keys. If the customer disables the key or
// removes the grant, KMS refuses and the data becomes unreadable immediately.

import { bs, fromBase64, toBase64 } from './envelope.ts';

export type EncryptionContext = Record<string, string>;

export interface DataKey {
  /** Raw 32-byte data key. Caller must wipe() it after use. */
  plaintext: Uint8Array;
  /** KMS-wrapped copy, base64 — safe to store. */
  wrapped: string;
}

export interface KmsProvider {
  generateDataKey(keyArn: string, ctx: EncryptionContext): Promise<DataKey>;
  unwrap(keyArn: string, wrapped: string, ctx: EncryptionContext): Promise<Uint8Array>;
  wrap(keyArn: string, dek: Uint8Array, ctx: EncryptionContext): Promise<string>;
}

export type KmsErrorCode =
  | 'ACCESS_DENIED'
  | 'KEY_DISABLED'
  | 'KEY_NOT_FOUND'
  | 'INVALID_CIPHERTEXT'
  | 'THROTTLED'
  | 'UNREACHABLE'
  | 'NOT_CONFIGURED'
  | 'INVALID_REQUEST';

export class KmsError extends Error {
  readonly code: KmsErrorCode;
  readonly retryable: boolean;
  constructor(code: KmsErrorCode, message: string) {
    super(message);
    this.name = 'KmsError';
    this.code = code;
    this.retryable = code === 'THROTTLED' || code === 'UNREACHABLE';
  }
}

/** What the customer sees when KMS refuses. Never leaks AWS internals. */
export function describeKmsError(code: KmsErrorCode): string {
  switch (code) {
    case 'ACCESS_DENIED': return 'Vireek is not allowed to use this key. Check the key policy grants our principal access.';
    case 'KEY_DISABLED': return 'The key is disabled or scheduled for deletion in your AWS account.';
    case 'KEY_NOT_FOUND': return 'The key could not be found. Check the ARN and region.';
    case 'INVALID_CIPHERTEXT': return 'The stored data key does not match this key.';
    case 'THROTTLED': return 'AWS KMS is rate limiting requests. Try again shortly.';
    case 'UNREACHABLE': return 'AWS KMS could not be reached. Try again shortly.';
    case 'NOT_CONFIGURED': return 'Customer-managed keys are not configured on this deployment.';
    default: return 'The key request was rejected.';
  }
}

// ---------------------------------------------------------------------------
// ARN handling
// ---------------------------------------------------------------------------

export interface ParsedKmsArn {
  region: string;
  accountId: string;
  kind: 'key' | 'alias';
  resource: string;
}

const KEY_ARN_RE = /^arn:aws:kms:([a-z]{2}(?:-[a-z]+)+-\d):(\d{12}):(key\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|key\/mrk-[0-9a-f]{32}|alias\/[A-Za-z0-9/_-]{1,256})$/;

export function parseKmsArn(arn: string): ParsedKmsArn | null {
  const m = KEY_ARN_RE.exec(arn.trim());
  if (!m) return null;
  return { region: m[1], accountId: m[2], kind: m[3].startsWith('alias/') ? 'alias' : 'key', resource: m[3] };
}

/** Encryption context bound to every wrap/unwrap — enforceable in the customer's key policy. */
export function tenantContext(ownerId: string): EncryptionContext {
  return { vireek_tenant: ownerId.toLowerCase(), vireek_purpose: 'sealed-data' };
}

/** Key-policy statement shown to the customer during setup. */
export function buildKeyPolicyStatement(principalArn: string, ownerId: string): Record<string, unknown> {
  return {
    Sid: 'AllowVireekEnvelopeEncryption',
    Effect: 'Allow',
    Principal: { AWS: principalArn },
    Action: ['kms:GenerateDataKey', 'kms:Decrypt', 'kms:Encrypt', 'kms:DescribeKey'],
    Resource: '*',
    Condition: { StringEquals: { 'kms:EncryptionContext:vireek_tenant': ownerId.toLowerCase() } },
  };
}

// ---------------------------------------------------------------------------
// AWS Signature Version 4 (enough for KMS: path "/", no query string)
// ---------------------------------------------------------------------------

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const te = new TextEncoder();
const hex = (buf: ArrayBuffer | Uint8Array): string =>
  Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? te.encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bs(bytes)));
}

async function hmac(key: Uint8Array | ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key instanceof Uint8Array ? bs(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, bs(te.encode(data)));
}

export interface SignInput {
  method: string;
  host: string;
  region: string;
  service: string;
  headers: Record<string, string>;
  body: string;
  credentials: AwsCredentials;
  date: Date;
}

/** Returns the headers to send (original + x-amz-date [+ security token] + Authorization). */
export async function signAwsRequest(input: SignInput): Promise<Record<string, string>> {
  const amzDate = input.date.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20150830T123600Z
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = { ...input.headers, host: input.host, 'x-amz-date': amzDate };
  if (input.credentials.sessionToken) headers['x-amz-security-token'] = input.credentials.sessionToken;

  const canon = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalHeaders = canon.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = canon.map(([k]) => k).join(';');

  const canonicalRequest = [input.method.toUpperCase(), '/', '', canonicalHeaders, signedHeaders, await sha256Hex(input.body)].join('\n');
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');

  const kDate = await hmac(te.encode(`AWS4${input.credentials.secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, input.region);
  const kService = await hmac(kRegion, input.service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = hex(await hmac(kSigning, stringToSign));

  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function awsCredentialsFromEnv(env: (k: string) => string | undefined): AwsCredentials | null {
  const accessKeyId = env('TRUST_AWS_ACCESS_KEY_ID');
  const secretAccessKey = env('TRUST_AWS_SECRET_ACCESS_KEY');
  if (!accessKeyId || !secretAccessKey) return null;
  return { accessKeyId, secretAccessKey, sessionToken: env('TRUST_AWS_SESSION_TOKEN') };
}

type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface AwsKmsOptions {
  fetchImpl?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

function mapAwsError(type: string | undefined, status: number): KmsErrorCode {
  const t = (type ?? '').split('#').pop() ?? '';
  if (/AccessDenied|UnrecognizedClient|InvalidSignature|ExpiredToken|IncompleteSignature/i.test(t) || status === 403) return 'ACCESS_DENIED';
  if (/Disabled|KMSInvalidState|InvalidState/i.test(t)) return 'KEY_DISABLED';
  if (/NotFound/i.test(t)) return 'KEY_NOT_FOUND';
  if (/InvalidCiphertext|IncorrectKey/i.test(t)) return 'INVALID_CIPHERTEXT';
  if (/Throttl|LimitExceeded|TooManyRequests/i.test(t) || status === 429) return 'THROTTLED';
  if (status >= 500) return 'UNREACHABLE';
  return 'INVALID_REQUEST';
}

export class AwsKmsProvider implements KmsProvider {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(private readonly credentials: AwsCredentials, opts: AwsKmsOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  private async call(target: string, keyArn: string, payload: Record<string, unknown>): Promise<Record<string, string>> {
    const parsed = parseKmsArn(keyArn);
    if (!parsed) throw new KmsError('INVALID_REQUEST', 'Invalid KMS key ARN');
    const host = `kms.${parsed.region}.amazonaws.com`;
    const body = JSON.stringify({ KeyId: keyArn, ...payload });

    let lastErr: KmsError | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await this.sleep(250);
      const headers = await signAwsRequest({
        method: 'POST',
        host,
        region: parsed.region,
        service: 'kms',
        headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `TrentService.${target}` },
        body,
        credentials: this.credentials,
        date: this.now(),
      });
      try {
        const res = await this.fetchImpl(`https://${host}/`, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
        const text = await res.text();
        let json: Record<string, string> = {};
        try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }
        if (res.ok) return json;
        lastErr = new KmsError(mapAwsError(json.__type, res.status), `KMS ${target} failed (${res.status})`);
      } catch (e) {
        lastErr = e instanceof KmsError ? e : new KmsError('UNREACHABLE', 'KMS request failed');
      }
      if (!lastErr.retryable) break;
    }
    throw lastErr ?? new KmsError('UNREACHABLE', 'KMS request failed');
  }

  async generateDataKey(keyArn: string, ctx: EncryptionContext): Promise<DataKey> {
    const r = await this.call('GenerateDataKey', keyArn, { KeySpec: 'AES_256', EncryptionContext: ctx });
    if (!r.Plaintext || !r.CiphertextBlob) throw new KmsError('INVALID_REQUEST', 'KMS returned an incomplete data key');
    return { plaintext: fromBase64(r.Plaintext), wrapped: r.CiphertextBlob };
  }

  async unwrap(keyArn: string, wrapped: string, ctx: EncryptionContext): Promise<Uint8Array> {
    const r = await this.call('Decrypt', keyArn, { CiphertextBlob: wrapped, EncryptionContext: ctx });
    if (!r.Plaintext) throw new KmsError('INVALID_REQUEST', 'KMS returned no plaintext');
    return fromBase64(r.Plaintext);
  }

  async wrap(keyArn: string, dek: Uint8Array, ctx: EncryptionContext): Promise<string> {
    const r = await this.call('Encrypt', keyArn, { Plaintext: toBase64(dek), EncryptionContext: ctx });
    if (!r.CiphertextBlob) throw new KmsError('INVALID_REQUEST', 'KMS returned no ciphertext');
    return r.CiphertextBlob;
  }
}

/**
 * Proves Vireek can really use the key: generate a data key, unwrap it, compare.
 * Called on registration and on a schedule, so revocation is noticed quickly.
 */
export async function validateKey(provider: KmsProvider, keyArn: string, ownerId: string): Promise<{ ok: true } | { ok: false; code: KmsErrorCode }> {
  const ctx = tenantContext(ownerId);
  try {
    const dk = await provider.generateDataKey(keyArn, ctx);
    const back = await provider.unwrap(keyArn, dk.wrapped, ctx);
    const same = back.byteLength === dk.plaintext.byteLength && back.every((b, i) => b === dk.plaintext[i]);
    dk.plaintext.fill(0);
    back.fill(0);
    return same ? { ok: true } : { ok: false, code: 'INVALID_CIPHERTEXT' };
  } catch (e) {
    return { ok: false, code: e instanceof KmsError ? e.code : 'UNREACHABLE' };
  }
}
