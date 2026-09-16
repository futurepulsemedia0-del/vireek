/**
 * Vertical-Specific AI Playbooks — client library.
 *
 * A playbook is a curated, trade-specific starter pack: triage questions,
 * emergency-detection language, common services, and upsell prompts for
 * one vertical (HVAC, plumbing, roofing, electrical, restoration,
 * locksmith — matching the slugs in `lib/industries.ts`).
 *
 * "Applying" a playbook does NOT invent a new AI pipeline. It writes real
 * rows into `knowledge_articles` (source: 'playbook', audience: 'ai',
 * status: 'published') — the exact table the phone assistant already
 * searches via supabase/functions/_shared/knowledge/search.ts. That's the
 * whole mechanism: a fast, high-quality way to seed the knowledge base
 * this account already has, not a parallel system.
 *
 * Applying a playbook never overwrites anything the tenant already wrote:
 * - `services_offered` is merged (union), not replaced.
 * - `primary_industry` is only set if it was empty.
 * - `greeting_script` is never touched — the suggested greeting is shown
 *   in the UI for the owner to copy into Assistant settings themselves.
 *
 * Server counterpart: supabase/migrations/20260923000000_vertical_ai_playbooks.sql
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export interface PlaybookArticle {
  title: string;
  /** The spoken answer — what the AI reads out. Keep it short. */
  summary: string;
  /** Longer version, for the Knowledge Base editor / human readers. */
  body: string;
  category: string;
  keywords: string[];
}

export interface Playbook {
  slug: string;
  name: string;
  tagline: string;
  triageQuestions: string[];
  emergencyKeywords: string[];
  emergencyGuidance: string;
  commonServices: string[];
  upsellPrompts: string[];
  suggestedGreeting: string;
  articles: PlaybookArticle[];
}

export interface PlaybookApplication {
  id: string;
  user_id: string;
  playbook_slug: string;
  articles_created: number;
  applied_at: string;
  created_at: string;
}

export interface PlaybookState {
  activePlaybookSlug: string | null;
  activePlaybookAppliedAt: string | null;
  businessProfileId: string | null;
  history: PlaybookApplication[];
}

export interface ApplyPlaybookResult {
  articlesCreated: number;
  servicesAdded: number;
}

// ============================================================
// PLAYBOOK CONTENT
// ============================================================

