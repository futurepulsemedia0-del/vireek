// supabase/functions/_shared/business-brain/router.ts
//
// Deterministic question understanding for Ask Vireek. No LLM call:
// it is free, instant, testable, and cannot be prompt-injected. The
// router only decides WHICH fixed analyses to run and extracts a few
// whitelisted parameters (period, job count, trade). Anything it does
// not recognise falls back to the "overview" pack, never to guessing.
//
// Keyword sets cover English, Persian, Spanish and Arabic stems because
// the dashboard is used in all four.

import type { Period, QuestionPlan, Topic } from "./types.ts";
import { isKnownTrade, normalizeDigits, tradeOf } from "./util.ts";

const RX = {
  profitWord: /profit|margin|revenue|income|earning|sales|takings|سود|درآمد|فروش|حاشیه|درامد|ganancia|beneficio|ingreso|ventas|ربح|إيراد|ايراد|مبيعات/i,
  changeWord: /fall|fell|drop|down|decreas|declin|dip|lower|less|worse|why|what happened|change|افت|کاهش|کم|پایین|چرا|چه شد|baj|cay|disminu|por qué|لماذا|انخفض|هبط/i,
  leakWord: /losing money|lose money|leak|waste|wasting|where.*(money|profit)|bleed|loss|ضرر|هدر|از دست|پول.*کجا|کجا.*پول|pérdida|perdiendo|fuga|desperdicio|خسار|أخسر|اخسر|هدر/i,
  techWord: /technician|\btech\b|who should|assign|dispatch|handle (this|the) job|send (a |the )?tech|تکنسین|کارشناس|اختصاص|کی باید|چه کسی|técnico|asignar|فني|تقني|من يجب/i,
  contactWord: /contact|call back|call today|follow.?up|reach out|customers? (should|to|i should)|who (should|do) (i|we) (call|contact)|مشتری.*(تماس|پیگیری)|تماس بگیر|پیگیری|cliente.*(contactar|llamar)|contactar|llamar|seguimiento|اتصل|متابعة|تواصل/i,
  capacityWord: /accept|take on|take \d+|can we (do|handle|take)|more jobs|extra jobs|capacity|room for|fit \d+|ظرفیت|بپذیر|قبول کن|جا داریم|capacidad|aceptar|podemos|سعة|قبول|نقبل/i,
  hireWord: /\bhire|hiring|another (technician|tech)|add (a |another )?(technician|tech)|new (technician|tech)|استخدام|نیروی جدید|تکنسین جدید|contratar|contrataci|توظيف|أوظف|اوظف/i,
  adviceWord: /what should i (change|do|fix|improve)|what (to|can) (change|improve)|improve|recommend|advice|priorit|بهبود|چه کار.*کنم|چه چیزی.*تغییر|پیشنهاد|اولویت|mejorar|qué (debo|debería) cambiar|recomend|تحسين|ماذا (أغير|اغير)/i,
};

const PERIODS: [RegExp, Period][] = [
  [/yesterday|دیروز|ayer|أمس|امس/i, "yesterday"],
  [/last week|هفته (قبل|گذشته)|semana pasada|الأسبوع الماضي|الاسبوع الماضي/i, "last_week"],
  [/this week|هفته (جاری|اخیر)|esta semana|هذا الأسبوع|هذا الاسبوع/i, "this_week"],
  [/this month|ماه (جاری|اخیر)|este mes|هذا الشهر/i, "this_month"],
  [/today|امروز|hoy|اليوم/i, "today"],
];

export function planQuestion(question: string): QuestionPlan {
  const normalized = normalizeDigits(question).toLowerCase().replace(/\s+/g, " ").trim();
  const topics: Topic[] = [];
  const add = (t: Topic) => {
    if (!topics.includes(t)) topics.push(t);
  };

  const hasNumber = /\d+/.test(normalized);
  const profit = RX.profitWord.test(normalized);

  if (RX.hireWord.test(normalized)) add("hiring_whatif");
  if (RX.capacityWord.test(normalized) && (hasNumber || /week|this week|هفته|semana|أسبوع/.test(normalized)) && !topics.includes("hiring_whatif")) {
    add("capacity_whatif");
  }
  if (RX.leakWord.test(normalized)) add("money_leaks");
  if (profit && RX.changeWord.test(normalized)) add("profit_drivers");
  if (RX.techWord.test(normalized) && !topics.includes("hiring_whatif")) add("technician_fit");
  if (RX.contactWord.test(normalized)) add("customer_outreach");
  if (RX.adviceWord.test(normalized)) add("recommendations");
  if (!topics.length && profit) add("profit_drivers");
  if (!topics.length) add("overview");

  // Period: explicit word wins; "why did profit fall" with no period means the latest full day.
  let period: Period = "yesterday";
  for (const [re, p] of PERIODS) {
    if (re.test(normalized)) {
      period = p;
      break;
    }
  }

  // Number of extra jobs: "20 more HVAC jobs", "take 15 jobs", "۲۰ کار بیشتر".
  let extraJobs: number | null = null;
  const jobsMatch =
    normalized.match(/(\d{1,3})\s*(?:more|extra|additional|new)?\s*(?:[a-z]+\s+){0,2}(?:jobs?|calls?|visits?|appointments?|customers?|کار|مشتری|trabajos|empleos|وظيفة|مهمة)/) ??
    normalized.match(/(?:accept|take on|take|fit|handle|قبول|بپذیر|aceptar|نقبل)\D{0,15}(\d{1,3})/);
  if (jobsMatch) {
    const n = parseInt(jobsMatch[1], 10);
    if (n >= 1 && n <= 500) extraJobs = n;
  }

  // Hires: "hire 2 technicians" (default 1).
  let hires = 1;
  const hireMatch = normalized.match(/(?:hire|hiring|add|contratar|استخدام)\D{0,12}(\d{1,2})\s*(?:more\s*)?(?:technicians?|techs?|people|نفر|تکنسین|técnicos)/);
  if (hireMatch) hires = Math.min(10, Math.max(1, parseInt(hireMatch[1], 10)));

  const t = tradeOf(normalized);
  const trade = isKnownTrade(t) ? t : null;

  return { topics, period, extraJobs, hires, trade, normalized };
}
