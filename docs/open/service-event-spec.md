# Service Event Spec

**Status: DRAFT 0.1.0 - internal. Not published, not announced, no public URL.**
**License of this text: `TODO(owner)`. License of the schema files and validator: `TODO(owner)`.** (Decide before any publication; options to weigh with counsel: a documentation license such as CC BY 4.0, a community-specification license, and a permissive code license for the schemas. Nothing here is licensed to anyone yet.)
**Canonical schema `$id` base URL: `TODO(owner)`.** The schemas have no `$id` on purpose.

## 1. Purpose
A small, plain JSON format for events about field-service work, so a call, a job, a piece of equipment and a result can move between systems without custom mapping. This draft describes what Vireek **already sends** and marks everything else **proposed**.

## 2. Where this comes from
| Part | Source in this repo | Status |
| --- | --- | --- |
| Envelope `{id, event, created_at, data}`, signing and retry behaviour | `WebhookEnvelope`, `WEBHOOK_DELIVERY_POLICY` in `supabase/functions/api-v1/contract.ts` | emitted today |
| `call.created`, `call.emergency` data | public API `Call` resource (same file) | emitted today |
| `job.created`, `job.completed` data | public API `Job` resource (same file) | emitted today |
| `equipment.registered` data | table `equipment` (`20260927000001_create_equipment_tables.sql`) | **proposed**: no event, no API resource |
| `outcome.recorded` data | table `value_events` (`20271121000000_value_scoreboard.sql`) | **proposed**: no event, no API resource |
| Compatibility and de-duplication rules | `validatePayload` / `compatibilityErrors` / `dedupeKey` in the platform's event registry (see 7) | rules adopted |

`docs/open/validate.test.mjs` fails if the call and job schemas or the emitted event list drift from `contract.ts`.

## 3. Envelope
Schema: `schemas/envelope.schema.json`.

| Field | Type | Rule |
| --- | --- | --- |
| `id` | uuid | Delivery id. Identical on retries. |
| `event` | string | `<object>.<verb>`, lowercase, `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$` |
| `created_at` | RFC 3339 date-time | When the delivery was created. |
| `data` | object | Validated by the schema registered for `event` in `event-types.json`. |

Unknown extra members are allowed anywhere (forward compatibility).

## 4. Event types
Registry: `event-types.json`.

| Event | Status | Data schema |
| --- | --- | --- |
| `call.created` | emitted, stable | `call.schema.json` |
| `call.emergency` | emitted, beta | `call.schema.json` |
| `job.created` | emitted, stable | `job.schema.json` |
| `job.completed` | emitted, beta | `job.schema.json` |
| `equipment.registered` | proposed | `equipment.schema.json` |
| `outcome.recorded` | proposed | `outcome.schema.json` |

Other emitted types (`lead.created`, `quote.sent`, `quote.accepted`, `review.completed`, `automation.installed`) are in the registry with no data schema: out of scope for this draft, envelope only. Names of the two proposed events are `TODO(owner)` to confirm.

### Service call / job
Required: call `id, call_datetime, status, created_at`; job `id, customer_name, job_status, invoice_status, created_at`. All other fields are optional and typed as in the public API (nullable where the API says so). `user_id` is the producer's account id: optional, never required of a consumer. Fields such as `caller_phone`, `caller_name`, `transcript`, `address` are personal data: a producer sends only what its own privacy rules allow, and a consumer must not assume they are present.

### Equipment (proposed)
Required: `id, equipment_type, status (active|replaced|removed), created_at`. Free-text columns and the account id are excluded. `serial_number` identifies a physical unit: treat as sensitive.

### Outcome (proposed)
One result: `type` (`recovered_revenue | saved_hours | avoided_cost`), `amount` (whole units, >= 1), `unit` (`cents` for money, `minutes` for time), `currency` (ISO 4217, required for money, null for time), `confidence` (`measured | estimated`), `evidence_ref`, `occurred_at`. The type/unit/currency consistency is enforced by the schema. A figure without `evidence_ref` is not a valid outcome.

## 5. Delivery and de-duplication (informative)
Consumers de-duplicate on the envelope `id`. Today's Vireek behaviour: any 2xx is success, 10 s timeout, 2 attempts, 4xx is permanent, signature `X-Vireek-Signature` = lowercase hex HMAC-SHA256 of the raw body. The signature has no timestamp yet, so it does not stop replay on its own. Signing is a Vireek delivery detail, not part of the open format; whether the standard should define one is `TODO(owner)`.
Ledger profile (optional): an ordered stream can use the key `eventType|aggregateId|aggregateVersion` with gap-free, per-aggregate versions. Vireek's internal ledger (`business_activity_events`) uses this but is not exposed externally.

## 6. Versioning
`spec_version` is semantic. Within one major version a schema may only **add optional fields**. Removing a field, changing a type, making an optional field required or adding a required field is breaking and needs a new major version. `compatibilityErrors()` in `validate.mjs` checks this rule.

## 7. Known gaps found while drafting (repo facts)
- The platform's pure registry file exists only as a stray root-level `event-registry.ts`; `supabase/functions/_shared/workflow-compiler/event-registry.test.ts` imports `./event-registry.ts` from that folder, where the file does not exist. That test cannot pass until the file is moved (not changed here).
- `src/lib/eventBus.ts` lists `home_passport.updated`; `contract.ts` `WEBHOOK_EVENTS` does not. This draft follows `contract.ts`.
- `payment.received` exists in the internal ledger and is not a webhook event.

## 8. Try it
```
node docs/open/validate.mjs docs/open/examples/call.created.json
node docs/open/validate.mjs docs/open/examples/invalid/call-missing-status.json   # exits 1
node --experimental-strip-types --no-warnings --test docs/open/validate.test.mjs
```
The bundled validator supports only the JSON Schema 2020-12 keywords these schemas use and throws on anything else. For real integrations use any 2020-12 validator.

## 9. Before any publication (you)
`TODO(owner)` licenses and `$id` base; confirm names of proposed events; counsel review of personal-data wording; decide whether signing is in scope; decide governance (who accepts changes).
