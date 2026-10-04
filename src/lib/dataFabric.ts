/**
 * Vireek Integration / Data Fabric — client library.
 *
 * The Universal Service Data Layer: external systems push records through the
 * `fabric-ingest` edge function; each record is landed idempotently, identity
 * resolved against what Vireek already knows, and projected into the canonical
 * service graph (see src/lib/serviceGraph.ts).
 *
 * Server counterparts:
 *   supabase/migrations/20270301000000_data_fabric.sql
 *   supabase/functions/fabric-ingest/index.ts
 */

import {
  BadgeCheck,
  Building2,
  Calculator,
  Calendar,
  Cpu,
  CreditCard,
  Factory,
  Landmark,
  Mail,
  MapPin,
  Package,
  PhoneCall,
  ShieldCheck,
  Store,
  Truck,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';

// ============================================================
// CATALOG
// ============================================================

export type CanonicalEntity =
  | 'customer' | 'property' | 'equipment' | 'technician' | 'part'
  | 'job' | 'vendor' | 'payment' | 'call' | 'warranty';

export const CANONICAL_ENTITIES: { key: CanonicalEntity; label: string; hint: string }[] = [
  { key: 'customer', label: 'Customer', hint: 'People and companies you serve' },
  { key: 'property', label: 'Property', hint: 'Sites and addresses (merged by normalized address)' },
  { key: 'equipment', label: 'Equipment', hint: 'Assets in the field (merged by serial number)' },
  { key: 'technician', label: 'Technician', hint: 'Field staff and contractors' },
  { key: 'part', label: 'Part', hint: 'Parts and materials' },
  { key: 'job', label: 'Job', hint: 'Work orders, appointments and visits' },
  { key: 'vendor', label: 'Vendor', hint: 'Suppliers, OEMs and partners' },
  { key: 'payment', label: 'Payment', hint: 'Invoices and payments (amounts never enter the graph)' },
  { key: 'call', label: 'Communication', hint: 'Calls, emails and messages' },
  { key: 'warranty', label: 'Warranty / Policy', hint: 'Warranties, insurance policies and permits' },
];

export type FabricDomain =
  | 'crm' | 'erp' | 'accounting' | 'oem' | 'iot' | 'telematics' | 'maps' | 'payments'
  | 'inventory' | 'phone' | 'email' | 'calendar' | 'insurance' | 'warranty'
  | 'government' | 'marketplace';

export interface FabricDomainInfo {
  key: FabricDomain;
  label: string;
  icon: LucideIcon;
  description: string;
  /** Entities this kind of system typically contributes. */
  entities: CanonicalEntity[];
  /** Examples of systems in this category — illustrative, not a certified-connector list. */
  examples: string;
}

export const FABRIC_DOMAINS: FabricDomainInfo[] = [
  { key: 'crm', label: 'CRM', icon: Users, description: 'Customers, contacts and deal history.', entities: ['customer', 'property', 'job'], examples: 'HubSpot, Salesforce, Jobber' },
  { key: 'erp', label: 'ERP', icon: Building2, description: 'Orders, assets and operational master data.', entities: ['customer', 'vendor', 'equipment', 'job'], examples: 'SAP, NetSuite, Dynamics' },
  { key: 'accounting', label: 'Accounting', icon: Calculator, description: 'Invoices, payments and counterparties.', entities: ['customer', 'vendor', 'payment'], examples: 'QuickBooks, Xero, Sage' },
  { key: 'oem', label: 'OEM', icon: Factory, description: 'Manufacturer product, part and warranty data.', entities: ['equipment', 'part', 'warranty', 'vendor'], examples: 'Manufacturer portals and registries' },
  { key: 'iot', label: 'IoT', icon: Cpu, description: 'Connected equipment status and alerts.', entities: ['equipment', 'property'], examples: 'Smart thermostats, sensors, gateways' },
  { key: 'telematics', label: 'Telematics', icon: Truck, description: 'Vehicles, drivers and field activity.', entities: ['technician', 'equipment', 'job'], examples: 'Fleet and GPS platforms' },
  { key: 'maps', label: 'Maps', icon: MapPin, description: 'Verified addresses and sites.', entities: ['property'], examples: 'Geocoding and address services' },
  { key: 'payments', label: 'Payments', icon: CreditCard, description: 'Card, ACH and financing transactions.', entities: ['payment', 'customer'], examples: 'Stripe, Square, financing providers' },
  { key: 'inventory', label: 'Inventory', icon: Package, description: 'Stock, parts and suppliers.', entities: ['part', 'vendor'], examples: 'Warehouse and parts systems' },
  { key: 'phone', label: 'Phone', icon: PhoneCall, description: 'Calls, voicemail and SMS.', entities: ['call', 'customer'], examples: 'Telephony and contact-center platforms' },
  { key: 'email', label: 'Email', icon: Mail, description: 'Threads and messages tied to customers.', entities: ['call', 'customer'], examples: 'Google Workspace, Microsoft 365' },
  { key: 'calendar', label: 'Calendar', icon: Calendar, description: 'Appointments and availability.', entities: ['job', 'technician'], examples: 'Google Calendar, Outlook' },
  { key: 'insurance', label: 'Insurance', icon: ShieldCheck, description: 'Policies, claims and coverage.', entities: ['warranty', 'customer', 'property'], examples: 'Carrier and TPA systems' },
  { key: 'warranty', label: 'Warranty', icon: BadgeCheck, description: 'Warranty terms and claims.', entities: ['warranty', 'equipment'], examples: 'Extended-warranty administrators' },
  { key: 'government', label: 'Government', icon: Landmark, description: 'Permits, licenses and inspections.', entities: ['warranty', 'property', 'job'], examples: 'Permit portals, license registries' },
  { key: 'marketplace', label: 'Marketplace', icon: Store, description: 'Leads and jobs from demand marketplaces.', entities: ['customer', 'job'], examples: 'Lead and job marketplaces' },
];

export const DOMAIN_BY_KEY: Record<FabricDomain, FabricDomainInfo> = Object.fromEntries(
  FABRIC_DOMAINS.map((d) => [d.key, d]),
) as Record<FabricDomain, FabricDomainInfo>;

export const ENTITY_LABELS: Record<CanonicalEntity, string> = Object.fromEntries(
  CANONICAL_ENTITIES.map((e) => [e.key, e.label]),
) as Record<CanonicalEntity, string>;

// ============================================================
// TYPES
// ============================================================

export type FieldMapping = Partial<Record<CanonicalEntity, Record<string, string>>>;
export type FabricConnectionStatus = 'active' | 'paused';
export type FabricRecordStatus = 'pending' | 'applied' | 'failed' | 'dead_letter';

export interface FabricConnection {
  id: string;
  user_id: string;
  connector_key: string;
  domain: FabricDomain;
  name: string;
  status: FabricConnectionStatus;
  entities: CanonicalEntity[];
  field_mapping: FieldMapping;
  ingest_key_prefix: string;
  last_event_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface FabricConnectionStat {
  connection_id: string;
  records: number;
  failed: number;
  last_received: string | null;
}

export interface FabricOverview {
  connections: number;
  active_connections: number;
  records_total: number;
  records_24h: number;
  applied: number;
  pending: number;
  failed: number;
  dead_letter: number;
  linked_nodes: number;
  multi_source_nodes: number;
  by_connection: FabricConnectionStat[];
}

export interface FabricRecordRow {
  id: string;
  connection_id: string;
  entity: CanonicalEntity;
  external_id: string;
  status: FabricRecordStatus;
  attempts: number;
  error: string | null;
  match_method: string | null;
  match_confidence: number | null;
  received_at: string;
}

export interface ReapplyResult {
  retried: number;
  applied: number;
  failed: number;
}

// ============================================================
// HELPERS
// ============================================================

// Column-level grants: `select('*')` is not allowed on fabric_connections.
const CONNECTION_COLUMNS =
  'id, user_id, connector_key, domain, name, status, entities, field_mapping, ingest_key_prefix, last_event_at, last_error, created_at, updated_at';

const RECORD_COLUMNS =
  'id, connection_id, entity, external_id, status, attempts, error, match_method, match_confidence, received_at';

export function fabricErrMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) return String((e as { message: unknown }).message);
  return 'Something went wrong';
}

