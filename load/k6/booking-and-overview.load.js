// k6: public booking page + booking RPCs + dashboard overview queries. STAGING ONLY.
//
//   k6 run -e APP_BASE_URL=https://<staging-app> \
//          -e SUPABASE_URL=https://<staging-ref>.supabase.co -e SUPABASE_ANON_KEY=... \
//          -e BOOKING_SLUG=<staging-probe-slug> \
//          -e USER_JWT=<staging test user access token>      # only for the overview scenario
//          -e BOOKING_WRITE=yes                               # OPTIONAL: also creates real staging bookings
//          -e PROFILE=smoke|load  load/k6/booking-and-overview.load.js
//
// RPC names/args are taken from src/lib/arrivalWindowsApi.ts (verified in repo). The booking page itself is a
// SPA shell (/book/:slug), so the "page" scenario measures static delivery, the RPC scenario the real work.
// Cleanup of created bookings: run synthetic_purge_artifacts() / delete the probe tenant's jobs (see docs/SLO.md).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import { env } from './lib.js';

function stagingOnly(url) {
  const prod = (__ENV.PRODUCTION_HOSTS || 'vireek.com,api.vireek.com,www.vireek.com').split(',').map((s) => s.trim()).filter(Boolean);
  if (prod.some((h) => url.includes(h)) && __ENV.I_KNOW_THIS_IS_PRODUCTION !== 'yes') throw new Error(`Refusing production host: ${url}`);
  return url.replace(/\/$/, '');
}
const app = stagingOnly(env('APP_BASE_URL'));
const sb = stagingOnly(env('SUPABASE_URL'));
const anon = env('SUPABASE_ANON_KEY');
const slug = env('BOOKING_SLUG');
const jwt = env('USER_JWT', false);
const write = __ENV.BOOKING_WRITE === 'yes';
const errors = new Rate('app_errors');

const smoke = (exec) => ({ executor: 'constant-vus', vus: 1, duration: '30s', exec });
const load = (exec, target) => ({ executor: 'ramping-vus', exec, startVUs: 0, stages: [{ duration: '1m', target }, { duration: '4m', target }, { duration: '30s', target: 0 }] });
const mode = __ENV.PROFILE === 'smoke' ? smoke : (e) => load(e, e === 'page' ? 40 : 15);

export const options = {
  scenarios: {
    page: mode('page'),
    booking_read: mode('bookingRead'),
    ...(write ? { booking_write: { executor: 'constant-arrival-rate', exec: 'bookingWrite', rate: 1, timeUnit: '2s', duration: '3m', preAllocatedVUs: 5, maxVUs: 10 } } : {}),
    ...(jwt ? { overview: mode('overview') } : {}),
  },
  // PROPOSED thresholds (see docs/SLO.md). abortOnFail protects staging.
  thresholds: {
    app_errors: [{ threshold: 'rate<0.01', abortOnFail: true, delayAbortEval: '30s' }],
    'http_req_duration{name:page}': ['p(95)<800'],
    'http_req_duration{name:rpc_booking_settings}': ['p(95)<500'],
    'http_req_duration{name:rpc_busy_window}': ['p(95)<800'],
    'http_req_duration{name:rpc_create_booking}': ['p(95)<1500'],
    'http_req_duration{name:overview_calls}': ['p(95)<1000'],
  },
};

const rpcHeaders = { apikey: anon, Authorization: `Bearer ${anon}`, 'Content-Type': 'application/json' };
const rpc = (fn, body, name) => http.post(`${sb}/rest/v1/rpc/${fn}`, JSON.stringify(body), { headers: rpcHeaders, tags: { name } });

export function page() {
  const r = http.get(`${app}/book/${encodeURIComponent(slug)}`, { tags: { name: 'page' } });
  errors.add(!check(r, { 'page 200': (x) => x.status === 200 }));
  sleep(1);
}

export function bookingRead() {
  const a = rpc('get_booking_public_settings', { p_slug: slug }, 'rpc_booking_settings');
  const start = new Date(Date.now() - 86400000).toISOString();
  const end = new Date(Date.now() + 14 * 86400000).toISOString();
  const b = rpc('get_booking_busy_window', { p_slug: slug, p_start: start, p_end: end }, 'rpc_busy_window');
  errors.add(!check(a, { 'settings 200': (x) => x.status === 200 }));
  errors.add(!check(b, { 'busy 200': (x) => x.status === 200 }));
  sleep(1);
}

export function bookingWrite() {
  const anchor = new Date(Date.now() + (3 + Math.floor(Math.random() * 20)) * 86400000);
  const wEnd = new Date(anchor.getTime() + 2 * 3600000);
  const r = rpc('create_public_booking_windowed', {
    p_slug: slug, p_customer_name: `k6 probe ${__VU}-${__ITER}`, p_customer_phone: null, p_customer_email: null, p_service_type: null,
    p_window_start: anchor.toISOString(), p_window_end: wEnd.toISOString(), p_anchor: anchor.toISOString(), p_notes: 'k6 load test',
    p_channel: 'k6', p_ref_code: null, p_intake_answers: {},
  }, 'rpc_create_booking');
  // slot_taken / too_soon are valid business outcomes (4xx), not server errors.
  errors.add(r.status >= 500);
}

export function overview() {
  const h = { apikey: anon, Authorization: `Bearer ${jwt}` };
  // Same shape as src/pages/DashboardPage.tsx loadData (bounded here by limit=2000 as proposed in the audit).
  const calls = http.get(`${sb}/rest/v1/calls?select=*&order=call_datetime.desc&limit=2000`, { headers: h, tags: { name: 'overview_calls' } });
  const jobs = http.get(`${sb}/rest/v1/jobs?select=*&order=created_at.desc&limit=2000`, { headers: h, tags: { name: 'overview_jobs' } });
  errors.add(!check(calls, { 'calls 200': (x) => x.status === 200 }) || !check(jobs, { 'jobs 200': (x) => x.status === 200 }));
  sleep(2);
}
