# Mass Incident Mode — setup, behaviour and limits

## What it does
Groups inbound contacts (calls, SMS, web leads) that look like ONE area-wide event into an **Incident**, so every caller hears the
same honest information and the business avoids pointless truck rolls. It is **opt-in per account** (Dashboard → Mass Incidents → Settings).

## Hard rules (enforced in `supabase/functions/_shared/mass-incident/core.ts`, covered by `src/lib/massIncident.test.ts`)
1. No contact is ever dropped. A contact that fits no incident stays visible as a "loose contact".
2. A cause is **suspected** until a verified source (NWS alert, or an https official page the owner attached) or the owner confirms it.
3. Confidence is capped (0.45 under the minimum contact count, 0.85 without corroboration, never 1.0).
4. Gas, CO, smoke/fire, sparks/shock, flooding, sewage, structural and vulnerable-person risk are emergencies: never deflected,
   never used to open or define an incident (reuses `screenSafety` from remote-resolution).
5. Sarah always offers a booking (except for emergencies, where she escalates) and uses hedged language.
6. Utility / municipal numbers are spoken only from `mass_incident_directory` rows that are `verified`, have an https `source_url`
   and were verified in the last 365 days. Otherwise Sarah says she has no verified number and points to the customer's own bill.

## Deploy order
1. `supabase db push`  (migration `20281103000000_mass_incident_mode.sql`)
2. `supabase secrets set MASS_INCIDENT_CRON_SECRET=<long-random-string>`
3. `supabase functions deploy mass-incident --no-verify-jwt`
4. Schedule the sweep every 10 minutes (same mechanism you use for `weather-surge-check`):
   `POST <SUPABASE_URL>/functions/v1/mass-incident`  body `{"action":"sweep"}`  header `X-Cron-Secret: <the secret>`
5. Redeploy the edited functions: `vapi-webhook`, `sms-webhook`, `speed-to-lead-intake`, `weather-surge-check`.
6. **Vapi dashboard** (tools are not stored in this repo): add the tool below to the assistant.
7. Dashboard → Mass Incidents → Settings → enable. Add verified utility contacts under "Evidence & directory".

## Vapi tool to add (Assistant → Tools → Custom tool → Server URL = your existing vapi-webhook URL)
```json
{
  "type": "function",
  "async": false,
  "function": {
    "name": "check_area_incident",
    "description": "Call this AFTER you know the caller's ZIP or address and what is wrong, and BEFORE booking, whenever the problem could be area-wide (no water, low pressure, power out, storm damage, sewer). Returns exact instructions about what to tell the caller. Follow them exactly. Do not call it for gas smell, smoke, sparks, flooding or any danger: use flag_emergency_call instead.",
    "parameters": {
      "type": "object",
      "properties": {
        "problem": { "type": "string", "description": "The caller's own words describing the problem." },
        "zip": { "type": "string", "description": "ZIP / postal code of the service address." },
        "address": { "type": "string", "description": "Street address if given." }
      },
      "required": ["problem"]
    }
  }
}
```
The "AREA INCIDENT MODE" paragraph is appended automatically to the existing `service_area_context` variable only while an incident is active,
so no prompt edit is needed.

## Needs human review BEFORE launch (not engineering decisions)
- The household safety steps in `causeSafetySteps()` — have a licensed trade professional and counsel approve the wording.
- Whether texting customers during an incident is "service" traffic for your A2P campaign / local law.
- Directory rows: only add numbers you verified on the utility's official page. The platform ships with none.

## What the sweep does (every 10 minutes)
1. Geocodes up to 15 recent contacts that have a street address (1 request/second, Nominatim, via the existing `geocodeAddress`), then
   ERASES the stored address. Failed lookups are retried at most 3 times, then the address is erased anyway.
2. For tenants with an open incident, polls the NWS alert feed at the incident's location and stores matching alerts as verified evidence
   (independent of the weather-surge automation).
3. Re-evaluates contacts that were just geocoded, so a loose contact can join or open an incident.
4. Moves quiet incidents active -> monitoring -> resolved, re-scores them as evidence expires, and marks directory rows older than 365 days stale.

## Truck rolls (advisory by design)
When Sarah tells a caller the problem may be area-wide and the caller still books, the job gets a one-line `dispatch_note`
("Area incident: ... Re-check status before rolling a truck") and is linked to the incident. The incident screen counts these bookings.
Nothing is cancelled, reassigned or blocked automatically: dispatch decisions stay with a human.

## SMS auto-reply (opt-in, default OFF)
Settings → "Send one automatic text...". Only fires when the texter's area (ZIP in the text, or the address of their latest job) matches an
active, confident incident and the text describes a non-emergency problem. One text per person per incident, never for emergencies,
sent through `sendCompliantSms` (A2P, STOP, quiet hours). When it fires, the generic auto-reply is skipped for that message.

## Known limits (honest)
- The live call path groups by ZIP/postal centroid (US/CA, cached Zippopotam); street-level precision arrives later via the sweep.
  Other countries are grouped by postal-code string only.
- Symptom embeddings are used only when COHERE_API_KEY is configured; otherwise the deterministic taxonomy is used (still tested).
- Official evidence: NWS is automatic. There is no universal public outage-map or municipal API, so those notices are entered by the
  owner with an official https link. Owner-configured RSS/JSON feeds were deliberately NOT built: fetching arbitrary owner-supplied URLs
  from an edge function needs an SSRF-safe egress layer that does not exist in this repo yet.
- The platform StatusPage is Vireek's own service status; tenant incidents are intentionally NOT published there.