export const PLAYBOOKS: Playbook[] = [
  {
    slug: 'hvac',
    name: 'HVAC',
    tagline: 'No-heat, no-cool triage and seasonal call handling.',
    triageQuestions: [
      'Is the system making any unusual noise, smell, or smoke?',
      'What type of system is it — furnace, heat pump, mini-split, or central AC?',
      'How long has it been out, and is anyone in the home elderly, an infant, or medically vulnerable?',
      'Is this a total loss of heat/cooling, or is it just not keeping up?',
      'When was the system last serviced?',
    ],
    emergencyKeywords: ['no heat', 'no cool', 'no ac', 'gas smell', 'burning smell', 'smoke', 'carbon monoxide', 'co alarm', 'elderly', 'infant', 'medical'],
    emergencyGuidance:
      'Treat any gas smell, burning smell, smoke, or CO alarm as an immediate safety emergency — advise the caller to leave the property and call 911 or the gas company before anything else, then flag for urgent human follow-up. Total no-heat/no-cool with a vulnerable occupant (elderly, infant, medical condition) or during extreme outdoor temperatures is a same-day priority, not a routine booking.',
    commonServices: ['No-heat repair', 'No-cool repair', 'AC tune-up', 'Furnace tune-up', 'Duct inspection', 'Thermostat installation', 'Refrigerant check', 'New system installation'],
    upsellPrompts: [
      'Mention the seasonal maintenance plan when booking any repair — it prevents the same breakdown next season.',
      'If the system is over 12 years old, gently note that a repair quote will include a comparison to replacement cost.',
      'Ask about duct or air-quality concerns when booking a tune-up; a lot of "AC isn\'t keeping up" calls are actually duct issues.',
    ],
    suggestedGreeting:
      "Thanks for calling — I can help get your heating or cooling taken care of. Is this for a repair, a tune-up, or something else today?",
    articles: [
      {
        title: 'How do you handle a no-heat or no-cool emergency call?',
        summary: 'No heat or no cool is treated as urgent, especially for elderly, infant, or medically vulnerable occupants — we prioritize same-day dispatch.',
        body: 'A total loss of heating or cooling is treated as a priority call, not a routine booking. If anyone in the home is elderly, an infant, or has a medical condition, or if outdoor temperatures are extreme, this is escalated for same-day dispatch. Any report of a gas smell, burning smell, smoke, or a CO alarm going off is a safety emergency — the caller should be advised to leave the property and contact 911 or the gas utility immediately, separate from booking a technician.',
        category: 'Emergency Handling',
        keywords: ['no heat', 'no cool', 'no ac', 'emergency', 'gas smell', 'carbon monoxide'],
      },
      {
        title: 'What information do you need before booking an HVAC service call?',
        summary: 'We ask what type of system it is, what symptoms you\'re seeing, how long it\'s been out, and when it was last serviced.',
        body: 'Before booking, we typically confirm: the system type (furnace, heat pump, mini-split, or central AC), any unusual noise, smell, or smoke, how long the issue has been going on, whether it\'s a total loss or the system just isn\'t keeping up, and when it was last serviced. This lets the technician arrive with the right parts and diagnostic approach instead of a blind visit.',
        category: 'Booking',
        keywords: ['triage', 'booking', 'diagnostic', 'system type'],
      },
      {
        title: 'Do you offer a seasonal maintenance plan?',
        summary: 'Yes — a seasonal tune-up plan is available and is worth mentioning any time a customer books a repair, since regular maintenance prevents most breakdowns.',
        body: 'A seasonal maintenance plan covering both the furnace and AC tune-up is available. It\'s worth raising this any time a customer books a repair call, since most no-heat/no-cool breakdowns are preventable with regular maintenance. The exact pricing and plan tiers should be confirmed against the current price book rather than quoted from memory.',
        category: 'Services',
        keywords: ['maintenance plan', 'tune-up', 'seasonal', 'upsell'],
      },
      {
        title: 'How old does a system need to be before you recommend replacement instead of repair?',
        summary: 'Systems over about 12 years old typically get a repair-versus-replacement cost comparison alongside the repair quote.',
        body: 'For systems older than roughly 12 years, it\'s standard practice to note during the call that the repair quote will come with a side-by-side comparison to replacement cost, since major component failures on older systems often make replacement the better long-term value. This is offered as information, not pressure — the customer still chooses.',
        category: 'Services',
        keywords: ['replacement', 'repair vs replace', 'system age', 'upsell'],
      },
    ],
  },
  {
    slug: 'plumbing',
    name: 'Plumbing',
    tagline: 'Burst-pipe and no-water triage, drain and water-heater booking.',
    triageQuestions: [
      'Is water actively leaking or flooding right now?',
      'Do you know where the main shut-off valve is, and have you turned it off?',
      'Is this affecting your only bathroom or your only working toilet?',
      'Is the water heater leaking, or is it a no-hot-water issue?',
      'Is this a clogged drain, a leak, or a fixture that needs replacing?',
    ],
    emergencyKeywords: ['burst pipe', 'flooding', 'water everywhere', 'sewage backup', 'no water', 'gas leak', 'water heater leaking', 'ceiling leak'],
    emergencyGuidance:
      'Active flooding, a burst pipe, or a sewage backup is always an emergency — walk the caller through locating and shutting the main water valve while dispatch is arranged, and prioritize immediate response. A leaking gas water heater or any gas smell is a safety issue: advise leaving the area and contacting the gas utility or 911 before anything else. No hot water or a single slow drain is a routine booking, not an emergency, unless it\'s the customer\'s only bathroom.',
    commonServices: ['Drain cleaning', 'Leak repair', 'Water heater repair/replacement', 'Toilet repair/replacement', 'Fixture installation', 'Sewer line inspection', 'Pipe repair', 'Water pressure issues'],
    upsellPrompts: [
      'When booking a drain clog, mention a camera inspection if the customer has had repeat clogs — it finds the root cause instead of treating symptoms.',
      'If the water heater is over 8-10 years old, note that repair quotes will include a replacement comparison.',
      'For any leak call, ask if they\'d like a whole-home plumbing inspection while the technician is already on site.',
    ],
    suggestedGreeting:
      "Thanks for calling — let's get your plumbing issue sorted. Is there any active water leaking right now, or is this something we can schedule?",
    articles: [
      {
        title: 'What counts as a plumbing emergency versus a routine call?',
        summary: 'Active flooding, a burst pipe, or sewage backup is always an emergency. No hot water or a single slow drain is routine unless it\'s your only bathroom.',
        body: 'Active flooding, a burst pipe, or a sewage backup is always treated as an emergency requiring immediate dispatch. A leaking gas water heater or any gas smell is a safety issue and the caller should be advised to leave the area and contact the gas utility or 911. No hot water, a single slow drain, or a minor fixture issue is a routine, schedulable call — unless it affects the customer\'s only working bathroom, in which case it gets priority scheduling.',
        category: 'Emergency Handling',
        keywords: ['emergency', 'burst pipe', 'flooding', 'sewage backup'],
      },
      {
        title: 'What should I do if I have an active water leak before the technician arrives?',
        summary: 'Locate and shut off the main water valve if it\'s safe to do so — this limits damage while we get someone out to you.',
        body: 'If water is actively leaking or flooding, the first step is locating and shutting off the main water shut-off valve, which limits damage while dispatch is arranged. Customers who don\'t know where their main valve is should be walked through common locations (near the water meter, in the basement, or where the line enters the home) as time allows.',
        category: 'Emergency Handling',
        keywords: ['main shut-off valve', 'active leak', 'flooding', 'water damage'],
      },
      {
        title: 'Do you offer camera inspections for recurring drain clogs?',
        summary: 'Yes — for repeat clogs, a camera inspection can find the root cause instead of just clearing the symptom again.',
        body: 'For customers reporting repeat clogs in the same drain, a camera inspection is worth offering alongside the standard cleaning. It identifies root causes — root intrusion, pipe damage, bellied lines — that a simple snake or hydro-jet won\'t fix long-term.',
        category: 'Services',
        keywords: ['drain cleaning', 'camera inspection', 'recurring clog'],
      },
      {
        title: 'How old does a water heater need to be before you recommend replacement?',
        summary: 'Water heaters over about 8 to 10 years old typically get a replacement comparison alongside any repair quote.',
        body: 'For water heaters older than roughly 8-10 years, standard tank life, it\'s worth noting during the call that the repair quote will include a replacement cost comparison, since older units are more likely to fail again soon after a repair.',
        category: 'Services',
        keywords: ['water heater', 'replacement', 'repair vs replace'],
      },
    ],
  },
  {
    slug: 'roofing',
    name: 'Roofing',
    tagline: 'Active-leak and storm-damage triage, inspection booking.',
    triageQuestions: [
      'Is water actively coming into the home right now?',
      'Was there a recent storm, high wind, or hail event?',
      'Do you know approximately how old the roof is?',
      'Is this for a leak repair, storm damage, or a full inspection/quote?',
      'Have you noticed any missing shingles, sagging, or visible damage from the ground?',
    ],
    emergencyKeywords: ['active leak', 'water coming in', 'ceiling collapse', 'storm damage', 'hail damage', 'tree on roof', 'missing shingles after storm'],
    emergencyGuidance:
      'Active water intrusion into the living space, a sagging ceiling, or storm damage with a tree or debris on the roof is treated as urgent — these can worsen fast and risk structural damage. Advise the caller to place a bucket/tarp if safe and avoid the affected room if there\'s any sign of ceiling sagging. A roof that\'s simply old or has cosmetic wear with no active leak is a standard inspection booking, not an emergency.',
    commonServices: ['Leak repair', 'Storm/hail damage inspection', 'Full roof replacement', 'Shingle repair', 'Gutter repair', 'Roof inspection', 'Insurance claim assistance'],
    upsellPrompts: [
      'After any storm-damage call, mention that we can assist with the insurance claim process — this is often the deciding factor for booking.',
      'For roofs over 15-20 years old, note that a leak repair quote will include a full-roof assessment.',
      'Offer a gutter inspection alongside any roof inspection — clogged gutters are a common hidden cause of "roof" leaks.',
    ],
    suggestedGreeting:
      "Thanks for calling — I'm sorry to hear about the roof trouble. Is water actively coming into the home right now, or is this something we can get scheduled?",
    articles: [
      {
        title: 'What counts as a roofing emergency?',
        summary: 'Active water coming into the home, a sagging ceiling, or storm damage with debris on the roof is urgent. Cosmetic wear with no active leak is a standard booking.',
        body: 'Active water intrusion into the living space, any sign of a sagging or bulging ceiling, or storm damage involving a tree or heavy debris on the roof is treated as urgent and prioritized for fast response, since these situations can worsen quickly and risk structural damage. A roof that is simply old, has cosmetic granule loss, or minor wear with no active leak is scheduled as a standard inspection.',
        category: 'Emergency Handling',
        keywords: ['active leak', 'storm damage', 'emergency', 'sagging ceiling'],
      },
      {
        title: 'Do you help with insurance claims for storm damage?',
        summary: 'Yes — after storm or hail damage, we can assist with documenting the damage for your insurance claim.',
        body: 'For storm or hail damage calls, it\'s worth mentioning that assistance is available for the insurance claim process, including damage documentation. This is frequently the deciding factor for a customer choosing to book, since navigating a claim alone is one of the biggest pain points after storm damage.',
        category: 'Services',
        keywords: ['insurance claim', 'storm damage', 'hail damage'],
      },
      {
        title: 'What should I do if my ceiling is actively leaking right now?',
        summary: 'Place a bucket under the leak if safe, and avoid the room if the ceiling looks like it\'s sagging or bulging.',
        body: 'If water is actively coming through the ceiling, the customer should place a bucket or container underneath if it\'s safe to do so, and avoid standing directly under or in a room where the ceiling appears to be sagging or bulging, since this can indicate a risk of collapse.',
        category: 'Emergency Handling',
        keywords: ['active leak', 'ceiling sagging', 'safety'],
      },
    ],
  },
  {
    slug: 'electrical',
    name: 'Electrical',
    tagline: 'Safety-first triage for sparks, burning smells, and outages.',
    triageQuestions: [
      'Do you smell burning, see sparks, or hear buzzing from an outlet or panel?',
      'Has power gone out to the whole house, or just part of it?',
      'Have you already turned off the breaker for the affected area?',
      'Is this for a repair, a new installation, or an inspection?',
      'Is the home\'s electrical panel older than 20-25 years or a known recalled brand?',
    ],
    emergencyKeywords: ['burning smell', 'sparks', 'smoke', 'buzzing outlet', 'panel sparking', 'power out', 'shock', 'electrocution', 'exposed wire'],
    emergencyGuidance:
      'Any report of burning smell, visible sparks, smoke, or a shock from an outlet or panel is a safety emergency — advise the caller to shut off the breaker for that circuit (or the main breaker if unsure which one) and avoid the area, then treat as an immediate priority dispatch, not a scheduled booking. A full home power outage with no visible hazard should first be checked against a utility outage before assuming it\'s an internal electrical issue.',
    commonServices: ['Panel upgrade', 'Outlet/switch repair', 'Circuit breaker repair', 'Whole-home rewiring', 'EV charger installation', 'Lighting installation', 'Electrical inspection', 'Generator installation'],
    upsellPrompts: [
      'If the panel is over 20-25 years old or a known recalled brand (e.g. Federal Pacific, Zinsco), mention a panel inspection is worth adding to any service call.',
      'For any new EV owner, mention EV charger installation as an add-on.',
      'When booking lighting or outlet work, ask if they\'ve considered a whole-home surge protector.',
    ],
    suggestedGreeting:
      "Thanks for calling — for your safety, can you tell me if you're seeing any sparks, smoke, or smelling anything burning right now?",
    articles: [
      {
        title: 'What counts as an electrical emergency?',
        summary: 'Sparks, smoke, a burning smell, or a shock from an outlet or panel is an emergency — turn off the breaker and avoid the area, then call us immediately.',
        body: 'Any report of visible sparks, smoke, a burning smell, buzzing from an outlet or panel, or a shock/electrocution is treated as a safety emergency. The caller should be advised to shut off the breaker for the affected circuit — or the main breaker if they\'re unsure which one — and avoid the area entirely until a technician arrives. This is dispatched as an immediate priority, not scheduled normally.',
        category: 'Emergency Handling',
        keywords: ['sparks', 'burning smell', 'shock', 'emergency', 'breaker'],
      },
      {
        title: 'My power is out — is that something you handle, or should I call the utility company?',
        summary: 'First check if it\'s a utility outage affecting the neighborhood. If it\'s isolated to your home with no visible hazard, we can send a technician.',
        body: 'A full home power outage should first be checked against the local utility\'s outage map or hotline, since a neighborhood-wide outage isn\'t an internal electrical issue. If the outage is isolated to the home and there\'s no visible hazard (sparks, smoke, burning smell), it can be scheduled as a diagnostic visit rather than an emergency.',
        category: 'Emergency Handling',
        keywords: ['power outage', 'utility', 'no power'],
      },
      {
        title: 'Do you install EV chargers?',
        summary: 'Yes — EV charger installation is one of our services, worth mentioning to any customer who\'s a new EV owner.',
        body: 'EV charger installation is offered as a standard service. It\'s worth raising as an add-on any time a customer mentions they\'ve recently bought an electric vehicle, since many customers don\'t realize professional installation is needed for a Level 2 home charger.',
        category: 'Services',
        keywords: ['ev charger', 'installation', 'upsell'],
      },
      {
        title: 'How do I know if my electrical panel needs to be upgraded?',
        summary: 'Panels over 20-25 years old, or known recalled brands, are worth having inspected — we can check this during any service visit.',
        body: 'Panels older than roughly 20-25 years, or from brands with known recall/safety histories (such as Federal Pacific or Zinsco), are worth flagging for an inspection. This is mentioned as a helpful add-on during any other service call rather than as a hard sell.',
        category: 'Services',
        keywords: ['panel upgrade', 'old panel', 'recalled panel'],
      },
    ],
  },
  {
    slug: 'restoration',
    name: 'Restoration',
    tagline: 'Water, fire, and mold damage — always urgent, always documented.',
    triageQuestions: [
      'Is this water damage, fire damage, mold, or a combination?',
      'How long ago did the damage occur?',
      'Is there standing water anywhere in the home right now?',
      'Have you contacted your insurance company yet?',
      'Is the affected area accessible, or is it structurally unsafe?',
    ],
    emergencyKeywords: ['flooding', 'water damage', 'fire damage', 'smoke damage', 'mold', 'sewage', 'burst pipe', 'storm damage', 'structural damage'],
    emergencyGuidance:
      'Restoration calls are treated as urgent by default — every hour of delay after water or fire damage increases the cost and the risk of secondary damage (mold growth typically begins within 24-48 hours of water exposure). Any report of standing water, active fire/smoke, or a structurally unsafe area should be escalated for immediate response, and the caller advised not to enter unsafe areas.',
    commonServices: ['Water damage extraction/drying', 'Fire and smoke damage restoration', 'Mold remediation', 'Sewage cleanup', 'Storm damage restoration', 'Content pack-out and storage', 'Insurance documentation'],
    upsellPrompts: [
      'Always mention insurance claim documentation support — most restoration customers are filing a claim and this is a major differentiator.',
      'If water damage is over 24 hours old, note that a mold inspection should be included given the risk window.',
      'Offer content pack-out/storage for any large-loss water or fire job.',
    ],
    suggestedGreeting:
      "Thanks for calling — I know this is a stressful situation. Can you tell me whether this is water, fire, or mold damage, and whether there's any standing water right now?",
    articles: [
      {
        title: 'Why is restoration treated as urgent even when it isn\'t "flooding"?',
        summary: 'Even modest water damage becomes a bigger, more expensive problem fast — mold risk typically starts within 24 to 48 hours, so we prioritize a quick response on every job.',
        body: 'Restoration calls default to urgent handling because delay compounds cost: mold growth typically begins within 24-48 hours of water exposure, and materials that could have been dried and saved often need full replacement after that window. Any standing water, active fire or smoke, or a structurally unsafe area is escalated for immediate response.',
        category: 'Emergency Handling',
        keywords: ['water damage', 'mold risk', 'urgent', '24-48 hours'],
      },
      {
        title: 'Do you help with the insurance claim process?',
        summary: 'Yes — documentation support for insurance claims is included, since most restoration jobs involve a claim.',
        body: 'Insurance claim documentation support is a standard part of the restoration process here, since the large majority of customers calling are filing a claim. This should be mentioned early in the call, as it\'s often what determines whether a caller books versus calls a competitor.',
        category: 'Services',
        keywords: ['insurance claim', 'documentation'],
      },
      {
        title: 'Is it safe to stay in the affected area of my home?',
        summary: 'If there\'s standing water, visible structural damage, or smoke/fire damage, avoid the area until a technician has assessed it.',
        body: 'Customers should be advised to avoid any area with standing water, visible structural sagging, or fire/smoke damage until a technician has assessed the space, since these conditions can pose safety risks (electrical hazards near water, weakened structures) beyond the visible damage.',
        category: 'Emergency Handling',
        keywords: ['safety', 'standing water', 'structural damage'],
      },
    ],
  },
  {
    slug: 'locksmith',
    name: 'Locksmith',
    tagline: 'Lockout urgency and identity verification, done right.',
    triageQuestions: [
      'Are you locked out right now, or is this scheduled work (new locks, rekey, etc.)?',
      'Is this a home, a vehicle, or a business?',
      'Can you confirm you\'re the property owner or an authorized occupant?',
      'Is anyone, especially a child or pet, locked inside unattended?',
      'Do you need a standard lock, a high-security lock, or a smart lock?',
    ],
    emergencyKeywords: ['locked out', 'child locked in car', 'pet locked in car', 'break-in', 'broken lock', 'lost keys', 'locked inside'],
    emergencyGuidance:
      'A child or pet locked inside a vehicle unattended is always an immediate priority — advise the caller to also call 911 in parallel if the situation is urgent (hot weather, distress), since emergency services can sometimes respond faster than any locksmith. A standard lockout is time-sensitive but not life-safety; a broken lock after a break-in is prioritized for same-day service since it\'s a security exposure, not a routine one. Identity/ownership should always be confirmed for lockout and rekey jobs before dispatch — this is a core anti-fraud safeguard, not optional friendliness.',
    commonServices: ['Home lockout', 'Vehicle lockout', 'Business lockout', 'Lock rekey', 'Lock installation/replacement', 'High-security lock upgrade', 'Smart lock installation', 'Broken key extraction'],
    upsellPrompts: [
      'After any lockout, mention a rekey service — a lockout is often the moment a customer realizes they don\'t know who else has a copy of their key.',
      'For business customers, mention master key systems and access control upgrades.',
      'Offer smart lock installation as an alternative any time a customer is replacing a standard lock.',
    ],
    suggestedGreeting:
      "Thanks for calling — I can help get you back in. First, is anyone, especially a child or pet, currently locked inside a vehicle?",
    articles: [
      {
        title: 'How do you verify identity before a lockout or rekey job?',
        summary: 'We confirm you\'re the property owner or an authorized occupant before dispatching — this protects you and is standard practice industry-wide.',
        body: 'Before dispatching for a lockout or rekey, identity and ownership/authorization are confirmed with the caller. This is a standard anti-fraud safeguard across the locksmith industry, not extra friction — it protects the actual property owner from someone else gaining unauthorized access.',
        category: 'Safety & Verification',
        keywords: ['identity verification', 'ownership', 'lockout', 'anti-fraud'],
      },
      {
        title: 'What should I do if a child or pet is locked inside a hot car?',
        summary: 'Call 911 immediately in addition to us — emergency services can sometimes respond faster, and this is always treated as the highest priority.',
        body: 'A child or pet locked inside a vehicle, particularly in hot weather or if there\'s any sign of distress, should prompt the caller to also call 911 in parallel, since emergency services may be able to respond faster than any locksmith dispatch. This situation is always treated as the highest priority call.',
        category: 'Emergency Handling',
        keywords: ['child locked in car', 'pet locked in car', 'emergency', '911'],
      },
      {
        title: 'Should I rekey my locks after a lockout?',
        summary: 'It\'s worth considering — a lockout is often when people realize they\'re not sure who else has a copy of their key.',
        body: 'After resolving a lockout, it\'s worth mentioning rekey service to the customer. A lockout situation frequently prompts customers to realize they don\'t have full confidence in who else holds a copy of their key (past tenants, contractors, an ex), making it a natural moment to offer this service.',
        category: 'Services',
        keywords: ['rekey', 'lockout', 'security', 'upsell'],
      },
    ],
  },
];

