// Shared helpers for the k6 suites. Run only against STAGING: production URLs are refused.
import { fail } from 'k6';

export function env(name, required = true, fallback = '') {
  const v = __ENV[name] || fallback;
  if (required && !v) fail(`Missing required env var ${name}`);
  return v;
}

export function functionsBase() {
  const base = env('FUNCTIONS_BASE_URL').replace(/\/$/, '');
  const prod = (__ENV.PRODUCTION_HOSTS || 'vireek.com,api.vireek.com').split(',').map((s) => s.trim()).filter(Boolean);
  if (prod.some((h) => base.includes(h)) && __ENV.I_KNOW_THIS_IS_PRODUCTION !== 'yes') {
    fail('Refusing to load-test a production host. Point FUNCTIONS_BASE_URL at staging.');
  }
  return base;
}

export function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}
