import {
  type LucideIcon,
  Zap,
  PhoneMissed,
  FileWarning,
  Undo2,
  Star,
  CreditCard,
  CalendarClock,
  Receipt,
  BadgeAlert,
  PartyPopper,
  Wrench,
  RotateCcw,
  ShieldOff,
  HeartHandshake,
  UserPlus,
  Timer,
  MessageSquareWarning,
  HeartHandshake,
} from 'lucide-react';
import type { WorkflowStepDefinition, WorkflowTriggerEvent } from '@/lib/workflowEngine';

/* ------------------------------------------------------------------ */
/*  workflowPlaybooks â€” the built-in Call-to-Cash step definitions.    */
/*  Curated content, same philosophy as AUTOMATION_TEMPLATES in         */
/*  src/lib/automationMarketplace.ts: shipping a new playbook is a      */
/*  code change, not a migration. "Install" clones one of these into    */
/*  workflow_definitions/workflow_versions for the account via the      */
/*  install_workflow_playbook RPC â€” after that, the business owns and   */
/*  can edit their copy independently of this catalog.                  */
/*                                                                       */
/*  Template variables available to every {{...}} in a step's body are  */
/*  customer_name, customer_phone, customer_email, business_name, plus  */
/*  whatever fields exist on the record that triggered the run (e.g. a  */
/*  quote's valid_until, a job's service_type) â€” see workflow_advance   */
/*  and match_workflow_definitions in the migration for exactly what's  */
/*  copied into context.                                                */
/* ------------------------------------------------------------------ */

export interface WorkflowPlaybook {
  slug: string;
  name: string;
  category: string;
  icon: LucideIcon;
  tagline: string;
  description: string;
  industry: string;
  trigger_event: WorkflowTriggerEvent;
  trigger_conditions: Record<string, unknown>;
  steps: WorkflowStepDefinition[];
}

