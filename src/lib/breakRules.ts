// Meal & rest break rule sets per jurisdiction — pure data + helpers (no Supabase, no DOM).
//
// Each rule set is DATA that maps onto the existing BreakSettings engine in
// breakCompliance.ts, so the evaluation logic stays in one place. A manager
// picks a rule set; it fills the rule fields, which can still be tuned by hand
// (the page then shows "Custom").
//
// NOT LEGAL ADVICE. Break law changes, has exemptions (industry, union
// agreements, wage orders, local ordinances) and depends on facts this app
// cannot see. Every rule set below is an approximation of the general rule for
// hourly employees — confirm with counsel before relying on it.
//
// Threshold convention (minutes of WORKED time, breaks excluded): a break is
// required once worked time REACHES the value. A statute that says "more than
// 5 hours" is therefore stored as 301. "6 hours or more" is stored as 360.

import type { BreakSettings } from './breakCompliance';

export const BREAK_RULES_DISCLAIMER =
  'Not legal advice. Break rules vary by state, industry, union agreement and employee type, and they change. These rule sets are a general starting point — confirm yours with a qualified employment lawyer or your state labor agency.';

export const CUSTOM_JURISDICTION = 'CUSTOM' as const;
export const DEFAULT_JURISDICTION = 'CA' as const;

export type JurisdictionCode = 'CA' | 'WA' | 'OR' | 'CO' | 'IL' | 'FED';
export type EffectiveJurisdiction = JurisdictionCode | typeof CUSTOM_JURISDICTION;

/**
 * fixed_per_type    — a fixed premium (e.g. one hour of pay) per violation type per shift
 * missed_time_wages — no fixed premium; pay for the missed or unpaid break time instead
 * none              — no premium pay mechanism
 */
export type PremiumModel = 'fixed_per_type' | 'missed_time_wages' | 'none';

export type RuleFields = Pick<
  BreakSettings,
  'meal_min_minutes' | 'meal_deadline_minutes' | 'meal_thresholds' | 'rest_min_minutes' | 'rest_thresholds' | 'premium_minutes'
>;

export interface JurisdictionRule {
  code: JurisdictionCode;
  name: string;
  /** One plain sentence a manager can read in the picker. */
  summary: string;
  citation: string;
  sourceUrl: string | null;
  /** YYYY-MM-DD the rule was last checked against the agency source; null = not yet verified. */
  lastReviewed: string | null;
  premiumModel: PremiumModel;
  premiumNote: string;
  /** Parts of the real rule this tool does NOT check — shown to the manager. */
  notChecked: string[];
  rules: RuleFields;
}

export const JURISDICTION_RULES: readonly JurisdictionRule[] = [
  {
    code: 'CA',
    name: 'California',
    summary: '30-min meal after 5h (second after 10h); 10-min rest per 4h or major fraction; 1 hour premium pay per violation type.',
    citation: 'Cal. Labor Code §§ 226.7, 512; IWC wage orders',
    sourceUrl: 'https://www.dir.ca.gov/dlse/faq_mealandrestperiods.htm',
    lastReviewed: null,
    premiumModel: 'fixed_per_type',
    premiumNote: 'One extra hour of pay at the regular rate per workday for meal violations, and another for rest violations.',
    notChecked: [
      'Written meal-break waivers (allowed for shifts of 6 hours or less, and the second meal up to 12 hours)',
      'On-duty meal periods and industry or wage-order exemptions',
      'The second meal must also start by the end of the 10th hour (only the first meal start is timed)',
    ],
    rules: { meal_min_minutes: 30, meal_deadline_minutes: 300, meal_thresholds: [300, 600], rest_min_minutes: 10, rest_thresholds: [210, 360, 600], premium_minutes: 60 },
  },
  {
    code: 'WA',
    name: 'Washington',
    summary: '30-min meal for shifts over 5h, started within hours 2–5; 10-min paid rest per 4h and never more than 3h without one.',
    citation: 'WAC 296-126-092',
    sourceUrl: 'https://app.leg.wa.gov/WAC/default.aspx?cite=296-126-092',
    lastReviewed: '2026-10-27',
    premiumModel: 'missed_time_wages',
    premiumNote: 'No fixed premium. Missed rest time and meal periods where the employee stayed on duty must be paid.',
    notChecked: [
      'Meal periods are waivable by agreement; rest breaks are not',
      'An extra 30-min meal is required when working 3+ hours past the normal workday',
      'The 3-hour limit between rest breaks (rest breaks are counted, not timed)',
      'Extra rules for health care employees',
    ],
    rules: { meal_min_minutes: 30, meal_deadline_minutes: 300, meal_thresholds: [301], rest_min_minutes: 10, rest_thresholds: [180, 420, 660], premium_minutes: 0 },
  },
  {
    code: 'OR',
    name: 'Oregon',
    summary: '30-min meal for work periods of 6h or more; 10-min paid rest per 4h or major part (more than 2h).',
    citation: 'OAR 839-020-0050',
    sourceUrl: 'https://oregon.public.law/rules/oar_839-020-0050',
    lastReviewed: '2026-10-27',
    premiumModel: 'missed_time_wages',
    premiumNote: 'No fixed premium. A meal period that is not fully duty-free must be paid; unprovided rest time is owed as wages.',
    notChecked: [
      'Tighter meal timing rules by shift length (shorter shifts must complete the meal before the 5th hour)',
      'Additional meal periods on very long shifts',
      'Waiver and collective-bargaining exceptions',
    ],
    rules: { meal_min_minutes: 30, meal_deadline_minutes: 300, meal_thresholds: [360], rest_min_minutes: 10, rest_thresholds: [121, 361, 601, 841], premium_minutes: 0 },
  },
  {
    code: 'CO',
    name: 'Colorado',
    summary: '30-min duty-free meal for shifts over 5h; 10-min paid rest per 4h or major fraction (more than 2h).',
    citation: '7 CCR 1103-1, Rules 5.1–5.2 (COMPS Order)',
    sourceUrl: 'https://cdle.colorado.gov/sites/cdle/files/info_%234_meal_and_rest_periods_09.15.25.pdf',
    lastReviewed: '2026-10-27',
    premiumModel: 'missed_time_wages',
    premiumNote: 'No fixed premium. A rest period not authorized and permitted is owed as 10 minutes of extra wages.',
    notChecked: [
      'Meal-time on-duty exceptions when work does not allow a duty-free meal',
      'Split 5-minute rest periods and averaged rest schedules',
      'COMPS exemptions by job type',
    ],
    rules: { meal_min_minutes: 30, meal_deadline_minutes: 300, meal_thresholds: [301], rest_min_minutes: 10, rest_thresholds: [121, 361, 601, 841], premium_minutes: 0 },
  },
  {
    code: 'IL',
    name: 'Illinois',
    summary: '20-min meal for 7.5h of continuous work, started within 5h; another 20 min for each additional 4.5h. No rest-break mandate.',
    citation: '820 ILCS 140/3 (One Day Rest in Seven Act)',
    sourceUrl: null,
    lastReviewed: null,
    premiumModel: 'none',
    premiumNote: 'No premium pay. Penalties are statutory fines, not wages to the employee.',
    notChecked: ['Coverage thresholds and exemptions (e.g. very small shifts, certain industries)', 'Continuous-work interruptions'],
    rules: { meal_min_minutes: 20, meal_deadline_minutes: 300, meal_thresholds: [450, 720], rest_min_minutes: 10, rest_thresholds: [], premium_minutes: 0 },
  },
  {
    code: 'FED',
    name: 'Federal baseline (no required breaks)',
    summary: 'Federal law does not require meal or rest breaks. Short breaks (about 5–20 min) that are given must be paid.',
    citation: 'FLSA, 29 CFR §§ 785.18–785.19',
    sourceUrl: null,
    lastReviewed: null,
    premiumModel: 'none',
    premiumNote: 'No premium pay. Use this when your state has no break law and you only want tracking and reminders.',
    notChecked: ['State and local break laws (many states have them)', 'Whether your short breaks were paid'],
    rules: { meal_min_minutes: 30, meal_deadline_minutes: 300, meal_thresholds: [], rest_min_minutes: 10, rest_thresholds: [], premium_minutes: 0 },
  },
];

