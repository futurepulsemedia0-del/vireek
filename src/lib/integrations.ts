import { Calculator, Calendar, CreditCard, Zap, Users, Cloud, MessageSquare, Mail, PhoneCall, type LucideIcon } from 'lucide-react';

export interface IntegrationFAQ {
  q: string;
  a: string;
}

export interface IntegrationStep {
  title: string;
  detail: string;
}

export interface Integration {
  slug: string;
  name: string;
  /** Short category label shown as an eyebrow / badge, e.g. "Accounting" */
  category: string;
  icon: LucideIcon;
  tagline: string;
  /** One-paragraph summary shown near the top of the page */
  summary: string;
  /** What this integration actually does inside Vireek, in plain language */
  capabilities: string[];
  /** Ordered "how it works" steps for connecting it */
  steps: IntegrationStep[];
  faq: IntegrationFAQ[];
}

export const INTEGRATIONS: Integration[] = [
  {
    slug: 'quickbooks',
    name: 'QuickBooks',
    category: 'Accounting',
    icon: Calculator,
    tagline: 'Keep every booked job lined up with your books, automatically.',
    summary:
      'Connect Vireek to QuickBooks so the jobs Sarah books over the phone show up on the accounting side without anyone re-typing customer names, addresses, or job details by hand.',
    capabilities: [
      'New customers captured on a call are matched or created in QuickBooks instead of being entered twice.',
      'Booked jobs carry the details your office already collects, so invoicing starts from accurate information.',
      'Fewer spreadsheet hand-offs between the phone, the calendar, and the accounting team.',
    ],
    steps: [
      { title: 'Open Integrations', detail: 'From your Vireek dashboard, go to Settings → Integrations.' },
      { title: 'Connect QuickBooks', detail: 'Sign in with your QuickBooks Online account and approve access.' },
      { title: 'Confirm the sync', detail: 'New customers and jobs from Vireek start flowing into QuickBooks automatically.' },
    ],
    faq: [
      {
        q: 'Does this replace my bookkeeper?',
        a: 'No. It removes double data entry between the phone and your books — your bookkeeper or accountant still handles invoicing, categorization, and reconciliation as usual.',
      },
      {
        q: 'What QuickBooks plan do I need?',
        a: 'QuickBooks Online is required for the connection. Talk to your account manager if you\u2019re unsure which plan supports it.',
      },
      {
        q: 'Is my financial data shared with anyone else?',
        a: 'No. The connection only moves customer and job information you already collect through Vireek — see our Trust Center for how account data is isolated.',
      },
    ],
  },
  {
    slug: 'google-calendar',
    name: 'Google Calendar',
    category: 'Scheduling',
    icon: Calendar,
    tagline: 'Sarah checks real availability and books straight onto your calendar.',
    summary:
      'Connect Google Calendar so Vireek only offers time slots your team actually has open, and every appointment booked over the phone appears on your calendar the moment the call ends.',
    capabilities: [
      'Appointment offers are checked against your real, current availability — no double-booking.',
      'Confirmed jobs are written to Google Calendar automatically, with the caller\u2019s details attached.',
      'Reschedules and cancellations handled by Sarah stay in sync with the calendar.',
    ],
    steps: [
      { title: 'Open Integrations', detail: 'From your Vireek dashboard, go to Settings → Integrations.' },
      { title: 'Connect Google Calendar', detail: 'Sign in with Google and choose the calendar you want Vireek to read and write to.' },
      { title: 'Set your availability', detail: 'Vireek respects existing events and your working hours when offering appointment times.' },
    ],
    faq: [
      {
        q: 'Can I connect more than one calendar, for different techs?',
        a: 'Team and multi-calendar routing is configured with your account manager based on how your crew is scheduled.',
      },
      {
        q: 'What happens if I move an appointment manually in Google Calendar?',
        a: 'Vireek reads your calendar before offering new times, so a manual change is reflected the next time a slot is checked.',
      },
    ],
  },
  {
    slug: 'stripe',
    name: 'Stripe',
    category: 'Billing',
    icon: CreditCard,
    tagline: 'Secure billing for your Vireek subscription, handled by Stripe.',
    summary:
      'Vireek uses Stripe to process subscription billing. Stripe handles your payment details directly — Vireek never stores your raw card number on its own servers.',
    capabilities: [
      'Subscription payments, upgrades, downgrades, and invoices are all managed through Stripe.',
      'Card details are entered directly into Stripe\u2019s secure checkout, not stored on Vireek\u2019s own infrastructure.',
      'Billing history and receipts are available from your account\u2019s Billing page at any time.',
    ],
    steps: [
      { title: 'Go to Billing', detail: 'From your Vireek dashboard, open Settings → Billing.' },
      { title: 'Add a payment method', detail: 'Enter your card details through Stripe\u2019s secure, hosted checkout.' },
      { title: 'Manage anytime', detail: 'Update your plan, payment method, or download invoices whenever you need to.' },
    ],
    faq: [
      {
        q: 'Does Vireek store my card number?',
        a: 'No. Card details are handled directly by Stripe, a PCI-compliant payment processor. Vireek\u2019s systems never see or store your raw card number.',
      },
      {
        q: 'Can I change plans or cancel at any time?',
        a: 'Yes, from the Billing page in your dashboard. Changes take effect according to the terms shown at checkout.',
      },
    ],
  },
  {
    slug: 'zapier',
    name: 'Zapier',
    category: 'Automation',
    icon: Zap,
    tagline: 'Send Vireek\u2019s calls, leads, and bookings to thousands of other apps.',
    summary:
      'Connect Vireek to Zapier to pass call outcomes, new leads, and booked jobs into the other tools you already run your business on — no custom code required.',
    capabilities: [
      'Trigger a Zap whenever Sarah answers a call, books a job, or flags an emergency.',
      'Push new leads into your CRM, spreadsheet, or team chat automatically.',
      'Combine Vireek with thousands of apps already supported by Zapier, without engineering work.',
    ],
    steps: [
      { title: 'Open Integrations', detail: 'From your Vireek dashboard, go to Settings → Integrations.' },
      { title: 'Connect Zapier', detail: 'Authorize the Vireek app inside your Zapier account.' },
      { title: 'Build your Zap', detail: 'Choose a Vireek trigger (new call, new lead, booked job) and pick what should happen next.' },
    ],
    faq: [
      {
        q: 'Do I need a paid Zapier plan?',
        a: 'Zapier\u2019s free plan supports basic single-step Zaps. Multi-step or high-volume automations may require a paid Zapier plan — that\u2019s billed by Zapier, not Vireek.',
      },
      {
        q: 'What events can trigger a Zap?',
        a: 'New calls, new leads, booked appointments, and flagged emergencies are all available as triggers from your Integrations settings.',
      },
    ],
  },
  {
    slug: 'hubspot',
    name: 'HubSpot',
    category: 'CRM',
    icon: Users,
    tagline: 'Every call becomes a contact, a deal, and a timeline entry in HubSpot.',
    summary:
      'Connect HubSpot so callers Sarah talks to are captured as contacts, with call details, timeline activity, and job status kept in sync — instead of your team re-entering the same lead by hand.',
    capabilities: [
      'New callers are matched to an existing HubSpot contact or created automatically, with no duplicate records.',
      'Call summaries and outcomes are logged to the contact timeline so your sales and support history stays in one place.',
      'Booked jobs and lead status changes update the matching HubSpot deal automatically.',
    ],
    steps: [
      { title: 'Open Integrations', detail: 'From your Vireek dashboard, go to Settings → Integrations.' },
      { title: 'Connect HubSpot', detail: 'Sign in with your HubSpot account and approve access to contacts and deals.' },
      { title: 'Map your pipeline', detail: 'Choose which HubSpot pipeline and stage new Vireek leads should land in.' },
    ],
    faq: [
      {
        q: 'Which HubSpot plan do I need?',
        a: 'The Contacts and Deals objects used by this integration are available on HubSpot\u2019s free CRM tier; certain custom properties may require a paid Marketing or Sales Hub plan.',
      },
      {
        q: 'Does this create duplicate contacts?',
        a: 'No — Vireek matches on phone number first, updating an existing HubSpot contact instead of creating a new one whenever possible.',
      },
    ],
  },
  {
    slug: 'salesforce',
    name: 'Salesforce',
    category: 'CRM',
    icon: Cloud,
    tagline: 'Enterprise-grade CRM sync, with field mapping built for how your team already works.',
    summary:
      'Connect Salesforce so leads and bookings captured by Sarah flow directly into the Leads or Accounts objects your team already reports from — with field mapping configured to match your existing setup.',
    capabilities: [
      'Leads captured on a call are created or matched in Salesforce, with call notes attached.',
      'Custom field mapping lets Vireek write into the same fields your team already uses for reporting.',
      'Booked appointments and job status changes are reflected on the matching Salesforce record.',
    ],
    steps: [
      { title: 'Open Integrations', detail: 'From your Vireek dashboard, go to Settings → Integrations.' },
      { title: 'Connect Salesforce', detail: 'Authorize the Vireek connected app inside your Salesforce org.' },
      { title: 'Configure field mapping', detail: 'Work with your account manager to map Vireek fields to your existing Salesforce objects.' },
    ],
    faq: [
      {
        q: 'Does this work with Salesforce Sales Cloud and Service Cloud?',
        a: 'Yes — the integration connects to standard Lead, Contact, and Account objects available in both.',
      },
      {
        q: 'Can we use our existing custom fields?',
        a: 'Yes. Field mapping is configured with your account manager so data lands exactly where your team already looks for it.',
      },
    ],
  },
  {
    slug: 'slack',
    name: 'Slack',
    category: 'Team Communication',
    icon: MessageSquare,
    tagline: 'Your team hears about a hot lead or emergency call the moment it happens.',
    summary:
      'Connect Slack so your team gets a real-time message the moment Sarah books a job, flags an emergency, or qualifies a lead — right in the channel your team already watches.',
    capabilities: [
      'Instant Slack notifications for new bookings, qualified leads, and flagged emergencies.',
      'Choose which channel each event type posts to, so urgent calls don\u2019t get lost in general chatter.',
      'Each notification links back to the full call record in your Vireek dashboard.',
    ],
    steps: [
      { title: 'Open Integrations', detail: 'From your Vireek dashboard, go to Settings → Integrations.' },
      { title: 'Connect Slack', detail: 'Authorize the Vireek app for your Slack workspace.' },
      { title: 'Choose your channels', detail: 'Pick which channel receives bookings, leads, and emergency alerts.' },
    ],
    faq: [
      {
        q: 'Can different alert types go to different channels?',
        a: 'Yes — for example, emergencies can post to a dedicated #urgent-calls channel while routine bookings go to #leads.',
      },
      {
        q: 'Will this notify my whole team on every call?',
        a: 'No. You choose which event types trigger a notification and which channel receives it, so routine calls don\u2019t flood the workspace.',
      },
    ],
  },
  {
    slug: 'microsoft-365',
    name: 'Microsoft 365 / Outlook',
    category: 'Calendar & Email',
    icon: Mail,
    tagline: 'Sarah books straight onto your Outlook calendar and confirms by email.',
    summary:
      'Connect Microsoft 365 so Vireek checks real availability on your Outlook calendar before offering an appointment time, and sends booking confirmations from the email your customers already recognize.',
    capabilities: [
      'Appointment offers are checked against your real Outlook calendar — no double-booking with existing meetings.',
      'Confirmed jobs are written to Outlook automatically, with the caller\u2019s details attached.',
      'Booking confirmation emails are sent from your connected Microsoft 365 mailbox.',
    ],
    steps: [
      { title: 'Open Integrations', detail: 'From your Vireek dashboard, go to Settings → Integrations.' },
      { title: 'Connect Microsoft 365', detail: 'Sign in with your Microsoft work account and approve calendar and mail access.' },
      { title: 'Set your availability', detail: 'Vireek respects existing Outlook events and working hours when offering appointment times.' },
    ],
    faq: [
      {
        q: 'Does this work with a shared team calendar?',
        a: 'Team and shared-calendar routing is configured with your account manager based on how your crew is scheduled.',
      },
      {
        q: 'Can I still edit appointments manually in Outlook?',
        a: 'Yes — Vireek reads your calendar before offering new times, so manual changes are reflected the next time a slot is checked.',
      },
    ],
  },
  {
    slug: 'twilio',
    name: 'Twilio',
    category: 'Voice & SMS',
    icon: PhoneCall,
    tagline: 'The telephony backbone behind Sarah\u2019s calls and text-back messages.',
    summary:
      'Vireek uses Twilio to route inbound calls to Sarah and to send SMS messages like text-back and appointment reminders — you can also connect your own existing Twilio number if you already have one.',
    capabilities: [
      'Inbound calls to your business number are routed to Sarah through Twilio\u2019s telephony network.',
      'SMS text-back, confirmations, and reminders are all sent through the same connected number.',
      'Bring your own existing Twilio number, or provision a new one directly from your Vireek dashboard.',
    ],
    steps: [
      { title: 'Open Integrations', detail: 'From your Vireek dashboard, go to Settings → Integrations.' },
      { title: 'Connect or provision a number', detail: 'Link an existing Twilio number or provision a new SMS-enabled number through Vireek.' },
      { title: 'Confirm call and text routing', detail: 'Test that inbound calls reach Sarah and outbound texts send correctly.' },
    ],
    faq: [
      {
        q: 'Do I need my own Twilio account?',
        a: 'No — most businesses use a number provisioned directly through Vireek. Bringing your own Twilio account is supported for teams with existing telephony infrastructure.',
      },
      {
        q: 'Does this affect my existing business number?',
        a: 'Your existing number can be forwarded to Vireek without changing what customers dial — see Call Forwarding in the glossary for how that works.',
      },
    ],
  },
];

export function getIntegrationBySlug(slug: string | undefined): Integration | undefined {
  return INTEGRATIONS.find((i) => i.slug === slug);
}
