import { Calculator, Calendar, CreditCard, Zap, type LucideIcon } from 'lucide-react';

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
];

export function getIntegrationBySlug(slug: string | undefined): Integration | undefined {
  return INTEGRATIONS.find((i) => i.slug === slug);
}
