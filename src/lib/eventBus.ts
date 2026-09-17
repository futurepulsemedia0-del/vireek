/* ------------------------------------------------------------------ */
/*  eventBus — types + curated event catalog for the Developer         */
/*  Platform's Event Bus (/dashboard/event-bus). The catalog here      */
/*  must stay in sync with the CHECK constraint on                     */
/*  webhook_endpoints.events in the matching migration — adding a new  */
/*  event means updating both.                                         */
/* ------------------------------------------------------------------ */

import type { WebhookLog } from '@/lib/supabase';

export type { WebhookLog };

export type EventType =
  | 'call.created'
  | 'call.emergency'
  | 'lead.created'
  | 'job.created'
  | 'job.completed'
  | 'quote.sent'
  | 'quote.accepted'
  | 'review.completed'
  | 'automation.installed';

export interface EventCatalogEntry {
  type: EventType;
  category: string;
  label: string;
  description: string;
}

export const EVENT_CATALOG: EventCatalogEntry[] = [
  { type: 'call.created', category: 'Calls', label: 'Call received', description: 'Fires the moment any call — answered or missed — is logged.' },
  { type: 'call.emergency', category: 'Calls', label: 'Emergency call detected', description: 'Fires when the AI receptionist tags a call as an emergency.' },
  { type: 'lead.created', category: 'Leads', label: 'New lead', description: 'Fires when a new lead is created from a call or manually.' },
  { type: 'job.created', category: 'Jobs', label: 'Job scheduled', description: 'Fires when a new job is added to the schedule.' },
  { type: 'job.completed', category: 'Jobs', label: 'Job completed', description: 'Fires when a job\u2019s status changes to Completed.' },
  { type: 'quote.sent', category: 'Quotes', label: 'Quote sent', description: 'Fires when a quote is sent to a customer.' },
  { type: 'quote.accepted', category: 'Quotes', label: 'Quote accepted', description: 'Fires when a customer accepts a quote.' },
  { type: 'review.completed', category: 'Reviews', label: 'Review submitted', description: 'Fires when a customer completes a requested review.' },
  { type: 'automation.installed', category: 'Automations', label: 'Automation installed', description: 'Fires when an Automation Marketplace recipe is installed.' },
];

export const EVENT_CATEGORIES: string[] = Array.from(new Set(EVENT_CATALOG.map((e) => e.category)));

export interface WebhookEndpoint {
  id: string;
  user_id: string;
  url: string;
  description: string | null;
  events: EventType[];
  signing_secret: string;
  status: 'active' | 'disabled';
  last_delivery_at: string | null;
  last_delivery_status: 'success' | 'error' | null;
  created_at: string;
}

export function eventLabel(type: string): string {
  return EVENT_CATALOG.find((e) => e.type === type)?.label ?? type;
}