const BY_CODE = new Map<string, JurisdictionRule>(JURISDICTION_RULES.map((r) => [r.code, r]));

export function isJurisdictionCode(v: unknown): v is JurisdictionCode {
  return typeof v === 'string' && BY_CODE.has(v);
}

/** Defensive read of the server value: unknown or missing falls back to California (the original default). */
export function normalizeJurisdictionCode(raw: unknown): JurisdictionCode {
  const v = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  return isJurisdictionCode(v) ? v : DEFAULT_JURISDICTION;
}

export function getJurisdictionRule(code: JurisdictionCode): JurisdictionRule {
  return BY_CODE.get(code) as JurisdictionRule;
}

/** The rule fields of a rule set merged into the account's current settings (on/off switches and reminder timing are kept). */
export function settingsForJurisdiction(code: JurisdictionCode, current: BreakSettings): BreakSettings {
  const r = getJurisdictionRule(code).rules;
  return {
    ...current,
    meal_min_minutes: r.meal_min_minutes,
    meal_deadline_minutes: r.meal_deadline_minutes,
    meal_thresholds: [...r.meal_thresholds],
    rest_min_minutes: r.rest_min_minutes,
    rest_thresholds: [...r.rest_thresholds],
    premium_minutes: r.premium_minutes,
  };
}

const sameList = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

export function matchesJurisdiction(settings: BreakSettings, code: JurisdictionCode): boolean {
  const r = getJurisdictionRule(code).rules;
  return (
    settings.meal_min_minutes === r.meal_min_minutes &&
    settings.meal_deadline_minutes === r.meal_deadline_minutes &&
    sameList(settings.meal_thresholds, r.meal_thresholds) &&
    settings.rest_min_minutes === r.rest_min_minutes &&
    sameList(settings.rest_thresholds, r.rest_thresholds) &&
    settings.premium_minutes === r.premium_minutes
  );
}

/** The saved rule set if the numbers still match it; otherwise "Custom" (a manager tuned the rules by hand). */
export function effectiveJurisdiction(saved: unknown, settings: BreakSettings): EffectiveJurisdiction {
  const code = normalizeJurisdictionCode(saved);
  return matchesJurisdiction(settings, code) ? code : CUSTOM_JURISDICTION;
}

export function jurisdictionLabel(code: EffectiveJurisdiction): string {
  return code === CUSTOM_JURISDICTION ? 'Custom rules' : getJurisdictionRule(code).name;
}

/** Plain-language premium explanation for the report. */
export function premiumExplanation(code: EffectiveJurisdiction): string {
  return code === CUSTOM_JURISDICTION
    ? 'Premium pay follows the minutes you set in Rules. Confirm what your state actually requires.'
    : getJurisdictionRule(code).premiumNote;
}