export function slugifyConnector(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return slug.length >= 2 ? slug : 'custom_source';
}

export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'never';
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

/** Share of records that landed cleanly. Returns null when nothing has been ingested yet. */
export function healthPercent(o: Pick<FabricOverview, 'records_total' | 'failed' | 'dead_letter'>): number | null {
  if (o.records_total <= 0) return null;
  return Math.max(0, Math.round(((o.records_total - o.failed - o.dead_letter) / o.records_total) * 100));
}

const FIELD_RE = /^[a-z_]{1,40}$/;

/**
 * Validates the optional field-mapping JSON a user pastes in.
 * Shape: { "<entity>": { "<canonical_field>": "<path.in.source[0].payload>" } }
 * Mirrors the rules enforced by the edge function and the database.
 */
export function parseFieldMapping(text: string): { ok: true; value: FieldMapping } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: {} };
  if (trimmed.length > 20000) return { ok: false, error: 'Mapping is too large (max 20 KB).' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: 'Mapping must be valid JSON.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Mapping must be a JSON object keyed by entity.' };
  }

  const known = new Set<string>(CANONICAL_ENTITIES.map((e) => e.key));
  const out: FieldMapping = {};
  for (const [entity, fields] of Object.entries(parsed as Record<string, unknown>)) {
    if (!known.has(entity)) return { ok: false, error: `Unknown entity "${entity}".` };
    if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
      return { ok: false, error: `Mapping for "${entity}" must be an object of field → path.` };
    }
    const entries = Object.entries(fields as Record<string, unknown>);
    if (entries.length > 40) return { ok: false, error: `Too many fields for "${entity}" (max 40).` };
    const clean: Record<string, string> = {};
    for (const [field, path] of entries) {
      if (!FIELD_RE.test(field)) return { ok: false, error: `Invalid field name "${field}" (use a-z and underscores).` };
      if (typeof path !== 'string' || path.length === 0 || path.length > 200) {
        return { ok: false, error: `Path for "${entity}.${field}" must be a string up to 200 characters.` };
      }
      clean[field] = path;
    }
    out[entity as CanonicalEntity] = clean;
  }
  return { ok: true, value: out };
}

