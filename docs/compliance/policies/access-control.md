# Access control and review policy

> **DRAFT — not approved.** Owner: _to be assigned_ · Approved by: _pending_ · Last review: _pending_. Adopting this text is a company decision; it makes no compliance claim (see `src/lib/trust/claims.ts`).

## Purpose and scope
Who may access production systems, customer data and the staff console, and how access is granted, reviewed and removed.

## Existing technical controls (evidence in this repository)
- Roles and route guards: `docs/generated/ROUTES.md`; staff gate `is_vireek_staff()`
- MFA (AAL2) enforced in-app when enrolled: `src/components/ProtectedRoute.tsx`
- Audit trail: `audit_log`, `src/pages/AuditLogPage.tsx`

## Gaps the owner must close before approval
- Mandatory MFA for workforce accounts (GitHub, Vercel, Supabase, Stripe, Twilio, Vapi) — see `SOC2_READINESS.md`
- Periodic access review procedure and evidence location
