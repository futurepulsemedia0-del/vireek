// k6: vapi-webhook ingestion under REDELIVERY. Sends each end-of-call-report N times (concurrent) and checks the
// endpoint stays 2xx and fast. After the run, verify on STAGING that exactly ONE `calls` row exists per call id:
//   select vapi_call_id, count(*) from calls where vapi_call_id like 'k6dup-%' group by 1 having count(*) > 1;   -- expect 0 rows
//   select status, count(*) from voice_webhook_events where vapi_call_id like 'k6dup-%' group by 1;           -- expect processed
//
//   k6 run -e FUNCTIONS_BASE_URL=https://<staging-ref>.supabase.co/functions/v1 -e VAPI_SERVER_SECRET=... \
//          -e ASSISTANT_ID=<staging probe assistant> -e COPIES=3 load/k6/webhook.dupes.load.js
// Cleanup: synthetic_purge_artifacts() removes probe-tenant artifacts.
import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';
import { env, functionsBase } from './lib.js';

const base = functionsBase();
const secret = env('VAPI_SERVER_SECRET');
const assistantId = env('ASSISTANT_ID');
const copies = Number(__ENV.COPIES || 3);
const bad = new Rate('webhook_dupe_failures');

export const options = {
  scenarios: { dupes: { executor: 'constant-arrival-rate', rate: Number(__ENV.RATE || 5), timeUnit: '1s', duration: __ENV.DURATION || '5m', preAllocatedVUs: 30, maxVUs: 100 } },
  thresholds: { webhook_dupe_failures: ['rate<0.01'], 'http_req_duration': ['p(95)<1500', 'p(99)<3000'] },
};

export default function () {
  const id = `k6dup-${__VU}-${__ITER}-${Date.now()}`;
  const payload = JSON.stringify({ message: { type: 'end-of-call-report', endedReason: 'customer-ended-call', durationSeconds: 30, call: { id: id, assistantId, customer: { number: '+15005550006' } }, artifact: { transcript: 'k6 synthetic' } } });
  const params = { headers: { 'Content-Type': 'application/json', 'x-vapi-secret': secret }, tags: { name: 'POST /vapi-webhook (dup)' } };
  const reqs = Array.from({ length: copies }, () => ['POST', `${base}/vapi-webhook`, payload, params]);
  for (const r of http.batch(reqs)) bad.add(!check(r, { '2xx': (x) => x.status >= 200 && x.status < 300 }));
}
