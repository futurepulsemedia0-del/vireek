// k6 soak test for the inbound webhook layer (supabase/functions/vapi-webhook).
// Sends signed-by-secret, side-effect-light "speech-update" events for a STAGING probe tenant and
// checks latency/error rate stay flat for hours (memory leaks, connection exhaustion, slow drift).
//
//   k6 run -e FUNCTIONS_BASE_URL=https://<staging-ref>.supabase.co/functions/v1 \
//          -e VAPI_SERVER_SECRET=... -e ASSISTANT_ID=<staging probe assistant> \
//          -e SOAK_DURATION=2h -e RATE=20 load/k6/webhook.soak.js
//
// Cleanup: synthetic_purge_artifacts() removes the calls this creates (probe tenants only).
import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { env, functionsBase } from './lib.js';

const base = functionsBase();
const secret = env('VAPI_SERVER_SECRET');
const assistantId = env('ASSISTANT_ID');
const rejected = new Rate('webhook_rejected_unexpectedly');
const unauthLatency = new Trend('webhook_unauthorized_latency', true);

export const options = {
  scenarios: {
    soak: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 20),
      timeUnit: '1s',
      duration: __ENV.SOAK_DURATION || '2h',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
    bad_auth: { executor: 'constant-arrival-rate', rate: 2, timeUnit: '1s', duration: __ENV.SOAK_DURATION || '2h', preAllocatedVUs: 2, maxVUs: 10, exec: 'badAuth' },
  },
  thresholds: {
    'http_req_failed{scenario:soak}': ['rate<0.01'],
    'http_req_duration{scenario:soak}': ['p(95)<1000', 'p(99)<2500'],
    webhook_rejected_unexpectedly: ['rate<0.005'],
    'http_req_duration{scenario:bad_auth}': ['p(95)<500'],
  },
};

function body(callId) {
  return JSON.stringify({
    message: {
      type: 'speech-update',
      status: 'started',
      role: 'assistant',
      call: { id: callId, assistantId, customer: { number: '+15005550006' } },
    },
  });
}

export default function () {
  const id = `k6-${__VU}-${__ITER}-${Date.now()}`;
  const res = http.post(`${base}/vapi-webhook`, body(id), {
    headers: { 'Content-Type': 'application/json', 'x-vapi-secret': secret },
    tags: { name: 'POST /vapi-webhook' },
  });
  rejected.add(res.status === 401 || res.status === 403);
  check(res, { 'accepted (2xx)': (r) => r.status >= 200 && r.status < 300 });
}

export function badAuth() {
  const res = http.post(`${base}/vapi-webhook`, body('k6-unauth'), {
    headers: { 'Content-Type': 'application/json', 'x-vapi-secret': 'definitely-wrong' },
    tags: { name: 'POST /vapi-webhook (bad secret)' },
    responseCallback: http.expectedStatuses(401, 403),
  });
  unauthLatency.add(res.timings.duration);
  check(res, { 'wrong secret is rejected': (r) => r.status === 401 || r.status === 403 });
}
