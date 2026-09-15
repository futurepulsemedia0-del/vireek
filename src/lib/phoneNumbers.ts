import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type PhoneNumberStatus = 'active' | 'porting_in' | 'porting_out' | 'pending' | 'released';
export type PhoneNumberType = 'local' | 'toll_free' | 'mobile';

export interface PortingDetails {
  losing_carrier?: string;
  account_number_last4?: string;
  billing_zip?: string;
  notes?: string;
  requested_at?: string;
  expected_complete_at?: string;
}

export interface PhoneNumber {
  id: string;
  account_id: string;
  phone_number: string; // E.164, e.g. +15125550123
  friendly_name: string;
  number_type: PhoneNumberType;
  status: PhoneNumberStatus;
  is_primary: boolean;
  voice_enabled: boolean;
  sms_enabled: boolean;
  forwarding_number: string | null;
  assigned_trade: string | null;
  assigned_location: string | null;
  monthly_cost_cents: number;
  porting_details: PortingDetails | null;
  created_at: string;
  updated_at: string;
}

export interface PhoneNumberInput {
  friendly_name: string;
  number_type: PhoneNumberType;
  forwarding_number?: string | null;
  assigned_trade?: string | null;
  assigned_location?: string | null;
  voice_enabled?: boolean;
  sms_enabled?: boolean;
}

export interface PortRequestInput {
  phone_number: string;
  friendly_name: string;
  losing_carrier: string;
  account_number_last4: string;
  billing_zip: string;
  notes?: string;
}

export interface EditNumberPatch {
  friendly_name: string;
  forwarding_number: string | null;
  assigned_trade: string | null;
  assigned_location: string | null;
  voice_enabled: boolean;
  sms_enabled: boolean;
}

// ============================================================
// FORMATTERS
// ============================================================

export function formatPhoneNumber(e164: string): string {
  const digits = e164.replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return e164;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// ============================================================
// DATA ACCESS
// Table: public.phone_numbers — see the accompanying SQL migration.
// Placeholder pricing (monthly_cost_cents) — wire this to your real
// carrier/billing rates before going live.
// ============================================================

export async function fetchPhoneNumbers(): Promise<PhoneNumber[]> {
  const { data, error } = await supabase
    .from('phone_numbers')
    .select('*')
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data as PhoneNumber[]) ?? [];
}

export async function purchasePhoneNumber(phoneNumber: string, input: PhoneNumberInput): Promise<PhoneNumber> {
  const { data, error } = await supabase
    .from('phone_numbers')
    .insert({
      phone_number: phoneNumber,
      friendly_name: input.friendly_name,
      number_type: input.number_type,
      status: 'active',
      is_primary: false,
      voice_enabled: input.voice_enabled ?? true,
      sms_enabled: input.sms_enabled ?? false,
      forwarding_number: input.forwarding_number ?? null,
      assigned_trade: input.assigned_trade ?? null,
      assigned_location: input.assigned_location ?? null,
      monthly_cost_cents: input.number_type === 'toll_free' ? 300 : 100,
    })
    .select()
    .single();
  if (error) throw error;
  return data as PhoneNumber;
}

export async function requestPortIn(input: PortRequestInput): Promise<PhoneNumber> {
  const { data, error } = await supabase
    .from('phone_numbers')
    .insert({
      phone_number: input.phone_number,
      friendly_name: input.friendly_name,
      number_type: 'local',
      status: 'porting_in',
      is_primary: false,
      voice_enabled: true,
      sms_enabled: false,
      monthly_cost_cents: 100,
      porting_details: {
        losing_carrier: input.losing_carrier,
        account_number_last4: input.account_number_last4,
        billing_zip: input.billing_zip,
        notes: input.notes,
        requested_at: new Date().toISOString(),
      },
    })
    .select()
    .single();
  if (error) throw error;
  return data as PhoneNumber;
}

export async function updatePhoneNumber(id: string, patch: EditNumberPatch): Promise<PhoneNumber> {
  const { data, error } = await supabase
    .from('phone_numbers')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data as PhoneNumber;
}

export async function setPrimaryPhoneNumber(id: string, accountId: string): Promise<void> {
  const { error: clearError } = await supabase
    .from('phone_numbers')
    .update({ is_primary: false })
    .eq('account_id', accountId);
  if (clearError) throw clearError;

  const { error: setError } = await supabase.from('phone_numbers').update({ is_primary: true }).eq('id', id);
  if (setError) throw setError;
}

export async function releasePhoneNumber(id: string): Promise<void> {
  const { error } = await supabase
    .from('phone_numbers')
    .update({ status: 'released', is_primary: false })
    .eq('id', id);
  if (error) throw error;
}
