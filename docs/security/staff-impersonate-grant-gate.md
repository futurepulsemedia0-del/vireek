# staff-impersonate: tie impersonation to a customer-approved grant

Apply AFTER migration `20281103000000_identity_authz_foundation.sql` is live. Edit `supabase/functions/staff-impersonate/index.ts` (Ctrl+F each anchor).

Ship it behind `REQUIRE_CUSTOMER_GRANT=true` (default off). There is no customer-facing UI yet for approving staff access
(`authz_decide_access_grant` exists, no screen calls it), so turning it on today would lock support out.

## 1. Find this line (after the `impersonationDenial` block, before `const since = ...`):

```ts
    const since = new Date(Date.now() - 3_600_000).toISOString();
```

Insert ABOVE it:

```ts
    // Customer consent gate: staff may only enter a tenant while its owner has approved a time-limited grant.
    let grantExpiresAt: string | null = null;
    if (Deno.env.get("REQUIRE_CUSTOMER_GRANT") === "true") {
      const { data: grantId } = await admin.rpc("authz_staff_grant_active", { p_staff: staffId, p_tenant: accountId });
      if (!grantId) {
        await audit(admin, { staff_id: staffId, staff_email: staffEmail, action: "impersonation_denied", target_account_id: accountId, reason, metadata: { why: "no_customer_grant" } });
        return jsonResponse({ error: "The customer has not approved support access for this account." }, 403);
      }
      const { data: grantRow } = await admin.from("authz_access_grants").select("expires_at").eq("id", grantId).maybeSingle();
      grantExpiresAt = grantRow?.expires_at ?? null;
    }
```

## 2. Find this line:

```ts
    const expiresAt = new Date(Date.now() + IMPERSONATION_MINUTES * 60_000).toISOString();
```

Replace with:

```ts
    const windowEnd = Date.now() + IMPERSONATION_MINUTES * 60_000;
    const expiresAt = new Date(grantExpiresAt ? Math.min(windowEnd, Date.parse(grantExpiresAt)) : windowEnd).toISOString();
```

## Known limit (not fixed by this patch)
The magic link still produces an ordinary owner session. `expiresAt` is recorded and the gate stops NEW sessions
after the grant ends, but nothing terminates an already-open session at expiry. Fixing that needs a session claim
RLS can read, which is a separate change to verify against your live auth setup.
