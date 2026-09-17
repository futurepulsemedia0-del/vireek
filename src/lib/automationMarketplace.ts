import {
  type LucideIcon,
  MessageSquareText,
  Star,
  CalendarClock,
  ShieldAlert,
  Flame,
  Gift,
  Bell,
  FileWarning,
  UserCheck,
  PhoneMissed,
  Ban,
  Repeat,
  Award,
  Landmark,
} from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  automationMarketplace — catalog for the in-app Automation          */
/*  Marketplace (/dashboard/automation-marketplace).                    */
/*                                                                      */
/*  The catalog below is curated content (same idea as the public       */
/*  Marketplace's PARTNER_LISTINGS in src/lib/marketplace.ts) so new     */
/*  automations ship as a code change, no migration required. What a    */
/*  business has turned on is the only thing that lives in the          */
/*  database — see the automation_installs table.                       */
/* ------------------------------------------------------------------ */

export type AutomationTier = 'starter' | 'pro';

export interface AutomationTemplate {
  slug: string;
  name: string;
  category: string;
  icon: LucideIcon;
  tagline: string;
  description: string;
  trigger: string;
  action: string;
  tier: AutomationTier;
  popular?: boolean;
}

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    slug: 'missed-call-text-back',
    name: 'Missed Call Text-Back',
    category: 'Missed Call Recovery',
    icon: PhoneMissed,
    tagline: 'Never lose a caller to voicemail again.',
    description:
      'The instant a call goes unanswered, the customer gets a text from your business number so the conversation keeps going even if no one picked up.',
    trigger: 'A call is missed or rings out to voicemail',
    action: 'Send an SMS with a booking link within 30 seconds',
    tier: 'starter',
    popular: true,
  },
  {
    slug: 'post-job-review-request',
    name: 'Post-Job Review Request',
    category: 'Reviews & Reputation',
    icon: Star,
    tagline: 'Turn finished jobs into 5-star reviews on autopilot.',
    description:
      'When a job is marked complete, the customer gets a friendly text asking for a Google review, timed for when satisfaction is highest.',
    trigger: 'A job is marked "Completed" on the Dispatch Board',
    action: 'Send a review-request SMS 2 hours after job completion',
    tier: 'starter',
    popular: true,
  },
  {
    slug: 'negative-review-alert',
    name: 'Negative Review Alert',
    category: 'Reviews & Reputation',
    icon: Bell,
    tagline: 'Hear about a bad review before your customers do.',
    description:
      'Any review of 3 stars or fewer pages the owner immediately by SMS and email so it can be addressed same-day, not discovered a week later.',
    trigger: 'A new review comes in at 3 stars or fewer',
    action: 'Notify the business owner by SMS and email',
    tier: 'starter',
  },
  {
    slug: 'quote-follow-up-sequence',
    name: 'Quote Follow-Up Sequence',
    category: 'Follow-ups & Sales',
    icon: FileWarning,
    tagline: 'Stop letting sent quotes go cold.',
    description:
      'A quote left unanswered gets a gentle nudge at day 2 and a final check-in before it expires, recovering revenue that would otherwise be lost to silence.',
    trigger: 'A quote is sent and stays unaccepted',
    action: 'Send follow-up texts on day 2 and 1 day before expiry',
    tier: 'starter',
    popular: true,
  },
  {
    slug: 'no-show-reschedule',
    name: 'No-Show Auto-Reschedule',
    category: 'Dispatch & Scheduling',
    icon: CalendarClock,
    tagline: 'Fill the gap a no-show leaves in the schedule.',
    description:
      'If a customer no-shows an appointment, they automatically receive a self-serve rescheduling link so the slot gets rebooked without a staff member calling around.',
    trigger: 'An appointment is marked "No-show"',
    action: 'Text the customer a self-reschedule link',
    tier: 'starter',
  },
  {
    slug: 'after-hours-emergency-escalation',
    name: 'After-Hours Emergency Escalation',
    category: 'Dispatch & Scheduling',
    icon: ShieldAlert,
    tagline: 'Route true emergencies to a live human, day or night.',
    description:
      "When the AI receptionist detects emergency language on an after-hours call, it skips the queue and immediately calls or texts the on-call tech instead of waiting for morning.",
    trigger: 'An after-hours call is tagged as an emergency',
    action: 'Call and text the on-call technician immediately',
    tier: 'pro',
    popular: true,
  },
  {
    slug: 'surge-mode-price-alert',
    name: 'Surge Mode Price Alert',
    category: 'Dispatch & Scheduling',
    icon: Flame,
    tagline: 'Let callers know before they book at peak pricing.',
    description:
      'While Surge Mode is active, the AI receptionist proactively mentions the current after-hours rate on the call, cutting down surprise-fee complaints later.',
    trigger: 'Surge Mode is turned on for the business',
    action: "Add the surge rate to the AI receptionist's live call script",
    tier: 'pro',
  },
  {
    slug: 'vip-customer-auto-tag',
    name: 'VIP Customer Auto-Tag',
    category: 'Retention & Loyalty',
    icon: UserCheck,
    tagline: 'Recognize your best customers automatically.',
    description:
      'Customers who cross a lifetime spend or job-count threshold get auto-tagged "VIP", so dispatchers and the AI receptionist can prioritize them without manual bookkeeping.',
    trigger: 'A customer crosses a lifetime spend or job-count threshold',
    action: 'Add the "VIP" tag to the customer record',
    tier: 'pro',
  },
  {
    slug: 'membership-renewal-referral-ask',
    name: 'Renewal Referral Ask',
    category: 'Retention & Loyalty',
    icon: Gift,
    tagline: 'Ask happy, renewing members for a referral.',
    description:
      'The moment a membership auto-renews, the customer gets a short thank-you text with a referral link — the highest-trust moment to ask.',
    trigger: 'A membership plan successfully auto-renews',
    action: 'Send a thank-you + referral-link SMS',
    tier: 'pro',
  },
  {
    slug: 'seasonal-maintenance-reminder',
    name: 'Seasonal Maintenance Reminder',
    category: 'Retention & Loyalty',
    icon: Repeat,
    tagline: 'Bring past customers back before they call a competitor.',
    description:
      'Customers due for seasonal service (HVAC tune-ups, drain checks, etc.) get a reminder text with a one-tap booking link roughly a year after their last matching job.',
    trigger: '~12 months since a matching past job',
    action: 'Send a seasonal reminder with a booking link',
    tier: 'pro',
  },
  {
    slug: 'dnc-auto-suppression',
    name: 'DNC Auto-Suppression',
    category: 'Alerts & Ops',
    icon: Ban,
    tagline: 'Keep every outbound campaign compliant automatically.',
    description:
      'Any number that opts out, complains, or hits the Do-Not-Call list is instantly suppressed across all outbound campaigns and the AI dialer — no manual list-scrubbing.',
    trigger: 'A number opts out or is added to the DNC list',
    action: 'Suppress that number across all outbound campaigns',
    tier: 'starter',
  },
  {
    slug: 'low-csat-auto-escalate',
    name: 'Low Call Satisfaction Auto-Escalate',
    category: 'Alerts & Ops',
    icon: Bell,
    tagline: 'Catch an unhappy caller while it can still be fixed.',
    description:
      'When a call ends with a low satisfaction score, the owner is notified with the call recording attached so the situation can be caught before it becomes a review.',
    trigger: 'A call ends with a low satisfaction score',
    action: 'Notify the owner with the call recording',
    tier: 'pro',
  },
  {
    slug: 'high-value-quote-financing-offer',
    name: 'High-Value Quote Financing Offer',
    category: 'Follow-ups & Sales',
    icon: Landmark,
    tagline: 'Make the "yes" easier on big-ticket quotes.',
    description:
      'Quotes above a chosen dollar amount automatically include a financing option in the follow-up text, removing the most common reason a large quote stalls.',
    trigger: 'A quote is sent above a chosen dollar threshold',
    action: 'Include a financing offer in the quote follow-up',
    tier: 'pro',
  },
  {
    slug: 'insurance-claim-status-update',
    name: 'Insurance Claim Status Update',
    category: 'Alerts & Ops',
    icon: MessageSquareText,
    tagline: 'Keep customers posted without a phone tag.',
    description:
      'Every time an insurance claim tied to a job changes status, the customer gets a short text update automatically, cutting down "any news?" calls to the office.',
    trigger: 'An insurance claim record changes status',
    action: 'Text the customer the new claim status',
    tier: 'pro',
  },
  {
    slug: 'academy-completion-badge',
    name: 'Academy Completion Badge',
    category: 'Alerts & Ops',
    icon: Award,
    tagline: 'Celebrate the team hitting a training milestone.',
    description:
      'When a team member finishes an Academy course, the owner gets a heads-up and the team member is emailed their certificate — no one has to check the Academy dashboard manually.',
    trigger: 'A team member completes an Academy course',
    action: 'Email the certificate and notify the owner',
    tier: 'starter',
  },
];

export const AUTOMATION_CATEGORIES: string[] = [
  'All',
  ...Array.from(new Set(AUTOMATION_TEMPLATES.map((t) => t.category))),
];

export const AUTOMATION_TIER_LABELS: Record<AutomationTier, string> = {
  starter: 'Starter',
  pro: 'Pro',
};

export type AutomationInstallStatus = 'active' | 'paused';

export interface AutomationInstall {
  id: string;
  user_id: string;
  template_slug: string;
  status: AutomationInstallStatus;
  config: Record<string, unknown>;
  installed_at: string;
  updated_at: string;
}

export function findTemplate(slug: string): AutomationTemplate | undefined {
  return AUTOMATION_TEMPLATES.find((t) => t.slug === slug);
}