export function getPlaybookBySlug(slug: string | undefined | null): Playbook | undefined {
  return PLAYBOOKS.find((p) => p.slug === slug);
}

// ============================================================
// STATE
// ============================================================

export async function fetchPlaybookState(userId: string): Promise<PlaybookState> {
  const [profileRes, historyRes] = await Promise.all([
    supabase
      .from('business_profile')
      .select('id, active_playbook_slug, active_playbook_applied_at')
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('playbook_applications')
      .select('*')
      .order('applied_at', { ascending: false })
      .limit(20),
  ]);

  const profile = profileRes.data as { id: string; active_playbook_slug: string | null; active_playbook_applied_at: string | null } | null;

  return {
    activePlaybookSlug: profile?.active_playbook_slug ?? null,
    activePlaybookAppliedAt: profile?.active_playbook_applied_at ?? null,
    businessProfileId: profile?.id ?? null,
    history: (historyRes.data as PlaybookApplication[]) ?? [],
  };
}

// ============================================================
// APPLY
// ============================================================

/**
 * Applies a playbook: writes its articles into the knowledge base, merges
 * (never overwrites) services_offered, sets primary_industry only if it
 * was empty, and logs the application. Safe to run more than once — a
 * re-apply creates a fresh set of articles rather than erroring, so a
 * tenant can pull in an updated playbook later without deleting anything
 * they've since customized.
 */
