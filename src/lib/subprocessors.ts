// Single source of truth for the sub-processor list — used by
// SubprocessorsPage.tsx (full legal list) and TrustCenterPage.tsx
// (interactive Subprocessor Map). Edit here once; both stay in sync.
//
// Every entry must reflect a vendor Vireek actually uses today. When you
// add, remove, or replace a processor:
//   1. Update this list.
//   2. Update SUBPROCESSORS_LAST_UPDATED below.
//   3. If you have customers on a signed DPA, follow the notice process
//      in DpaContent.tsx Section 5 (Sub-processors) before the change
//      goes live for their account.
import { Building2, Globe, Mail, Plug, ShieldCheck, type LucideIcon } from 'lucide-react';

export const SUBPROCESSORS_LAST_UPDATED = 'September 12, 2026';

export interface Processor {
  name: string;
  purpose: string;
  location: string;
  dataTypes: string;
}

export interface ProcessorCategory {
  icon: LucideIcon;
  title: string;
  description: string;
  required: boolean; // false = only involved if the customer connects it
  processors: Processor[];
}

export const SUBPROCESSOR_CATEGORIES: ProcessorCategory[] = [
  {
    icon: Building2,
    title: 'Infrastructure & Hosting',
    description: 'Core systems every account runs on.',
    required: true,
    processors: [
      { name: 'Supabase, Inc.', purpose: 'Database, authentication, and backend (edge function) hosting', location: 'United States', dataTypes: 'All account, call, lead, and job data' },
      { name: 'Vercel Inc.', purpose: 'Frontend website and dashboard hosting', location: 'United States', dataTypes: 'Website traffic; no call content' },
    ],
  },
  {
    icon: ShieldCheck,
    title: 'Voice & AI Processing',
    description: "Providers that power Sarah's call handling and AI features.",
    required: true,
    processors: [
      { name: 'Vapi Inc.', purpose: 'Voice AI and telephony infrastructure for answering and routing calls', location: 'United States', dataTypes: 'Call audio, call transcripts, caller phone numbers' },
      { name: 'Google LLC (Gemini API)', purpose: 'AI language model used for call understanding and summarization', location: 'United States', dataTypes: 'Call transcripts and text prompts (no raw audio)' },
      { name: 'Groq, Inc.', purpose: 'AI inference (fallback provider in the model routing chain)', location: 'United States', dataTypes: 'Call transcripts and text prompts' },
      { name: 'Cerebras Systems Inc.', purpose: 'AI inference (fallback provider in the model routing chain)', location: 'United States', dataTypes: 'Call transcripts and text prompts' },
      { name: 'Cloudflare, Inc. (Workers AI)', purpose: 'AI inference (fallback provider in the model routing chain)', location: 'United States', dataTypes: 'Call transcripts and text prompts' },
      { name: 'OpenRouter, Inc.', purpose: 'AI inference routing (fallback provider in the model routing chain)', location: 'United States', dataTypes: 'Call transcripts and text prompts' },
      { name: 'Anthropic, PBC', purpose: 'AI inference (fallback provider in the model routing chain)', location: '[VERIFY] United States', dataTypes: 'Call transcripts and text prompts' },
      { name: 'Cohere', purpose: 'Text embeddings and ranking for knowledge-base search', location: '[VERIFY]', dataTypes: 'Knowledge-base text and search queries' },
      { name: 'ElevenLabs', purpose: 'Text-to-speech voice synthesis', location: '[VERIFY]', dataTypes: 'Text to be spoken' },
      { name: 'Twilio Inc.', purpose: 'SMS, voice, and phone-number lookup', location: '[VERIFY] United States', dataTypes: 'Phone numbers, message content, call metadata' },
      { name: 'Telnyx LLC', purpose: 'SMS and voice (telephony failover)', location: '[VERIFY] United States', dataTypes: 'Phone numbers, message content, call metadata' },
      { name: 'Daily.co', purpose: 'Video sessions (for example video quotes)', location: '[VERIFY]', dataTypes: 'Live audio and video of session participants' },
    ],
  },
  {
    icon: Mail,
    title: 'Payments & Communications',
    description: 'Billing and transactional messages.',
    required: true,
    processors: [
      { name: 'Stripe, Inc.', purpose: 'Payment processing and subscription billing', location: 'United States', dataTypes: 'Billing name, email, and payment details' },
      { name: 'Resend', purpose: 'Transactional email delivery (e.g. team invites)', location: 'United States', dataTypes: 'Recipient name and email address' },
    ],
  },
  {
    icon: ShieldCheck,
    title: 'Analytics & Monitoring',
    description: 'Keeping the product reliable and the website measurable.',
    required: true,
    processors: [
      { name: 'Sentry (Functional Software, Inc.)', purpose: 'Application error monitoring', location: 'United States', dataTypes: 'Technical error data; PII stripped before it leaves the browser' },
      { name: 'Google LLC (Google Analytics)', purpose: 'Website analytics', location: 'United States', dataTypes: 'Website usage data; only active with cookie consent' },
      { name: 'PagerDuty, Inc.', purpose: 'Incident alerting for the Vireek on-call team', location: '[VERIFY] United States', dataTypes: 'Operational alert metadata' },
    ],
  },
  {
    icon: Building2,
    title: 'Customer-Optional Integrations',
    description: 'Only involved if you choose to connect them from your dashboard.',
    required: false,
    processors: [
      { name: 'Google LLC (Google Calendar)', purpose: 'Appointment scheduling sync', location: 'United States', dataTypes: 'Appointment details, when connected' },
      { name: 'Intuit Inc. (QuickBooks)', purpose: 'Accounting sync', location: 'United States', dataTypes: 'Invoice and job data, when connected' },
      { name: 'Zapier, Inc.', purpose: 'Workflow automation', location: 'United States', dataTypes: 'Whatever data your configured Zap passes through, when connected' },
      { name: 'Xero Limited', purpose: 'Accounting sync', location: '[VERIFY]', dataTypes: 'Invoice, contact, and job data, when connected' },
      { name: 'Sage Intacct', purpose: 'Accounting sync', location: '[VERIFY] United States', dataTypes: 'Invoice, contact, and job data, when connected' },
      { name: 'Oracle NetSuite', purpose: 'Accounting sync', location: '[VERIFY] United States', dataTypes: 'Invoice, contact, and job data, when connected' },
      { name: 'Zoho Corporation', purpose: 'Accounting and CRM sync', location: '[VERIFY]', dataTypes: 'Invoice, contact, and lead data, when connected' },
      { name: 'Gusto, Inc.', purpose: 'Payroll connector', location: '[VERIFY] United States', dataTypes: 'Employee and time data, when connected' },
      { name: 'HubSpot, Inc.', purpose: 'CRM sync', location: '[VERIFY] United States', dataTypes: 'Contact and lead data, when connected' },
      { name: 'Salesforce, Inc.', purpose: 'CRM sync', location: '[VERIFY] United States', dataTypes: 'Contact and lead data, when connected' },
      { name: 'Pipedrive', purpose: 'CRM sync', location: '[VERIFY]', dataTypes: 'Contact and lead data, when connected' },
      { name: 'Jobber', purpose: 'Job and price-book sync', location: '[VERIFY]', dataTypes: 'Customer, job, and pricing data, when connected' },
      { name: 'Housecall Pro', purpose: 'Job and price-book sync', location: '[VERIFY] United States', dataTypes: 'Customer, job, and pricing data, when connected' },
      { name: 'ServiceTitan, Inc.', purpose: 'Job and price-book sync', location: '[VERIFY] United States', dataTypes: 'Customer, job, and pricing data, when connected' },
      { name: 'RealPage, Inc. (Buildium, Propertyware)', purpose: 'Property-management sync', location: '[VERIFY] United States', dataTypes: 'Property, tenant, and work-order data, when connected' },
      { name: 'Yardi Systems, Inc.', purpose: 'Property-management sync', location: '[VERIFY] United States', dataTypes: 'Property, tenant, and work-order data, when connected' },
      { name: 'Samsara Inc.', purpose: 'Fleet telematics sync', location: '[VERIFY] United States', dataTypes: 'Vehicle location and driver data, when connected' },
      { name: 'Splunk', purpose: 'Security log streaming to your own instance', location: '[VERIFY]', dataTypes: 'Security and audit events, when connected' },
      { name: 'Klaviyo, Inc.', purpose: 'Marketing data destination', location: '[VERIFY] United States', dataTypes: 'Contact and engagement data, when connected' },
      { name: 'Slack Technologies, LLC', purpose: 'Team notifications and chat channel', location: '[VERIFY] United States', dataTypes: 'Notification content you route to Slack, when connected' },
      { name: 'Microsoft Corporation', purpose: 'Calendar sync and Teams notifications', location: '[VERIFY] United States', dataTypes: 'Appointment details and notification content, when connected' },
      { name: 'Meta Platforms, Inc.', purpose: 'WhatsApp, Messenger, and Facebook messaging channels', location: '[VERIFY] United States', dataTypes: 'Message content and sender identifiers, when connected' },
      { name: 'Telegram', purpose: 'Telegram messaging channel', location: '[VERIFY]', dataTypes: 'Message content and sender identifiers, when connected' },
    ],
  },
  {
    icon: Plug,
    title: 'Optional Platform Features',
    description: 'Only involved when the related feature is enabled for your account.',
    required: false,
    processors: [
      { name: 'Plaid Inc.', purpose: 'Bank-account connection for payments and reconciliation', location: '[VERIFY] United States', dataTypes: 'Bank connection tokens and transaction data, when connected' },
      { name: 'Wisetack, Inc.', purpose: 'Consumer financing offers', location: '[VERIFY] United States', dataTypes: 'Customer name, contact details, and job amount, when used' },
      { name: 'TaxJar, Inc.', purpose: 'Sales-tax calculation', location: '[VERIFY] United States', dataTypes: 'Job address and amounts, when used' },
      { name: 'Checkr, Inc.', purpose: 'Technician background screening', location: '[VERIFY] United States', dataTypes: 'Candidate identity and screening results, when used' },
      { name: 'Lob.com, Inc.', purpose: 'Printed direct mail', location: '[VERIFY] United States', dataTypes: 'Recipient name and postal address, when used' },
      { name: 'Sinch', purpose: 'RCS and Apple Messages for Business', location: '[VERIFY]', dataTypes: 'Phone numbers and message content, when used' },
      { name: 'Apple Inc.', purpose: 'Push notifications (APNs) and Wallet pass updates', location: '[VERIFY] United States', dataTypes: 'Device push tokens and notification content, when used' },
      { name: 'Google LLC (Firebase Cloud Messaging, Business Profile, Ads, BigQuery, Maps)', purpose: 'Push notifications and Google service integrations', location: '[VERIFY] United States', dataTypes: 'Device push tokens, listing and ad data, address lookups, when used' },
      { name: 'Yelp Inc.', purpose: 'Review and listing integration', location: '[VERIFY] United States', dataTypes: 'Business listing and review data, when used' },
      { name: 'RentCast', purpose: 'Property data lookups', location: '[VERIFY] United States', dataTypes: 'Property addresses, when used' },
      { name: 'ATTOM Data Solutions', purpose: 'Property data lookups', location: '[VERIFY] United States', dataTypes: 'Property addresses, when used' },
    ],
  },
  {
    icon: Globe,
    title: 'Browser-Side Services',
    description: 'Services your browser contacts directly when you use our website and dashboard.',
    required: true,
    processors: [
      { name: 'Formspark (submit-form.com)', purpose: 'Website form submissions (contact, signup, exit-intent, evidence requests)', location: '[VERIFY]', dataTypes: 'Names, email addresses, and the message you submit' },
      { name: 'Formspree, Inc.', purpose: 'Website form submissions (podcast and report request forms)', location: '[VERIFY] United States', dataTypes: 'Names, email addresses, and the message you submit' },
      { name: 'OpenFreeMap', purpose: 'Map tiles and styles for the live map and canvassing views', location: '[VERIFY]', dataTypes: 'IP address and requested map area' },
      { name: 'Cloudflare, Inc. (Turnstile, TURN, DNS)', purpose: 'Bot protection on forms, WebRTC relay, and DNS lookups', location: '[VERIFY] United States', dataTypes: 'IP address and browser signals; relayed real-time media in transit' },
    ],
  },
];
