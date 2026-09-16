/**
 * Sandbox helpers — endpoint catalog, synthetic payloads, and API base URL.
 * Pure client-side; no backend dependency beyond the existing api-v1.
 */

export const API_BASE =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '') +
  '/functions/v1/api-v1';

export type HttpMethod = 'GET';

export interface SandboxEndpoint {
  id: string;
  method: HttpMethod;
  path: string;           // e.g. "/calls" or "/calls/:id"
  scope: string;
  description: string;
  hasId?: boolean;
  defaultLimit?: number;
}

export const SANDBOX_ENDPOINTS: SandboxEndpoint[] = [
  {
    id: 'calls-list',
    method: 'GET',
    path: '/calls',
    scope: 'calls:read',
    description: 'List recent calls (transcripts, summaries, sentiment).',
    defaultLimit: 5,
  },
  {
    id: 'calls-get',
    method: 'GET',
    path: '/calls/:id',
    scope: 'calls:read',
    description: 'Fetch a single call by ID.',
    hasId: true,
  },
  {
    id: 'leads-list',
    method: 'GET',
    path: '/leads',
    scope: 'leads:read',
    description: 'List leads captured from calls.',
    defaultLimit: 5,
  },
  {
    id: 'leads-get',
    method: 'GET',
    path: '/leads/:id',
    scope: 'leads:read',
    description: 'Fetch a single lead by ID.',
    hasId: true,
  },
  {
    id: 'jobs-list',
    method: 'GET',
    path: '/jobs',
    scope: 'jobs:read',
    description: 'List booked / scheduled jobs.',
    defaultLimit: 5,
  },
  {
    id: 'jobs-get',
    method: 'GET',
    path: '/jobs/:id',
    scope: 'jobs:read',
    description: 'Fetch a single job by ID.',
    hasId: true,
  },
];

export type SyntheticEventType = 'call.created' | 'lead.created' | 'job.created';

export interface SyntheticEvent {
  type: SyntheticEventType;
  label: string;
  description: string;
  payload: Record<string, unknown>;
}

function isoNow() {
  return new Date().toISOString();
}

function uid(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function buildSyntheticEvents(): SyntheticEvent[] {
  const now = isoNow();
  return [
    {
      type: 'call.created',
      label: 'Call created',
      description: 'A completed inbound call with transcript + summary.',
      payload: {
        event: 'call.created',
        created_at: now,
        data: {
          id: uid('call'),
          direction: 'inbound',
          status: 'completed',
          duration_seconds: 187,
          from: '+15551234567',
          to: '+15559876543',
          recording_url: null,
          transcript:
            'Caller: Hi, my AC stopped working this morning.\nAgent: I’m sorry to hear that. Can I get your address and preferred time?',
          summary: 'Homeowner reported AC failure. Prefers morning appointment tomorrow.',
          sentiment: 'neutral',
          lead_id: uid('lead'),
          created_at: now,
        },
      },
    },
    {
      type: 'lead.created',
      label: 'Lead created',
      description: 'A new lead captured from a call.',
      payload: {
        event: 'lead.created',
        created_at: now,
        data: {
          id: uid('lead'),
          name: 'Jordan Lee',
          phone: '+15551234567',
          email: 'jordan.lee@example.com',
          address: '742 Evergreen Terrace, Springfield',
          service: 'HVAC repair',
          urgency: 'same_day',
          source: 'inbound_call',
          status: 'new',
          notes: 'AC not cooling. Prefers morning window.',
          created_at: now,
        },
      },
    },
    {
      type: 'job.created',
      label: 'Job created',
      description: 'A scheduled job booked from a qualified lead.',
      payload: {
        event: 'job.created',
        created_at: now,
        data: {
          id: uid('job'),
          lead_id: uid('lead'),
          status: 'scheduled',
          service: 'HVAC diagnostic',
          scheduled_start: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          scheduled_end: new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString(),
          address: '742 Evergreen Terrace, Springfield',
          customer_name: 'Jordan Lee',
          customer_phone: '+15551234567',
          estimated_value_cents: 18900,
          created_at: now,
        },
      },
    },
  ];
}

export function buildCurl(opts: {
  method: string;
  url: string;
  apiKey: string;
}): string {
  const key = opts.apiKey.trim() || 'vrk_live_YOUR_KEY';
  return `curl -sS "${opts.url}" \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json"`;
}

export interface PlaygroundResult {
  ok: boolean;
  status: number;
  statusText: string;
  latencyMs: number;
  body: unknown;
  raw: string;
  error?: string;
}

export async function executeSandboxRequest(opts: {
  method: HttpMethod;
  path: string; // already resolved (no :id)
  apiKey: string;
  limit?: number;
  before?: string;
}): Promise<PlaygroundResult> {
  const url = new URL(API_BASE + opts.path);
  if (opts.limit != null) url.searchParams.set('limit', String(opts.limit));
  if (opts.before) url.searchParams.set('before', opts.before);

  const started = performance.now();
  try {
    const res = await fetch(url.toString(), {
      method: opts.method,
      headers: {
        Authorization: `Bearer ${opts.apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
    });
    const latencyMs = Math.round(performance.now() - started);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* keep raw text */
    }
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      latencyMs,
      body,
      raw: text,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    return {
      ok: false,
      status: 0,
      statusText: 'Network Error',
      latencyMs,
      body: null,
      raw: '',
      error: err instanceof Error ? err.message : 'Request failed',
    };
  }
}

const STORAGE_KEY = 'vireek_sandbox_api_key';

export function loadStoredKey(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveStoredKey(key: string) {
  try {
    if (key) localStorage.setItem(STORAGE_KEY, key);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
