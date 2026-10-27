import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { CliError, usageError } from './errors.js';

/** Header names as sent by supabase/functions/event-bus-dispatch. */
export const SIGNATURE_HEADER = 'X-Vireek-Signature';
export const DELIVERY_HEADER = 'X-Vireek-Delivery-Id';
/** The dispatcher aborts after 10 s; the test sender mirrors that. */
export const DELIVERY_TIMEOUT_MS = 10_000;

export const KNOWN_EVENTS = [
  'call.created',
  'call.emergency',
  'lead.created',
  'job.created',
  'job.completed',
  'quote.sent',
  'quote.accepted',
  'review.completed',
  'automation.installed',
] as const;
export type KnownEvent = (typeof KNOWN_EVENTS)[number];

const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

export function validateEventName(event: string): string {
  if (!EVENT_NAME.test(event)) {
    throw usageError(`Invalid event name "${event}".`, 'Use the dotted form, e.g. job.completed.');
  }
  return event;
}

/** HMAC-SHA256 hex digest of the exact request body, keyed by the endpoint's signing secret. */
export function signPayload(secret: string, body: string | Uint8Array): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function verifySignature(secret: string, body: string | Uint8Array, signature: string): boolean {
  const given = signature.trim();
  if (!/^[0-9a-f]{64}$/i.test(given)) return false;
  return timingSafeEqual(Buffer.from(signPayload(secret, body), 'hex'), Buffer.from(given, 'hex'));
}

export interface Envelope {
  id: string;
  event: string;
  created_at: string;
  data: unknown;
}

/** Same field order as the production dispatcher, so signatures are byte-for-byte comparable. */
export function buildEnvelope(event: string, data: unknown, id: string = randomUUID(), now: Date = new Date()): Envelope {
  return { id, event, created_at: now.toISOString(), data };
}

const SAMPLE_USER = '00000000-0000-4000-8000-000000000001';
const SAMPLE_ID = '00000000-0000-4000-8000-0000000000a1';

/** Illustrative payloads. Pass --data to send the exact record your receiver expects. */
export function sampleData(event: KnownEvent, now: Date = new Date()): Record<string, unknown> {
  const stamp = now.toISOString();
  const call = {
    id: SAMPLE_ID,
    user_id: SAMPLE_USER,
    external_id: 'sample-call-1',
    caller_phone: '+15555550100',
    caller_name: 'Sample Caller',
    call_datetime: stamp,
    duration_seconds: 94,
    summary: 'Customer reports no heat and asks for a technician today.',
    is_emergency: false,
    sentiment: 'neutral',
    status: 'new_lead',
    tags: [],
    created_at: stamp,
  };
  const job = {
    id: SAMPLE_ID,
    user_id: SAMPLE_USER,
    customer_name: 'Sample Customer',
    service_type: 'Furnace repair',
    address: '1 Sample Street',
    scheduled_datetime: stamp,
    job_status: 'scheduled',
    invoice_amount: null,
    invoice_status: null,
    completed_at: null,
    created_at: stamp,
  };
  switch (event) {
    case 'call.created':
      return call;
    case 'call.emergency':
      return { ...call, is_emergency: true, sentiment: 'negative', status: 'emergency' };
    case 'lead.created':
      return {
        id: SAMPLE_ID,
        user_id: SAMPLE_USER,
        name: 'Sample Lead',
        phone: '+15555550101',
        email: 'lead@example.com',
        service_interested: 'AC installation',
        stage: 'new',
        tags: [],
        created_at: stamp,
      };
    case 'job.created':
      return job;
    case 'job.completed':
      return { ...job, job_status: 'completed', invoice_amount: 420, invoice_status: 'sent', completed_at: stamp };
    case 'quote.sent':
    case 'quote.accepted':
      return {
        id: SAMPLE_ID,
        user_id: SAMPLE_USER,
        customer_name: 'Sample Customer',
        status: event === 'quote.sent' ? 'sent' : 'accepted',
        total_amount: 1850,
        created_at: stamp,
      };
    case 'review.completed':
      return { id: SAMPLE_ID, user_id: SAMPLE_USER, rating: 5, customer_name: 'Sample Customer', created_at: stamp };
    case 'automation.installed':
      return { id: SAMPLE_ID, user_id: SAMPLE_USER, automation_key: 'vip-customer-tag', created_at: stamp };
  }
}

export function isKnownEvent(event: string): event is KnownEvent {
  return (KNOWN_EVENTS as readonly string[]).includes(event);
}

