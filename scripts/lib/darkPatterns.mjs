// scripts/lib/darkPatterns.mjs
//
// Pure rule engine for the dark-pattern checklist (docs/design/dark-patterns.md). No I/O: callers pass { path, text } files.
// Rule ids match the checklist ids. Heuristics, not proof: a clean run means "none of the known mechanical patterns", not "no dark patterns".

/** Files that make up signup, billing, cancellation and upsell. Paths are repo-relative, forward slashes. */
export const FLOW_FILE_PATTERNS = [
  /^src\/pages\/(Signup|Pricing|Billing|BillingPlans|BillingInvoices|CancelSubscription|Onboarding|OnboardingConcierge|OnboardingGuide)Page\.tsx$/,
  /^src\/components\/(TrialBanner|UpgradeBanner|PlanLimitDialog|UsageLimitBanner)\.tsx$/,
  /^src\/components\/billing\/.+\.tsx$/,
  /^src\/components\/paymentPlans\/.+\.tsx$/,
  /^src\/components\/onboarding\/.+\.tsx$/,
  /^src\/i18n\/(churnSave|renewalDisclosure|billing|pricing|signup)[A-Za-z]*Namespace\.ts$/,
];
export const isFlowFile = (p) => FLOW_FILE_PATTERNS.some((re) => re.test(p));
const isUi = (p) => /\.(tsx|ts|json)$/.test(p) && !/\.test\.(tsx|ts)$/.test(p);

