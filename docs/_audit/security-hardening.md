# Security hardening audit (static, snapshot vireek-main.zip)

## Verified (static)
- Profiles: only is_staff was trigger-protected → new guard trigger (migration 20290304000000).
- OAuth start (Jobber/HubSpot/Google) lacked can-manage check → shared guard.
- HubSpot/Google callbacks wrote plaintext tokens to integrations.config → removed; SQL scrub documented.
- xero-sync-run plain secret compare → secretEquals; xero-* declared in function-policy.json.
- whatsapp-webhook had no POST signature check → META_APP_SECRET HMAC, fail closed.
- config.toml: duplicate tables + 127 verify_jwt drifts → `sync-verify-jwt.mjs write`.
- CSP: script-src hash-based, no unsafe-*; only style-src 'unsafe-inline' remains (accepted exception).
- MFA: enforcement was a UI flag only → server state function + grace policy + AAL2 for staff-impersonate.

## Executed (sandbox)
secretEquals, Xero webhook signature and MFA decision/jwtAal logic ran with node (all assertions true); function-matrix gate reports no xero violations.

## NOT RUN
pgTAP, vitest suite, tsc, lint, live DB checks, deployments.

## NOT DONE
Two-tenant pgTAP for the 10 core tables; SECURITY DEFINER IDOR sweep; rate limiting audit of public endpoints
(ovb-public, quote-ar-public, quote-video-public, state-of-calls-public, google-booking-feed, public-payment);
email-webhook secret travels in the query string; Supabase Auth rate limits (dashboard-level, not in repo).

## Needs human
Rotate keys if real git history shows leaks; set WEBHOOK_SIG_MODE=enforce after clean shadow logs; run live verify SQL;
deploy migrations/functions; run vault backfill then scrub SQL; enable MFA policy (set enforce_from); review RLS_EXCEPTIONS section C.
