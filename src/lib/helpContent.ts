import {
  Rocket,
  PhoneCall,
  LayoutDashboard,
  Users,
  CreditCard,
  Plug,
  Bell,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

export interface HelpArticle {
  q: string;
  a: string;
  /** Optional stable URL slug. Set it once an article is live so editing the question never changes its URL. */
  slug?: string;
}

export interface HelpCategory {
  id: string;
  name: string;
  icon: LucideIcon;
  description: string;
  articles: HelpArticle[];
}

export const HELP_CATEGORIES: HelpCategory[] = [
  {
    id: 'getting-started',
    name: 'Getting Started',
    icon: Rocket,
    description: 'Create your account, connect your number, and take your first call with Sarah.',
    articles: [
      {
        q: 'How do I create a Vireek account?',
        a: 'Go to the Sign Up page and create your account with a work email and password. You will move straight into a short onboarding flow where you tell Sarah about your business — industry, service area, hours, and how you want calls handled.',
      },
      {
        q: 'Do I need to change my business phone number?',
        a: 'No. Keep the number your customers already know. Most businesses simply forward calls to Vireek (all calls, after-hours only, or overflow when your line is busy) so Sarah answers under the same number.',
      },
      {
        q: 'How long does setup take?',
        a: 'Most businesses are live within about 15 minutes: create an account, complete the Business Profile (services, hours, FAQs, escalation contact), forward your calls, and place a test call to confirm the greeting sounds right.',
      },
      {
        q: 'Can I test Sarah before going live?',
        a: 'Yes. Use the Live Demo on the marketing site or place a call to your forwarded number after setup to hear exactly what your customers will hear, then adjust the script from your Business Profile.',
      },
    ],
  },
  {
    id: 'call-handling',
    name: 'Call Handling & Sarah',
    icon: PhoneCall,
    description: 'How your AI receptionist answers, qualifies, and escalates every call.',
    articles: [
      {
        q: 'What does Sarah actually do on a call?',
        a: 'Sarah answers with your greeting, asks the qualifying questions relevant to your trade (service needed, address, urgency, availability), and captures the details your team needs — then books an appointment, logs a lead, or escalates, depending on what the caller needs.',
      },
      {
        q: 'Can Sarah handle emergency calls?',
        a: 'Yes. Sarah is trained to recognize urgent language, gather the key safety and location details, and immediately flag the call for fast follow-up. Sarah is not a replacement for 911 or licensed emergency dispatch, but she makes sure a real emergency never sits in a voicemail queue.',
      },
      {
        q: 'Can I customize what Sarah says?',
        a: 'Yes, from Dashboard → Business Profile. You control the greeting, service list, hours, FAQ answers, qualifying questions, and who calls get escalated to. Changes take effect on the next call — no redeployment needed.',
      },
      {
        q: 'What happens when Sarah can\u2019t answer a caller\u2019s question?',
        a: 'Sarah will offer to take a message, schedule a callback, or transfer to your designated escalation contact based on the rules you set in Business Profile, rather than guessing or ending the call.',
      },
    ],
  },
  {
    id: 'dashboard',
    name: 'Dashboard & Reporting',
    icon: LayoutDashboard,
    description: 'Where every call, lead, and job lives after Sarah answers the phone.',
    articles: [
      {
        q: 'Where do I see my calls?',
        a: 'Dashboard → Calls shows every conversation Sarah has handled in real time, including a transcript, caller intent, and outcome. New calls appear at the top the moment they finish — no refresh needed.',
      },
      {
        q: 'What\u2019s the difference between Leads and Jobs?',
        a: 'Leads (Dashboard → Leads) are captured inquiries that haven\u2019t been converted yet. Jobs (Dashboard → Jobs) are confirmed, scheduled work with a status you can move through your pipeline (scheduled, in progress, completed, cancelled).',
      },
      {
        q: 'Can I see revenue and performance trends?',
        a: 'Yes. Dashboard → Analytics breaks down call volume, answer rate, lead conversion, and estimated revenue recovered over any date range. Dashboard → Insights adds AI-generated summaries of what changed and why.',
      },
      {
        q: 'Is my dashboard data live?',
        a: 'Yes. Calls, Jobs, and the Overview stat cards update in real time. A small Live / Reconnecting indicator next to the page title shows the current connection status.',
      },
    ],
  },
  {
    id: 'team',
    name: 'Team & Permissions',
    icon: Users,
    description: 'Invite technicians, dispatchers, and office staff with the right access level.',
    articles: [
      {
        q: 'How do I invite a team member?',
        a: 'Go to Dashboard → Team and send an invite by email. The invite includes a secure sign-up link, and you can resend it if it expires before they accept.',
      },
      {
        q: 'Can I limit what a team member sees?',
        a: 'Yes. Roles control access — for example, a technician can be limited to only the jobs assigned to them, while an office manager can see every call, lead, and job across the account.',
      },
      {
        q: 'A team member says they aren\u2019t seeing new calls update live. What\u2019s going on?',
        a: 'Realtime updates are scoped to your account, not to any single login, so this should work automatically. If it doesn\u2019t, ask them to refresh the page once — if the issue persists, contact support with their account email.',
      },
    ],
  },
  {
    id: 'billing',
    name: 'Billing & Plans',
    icon: CreditCard,
    description: 'Plans, usage, invoices, and how to change or cancel your subscription.',
    articles: [
      {
        q: 'How is Vireek priced?',
        a: 'Plans are based on call volume and features. Compare current plans on the Pricing page, or use the Revenue Calculator to estimate what missed calls are costing you today versus a Vireek plan.',
      },
      {
        q: 'Where do I manage billing and invoices?',
        a: 'Dashboard → Billing shows your current plan, usage against your call allowance, and past invoices, and lets you update your payment method or change plans.',
      },
      {
        q: 'What happens if I go over my plan\u2019s call limit?',
        a: 'You\u2019ll get a usage alert (in-app and via the Notification Center) as you approach your limit so you can upgrade before it affects call answering. We don\u2019t cut off calls without warning you first.',
      },
      {
        q: 'Can I cancel anytime?',
        a: 'Yes, from Dashboard → Billing. There\u2019s no long-term contract requirement for standard plans — check your plan details for the exact terms that apply to your account.',
      },
    ],
  },
  {
    id: 'integrations',
    name: 'Integrations',
    icon: Plug,
    description: 'Connect Vireek to the CRM, calendar, and tools you already use.',
    articles: [
      {
        q: 'Does Vireek integrate with my CRM?',
        a: 'Dashboard → Integrations lists the connections available for your plan. Vireek captures structured call and lead data specifically so it can flow into your existing tools instead of living in a separate silo.',
      },
      {
        q: 'Does Sarah book directly onto my calendar?',
        a: 'Yes — appointments booked during a call are written to Dashboard → Calendar and, where connected, synced to your integrated calendar so there\u2019s one source of truth for scheduling.',
      },
      {
        q: 'An integration shows as disconnected. What should I do?',
        a: 'Reconnect it from Dashboard → Integrations — this usually resolves an expired authorization. If it reconnects and then drops again, contact support so we can check the connection logs on our side.',
      },
    ],
  },
  {
    id: 'notifications',
    name: 'Notifications & Alerts',
    icon: Bell,
    description: 'Stay on top of emergency calls, new insights, and account activity.',
    articles: [
      {
        q: 'How do I get notified about an emergency call?',
        a: 'Emergency calls automatically create a notification (bell icon in the dashboard header) and, if enabled, an email or SMS alert. Configure exactly which events notify you at Dashboard → Settings → Notification Preferences.',
      },
      {
        q: 'Can I turn off certain notification types?',
        a: 'Yes. Dashboard → Settings lets you toggle email and SMS alerts independently for emergencies, new bookings, and usage warnings, without turning off in-app notifications.',
      },
      {
        q: 'Where can I see my full notification history?',
        a: 'Dashboard → Notifications keeps a complete, searchable history and lets you mark items as read individually or all at once.',
      },
    ],
  },
  {
    id: 'security',
    name: 'Security & Privacy',
    icon: ShieldCheck,
    description: 'How your account, caller data, and team access are protected.',
    articles: [
      {
        q: 'How is my customer call data protected?',
        a: 'Data is protected with encryption in transit and at rest, strict database-level access rules (Row Level Security) scoped to your account, and role-based permissions so team members only ever see what they\u2019re allowed to. See the full Security page for details.',
      },
      {
        q: 'What is the Audit Log?',
        a: 'Dashboard → Settings → Security records sensitive account changes — team permission changes, job deletions, billing plan changes, business profile edits, and integration connect/disconnect events — as an append-only log for accountability.',
      },
      {
        q: 'What are trusted devices?',
        a: 'When you verify a new device during login, you can mark it as trusted so future sign-ins from that device skip extra verification. Manage or revoke trusted devices anytime from Dashboard → Settings → Security.',
      },
      {
        q: 'Where do I read the full privacy policy?',
        a: 'The complete Privacy Policy and Terms of Service are always available in the site footer and explain exactly what data is collected, why, and how long it\u2019s kept.',
      },
    ],
  },
  {
    id: 'troubleshooting',
    name: 'Troubleshooting',
    icon: Wrench,
    description: 'Fixes for the most common setup and call-handling issues.',
    articles: [
      {
        q: 'Calls aren\u2019t reaching Sarah.',
        a: 'Double-check the call-forwarding number configured with your phone carrier matches the number shown in Dashboard → Business Profile exactly, including country code. Most issues come from a forwarding rule pointing at the wrong number or being scoped to \u201cbusy only\u201d instead of \u201cno answer.\u201d',
      },
      {
        q: 'A caller says Sarah didn\u2019t understand them.',
        a: 'Background noise and heavy accents can occasionally affect recognition. Check the call transcript in Dashboard → Calls — if it\u2019s a recurring pattern rather than a one-off, send us the call ID so we can review it.',
      },
      {
        q: 'I don\u2019t see a booked appointment on my calendar.',
        a: 'Confirm the integration is still connected at Dashboard → Integrations, then check Dashboard → Calendar directly, since a booking always lands there first regardless of external sync status.',
      },
      {
        q: 'I\u2019m not receiving email or SMS alerts.',
        a: 'Check Dashboard → Settings → Notification Preferences to confirm the relevant toggle is on, and check your spam folder for the sending address. If alerts still don\u2019t arrive, contact support.',
      },
    ],
  },
];
