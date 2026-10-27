// Who should we contact for <purpose>?  Thin wrapper over the SQL function customer_contact_recipients()
// (service_role only) so every edge function routes the same way.
// Fail-soft by design: if the lookup fails, callers get [] and keep their pre-contacts behaviour.

export type ContactPurpose = "invoice" | "service" | "emergency" | "portal" | "general";

export interface ContactRecipient {
  contactId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  language: string | null;
  roles: string[];
  isFallback: boolean;
}

// deno-lint-ignore no-explicit-any
export async function resolveContactRecipients(admin: any, ownerId: string, customerId: string | null | undefined, purpose: ContactPurpose): Promise<ContactRecipient[]> {
  if (!customerId) return [];
  try {
    const { data, error } = await admin.rpc("customer_contact_recipients", {
      p_user_id: ownerId,
      p_customer_id: customerId,
      p_purpose: purpose,
    });
    if (error || !Array.isArray(data)) return [];
    // deno-lint-ignore no-explicit-any
    return data.map((r: any) => ({
      contactId: typeof r.contact_id === "string" ? r.contact_id : null,
      name: typeof r.contact_name === "string" ? r.contact_name : "",
      email: typeof r.contact_email === "string" && r.contact_email.trim() ? r.contact_email.trim() : null,
      phone: typeof r.contact_phone === "string" && r.contact_phone.trim() ? r.contact_phone.trim() : null,
      language: typeof r.contact_language === "string" ? r.contact_language : null,
      roles: Array.isArray(r.contact_roles) ? r.contact_roles.filter((x: unknown) => typeof x === "string") : [],
      isFallback: r.is_fallback === true,
    }));
  } catch {
    return [];
  }
}

/**
 * Invoice recipients, de-duplicated (case-insensitive): the email typed on the invoice first, then every billing
 * contact. Fallback rows are used only when the invoice has no valid email of its own.
 */
export function invoiceRecipientEmails(
  invoiceEmail: string | null | undefined,
  billing: ContactRecipient[],
  isEmail: (value: string) => boolean,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | null | undefined) => {
    const t = (value ?? "").trim();
    const key = t.toLowerCase();
    if (t && isEmail(t) && !seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  };
  add(invoiceEmail);
  for (const r of billing) {
    if (!r.isFallback || out.length === 0) add(r.email);
  }
  return out;
}
