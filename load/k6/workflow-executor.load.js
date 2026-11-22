// k6 load test for the workflow executor tick (supabase/functions/workflow-graph-executor) — STAGING ONLY.
// Fires overlapping ticks (as if cron fired many times / several workers ran) while runs are in flight, then you run
// load/workflow/verify.sql to prove no side effect or undo ran twice. k6 cannot see inside Postgres, so a green k6 run alone proves nothing.
//
// 1) seed:   psql "$STAGING_DB_URL" -v runs=500 -f load/workflow/seed.sql        (creates test-mode runs; mode='test' => no real side effects)
// 2) env on the function (staging): WORKFLOW_PARALLEL_ENABLED=true WORKFLOW_TOKENS_ENABLED=true WORKFLOW_DURABLE_COMPENSATION=true
// 3) run:    k6 run -e FUNCTIONS_BASE_URL=https://<staging-ref>.supabase.co/functions/v1 -e CRON_SECRET=... load/k6/workflow-executor.load.js
// 4) verify: psql "$STAGING_DB_URL" -f load/workflow/verify.sql      (every row must report ok = true)
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { env, functionsBase } from './lib.js';

const base = functionsBase();
const secret = env('CRON_SECRET', false);
const errors = new Rate('executor_errors');
const processed = new Counter('executor_runs_processed');

const profiles = {
  smoke: { executor: 'constant-vus', vus: 2, duration: '30s' },
  load: { executor: 'constant-vus', vus: 10, duration: '3m' },
  stress: { executor: 'ramping-vus', startVUs: 0, stages: [{ duration: '1m', target: 20 }, { duration: '3m', target: 40 }, { duration: '1m', target: 0 }] },
};
export const options = {
  scenarios: { tick: profiles[__ENV.PROFILE || 'load'] },
  thresholds: { executor_errors: ['rate<0.01'], 'http_req_duration{expected_response:true}': ['p(95)<110000'] },
};

export default function () {
  const res = http.post(`${base}/workflow-graph-executor`, '{}', { headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Cron-Secret': secret } : {}) }, timeout: '120s', tags: { name: 'POST workflow tick' } });
  const ok = check(res, { 'tick 200': (r) => r.status === 200 });
  errors.add(!ok);
  if (ok) { try { processed.add(Number(res.json('runsProcessed')) || 0); } catch (_e) { /* body shape is informational */ } }
}