export const WORKFLOW_PLAYBOOKS: WorkflowPlaybook[] = [
  {
    slug: 'service-recovery-auto-response',
    name: 'Service Recovery Auto-Response',
    category: 'Retention',
    icon: HeartHandshake,
    tagline: 'Apologize before the negative review goes public.',
    description:
      'The moment a service recovery signal is detected — a missed ETA, a broken promise, a negative-sentiment call, or a low private review — the customer automatically gets the drafted apology/update text. Anything flagged for a personal phone call is skipped here and left for staff in the Service Recovery dashboard.',
    industry: 'general',
    trigger_event: 'service_recovery.signal_detected',
    trigger_conditions: {},
    steps: [
      {
        step_number: 1,
        type: 'condition_gate',
        delay_minutes: 0,
        on_failure: 'stop',
        config: { check: 'recommended_channel_not_call' },
      },
      {
        step_number: 2,
        type: 'sms',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { body: '{{recommended_message}}' },
      },
    ],
  },
  {
    slug: 'speed-to-lead-60s',
    name: 'Speed-to-Lead (60 Seconds)',
    category: 'Lead Response',
    icon: Zap,
    tagline: 'The first business to respond usually wins the job.',
    description:
      'The instant a new lead is created, the customer gets an immediate text confirming you got their request. If the lead is still unbooked five minutes later, the AI receptionist calls them directly.',
    industry: 'general',
    trigger_event: 'lead.created',
    trigger_conditions: {},
    steps: [
      {
        step_number: 1,
        type: 'sms',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { body: "Hi {{customer_name}}, thanks for reaching out to {{business_name}}! We got your request and someone will be in touch shortly." },
      },
      {
        step_number: 2,
        type: 'condition_gate',
        delay_minutes: 5,
        on_failure: 'stop',
        config: { check: 'lead_not_progressed' },
      },
      {
        step_number: 3,
        type: 'call',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { call_context: 'speed_to_lead_followup' },
      },
    ],
  },
  {
    slug: 'missed-call-text-back',
    name: 'Missed Call Text-Back & Recovery',
    category: 'Missed Call Recovery',
    icon: PhoneMissed,
    tagline: 'Never lose a caller to voicemail again.',
    description:
      'The moment a call goes unanswered, the caller gets a text so the conversation keeps going. If they still haven\u2019t booked ten minutes later, a callback goes out automatically.',
    industry: 'general',
    trigger_event: 'call.missed',
    trigger_conditions: {},
    steps: [
      {
        step_number: 1,
        type: 'sms',
        delay_minutes: 0,
        on_failure: 'stop',
        config: { body: "Hi, sorry we missed your call at {{business_name}}! Reply here or call us back and we'll get you taken care of right away." },
      },
      {
        step_number: 2,
        type: 'wait',
        delay_minutes: 10,
        on_failure: 'continue',
        config: {},
      },
      {
        step_number: 3,
        type: 'call',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { call_context: 'missed_call_callback' },
      },
    ],
  },
  {
    slug: 'quote-follow-up-close',
    name: 'Quote Follow-Up & Close',
    category: 'Follow-ups & Sales',
    icon: FileWarning,
    tagline: 'Stop letting sent quotes go cold.',
    description:
      'A quote left unanswered gets a friendly nudge two days later, then a final check-in call before it goes stale \u2014 each step re-checks the quote is still pending so a customer who already responded is never bothered again.',
    industry: 'general',
    trigger_event: 'quote.sent',
    trigger_conditions: {},
    steps: [
      {
        step_number: 1,
        type: 'condition_gate',
        delay_minutes: 2880, // 2 days
        on_failure: 'stop',
        config: { check: 'quote_still_pending' },
      },
      {
        step_number: 2,
        type: 'sms',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { body: "Hi {{customer_name}}, just checking in on the quote {{business_name}} sent over \u2014 happy to answer any questions or set up a time to get started." },
      },
      {
        step_number: 3,
        type: 'condition_gate',
        delay_minutes: 4320, // 3 more days
        on_failure: 'stop',
        config: { check: 'quote_still_pending' },
      },
      {
        step_number: 4,
        type: 'call',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { call_context: 'quote_followup_final' },
      },
    ],
  },
  {
    slug: 'quote-declined-winback',
    name: 'Quote Declined Win-Back',
    category: 'Follow-ups & Sales',
    icon: Undo2,
    tagline: 'A declined quote is not always a lost customer.',
    description:
      'When a customer declines a quote, they get one respectful, no-pressure text a day later offering to revisit pricing or financing \u2014 recovering deals that were lost on price alone.',
    industry: 'general',
    trigger_event: 'quote.declined',
    trigger_conditions: {},
    steps: [
      {
        step_number: 1,
        type: 'wait',
        delay_minutes: 1440, // 1 day
        on_failure: 'continue',
        config: {},
      },
      {
        step_number: 2,
        type: 'sms',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { body: "Hi {{customer_name}}, totally understand if the pricing wasn't the right fit. If it'd help, {{business_name}} also offers flexible payment options \u2014 happy to revisit anytime." },
      },
    ],
  },
  {
    slug: 'post-job-review-request',
    name: 'Post-Job Review Request',
    category: 'Reviews & Reputation',
    icon: Star,
    tagline: 'Turn finished jobs into 5-star reviews on autopilot.',
    description:
      'When a job is marked complete, the customer gets a friendly review request timed for when satisfaction is highest, and it automatically checks whether they already left one before asking.',
    industry: 'general',
    trigger_event: 'job.completed',
    trigger_conditions: {},
    steps: [
      {
        step_number: 1,
        type: 'wait',
        delay_minutes: 120, // 2 hours
        on_failure: 'continue',
        config: {},
      },
      {
        step_number: 2,
        type: 'condition_gate',
        delay_minutes: 0,
        on_failure: 'stop',
        config: { check: 'review_not_yet_left' },
      },
      {
        step_number: 3,
        type: 'sms',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { body: "Hi {{customer_name}}, thanks for choosing {{business_name}}! If you have a minute, a quick review would mean a lot to us." },
      },
    ],
  },
  {
    slug: 'estimate-financing-recovery',
    name: 'Estimate Recovery â€” Financing',
    category: 'Estimate-to-Cash Recovery',
    icon: CreditCard,
    tagline: 'A stalled high-value quote is often a cash-flow problem, not a "no".',
    description:
      'When a sizable quote sits unanswered for three days, the customer gets one message about flexible payment options before anyone gives up on the deal.',
    industry: 'general',
    trigger_event: 'quote.financing_needed',
    trigger_conditions: {},
    steps: [
      {
        step_number: 1,
        type: 'condition_gate',
        delay_minutes: 0,
        on_failure: 'stop',
        config: { check: 'quote_still_pending' },
      },
      {
        step_number: 2,
        type: 'sms',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { body: "Hi {{customer_name}}, just following up on your estimate from {{business_name}} \u2014 if budget is a factor, we also offer flexible payment options. Happy to walk you through it." },
      },
      {
        step_number: 3,
        type: 'human_approval',
        delay_minutes: 0,
        on_failure: 'stop',
        config: { reason: 'Approve sending a financing offer link to this customer.' },
      },
      {
        step_number: 4,
        type: 'call',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { call_context: 'financing_offer_followup' },
      },
    ],
  },
  {
    slug: 'estimate-booking-recovery',
    name: 'Estimate Recovery â€” Booking',
    category: 'Estimate-to-Cash Recovery',
    icon: CalendarClock,
    tagline: 'An accepted quote with no job on the calendar is money left on the table.',
    description:
      'The customer already said yes \u2014 this playbook closes the gap between acceptance and an actual scheduled job before the deal goes cold.',
    industry: 'general',
    trigger_event: 'quote.accepted_not_booked',
    trigger_conditions: {},
    steps: [
      {
        step_number: 1,
        type: 'sms',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { body: "Hi {{customer_name}}, thanks for approving your estimate with {{business_name}}! Let's get you on the schedule \u2014 what day works best?" },
      },
      {
        step_number: 2,
        type: 'wait',
        delay_minutes: 720, // 12 hours
        on_failure: 'continue',
        config: {},
      },
      {
        step_number: 3,
        type: 'call',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { call_context: 'booking_recovery_followup' },
      },
    ],
  },
  {
    slug: 'estimate-invoice-recovery',
    name: 'Estimate Recovery â€” Invoicing',
    category: 'Estimate-to-Cash Recovery',
    icon: Receipt,
    tagline: 'A completed job with no invoice is revenue stuck in limbo.',
    description:
      'Flags any completed job still sitting without an invoice a day later, so nothing finished ever quietly goes unbilled.',
    industry: 'general',
    trigger_event: 'job.completed_not_invoiced',
    trigger_conditions: {},
    steps: [
      {
        step_number: 1,
        type: 'human_approval',
        delay_minutes: 0,
        on_failure: 'stop',
        config: { reason: 'This completed job has no invoice yet \u2014 send one now?' },
      },
      {
        step_number: 2,
        type: 'sms',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { body: "Hi {{customer_name}}, thanks again for choosing {{business_name}}! Your invoice is on its way \u2014 reach out anytime with questions." },
      },
    ],
  },
  {
    slug: 'estimate-collection-recovery',
    name: 'Estimate Recovery â€” Collection',
    category: 'Estimate-to-Cash Recovery',
    icon: BadgeAlert,
    tagline: 'An overdue invoice deserves a human check-in, not just another auto-reminder.',
    description:
      'Layers a personal, respectful nudge on top of the existing automated payment reminders once an invoice has been unpaid past the normal collection window.',
    industry: 'general',
    trigger_event: 'invoice.payment_overdue',
    trigger_conditions: {},
    steps: [
      {
        step_number: 1,
        type: 'sms',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { body: "Hi {{customer_name}}, this is a friendly note from {{business_name}} about your outstanding invoice. If anything's holding it up \u2014 a question, a payment plan \u2014 just reply here." },
      },
      {
        step_number: 2,
        type: 'wait',
        delay_minutes: 4320, // 3 days
        on_failure: 'continue',
        config: {},
      },
      {
        step_number: 3,
        type: 'human_approval',
        delay_minutes: 0,
        on_failure: 'stop',
        config: { reason: 'Invoice still unpaid after a gentle nudge \u2014 escalate with a personal call?' },
      },
      {
        step_number: 4,
        type: 'call',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { call_context: 'collection_recovery_call' },
      },
    ],
  },
  {
    slug: 'estimate-parts-unbilled-recovery',
    name: 'Estimate Recovery — Parts Billing Gap',
    category: 'Estimate-to-Cash Recovery',
    icon: Wrench,
    tagline: 'Parts went out on the truck; make sure their value made it onto the invoice.',
    description:
      'Flags a completed, already-invoiced job where the parts actually installed are worth more than what got billed — a quiet markup you never captured.',
    industry: 'general',
    trigger_event: 'job.parts_unbilled',
    trigger_conditions: {},
    steps: [
      {
        step_number: 1,
        type: 'human_approval',
        delay_minutes: 0,
        on_failure: 'stop',
        config: { reason: 'This job\u2019s invoice looks light for the parts installed \u2014 send a supplemental invoice?' },
      },
    ],
  },
  {
    slug: 'service-recovery-eta-missed',
    name: 'Service Recovery — Missed ETA',
    category: 'Service Recovery & Complaint Prevention',
    icon: Timer,
    tagline: 'A late technician doesn\u2019t have to become a bad review.',
    description:
      'The moment a job blows past its promised ETA, the customer gets a proactive apology with a real update — before they start refreshing the tracking page.',
    industry: 'general',
    trigger_event: 'job.eta_missed',
    trigger_conditions: {},
    steps: [
      {
        step_number: 1,
        type: 'sms',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { body: "Hi {{customer_name}}, this is {{business_name}} \u2014 we\u2019re sorry, your technician is running behind schedule. We\u2019re getting you an updated arrival time right now and truly appreciate your patience." },
      },
      {
        step_number: 2,
        type: 'human_approval',
        delay_minutes: 0,
        on_failure: 'stop',
        config: { reason: 'Confirm the updated ETA (or a goodwill credit) before it goes to the customer.' },
      },
      {
        step_number: 3,
        type: 'sms',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { body: "Update from {{business_name}}: your technician now expects to arrive shortly. Thanks again for bearing with us." },
      },
    ],
  },
  {
    slug: 'service-recovery-technician-delayed',
    name: 'Service Recovery — Technician Delay',
    category: 'Service Recovery & Complaint Prevention',
    icon: Timer,
    tagline: 'Tell the customer before they have to ask.',
    description:
      'When a scheduled job runs late before the technician has even left, the customer hears it from you first \u2014 not from an empty driveway.',
    industry: 'general',
    trigger_event: 'job.technician_delayed',
    trigger_conditions: {},
    steps: [
      {
        step_number: 1,
        type: 'condition_gate',
        delay_minutes: 0,
        on_failure: 'stop',
        config: { check: 'job_still_active' },
      },
      {
        step_number: 2,
        type: 'sms',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { body: "Hi {{customer_name}}, {{business_name}} here \u2014 we\u2019re running a little behind on your scheduled visit today. We\u2019ll text your technician\u2019s ETA the moment they\u2019re on the way." },
      },
      {
        step_number: 3,
        type: 'call',
        delay_minutes: 30,
        on_failure: 'continue',
        config: { call_context: 'technician_delay_followup' },
      },
    ],
  },
  {
    slug: 'service-recovery-negative-sentiment',
    name: 'Service Recovery — Negative Sentiment',
    category: 'Service Recovery & Complaint Prevention',
    icon: MessageSquareWarning,
    tagline: 'Catch a frustrated customer while it\u2019s still fixable.',
    description:
      'When AI call analysis flags a negative-sentiment conversation, a manager reviews it and reaches out personally \u2014 before the customer takes it to a public review instead.',
    industry: 'general',
    trigger_event: 'call.negative_sentiment',
    trigger_conditions: {},
    steps: [
      {
        step_number: 1,
        type: 'human_approval',
        delay_minutes: 0,
        on_failure: 'stop',
        config: { reason: 'Review this call before any outreach \u2014 confirm it\u2019s a genuine service issue, not a false positive.' },
      },
      {
        step_number: 2,
        type: 'sms',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { body: "Hi {{customer_name}}, this is {{business_name}} \u2014 we want to make sure your recent experience with us was handled right. A manager would like to give you a quick call, at your convenience." },
      },
      {
        step_number: 3,
        type: 'call',
        delay_minutes: 15,
        on_failure: 'continue',
        config: { call_context: 'negative_sentiment_manager_followup' },
      },
    ],
  },
  {
    slug: 'service-recovery-customer-dispute',
    name: 'Service Recovery — Dispute Resolution',
    category: 'Service Recovery & Complaint Prevention',
    icon: HeartHandshake,
    tagline: 'A flagged dispute gets a human, fast.',
    description:
      'The highest-priority signal in the queue: a staff-flagged dispute skips straight to manager approval and a same-day acknowledgment.',
    industry: 'general',
    trigger_event: 'job.customer_disputed',
    trigger_conditions: {},
    steps: [
      {
        step_number: 1,
        type: 'human_approval',
        delay_minutes: 0,
        on_failure: 'stop',
        config: { reason: 'A dispute was flagged on this job \u2014 confirm the resolution approach before any customer contact.' },
      },
      {
        step_number: 2,
        type: 'sms',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { body: "Hi {{customer_name}}, this is {{business_name}}. We heard about the concern with your recent job and want to make it right \u2014 a manager will call you today." },
      },
      {
        step_number: 3,
        type: 'call',
        delay_minutes: 0,
        on_failure: 'stop',
        config: { call_context: 'dispute_resolution_call' },
      },
    ],
  },
  {
    slug: 'estimate-payment-failed-recovery',
    name: 'Estimate Recovery — Payment Failed',
    category: 'Estimate-to-Cash Recovery',
    icon: CreditCard,
    tagline: 'A declined card is a same-day fix if you catch it fast.',
    description:
      'The moment a charge attempt comes back failed, the customer gets a quick nudge to retry or update their payment method \u2014 before it goes cold.',
    industry: 'general',
    trigger_event: 'invoice.payment_failed',
    trigger_conditions: {},
    steps: [
      {
        step_number: 1,
        type: 'sms',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { body: "Hi {{customer_name}}, your recent payment to {{business_name}} didn't go through. Reply here or call us and we'll get it sorted \u2014 happens to the best cards." },
      },
      {
        step_number: 2,
        type: 'wait',
        delay_minutes: 1440,
        on_failure: 'continue',
        config: {},
      },
      {
        step_number: 3,
        type: 'human_approval',
        delay_minutes: 0,
        on_failure: 'stop',
        config: { reason: 'Payment still hasn\u2019t gone through a day later \u2014 follow up personally?' },
      },
    ],
  },

  {
    slug: 'membership-welcome',
    name: 'Membership Welcome',
    category: 'Membership Lifecycle',
    icon: PartyPopper,
    tagline: 'Get a new member using their plan before the honeymoon wears off.',
    description:
      'The moment a membership goes active, the customer gets a welcome message and, a day later, a nudge to book their first included visit \u2014 members who use the benefit early stick around.',
    industry: 'general',
    trigger_event: 'membership.sold',
    trigger_conditions: {},
    steps: [
      {
        step_number: 1,
        type: 'sms',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { body: "Welcome to {{business_name}}'s membership program, {{customer_name}}! You're all set \u2014 we'll reach out to help schedule your included visits." },
      },
      {
        step_number: 2,
        type: 'wait',
        delay_minutes: 1440, // 1 day
        on_failure: 'continue',
        config: {},
      },
      {
        step_number: 3,
        type: 'call',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { call_context: 'membership_welcome_visit_booking' },
      },
    ],
  },
  {
    slug: 'membership-visit-reminder',
    name: 'Membership Visit Reminder',
    category: 'Membership Lifecycle',
    icon: Wrench,
    tagline: 'An unused benefit is the #1 reason members cancel.',
    description:
      'Halfway through the billing period, a member who hasn\u2019t booked their included visit gets a friendly reminder \u2014 keeping the benefit real keeps the membership real.',
    industry: 'general',
    trigger_event: 'membership.visit_due',
    trigger_conditions: {},
    steps: [
      {
        step_number: 1,
        type: 'sms',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { body: "Hi {{customer_name}}, just a reminder that your {{business_name}} membership includes a visit you haven't used yet this period \u2014 want to grab a time?" },
      },
      {
        step_number: 2,
        type: 'wait',
        delay_minutes: 4320, // 3 days
        on_failure: 'continue',
        config: {},
      },
      {
        step_number: 3,
        type: 'call',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { call_context: 'membership_visit_booking_followup' },
      },
    ],
  },
  {
    slug: 'membership-renewal-reminder',
    name: 'Membership Renewal Follow-Up',
    category: 'Membership Lifecycle',
    icon: RotateCcw,
    tagline: "Don't let a forgotten renewal invoice quietly lapse into churn.",
    description:
      'The renewal invoice itself goes out immediately when it\u2019s due; this playbook follows up three days later on anyone who still hasn\u2019t paid, before it ever reaches dunning.',
    industry: 'general',
    trigger_event: 'membership.renewal_upcoming',
    trigger_conditions: {},
    steps: [
      {
        step_number: 1,
        type: 'wait',
        delay_minutes: 4320, // 3 days
        on_failure: 'continue',
        config: {},
      },
      {
        step_number: 2,
        type: 'sms',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { body: "Hi {{customer_name}}, just checking in \u2014 your {{business_name}} membership renewal is ready whenever you get a chance. Let us know if you have any questions!" },
      },
    ],
  },
  {
    slug: 'membership-payment-failed',
    name: 'Membership Payment Recovery',
    category: 'Membership Lifecycle',
    icon: ShieldOff,
    tagline: 'A failed card is usually an accident, not a decision to leave.',
    description:
      'When a renewal payment doesn\u2019t go through, the member gets a clear, low-pressure heads-up with time to fix it before the membership lapses.',
    industry: 'general',
    trigger_event: 'membership.payment_failed',
    trigger_conditions: {},
    steps: [
      {
        step_number: 1,
        type: 'sms',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { body: "Hi {{customer_name}}, we weren't able to process your {{business_name}} membership renewal. No rush \u2014 just reply or use your original payment link whenever you get a chance." },
      },
      {
        step_number: 2,
        type: 'wait',
        delay_minutes: 10080, // 7 days
        on_failure: 'continue',
        config: {},
      },
      {
        step_number: 3,
        type: 'call',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { call_context: 'membership_payment_recovery_call' },
      },
    ],
  },
  {
    slug: 'membership-churn-risk-save',
    name: 'Membership Save Offer',
    category: 'Membership Lifecycle',
    icon: HeartHandshake,
    tagline: 'Catch a quiet member before they cancel, not after.',
    description:
      'A member who\u2019s paid for months without using their included visit is flagged before renewal \u2014 this playbook gets them scheduled, with an optional human-approved save offer for anyone still at risk.',
    industry: 'general',
    trigger_event: 'membership.churn_risk',
    trigger_conditions: {},
    steps: [
      {
        step_number: 1,
        type: 'sms',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { body: "Hi {{customer_name}}, you've got an included visit still available on your {{business_name}} membership \u2014 want to use it before your next renewal?" },
      },
      {
        step_number: 2,
        type: 'human_approval',
        delay_minutes: 2880, // 2 days
        on_failure: 'stop',
        config: { reason: 'Still unused close to renewal \u2014 approve a retention offer for this member?' },
      },
      {
        step_number: 3,
        type: 'sms',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { body: "Hi {{customer_name}}, we noticed you haven't had a chance to use your membership visit \u2014 we'd love to make it easy for you. Reply here and we'll get you taken care of." },
      },
    ],
  },
  {
    slug: 'membership-winback',
    name: 'Membership Win-Back',
    category: 'Membership Lifecycle',
    icon: UserPlus,
    tagline: 'A lapsed member already trusted you once.',
    description:
      'A respectful, no-pressure re-offer a week after a membership churns or is cancelled \u2014 recovering members who lapsed on payment or timing, not dissatisfaction.',
    industry: 'general',
    trigger_event: 'membership.churned',
    trigger_conditions: {},
    steps: [
      {
        step_number: 1,
        type: 'wait',
        delay_minutes: 10080, // 7 days
        on_failure: 'continue',
        config: {},
      },
      {
        step_number: 2,
        type: 'sms',
        delay_minutes: 0,
        on_failure: 'continue',
        config: { body: "Hi {{customer_name}}, we noticed your {{business_name}} membership lapsed \u2014 no hard feelings! If you'd like to pick it back up, just reply here." },
      },
    ],
  },
];

export function findPlaybook(slug: string): WorkflowPlaybook | undefined {
  return WORKFLOW_PLAYBOOKS.find((p) => p.slug === slug);
}
