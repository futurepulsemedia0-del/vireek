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
import { Building2, Mail, ShieldCheck, type LucideIcon } from 'lucide-react';

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
    ],
  },
];