export function ingestEndpoint(): string {
  const base = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? 'https://YOUR-PROJECT.supabase.co';
  return `${base.replace(/\/$/, '')}/functions/v1/fabric-ingest`;
}

const SAMPLE_DATA: Record<CanonicalEntity, Record<string, unknown>> = {
  customer: { name: 'Ana Silva', email: 'ana@example.com', phone: '+1 555 010 2000', address: '12 Oak Street' },
  property: { address: '12 Oak Street', city: 'Austin', region: 'TX', postal_code: '78701' },
  equipment: { make: 'Acme', model: 'WH-50', serial_number: 'SN-100245', install_date: '2024-05-01' },
  technician: { name: 'Marco Reyes', status: 'active' },
  part: { name: 'Anode rod', sku: 'AR-1042', category: 'water_heater' },
  job: { title: 'Water heater service', status: 'scheduled', scheduled_at: '2027-03-02T14:00:00Z', address: '12 Oak Street' },
  vendor: { name: 'Acme Supply', category: 'oem' },
  payment: { status: 'paid', currency: 'USD' },
  call: { kind: 'inbound_call', channel: 'phone', duration_seconds: 184 },
  warranty: { name: '10-year tank warranty', coverage_type: 'parts', valid_until: '2034-05-01' },
};

/** A ready-to-run curl example for the first entity of a domain. */
export function buildCurlExample(domain: FabricDomain, key = 'vfk_YOUR_KEY'): string {
  const entity = DOMAIN_BY_KEY[domain].entities[0];
  const body = {
    records: [
      {
        entity,
        external_id: 'source-record-1',
        data: SAMPLE_DATA[entity],
        occurred_at: new Date().toISOString(),
      },
    ],
  };
  return [
    `curl -X POST '${ingestEndpoint()}' \\`,
    `  -H 'Authorization: Bearer ${key}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '${JSON.stringify(body)}'`,
  ].join('\n');
}

