import {
  type LucideIcon,
  Zap,
  PhoneMissed,
  FileWarning,
  Undo2,
  Star,
} from 'lucide-react';
import type { WorkflowStepDefinition, WorkflowTriggerEvent } from '@/lib/workflowEngine';

/* ------------------------------------------------------------------ */
/*  workflowPlaybooks — the built-in Call-to-Cash step definitions.    */
/*  Curated content, same philosophy as AUTOMATION_TEMPLATES in         */
/*  src/lib/automationMarketplace.ts: shipping a new playbook is a      */
/*  code change, not a migration. "Install" clones one of these into    */
/*  workflow_definitions/workflow_versions for the account via the      */
/*  install_workflow_playbook RPC — after that, the business owns and   */
/*  can edit their copy independently of this catalog.                  */
/*                                                                       */
/*  Template variables available to every {{...}} in a step's body are  */
/*  customer_name, customer_phone, customer_email, business_name, plus  */
/*  whatever fields exist on the record that triggered the run (e.g. a  */
/*  quote's valid_until, a job's service_type) — see workflow_advance   */
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
];

export function findPlaybook(slug: string): WorkflowPlaybook | undefined {
  return WORKFLOW_PLAYBOOKS.find((p) => p.slug === slug);
}