export async function applyPlaybook(playbook: Playbook, userId: string): Promise<ApplyPlaybookResult> {
  const articleRows = playbook.articles.map((a) => ({
    user_id: userId,
    created_by: userId,
    title: a.title,
    summary: a.summary,
    body: a.body,
    category: a.category,
    keywords: a.keywords,
    audience: 'ai' as const,
    status: 'published' as const,
    source: 'playbook' as const,
  }));

  const { data: insertedArticles, error: articlesError } = await supabase
    .from('knowledge_articles')
    .insert(articleRows)
    .select('id');
  if (articlesError) throw articlesError;
  const articlesCreated = insertedArticles?.length ?? 0;

  const { data: existingProfile, error: profileFetchError } = await supabase
    .from('business_profile')
    .select('id, services_offered, primary_industry')
    .eq('user_id', userId)
    .maybeSingle();
  if (profileFetchError) throw profileFetchError;

  const existingServices: string[] = (existingProfile?.services_offered as string[] | null) ?? [];
  const mergedServices = Array.from(new Set([...existingServices, ...playbook.commonServices]));
  const servicesAdded = mergedServices.length - existingServices.length;

  const profilePayload = {
    user_id: userId,
    services_offered: mergedServices,
    primary_industry: existingProfile?.primary_industry || playbook.slug,
    active_playbook_slug: playbook.slug,
    active_playbook_applied_at: new Date().toISOString(),
  };

  if (existingProfile?.id) {
    const { error } = await supabase.from('business_profile').update(profilePayload).eq('id', existingProfile.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from('business_profile').insert(profilePayload);
    if (error) throw error;
  }

  const { error: logError } = await supabase.from('playbook_applications').insert({
    user_id: userId,
    playbook_slug: playbook.slug,
    articles_created: articlesCreated,
  });
  if (logError) throw logError;

  return { articlesCreated, servicesAdded };
}

export function relativePlaybookTime(iso: string | null): string {
  if (!iso) return 'Never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 30) return `${diffDays} days ago`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths} month${diffMonths === 1 ? '' : 's'} ago`;
  const diffYears = Math.floor(diffMonths / 12);
  return `${diffYears} year${diffYears === 1 ? '' : 's'} ago`;
}
