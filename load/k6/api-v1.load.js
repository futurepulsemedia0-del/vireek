// k6 load test for the public REST API (supabase/functions/api-v1).
// Per-key limit is 120 req/min, so spread load over several keys and treat 429 as a measured outcome.
//
//   k6 run -e FUNCTIONS_BASE_URL=https://<staging-ref>.supabase.co/functions/v1 \
//          -e API_KEYS=vrk_live_a,vrk_live_b,vrk_live_c load/k6/api-v1.load.js
//
// PROFILE=smoke|load|stress (default load)
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { env, functionsBase, pick } from './lib.js';

const base = functionsBase();
const keys = env('API_KEYS').split(',').map((s) => s.trim()).filter(Boolean);
const rateLimited = new Counter('api_rate_limited');
const serverErrors = new Rate('api_server_errors');

const profiles = {
  smoke: { executor: 'constant-vus', vus: 1, duration: '30s' },
  load: { executor: 'ramping-vus', startVUs: 0, stages: [{ duration: '2m', target: 20 }, { duration: '5m', target: 20 }, { duration: '1m', target: 0 }] },
  stress: { executor: 'ramping-vus', startVUs: 0, stages: [{ duration: '2m', target: 50 }, { duration: '3m', target: 100 }, { duration: '2m', target: 150 }, { duration: '2m', target: 0 }] },
};

export const options = {
  scenarios: { api: profiles[__ENV.PROFILE || 'load'] },
  thresholds: {
    http_req_failed: [{ threshold: 'rate<0.01', abortOnFail: true, delayAbortEval: '30s' }],
    api_server_errors: ['rate<0.005'],
    'http_req_duration{expected_response:true}': ['p(95)<800', 'p(99)<1500'],
  },
};

const resources = ['calls', 'leads', 'jobs'];

export default function () {
  const res = http.get(`${base}/api-v1/${pick(resources)}?limit=20`, {
    headers: { Authorization: `Bearer ${pick(keys)}` },
    tags: { name: 'GET /api-v1/:resource' },
    responseCallback: http.expectedStatuses(200, 429),
  });
  if (res.status === 429) rateLimited.add(1);
  serverErrors.add(res.status >= 500);
  check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
    '200 returns JSON data': (r) => r.status !== 200 || Array.isArray(r.json('data')),
    '429 carries Retry-After': (r) => r.status !== 429 || r.headers['Retry-After'] !== undefined,
  });
  sleep(0.5 + Math.random());
}
