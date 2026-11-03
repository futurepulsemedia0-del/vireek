// supabase/functions/_shared/playbooks/catalogOps.ts — business-state playbooks.
import { advisory, capacity, closure, escalate, script, surge, template } from './builders.ts';
import type { Playbook } from './types.ts';

export const VACATION_CLOSED: Playbook = {
  key: 'vacation-closed', version: 1, name: 'Vacation / Closed Mode', tagline: 'Close routine booking cleanly while emergencies still reach you.',
  trades: ['all'], seasons: ['any'], goals: ['continuity'],
  summary: 'Marks the window closed, tells callers when you return, and keeps emergency routing on.',
  whenToUse: 'Planned shutdowns or owner vacations. Set the start and end dates when you schedule it.',
  trigger: {},
  defaultDurationHours: 24 * 7, maxDurationHours: 24 * 45,
  rollback: 'Removes the closure dates this playbook added and restores scripts, capacity and surge settings.',
  items: [
    closure('vacation-closure', 'Mark each day in the window as closed', 'Blocks routine online booking and tells the AI receptionist the business is closed on those dates.',
      'Closed', 'We are closed until %END_DATE%. For emergencies, please follow the prompts.'),
    script('after-hours-vacation', 'Closed-period call script', 'Callers need a clear return date and an emergency path.', 'after_hours',
      'Thanks for calling. We are closed right now.',
      'Say clearly that the business is closed until %END_DATE%. Offer to take a name, callback number and a short description so someone can call back after the return date. If the caller reports an emergency (gas smell, fire, active flooding, electrical hazard, no heat in freezing weather), tell them to call 911 or the utility first, then follow the emergency flow so the owner is alerted.'),
    surge('vacation-surge', 'Closed banner message', 'Customer-facing notice.',
      { message: 'We are closed until %END_DATE%. Emergencies are still monitored.', priority: 'Emergencies only until %END_DATE%.' }),
    escalate('vacation-emergency-sms', 'Emergency alert to owner', 'Emergency detection never turns off, even when closed.',
      { trigger: 'emergency', action: 'sms', note: 'Closed mode: emergency call' }),
    template('vacation-sms', 'Closure announcement (SMS draft)', 'Customers hate surprises.',
      { channel: 'sms', category: 'service_update', name: 'We are closed until return date',
        body: '{{business_name}}: We are closed until %END_DATE%. We will respond to routine requests when we return. For emergencies, call us and follow the prompts.' }),
    advisory('vacation-ads', 'Pause ads while closed', 'Paying for clicks you cannot serve wastes money.',
      { area: 'ads', action: 'pause', detail: 'Pause paid campaigns for the closure window. Requires your approval; Vireek does not change ad budgets automatically.' }),
  ],
  impact: [
    { metric: 'Unanswered-caller complaints', lowPct: -60, highPct: -30, assumptions: ['Callers hear the return date from the AI receptionist'] },
    { metric: 'Wasted ad spend', lowPct: -100, highPct: -50, assumptions: ['Ad pause is approved and applied by you'] },
  ],
  compliance: ['Emergency detection and owner alerts stay on.'],
};

export const GRAND_OPENING: Playbook = {
  key: 'grand-opening', version: 1, name: 'Grand Opening', tagline: 'Launch with a strong first impression and a reviews flywheel.',
  trades: ['all'], seasons: ['any'], goals: ['reputation', 'capture_demand'],
  summary: 'Equips a new business or new location to answer consistently, announce itself and collect early reviews.',
  whenToUse: 'First 30 to 60 days of a new business or new location.',
  trigger: {},
  defaultDurationHours: 24 * 30, maxDurationHours: 24 * 60,
  rollback: 'Restores prior scripts and capacity; template drafts are archived.',
  items: [
    script('new-inquiry-opening', 'New-business intake script', 'First impressions are scarce.', 'new_inquiry',
      'Thanks for calling. We are new in your area and would love to help.',
      'Welcome the caller warmly and ask how they heard about us so we learn which channels work. Ask what they need, collect the address, and offer the first available appointment. Do not invent opening discounts; only mention a promotion that exists in the knowledge base.'),
    capacity('opening-capacity', 'Open slots for launch', 'New businesses need to say yes to early work.',
      { maxSlotsScalePct: 15, waitlistEnabled: true }),
    template('opening-announce-sms', 'Opening announcement (SMS draft)', 'Tells your first contacts you are open.',
      { channel: 'sms', category: 'marketing', name: 'Grand opening announcement',
        body: '{{business_name}} is now open and taking appointments. Reply or call to book. Reply STOP to opt out.' }),
    template('opening-review-sms', 'Early review request (SMS draft)', 'The first reviews matter most.',
      { channel: 'sms', category: 'review_request', name: 'Early review request',
        body: '{{business_name}}: Thanks for being one of our first customers. If you are happy with the work, a short review would mean a lot.' }),
    advisory('opening-gbp', 'Google Business Profile', 'Local visibility starts here.',
      { area: 'marketing', detail: 'Complete your Google Business Profile (hours, service area, photos, services) and post the opening announcement.' }),
    advisory('opening-ads', 'Ads: launch boost', 'Modest paid reach builds early volume.',
      { area: 'ads', action: 'boost', boostPct: 15, detail: 'Run a modest local campaign for the first weeks. Requires your approval.' }),
    advisory('opening-followup', 'Follow-up cadence', 'Early customers become your referral base.',
      { area: 'followup', detail: 'Request a review within 24 hours of every completed job and ask satisfied customers for a referral after 7 days.' }),
  ],
  impact: [
    { metric: 'First-30-day bookings', lowPct: 10, highPct: 35, assumptions: ['You announce to a list of at least 100 contacts', 'A new profile and phone number are active'] },
    { metric: 'Reviews collected', lowPct: 20, highPct: 60, assumptions: ['Review requests are sent after every completed job'] },
  ],
  compliance: ['Marketing SMS must include opt-out language (enforced in template review).'],
};