/** https only, except loopback (local receivers) or when explicitly allowed. */
export function validateTargetUrl(raw: string, allowInsecure = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usageError(`Invalid webhook URL "${raw}".`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw usageError('The webhook URL must be http(s).');
  if (url.username || url.password) throw usageError('Do not put credentials in the webhook URL.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !loopback && !allowInsecure) {
    throw usageError('Refusing to send to a non-https URL.', 'Use https, or pass --allow-insecure for a trusted test host.');
  }
  return url;
}

export interface DeliveryResult {
  url: string;
  event: string;
  deliveryId: string;
  signature: string;
  body: string;
  ok: boolean;
  status?: number;
  latencyMs: number;
  responseSnippet: string;
  error?: string;
}

export interface SendOptions {
  url: URL;
  secret: string;
  event: string;
  data: unknown;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  deliveryId?: string;
  now?: Date;
  signal?: AbortSignal;
}

/** Sends one signed delivery exactly like production would (single attempt, no retries). */
export async function sendTestDelivery(options: SendOptions): Promise<DeliveryResult> {
  const { url, secret, event, data, fetchImpl = fetch, timeoutMs = DELIVERY_TIMEOUT_MS } = options;
  const deliveryId = options.deliveryId ?? randomUUID();
  const body = JSON.stringify(buildEnvelope(event, data, deliveryId, options.now));
  const signature = signPayload(secret, body);
  const started = performance.now();
  const base = { url: url.toString(), event, deliveryId, signature, body };
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [SIGNATURE_HEADER]: signature,
        [DELIVERY_HEADER]: deliveryId,
        'User-Agent': 'Vireek-Webhooks/1.0 (cli-test)',
      },
      body,
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
    const text = await response.text().catch(() => '');
    return {
      ...base,
      ok: response.ok,
      status: response.status,
      latencyMs: Math.round(performance.now() - started),
      responseSnippet: text.replace(/\s+/g, ' ').trim().slice(0, 300),
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return {
      ...base,
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      responseSnippet: '',
      error: timedOut ? `Timed out after ${timeoutMs}ms` : error instanceof Error ? error.message : String(error),
    };
  }
}

export type SignatureStatus = 'valid' | 'invalid' | 'missing' | 'unchecked';

export interface ReceivedDelivery {
  at: Date;
  event: string | null;
  deliveryId: string | null;
  signature: SignatureStatus;
  duplicate: boolean;
  bytes: number;
  body: string;
  status: number;
}

export interface ListenerOptions {
  secret?: string;
  onDelivery: (delivery: ReceivedDelivery) => void;
  maxBodyBytes?: number;
}

/**
 * A local webhook receiver that verifies signatures the same way a production
 * consumer should: over the raw bytes, with a constant-time comparison.
 */
export function createWebhookListener({ secret, onDelivery, maxBodyBytes = 1_048_576 }: ListenerOptions): http.Server {
  const seen = new Set<string>();

  return http.createServer((req, res) => {
    const reply = (status: number, body: Record<string, unknown>) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true });
    if (req.method !== 'POST') return reply(405, { error: 'Method not allowed' });

    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBodyBytes) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('error', () => undefined);
    req.on('end', () => {
      if (tooLarge) return reply(413, { error: 'Payload too large' });
      const raw = Buffer.concat(chunks);
      const header = req.headers[SIGNATURE_HEADER.toLowerCase()];
      const given = Array.isArray(header) ? header[0] : header;

      let signature: SignatureStatus = 'unchecked';
      if (secret) signature = !given ? 'missing' : verifySignature(secret, raw, given) ? 'valid' : 'invalid';

      let event: string | null = null;
      let deliveryId: string | null = null;
      let parsed = true;
      try {
        const envelope = JSON.parse(raw.toString('utf8')) as Partial<Envelope>;
        event = typeof envelope.event === 'string' ? envelope.event : null;
        deliveryId = typeof envelope.id === 'string' ? envelope.id : null;
      } catch {
        parsed = false;
      }

      const status = signature === 'invalid' || signature === 'missing' ? 401 : parsed ? 200 : 400;
      const duplicate = status === 200 && deliveryId !== null && seen.has(deliveryId);
      if (status === 200 && deliveryId !== null) {
        seen.add(deliveryId);
        if (seen.size > 1_000) seen.delete(seen.values().next().value as string);
      }
      onDelivery({ at: new Date(), event, deliveryId, signature, duplicate, bytes: raw.length, body: raw.toString('utf8'), status });
      reply(status, status === 200 ? { received: true } : { error: status === 401 ? 'Invalid signature' : 'Invalid JSON' });
    });
  });
}

export function requireSecret(secret: string | undefined): string {
  if (!secret) {
    throw new CliError('A signing secret is required.', {
      exitCode: 2,
      hint: 'Pass --secret or set VIREEK_WEBHOOK_SECRET (the whsec_… value of your endpoint).',
    });
  }
  return secret;
}