// ============================================================
// API
// ============================================================

export async function fetchConnections(): Promise<FabricConnection[]> {
  const { data, error } = await supabase
    .from('fabric_connections')
    .select(CONNECTION_COLUMNS)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as FabricConnection[];
}

export async function fetchOverview(): Promise<FabricOverview> {
  const { data, error } = await supabase.rpc('fabric_overview');
  if (error) throw error;
  const o = (data ?? {}) as Partial<FabricOverview>;
  return {
    connections: o.connections ?? 0,
    active_connections: o.active_connections ?? 0,
    records_total: o.records_total ?? 0,
    records_24h: o.records_24h ?? 0,
    applied: o.applied ?? 0,
    pending: o.pending ?? 0,
    failed: o.failed ?? 0,
    dead_letter: o.dead_letter ?? 0,
    linked_nodes: o.linked_nodes ?? 0,
    multi_source_nodes: o.multi_source_nodes ?? 0,
    by_connection: o.by_connection ?? [],
  };
}

export async function fetchRecords(opts: { statuses?: FabricRecordStatus[]; limit?: number } = {}): Promise<FabricRecordRow[]> {
  let q = supabase.from('fabric_records').select(RECORD_COLUMNS).order('received_at', { ascending: false }).limit(opts.limit ?? 20);
  if (opts.statuses && opts.statuses.length > 0) q = q.in('status', opts.statuses);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as FabricRecordRow[];
}

export async function createConnection(input: {
  domain: FabricDomain;
  name: string;
  entities: CanonicalEntity[];
  fieldMapping: FieldMapping;
}): Promise<{ connectionId: string; ingestKey: string }> {
  const { data, error } = await supabase.rpc('fabric_create_connection', {
    p_connector_key: slugifyConnector(input.name),
    p_domain: input.domain,
    p_name: input.name.trim(),
    p_entities: input.entities,
    p_field_mapping: input.fieldMapping,
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as { connection_id: string; ingest_key: string } | undefined;
  if (!row) throw new Error('Connection was not created.');
  return { connectionId: row.connection_id, ingestKey: row.ingest_key };
}

export async function updateConnection(
  id: string,
  patch: { name?: string; status?: FabricConnectionStatus; entities?: CanonicalEntity[]; fieldMapping?: FieldMapping },
): Promise<void> {
  const { error } = await supabase.rpc('fabric_update_connection', {
    p_id: id,
    p_name: patch.name ?? null,
    p_status: patch.status ?? null,
    p_entities: patch.entities ?? null,
    p_field_mapping: patch.fieldMapping ?? null,
  });
  if (error) throw error;
}

export async function rotateIngestKey(id: string): Promise<string> {
  const { data, error } = await supabase.rpc('fabric_rotate_key', { p_id: id });
  if (error) throw error;
  return data as string;
}

export async function deleteConnection(id: string): Promise<void> {
  const { error } = await supabase.rpc('fabric_delete_connection', { p_id: id });
  if (error) throw error;
}

export async function reapplyFailed(connectionId?: string): Promise<ReapplyResult> {
  const { data, error } = await supabase.rpc('fabric_reapply_failed', { p_connection_id: connectionId ?? null });
  if (error) throw error;
  const r = (data ?? {}) as Partial<ReapplyResult>;
  return { retried: r.retried ?? 0, applied: r.applied ?? 0, failed: r.failed ?? 0 };
}
