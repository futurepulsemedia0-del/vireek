# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately. Do **not** open a public issue.

- Email: `ali@vireek.com` (same contact as `public/.well-known/security.txt`)
- Or use the contact form: https://vireek.com/contact

Include: affected URL or function name, steps to reproduce, impact, and any proof-of-concept. Do not include real customer data.

## What to expect

These are targets, not contractual commitments:

| Step | Target |
|---|---|
| Acknowledge report | within 3 business days |
| Initial assessment | within 7 business days |
| Fix or mitigation plan | communicated after assessment |

## Scope

In scope: the Vireek web app, the `supabase/functions/*` edge functions, the public API (`api-v1`), the MCP server, the Chrome extension, and the Capacitor apps (Vireek Field `com.vireek.field`, Vireek Home `com.vireek.home`).

Out of scope: social engineering of staff, physical attacks, denial-of-service load testing, and third-party providers' own platforms (report those to the provider).

## Safe harbour

Good-faith research that avoids privacy violations, data destruction, and service degradation, and that stops at proof of the issue, will not be pursued by Vireek. Never access another tenant's data beyond the minimum needed to demonstrate the issue.

## Keep `security.txt` current

`public/.well-known/security.txt` has an `Expires` field. Renew it before it lapses (currently 2027-09-10). See `docs/runbooks/security-txt-renewal.md`.

## Internal references

- Security architecture and gaps: `docs/compliance/SOC2_READINESS.md`
- Threat model: `docs/security/THREAT_MODEL.md`
- Incident response: `docs/runbooks/incident-response.md`
- Policy set (drafts): `docs/compliance/policies/`

This file is a disclosure process, not a statement of certification or compliance.
