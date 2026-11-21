# Runbook — Vapi webhook secret header (Bearer + legacy `x-vapi-secret`)

Applies to `vapi-webhook` (via `_shared/voice-hardening/router.ts`) and `_shared/voice/vapiProvider.ts`.
Code: `_shared/voice-hardening/webhookAuth.ts`. Tests: `webhookAuth.test.ts`, `router.test.ts`, `voice/provider.test.ts`.

## What was verified, and what was not

| Claim | Status | Source |
|---|---|---|
| Server URL auth is opt-in: a Vapi Bearer Token custom credential sends `Authorization: Bearer <token>` (recommended) | Verified from the docs page text, 2026-11-21 | https://docs.vapi.ai/server-url/server-authentication |
| The legacy `X-Vapi-Secret` header is still supported: a Bearer credential with header name `X-Vapi-Secret` and "Include Bearer Prefix" off | Verified, same page | same |
| The old inline `server.secret` sends `x-vapi-secret` | Verified (docs repo change "Add server credentialId docs", VapiAI/docs #669) | https://github.com/VapiAI/docs/pull/669 |
| Vapi also offers OAuth 2.0 and HMAC credentials | Verified, same page. **Not supported by this function** (it only handles the shared-secret schemes) | same |
| What your Vapi account actually sends today | **[VERIFY]** open Vapi dashboard → Custom Credentials / the Server URL of each assistant, phone number and the org, and check which credential is attached | dashboard |
| A live call authenticates with each header | **[VERIFY]** not exercised against a real Vapi call; only unit tests were run | — |

## Behaviour

`VAPI_SERVER_SECRET` is the single shared secret. A request is authentic if **either** header carries it
(constant-time compare, both headers are always compared, fails closed when the secret is unset):

| Request headers | Result |
|---|---|
| `Authorization: Bearer <secret>` (also `bearer`, or the raw token if Vapi's Bearer prefix is off) | accepted, logged `auth_via: "authorization"` |
| `x-vapi-secret: <secret>` | accepted, logged `auth_via: "x-vapi-secret"` |
| `x-vapi-secret: <secret>` + `Authorization: Bearer <service-role key>` (what `voice-reconcile` sends) | accepted via `x-vapi-secret`; the unrelated Authorization value is ignored |
| `Authorization: Bearer <service-role key>` alone, or any wrong/empty/truncated/extended value | **401** |
| `VAPI_SERVER_SECRET` not set | **500** (fail closed) |
| `VAPI_ACCEPT_LEGACY_SECRET_HEADER=0` and only `x-vapi-secret` | **401** |

The log field `auth_via` is on the `webhook_received` event. Header values are never logged.

## Preconditions

- The function must be deployed with `--no-verify-jwt` (a Vapi secret is not a Supabase JWT, so the gateway would reject it for either header). In this snapshot `supabase/config.toml` has **no** `[functions.vapi-webhook]` entry, so the deploy flag is the only thing providing this. **[VERIFY]** on your project.

## Transition plan

1. **Deploy this change.** Nothing breaks: the legacy header keeps working. No Vapi change is needed yet.
2. **Create the Bearer credential** in Vapi (Custom Credentials → Bearer Token, header `Authorization`, Bearer prefix on). Use the **same value** as `VAPI_SERVER_SECRET`. Attach it by `credentialId` to every Server URL that targets this function (assistants, phone numbers, org level). Never paste the value into tickets or chat.
3. **Watch** the `vapi-webhook` logs for `auth_via`. Real Vapi traffic should move to `"authorization"`.
4. **Migrate the internal caller first:** `supabase/functions/voice-reconcile/index.ts` (`replayThroughWebhook`) still authenticates with `x-vapi-secret`. Turning the legacy header off before changing it makes every reconcile replay 401. *(Not changed in this task.)*
5. **Decide the cut-off** (suggestion: no `auth_via: "x-vapi-secret"` events for 14 days — your call). Then:
   `supabase secrets set VAPI_ACCEPT_LEGACY_SECRET_HEADER=0`. The function reads it on every request; how fast a secrets change reaches running instances is a Supabase platform detail **[VERIFY]**, so re-test right after.
6. **Rollback:** `supabase secrets unset VAPI_ACCEPT_LEGACY_SECRET_HEADER` (default is accept). If Vapi traffic starts returning 401, check the Vapi delivery log first, then the credential value vs `VAPI_SERVER_SECRET`.

`_shared/audit/script.ts` provisions assistants with `server.headers["x-vapi-secret"]`; that remains valid (legacy). Move it to a credential when step 5 is decided.

## Rotating the secret

Unchanged principle (see `secret-rotation.md`): the function holds one secret, so rotation is a short two-sided window.
Update `VAPI_SERVER_SECRET` and the Vapi credential together, or expect 401s until they match.
