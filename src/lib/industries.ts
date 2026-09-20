import { Flame, Droplets, Home, Zap, Wind, KeyRound, Bug, Trees, Sparkles, Waves, Wrench, Sun, PaintRoller, type LucideIcon } from 'lucide-react';

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
  {
    slug: 'locksmith',
    name: 'Locksmith',
    audience: 'locksmith companies',
    icon: KeyRound,
    tagline: 'Lockouts and emergencies don\'t wait. Your receptionist shouldn\'t either.',
    terms: ['Lockouts', 'rekeying', 'key replacement', 'safe opening', 'ignition', 'security upgrades'],
    painPoints: [
      'Lockout calls are urgent — customers need immediate reassurance and fast ETA, not voicemail.',
      'After-hours emergencies are the highest-value jobs but the hardest to capture without 24/7 coverage.',
      'Distinguishing a genuine emergency from a routine key copy wastes dispatcher time.',
    ],
    capabilities: [
      'Answers instantly, 24/7, capturing the lock type, location, and urgency level.',
      'Flags lockout and security emergencies for immediate dispatch.',
      'Books non-emergency appointments like rekeying and security upgrades directly to your calendar.',
    ],
    faq: [
      {
        q: 'Can Vireek handle after-hours lockout emergencies?',
        a: 'Yes. Vireek answers 24/7, captures the customer\'s location and situation, and triggers your escalation path so your on-call tech is notified immediately.',
      },
    ],
  },
  {
    slug: 'pest-control',
    name: 'Pest Control',
    audience: 'pest control companies',
    icon: Bug,
    tagline: 'Infestation calls come in scared and urgent. Sarah never leaves them on hold.',
    terms: ['Termites', 'rodents', 'bed bugs', 'ants', 'wasps', 'recurring treatment plans'],
    painPoints: [
      'A caller who just found termites or bed bugs wants reassurance immediately, not a callback tomorrow.',
      'Recurring quarterly treatment plans generate a steady stream of rescheduling calls that eat office time.',
      'Seasonal spikes (spring ants, fall rodents) overwhelm phone lines exactly when technicians are booked solid.',
    ],
    capabilities: [
      'Answers instantly and asks the right triage questions (pest type, severity, occupied vs. vacant property).',
      'Books initial inspections and recurring treatment visits straight onto your calendar.',
      'Flags urgent infestations (active bed bugs, structural termite damage) for same-day follow-up.',
    ],
    faq: [
      {
        q: 'Can it tell the difference between a routine quarterly visit and an urgent infestation?',
        a: 'Yes. Vireek is configured with your escalation rules so language indicating an active or severe infestation is flagged for priority scheduling, while routine treatment renewals are booked normally.',
      },
      {
        q: 'Does it know pest control terminology?',
        a: 'Yes. Vireek is set up with trade-specific vocabulary for common pests and treatment types so callers do not have to over-explain their situation.',
      },
    ],
  },
  {
    slug: 'lawn-care',
    name: 'Lawn Care & Landscaping',
    audience: 'lawn care and landscaping companies',
    icon: Trees,
    tagline: 'Spring rush fills your voicemail. Sarah keeps every call moving instead.',
    terms: ['Mowing', 'fertilization', 'aeration', 'landscape design', 'irrigation', 'seasonal cleanup'],
    painPoints: [
      'Spring and fall bring a flood of new-customer calls that a small office team cannot answer fast enough.',
      'Recurring maintenance customers call constantly to reschedule around weather, tying up the phone.',
      'Estimate requests for landscape design projects get lost in the same queue as a simple mowing signup.',
    ],
    capabilities: [
      'Answers every call during your busiest seasons without hold times or voicemail.',
      'Captures property size, service type, and frequency to route recurring vs. one-time requests correctly.',
      'Books mowing and maintenance visits directly, and flags larger design/install jobs for a callback with details already collected.',
    ],
    faq: [
      {
        q: 'Can it handle the seasonal call spike in spring?',
        a: 'Yes. Because Vireek answers every call instantly regardless of volume, seasonal surges do not create hold times, missed calls, or a backlog of voicemails to return.',
      },
      {
        q: 'Can it separate a simple mowing signup from a landscape design estimate?',
        a: 'Yes. Vireek captures the service type and scope up front so simple recurring services get booked immediately while larger design requests are routed to your estimating process.',
      },
    ],
  },
  {
    slug: 'cleaning',
    name: 'Cleaning Services',
    audience: 'residential and commercial cleaning companies',
    icon: Sparkles,
    tagline: 'New-client calls and reschedules never stop. Sarah handles both without missing a beat.',
    terms: ['Recurring cleaning', 'move-out cleaning', 'deep cleaning', 'commercial contracts', 'rescheduling'],
    painPoints: [
      'New-client inquiries often come in during active cleaning jobs, when no one is near a phone.',
      'Recurring clients call constantly to reschedule or skip a visit, and each one takes office time.',
      'Commercial contract inquiries need different handling than a one-time residential deep clean.',
    ],
    capabilities: [
      'Answers instantly whether your team is mid-job or off for the day.',
      'Captures property size, service type, and frequency to quote and book new recurring clients.',
      'Handles reschedule and skip-a-visit requests directly against your calendar.',
    ],
    faq: [
      {
        q: 'Can it quote a recurring cleaning plan on the call?',
        a: 'Yes. Vireek is configured with your pricing so it can give an estimate based on square footage and frequency, then book the first visit.',
      },
      {
        q: 'Can existing clients reschedule without waiting for a callback?',
        a: 'Yes. Vireek looks up the existing booking and rebooks it against your real availability in the same call.',
      },
    ],
  },
  {
    slug: 'pool-service',
    name: 'Pool Service',
    audience: 'pool cleaning and repair companies',
    icon: Waves,
    tagline: 'Green pools and broken equipment cannot wait for a callback. Neither should you make them.',
    terms: ['Green pool', 'equipment repair', 'weekly maintenance', 'opening/closing', 'leak detection'],
    painPoints: [
      'A green or unsafe pool is an urgent call that competitors will answer if you do not.',
      'Weekly maintenance customers call often about scheduling, which pulls staff off routes.',
      'Equipment failures (pumps, heaters, filters) need fast triage to know if it is a same-day dispatch.',
    ],
    capabilities: [
      'Answers instantly and triages urgent issues like green or unsafe water from routine maintenance questions.',
      'Books weekly service signups and one-time repair visits directly onto your calendar.',
      'Flags equipment failures that need same-day dispatch based on your escalation rules.',
    ],
    faq: [
      {
        q: 'Can it tell a green pool emergency from a routine question?',
        a: 'Yes. Vireek is configured with your escalation rules so urgent water-quality or safety issues are flagged for priority scheduling.',
      },
      {
        q: 'Can it handle seasonal opening and closing requests?',
        a: 'Yes. Vireek books seasonal opening and closing appointments the same way it books routine service, based on your real availability.',
      },
    ],
  },
  {
    slug: 'appliance-repair',
    name: 'Appliance Repair',
    audience: 'appliance repair companies',
    icon: Wrench,
    tagline: 'A dead fridge or washer is urgent to the customer. Sarah treats it that way.',
    terms: ['Refrigerator repair', 'washer/dryer', 'dishwasher', 'oven/range', 'warranty service'],
    painPoints: [
      'A broken refrigerator is a same-day emergency to the customer, even if it is routine to your team.',
      'Diagnosing the likely issue and brand/model over the phone takes time your office staff does not have.',
      'Warranty and non-warranty calls need different handling but often get mixed together.',
    ],
    capabilities: [
      'Answers instantly and captures appliance type, brand, symptom, and warranty status.',
      'Books diagnostic and repair visits directly onto your calendar based on real availability.',
      'Flags high-urgency situations like a fridge full of spoiling food for faster scheduling.',
    ],
    faq: [
      {
        q: 'Can it capture the appliance brand and model over the phone?',
        a: 'Yes. Vireek asks the same qualifying questions a trained dispatcher would, so your technician arrives with the right information.',
      },
      {
        q: 'Can it separate warranty calls from paid service calls?',
        a: 'Yes. Vireek captures warranty status on the call and routes the booking accordingly.',
      },
    ],
  },
  {
    slug: 'solar',
    name: 'Solar',
    audience: 'solar installation and service companies',
    icon: Sun,
    tagline: 'Every missed call is a missed install lead. Sarah answers every one.',
    terms: ['New installation', 'system monitoring alerts', 'inverter issues', 'maintenance', 'warranty claims'],
    painPoints: [
      'New-install leads are high-value and time-sensitive — a slow callback often means a lost sale to a competitor.',
      'Existing customers call about monitoring alerts or production drops and need quick triage.',
      'Sales inquiries and service/warranty calls need to be routed very differently.',
    ],
    capabilities: [
      'Answers instantly and separates new-install sales inquiries from existing-customer service needs.',
      'Captures property and system details up front so your sales or service team gets a qualified handoff.',
      'Books site assessments and service visits directly onto your calendar.',
    ],
    faq: [
      {
        q: 'Can it separate a new sales lead from an existing customer service call?',
        a: 'Yes. Vireek asks early qualifying questions to route new-install inquiries to sales and existing-system issues to service, so neither gets stuck in the wrong queue.',
      },
      {
        q: 'Can it handle warranty and monitoring-alert calls?',
        a: 'Yes. Vireek captures system details and the nature of the issue, then books a service visit or escalates according to your rules.',
      },
    ],
  },
  {
    slug: 'painting',
    name: 'Painting',
    audience: 'painting companies',
    icon: PaintRoller,
    tagline: 'Estimate requests pile up fast. Sarah captures every one, day or night.',
    terms: ['Interior painting', 'exterior painting', 'cabinet refinishing', 'commercial painting', 'estimates'],
    painPoints: [
      'Estimate requests are the lifeblood of a painting business, and a missed call is a lost bid opportunity.',
      'Crews are on job sites all day and cannot answer new-lead calls during work hours.',
      'Residential and commercial inquiries need different qualifying questions but often get handled the same way.',
    ],
    capabilities: [
      'Answers instantly while your crews are on-site, capturing project scope, square footage, and timeline.',
      'Books in-person estimate appointments directly onto your calendar.',
      'Separates residential from commercial inquiries so each gets routed and qualified correctly.',
    ],
    faq: [
      {
        q: 'Can it capture enough detail for a useful estimate appointment?',
        a: 'Yes. Vireek asks about project scope, rooms or square footage, and timeline so your estimator arrives prepared instead of starting from scratch.',
      },
      {
        q: 'Can it handle commercial painting inquiries differently from residential?',
        a: 'Yes. Vireek is configured to ask different qualifying questions for commercial projects and route them accordingly.',
      },
    ],
  },
];

export function getIndustryBySlug(slug: string | undefined): Industry | undefined {
  return INDUSTRIES.find((i) => i.slug === slug);
}
