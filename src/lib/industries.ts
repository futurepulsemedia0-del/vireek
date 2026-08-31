import { Flame, Droplets, Home, Zap, Wind, type LucideIcon } from 'lucide-react';

export interface IndustryFAQ {
  q: string;
  a: string;
}

export interface Industry {
  slug: string;
  name: string;
  /** Short plural used in headings, e.g. "plumbers", "HVAC teams" */
  audience: string;
  icon: LucideIcon;
  tagline: string;
  /** Common call reasons — reused from the homepage Industries section */
  terms: string[];
  /** Pain points this trade specifically deals with */
  painPoints: string[];
  /** How Vireek handles calls for this trade, specifically */
  capabilities: string[];
  faq: IndustryFAQ[];
}

export const INDUSTRIES: Industry[] = [
  {
    slug: 'hvac',
    name: 'HVAC',
    audience: 'HVAC companies',
    icon: Wind,
    tagline: 'Never lose a no-heat or no-cool call to voicemail again.',
    terms: ['AC repair', 'furnace issues', 'heat pumps', 'no heat', 'no cool', 'thermostat problems'],
    painPoints: [
      'No-heat and no-cool calls spike exactly when your team is already slammed on a job.',
      'After-hours emergency calls go to voicemail and the customer calls a competitor instead.',
      'Dispatchers waste time on calls that turn out to be simple filter or thermostat questions.',
    ],
    capabilities: [
      'Answers every call day or night and asks the right triage questions (system type, symptoms, how long it\u2019s been out).',
      'Books service appointments directly onto your calendar based on your real availability.',
      'Flags true no-heat/no-cool emergencies for immediate dispatch instead of sitting in a queue.',
    ],
    faq: [
      {
        q: 'Can it tell the difference between an emergency and a routine maintenance call?',
        a: 'Yes. Vireek is configured with your escalation rules, so language indicating no heat, no cooling, or safety concerns is flagged for immediate follow-up, while routine requests are booked normally.',
      },
      {
        q: 'Does it know basic HVAC terminology?',
        a: 'Yes. Vireek is set up with HVAC-specific vocabulary — heat pumps, furnaces, thermostats, refrigerant, ductwork — so callers don\u2019t have to explain themselves twice.',
      },
      {
        q: 'Can it handle seasonal call spikes?',
        a: 'Yes. Because Vireek answers every call instantly regardless of volume, seasonal surges (first heat wave, first cold snap) don\u2019t create hold times or missed calls.',
      },
    ],
  },
  {
    slug: 'plumbing',
    name: 'Plumbing',
    audience: 'plumbing companies',
    icon: Droplets,
    tagline: 'Burst pipes don\u2019t wait for business hours. Neither should your receptionist.',
    terms: ['Burst pipes', 'leaks', 'drain cleaning', 'water heaters', 'sewer backup', 'low pressure'],
    painPoints: [
      'A burst pipe at 2am is either an answered call and a loyal customer, or a missed call and a Google review.',
      'Office staff spend hours a week just relaying appointment requests instead of running the business.',
      'Low-priority calls (a running toilet) and true emergencies (sewer backup) get treated the same way.',
    ],
    capabilities: [
      'Picks up instantly, 24/7, so emergency leaks and backups get triaged the moment they happen.',
      'Captures address, issue, and urgency, then books or escalates based on your rules.',
      'Syncs every call and booking straight into your CRM — no manual re-entry.',
    ],
    faq: [
      {
        q: 'Can Vireek prioritize a sewer backup over a slow drain?',
        a: 'Yes. You define what counts as urgent, and Vireek routes those calls for immediate dispatch while booking non-urgent requests into your normal schedule.',
      },
      {
        q: 'Will callers know they\u2019re not talking to a person?',
        a: 'Vireek is upfront and conversational, and is built to gather the same details a trained dispatcher would — without hold music or a full voicemail box.',
      },
    ],
  },
  {
    slug: 'roofing',
    name: 'Roofing',
    audience: 'roofing companies',
    icon: Home,
    tagline: 'Storm season floods your phone lines. Vireek never gets overwhelmed.',
    terms: ['Leak repair', 'storm damage', 'missing shingles', 'gutter issues', 'flashing', 'ice dams'],
    painPoints: [
      'After a storm, call volume can 10x overnight — and every missed call is a lead going to a competitor.',
      'Insurance-related calls need specific details captured accurately the first time.',
      'Sales and field teams can\u2019t answer phones while they\u2019re on a roof.',
    ],
    capabilities: [
      'Handles unlimited simultaneous calls, so a storm surge never means a busy signal.',
      'Captures damage details and contact info consistently, ready for your estimating team.',
      'Books inspection appointments automatically based on real crew availability.',
    ],
    faq: [
      {
        q: 'Can it handle a sudden spike in calls after a storm?',
        a: 'Yes — this is one of the biggest reasons roofing companies use Vireek. It answers every call simultaneously with no hold queue, no matter how many come in at once.',
      },
    ],
  },
  {
    slug: 'electrical',
    name: 'Electrical',
    audience: 'electrical contractors',
    icon: Zap,
    tagline: 'From flickering lights to a dead panel, every call gets answered.',
    terms: ['Power issues', 'breaker problems', 'flickering lights', 'panel upgrades', 'GFCI'],
    painPoints: [
      'Safety-related calls (sparking outlets, burning smells) need to be flagged and escalated immediately.',
      'Estimate requests for panel upgrades often come in after hours when the office is closed.',
      'Techs in the field can\u2019t stop to answer the phone mid-job.',
    ],
    capabilities: [
      'Recognizes safety-critical language and escalates it immediately per your rules.',
      'Books estimates and service calls straight onto your calendar, any time of day.',
      'Gives you a clean, searchable log of every call and outcome.',
    ],
    faq: [
      {
        q: 'Does it recognize an electrical emergency versus a routine request?',
        a: 'Yes. You configure the trigger language (sparking, burning smell, no power) and Vireek escalates those calls immediately instead of just booking a normal appointment.',
      },
    ],
  },
  {
    slug: 'restoration',
    name: 'Restoration',
    audience: 'restoration companies',
    icon: Flame,
    tagline: 'Water and fire damage calls are always urgent. Vireek treats them that way.',
    terms: ['Flood extraction', 'structural drying', 'smoke damage', 'mold remediation', 'board-up'],
    painPoints: [
      'Restoration calls are almost always time-sensitive — every hour of delay can mean more damage.',
      'Insurance claims require accurate, consistently captured information from the first call.',
      'Crews are on active job sites and can\u2019t staff a 24/7 phone line themselves.',
    ],
    capabilities: [
      'Answers immediately, any hour, and captures the details your crew needs before they even arrive.',
      'Flags active flooding, fire damage, or safety hazards for instant dispatch.',
      'Keeps a full record of every call for insurance and follow-up purposes.',
    ],
    faq: [
      {
        q: 'Can Vireek dispatch a crew immediately for active flooding?',
        a: 'Vireek captures the details and triggers your defined escalation path (SMS, call transfer, or team alert) so your on-call crew is notified right away.',
      },
    ],
  },
];

export function getIndustryBySlug(slug: string | undefined): Industry | undefined {
  return INDUSTRIES.find((i) => i.slug === slug);
}
