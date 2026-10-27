import { supabase } from '@/lib/supabase';
import { normalizeContactRow, sortContacts, type ContactDraft, type CustomerContact } from '@/lib/customerContacts';

const COLUMNS =
  'id, customer_id, full_name, job_title, email, phone, roles, is_primary, site_label, preferred_channel, language, portal_access, notes, created_at';

function toRow(d: ContactDraft) {
  const nn = (v: string) => (v.trim() === '' ? null : v.trim());
  return {
    full_name: d.fullName.trim(),
    job_title: nn(d.jobTitle),
    email: nn(d.email),
    phone: nn(d.phone),
    roles: d.roles,
    is_primary: d.isPrimary,
    site_label: nn(d.siteLabel),
    preferred_channel: d.preferredChannel,
    language: d.language === '' ? null : d.language,
    portal_access: d.portalAccess,
    notes: nn(d.notes),
  };
}

export async function fetchContacts(customerId: string): Promise<CustomerContact[]> {
  const { data, error } = await supabase
    .from('customer_contacts')
    .select(COLUMNS)
    .eq('customer_id', customerId)
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  return sortContacts(rows.map(normalizeContactRow).filter((c): c is CustomerContact => c !== null));
}

export async function createContact(customerId: string, draft: ContactDraft): Promise<void> {
  const { error } = await supabase.from('customer_contacts').insert({ customer_id: customerId, ...toRow(draft) });
  if (error) throw error;
}

export async function updateContact(contactId: string, draft: ContactDraft): Promise<void> {
  const { error } = await supabase.from('customer_contacts').update(toRow(draft)).eq('id', contactId);
  if (error) throw error;
}

export async function makePrimary(contactId: string): Promise<void> {
  const { error } = await supabase.from('customer_contacts').update({ is_primary: true }).eq('id', contactId);
  if (error) throw error;
}

export async function deleteContact(contactId: string): Promise<void> {
  const { error } = await supabase.from('customer_contacts').delete().eq('id', contactId);
  if (error) throw error;
}

// ------------------------------------------------------------------ customer portal (anon, token-gated)

export interface PortalContact {
  id: string;
  name: string;
  title: string | null;
  roles: string[];
  maskedEmail: string | null;
  maskedPhone: string | null;
  isPrimary: boolean;
  portalRecipient: boolean;
}

export async function fetchPortalContacts(token: string): Promise<PortalContact[]> {
  const { data, error } = await supabase.rpc('get_portal_customer_contacts', { p_token: token });
  if (error) throw error;
  if (!Array.isArray(data)) return [];
  const out: PortalContact[] = [];
  for (const r of data as Record<string, unknown>[]) {
    if (typeof r.contact_id !== 'string' || typeof r.display_name !== 'string') continue;
    out.push({
      id: r.contact_id,
      name: r.display_name,
      title: typeof r.contact_title === 'string' ? r.contact_title : null,
      roles: Array.isArray(r.contact_roles) ? (r.contact_roles as unknown[]).filter((x): x is string => typeof x === 'string') : [],
      maskedEmail: typeof r.masked_email === 'string' ? r.masked_email : null,
      maskedPhone: typeof r.masked_phone === 'string' ? r.masked_phone : null,
      isPrimary: r.primary_contact === true,
      portalRecipient: r.portal_recipient === true,
    });
  }
  return out;
}
