/** Resources exposed by the public API (supabase/functions/api-v1). */
export const RESOURCES = ['calls', 'leads', 'jobs'] as const;
export type Resource = (typeof RESOURCES)[number];

export const RESOURCE_SCOPE: Record<Resource, string> = {
  calls: 'calls:read',
  leads: 'leads:read',
  jobs: 'jobs:read',
};

/** Columns shown by `vireek <resource> list` in table mode. */
export const DEFAULT_COLUMNS: Record<Resource, string[]> = {
  calls: ['id', 'call_datetime', 'caller_phone', 'caller_name', 'duration_seconds', 'is_emergency', 'status'],
  leads: ['id', 'created_at', 'name', 'phone', 'service_interested', 'stage'],
  jobs: ['id', 'created_at', 'customer_name', 'service_type', 'job_status', 'scheduled_datetime', 'invoice_amount'],
};

export function isResource(value: string): value is Resource {
  return (RESOURCES as readonly string[]).includes(value);
}
