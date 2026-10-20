import type { HomeHealthEquipment } from '@/lib/homeHealth';

export type LinkStatus = 'pending' | 'active' | 'revoked';
export type JobStatus = 'scheduled' | 'en_route' | 'in_progress' | 'completed' | 'cancelled';

export const SCOPE_KEYS = ['jobs', 'invoices', 'equipment', 'documents', 'health'] as const;
export type ScopeKey = (typeof SCOPE_KEYS)[number];
export type ShareScopes = Record<ScopeKey, boolean>;

export interface HomeownerProfile {
  full_name: string | null;
  phone: string;
  language: string;
  ai_enabled: boolean;
}

export interface OverviewBusiness {
  link_id: string;
  status: LinkStatus;
  live: boolean;
  business_name: string;
  business_phone: string | null;
  booking_slug: string | null;
  scopes: ShareScopes;
  next_appointment: {
    job_id: string;
    service_type: string | null;
    scheduled_datetime: string | null;
    job_status: JobStatus;
  } | null;
  outstanding_cents: number | null;
  health_score: number | null;
}

export interface HomeOverview {
  profile: HomeownerProfile | null;
  businesses: OverviewBusiness[];
}

export interface HomeJob {
  id: string;
  service_type: string | null;
  scheduled_datetime: string | null;
  completed_at: string | null;
  job_status: JobStatus;
  reschedule_token: string | null;
}

export interface HomeInvoice {
  id: string;
  invoice_number: string | null;
  invoice_token: string | null;
  status: string;
  total_cents: number;
  due_date: string | null;
  sent_at: string | null;
  paid_at: string | null;
}

export interface HomeEquipment {
  id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  install_date: string | null;
  warranty_expires_at: string | null;
  last_service_date: string | null;
  passport_code: string | null;
}

export interface HomeDocument {
  id: string;
  title: string;
  category: string;
  issued_on: string | null;
  expires_on: string | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
}

export interface HomeHealthAction {
  id: string;
  equipment_id: string;
  action_type: 'maintenance' | 'replacement_planning';
  stage: string;
  urgency: 'medium' | 'high';
  window_min_months: number | null;
  window_max_months: number | null;
  explanation: string | null;
}

export interface HomeHealthData {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  confidence: number;
  equipment_count: number;
  at_risk_count: number;
  breakdown: HomeHealthEquipment[];
  computed_at: string;
  history: { score: number; computed_at: string }[];
  actions: HomeHealthAction[];
}

export interface BusinessDetail {
  link_id: string;
  business_name: string;
  business_phone: string | null;
  booking_slug: string | null;
  customer_name: string | null;
  scopes: ShareScopes;
  jobs: HomeJob[] | null;
  invoices: HomeInvoice[] | null;
  equipment: HomeEquipment[] | null;
  documents: HomeDocument[] | null;
  health: HomeHealthData | null;
}

export interface ConsentEvent {
  id: string;
  event_type: string;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
}
