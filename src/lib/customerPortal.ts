import { supabase } from '@/lib/supabase';

/**
 * Customer Self-Service Portal — client library.
 *
 * Same security pattern as `lib/reschedule.ts`: all reads and writes go
 * through narrow SECURITY DEFINER Postgres functions that validate the
 * portal token server-side (get_customer_portal_bundle,
 * submit_portal_service_request, update_portal_contact_info — see
 * supabase/migrations/20260925000000_customer_self_service_portal.sql).
 * RLS on customers/jobs/quotes/memberships is never opened to anon.
 */

export interface PortalJob {
  id: string;
  service_type: string | null;
  scheduled_datetime: string | null;
  job_status: 'scheduled' | 'en_route' | 'in_progress' | 'completed' | 'cancelled' | 'no_show';
  invoice_amount: number | null;
  invoice_status: 'not_sent' | 'sent' | 'paid';
  reschedule_token: string | null;
  payment_link_url: string | null;
  created_at: string;
}

export interface PortalEquipment {
  id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  install_date: string | null;
  warranty_expires_at: string | null;
  warranty_alert_stage: 'expiring_soon' | 'expired' | null;
  last_service_date: string | null;
}

export interface PortalQuote {
  id: string;
  quote_token: string;
  status: 'draft' | 'sent' | 'accepted' | 'declined' | 'expired';
  accepted_total_cents: number | null;
  valid_until: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface PortalMembership {
  status: 'offered' | 'active' | 'cancelled';
  started_at: string | null;
  plan_name: string | null;
  benefits: string[] | null;
}

export interface PortalBundle {
  customer: {
    name: string;
    phone: string | null;
    email: string | null;
    address: string | null;
    lifecycle_stage: string;
  };
  business_name: string | null;
  booking_slug: string | null;
  jobs: PortalJob[];
  quotes: PortalQuote[];
  equipment: PortalEquipment[];
  membership: PortalMembership | null;
}

export function getPortalLink(token: string): string {
  return `${window.location.origin}/portal/${token}`;
}

export function getRescheduleLink(token: string): string {
  return `${window.location.origin}/reschedule/${token}`;
}

export function getBookingLink(slug: string): string {
  return `${window.location.origin}/book/${slug}`;
}

export function formatWarrantyStatus(exp: string | null): { label: string; tone: 'ok' | 'warn' | 'expired' } {
  if (!exp) return { label: 'No warranty on file', tone: 'ok' };
  const days = Math.floor((new Date(exp).getTime() - Date.now()) / 86400000);
  if (days < 0) return { label: `Expired ${formatPortalDate(exp)}`, tone: 'expired' };
  if (days <= 60) return { label: `Expires ${formatPortalDate(exp)}`, tone: 'warn' };
  return { label: `Covered until ${formatPortalDate(exp)}`, tone: 'ok' };
}

/**
 * Returns the bundle, or null if the link is invalid OR the business
 * hasn't turned the portal on. Those two cases are deliberately
 * indistinguishable to the caller (see get_customer_portal_bundle) —
 * an invalid-vs-disabled distinction would let a guessed token confirm
 * whether a given link format exists at all.
 */
export async function fetchPortalBundle(token: string): Promise<PortalBundle | null> {
  const { data, error } = await supabase.rpc('get_customer_portal_bundle', { p_token: token });
  if (error || !data) return null;
  return data as PortalBundle;
}

export async function submitServiceRequest(token: string, serviceType: string, message: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('submit_portal_service_request', {
    p_token: token,
    p_service_type: serviceType,
    p_message: message,
  });
  if (error) return false;
  return Boolean(data);
}

export async function updateContactInfo(token: string, phone: string, email: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('update_portal_contact_info', {
    p_token: token,
    p_phone: phone,
    p_email: email,
  });
  if (error) return false;
  return Boolean(data);
}

// ============================================================
// DISPLAY HELPERS
// ============================================================

export const JOB_STATUS_LABELS: Record<PortalJob['job_status'], string> = {
  scheduled: 'Scheduled',
  en_route: 'Technician en route',
  in_progress: 'In progress',
  completed: 'Completed',
  no_show: 'No-show',
  cancelled: 'Cancelled',
};

export const INVOICE_STATUS_LABELS: Record<PortalJob['invoice_status'], string> = {
  not_sent: 'Not yet invoiced',
  sent: 'Invoice sent — payment due',
  paid: 'Paid',
};

export function formatAmount(amount: number | null): string {
  if (amount === null) return '—';
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function formatCents(cents: number | null): string {
  if (cents === null) return '—';
  return formatAmount(cents / 100);
}

export function formatPortalDate(dateStr: string | null): string {
  if (!dateStr) return 'Not yet scheduled';
  return new Date(dateStr).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