// DP-02 confirmshaming: the decline option insults, guilt-trips or mocks the user.
export const CONFIRMSHAMING = [
  /\bno thanks?,? i (don'?t|do not|hate|prefer|like|want to (lose|pay|miss|stay))\b/i,
  /\bi('d| would) rather (pay|miss|lose|stay|not (save|grow|succeed))\b/i,
  /\bi (don'?t|do not) (want|need|like) (to )?(save|grow|more|success|customers|money|revenue|protect)/i,
  /\bno,? i (don'?t|do not) care( about)?\b/i,
  /\bi('ll| will) (pay full price|miss out|stay (broke|stuck))\b/i,
  /\bi('m| am) (fine|happy) (with )?(losing|missing|wasting)\b/i,
  /\bmaybe later,? i (hate|don'?t)\b/i,
  /\bkeep (losing|wasting) (money|calls|customers)\b/i,
  /\bi (prefer|choose) (to )?(lose|miss|waste)\b/i,
];

// DP-04 false urgency / scarcity. Real dates ("trial ends 12 Dec") are fine and are not matched.
export const FALSE_URGENCY = [
  /\blimited[- ]time (offer|deal|only)\b/i,
  /\bonly \d+ (spots?|seats?|left|remaining|slots?)\b/i,
  /\b(hurry|act now|last chance|don'?t miss out|offer expires (soon|today|tonight)|while (supplies|stocks) last)\b/i,
  /\b\d+ (people|others|businesses|companies) (are )?(viewing|looking at|buying) (this|now)\b/i,
  /\b(countdown|timer)\b.*\b(offer|discount|deal)\b/i,
];

// DP-03 hidden cancel: cancelling is pushed to a channel the user must wait on or phone.
export const CANCEL_OBSTRUCTION = [
  /\b(contact|call|email|message|chat with) (our )?(support|sales|us|an agent|your account manager)\b[^.<]{0,40}\bto cancel\b/i,
  /\bto cancel( a| your)?( paid)?( subscription| plan| account)?,? (please )?(contact|call|email|speak|chat)\b/i,
  /\bcancell?ations? (is|are) (only )?(available|possible|handled) (by|via|through) (phone|support|email)\b/i,
  /\bcall (us )?during business hours to cancel\b/i,
];

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

function findPatterns(file, patterns, rule, message, onlyFlow = false) {
  if (!isUi(file.path) || (onlyFlow && !isFlowFile(file.path))) return [];
  const out = [];
  for (const re of patterns) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(file.text)) !== null) {
      out.push({ rule, path: file.path, line: lineOf(file.text, m.index), match: m[0].slice(0, 80), message });
      if (m[0].length === 0) g.lastIndex++;
    }
  }
  return out;
}

/** Names of options that cost money, share data or send marketing. Checked in ANY file; every option is checked in flow files. */
const SENSITIVE_OPTION = /marketing|newsletter|promo|upsell|add_?on|bundle|consent|optin|opt_?in|share(?:d)?With|autoCharge|autoRenew|auto_?pay|insurance|donat|tip(?:Amount)?$|warranty|protection/i;

/** DP-01: checkbox / switch pre-selected. Looks at defaultChecked, checked={true}, and checked={X} where X is useState(true). */
export function checkPreChecked(file) {
  if (!/\.tsx$/.test(file.path) || /\.test\.tsx$/.test(file.path)) return [];
  const inFlow = isFlowFile(file.path);
  const out = [];
  const t = file.text;
  const hit = (idx, what) => out.push({ rule: 'DP-01', path: file.path, line: lineOf(t, idx), match: what, message: 'Consent, upsell or charge option is pre-selected. Options that cost money or share data must start unchecked.' });
  if (inFlow) for (const m of t.matchAll(/<(?:input[^>]*type=["']checkbox["']|Checkbox|Switch|Toggle)(?=[\s/>])[^>]*?\b(defaultChecked|checked=\{true\})/g)) hit(m.index, m[1]);
  const trueStates = [...t.matchAll(/const \[(\w+), set\w+\] = useState(?:<boolean>)?\(true\)/g)].map((m) => m[1]);
  for (const name of trueStates) {
    if (!inFlow && !SENSITIVE_OPTION.test(name)) continue;
    const re = new RegExp(`<(?:input[^>]*type=["']checkbox["']|Checkbox|Switch|Toggle)(?=[\\s/>])[^>]*?\\bchecked=\\{${name}\\}`, 'g');
    for (const m of t.matchAll(re)) hit(m.index, `checked={${name}} (state starts true)`);
  }
  return out;
}

export const checkConfirmshaming = (f) => findPatterns(f, CONFIRMSHAMING, 'DP-02', 'Decline option shames or guilt-trips the user. Use a neutral label ("No thanks", "Not now").');
export const checkFalseUrgency = (f) => findPatterns(f, FALSE_URGENCY, 'DP-04', 'False urgency or scarcity wording in a billing/signup/upsell flow. Only real, dated deadlines are allowed.', true);
export const checkCancelObstruction = (f) => findPatterns(f, CANCEL_OBSTRUCTION, 'DP-03', 'Cancelling is routed to support. Cancel must be self-serve and as easy as signing up.');

/** DP-03/DP-05 structural checks over the whole file set (needs several files at once). */
export function checkStructure(files) {
  const by = (p) => files.find((f) => f.path === p);
  const out = [];
  const bill = by('src/pages/BillingPage.tsx');
  if (bill && !/\/dashboard\/billing\/cancel/.test(bill.text)) out.push({ rule: 'DP-03', path: bill.path, line: 1, match: '', message: 'Billing page has no path to the cancel flow.' });
  const plans = by('src/pages/BillingPlansPage.tsx');
  if (plans && !/\/dashboard\/billing\/cancel/.test(plans.text)) out.push({ rule: 'DP-03', path: plans.path, line: 1, match: '', message: 'Plans page does not link to the cancel flow.' });
  const cancel = by('src/pages/CancelSubscriptionPage.tsx');
  if (cancel) {
    if (/text-danger">\*<\/span>/.test(cancel.text) || /reasonError/.test(cancel.text)) out.push({ rule: 'DP-05', path: cancel.path, line: 1, match: 'required reason', message: 'Cancel survey must be optional (no required marker, no blocking error).' });
    if (!/\(optional\)/i.test(cancel.text)) out.push({ rule: 'DP-05', path: cancel.path, line: 1, match: '', message: 'Cancel survey must say it is optional.' });
    if (!/Skip and cancel now/.test(cancel.text)) out.push({ rule: 'DP-05', path: cancel.path, line: 1, match: '', message: 'Cancel survey needs a visible "Skip and cancel now" action.' });
    const steps = cancel.text.match(/type Step = ([^;]+);/);
    if (steps && steps[1].split('|').length > 3) out.push({ rule: 'DP-06', path: cancel.path, line: 1, match: steps[1].trim(), message: 'Cancel flow has more than 3 steps. Cancelling must not take more steps than signing up.' });
  }
  const signup = by('src/pages/SignupPage.tsx');
  if (signup) {
    if (/useState\((true)\)/.test((signup.text.match(/const \[agreeTerms[^\n]*/) ?? [''])[0])) out.push({ rule: 'DP-01', path: signup.path, line: 1, match: 'agreeTerms', message: 'Terms checkbox must start unchecked.' });
    if (/marketing|newsletter/i.test(signup.text) && /\bchecked=\{(?:marketing|newsletter|promo)\w*\}/i.test(signup.text) === false && /(marketing|newsletter)\w*\] = useState\(true\)/i.test(signup.text)) out.push({ rule: 'DP-01', path: signup.path, line: 1, match: 'marketing opt-in', message: 'Marketing opt-in must start unchecked.' });
  }
  return out;
}

export function scanFiles(files, allowlist = []) {
  const findings = [];
  for (const f of files) findings.push(...checkPreChecked(f), ...checkConfirmshaming(f), ...checkFalseUrgency(f), ...checkCancelObstruction(f));
  findings.push(...checkStructure(files));
  const allowed = (x) => allowlist.some((a) => a.rule === x.rule && a.path === x.path && (!a.match || x.match.includes(a.match)));
  return { findings: findings.filter((x) => !allowed(x)), suppressed: findings.filter(allowed) };
}
