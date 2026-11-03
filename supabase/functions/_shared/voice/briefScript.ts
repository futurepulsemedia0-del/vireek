// supabase/functions/_shared/voice/briefScript.ts
//
// Turns REAL measured facts into a spoken Morning Brief (<= 150 words). Pure and deterministic: no LLM is involved,
// so a number can only appear in the script if it is in BriefFacts, and every spoken fact has an evidence entry
// for the in-app "Why this?" panel. Style follows docs/voice-and-tone.md (plain, active, no filler, max one "!").
//
// A fact that is `null` means "could not be loaded". It is never spoken as zero (a failed source stays silent).

export const MAX_WORDS = 150;
export type Lang = "en" | "es" | "fr";
export const LANGS: readonly Lang[] = ["en", "es", "fr"];

/** Keep in sync with ROUTES in src/lib/dailyBriefing.ts (a unit test enforces this). */
export const HREF = {
  calls: "/dashboard/calls",
  jobs: "/dashboard/jobs",
  dispatch: "/dashboard/dispatch",
  invoicing: "/dashboard/invoicing",
  quotes: "/dashboard/quotes",
} as const;

export type WeatherKind = "storm" | "heat" | "cold" | "wind" | "snow" | "rain" | "flood";

export interface BriefFacts {
  date: string;                       // local YYYY-MM-DD
  ownerName: string | null;           // first name only
  calls: { total: number; missed: number; emergencies: number; emergenciesUnhandled: number } | null;
  bookings: { created: number } | null;
  overdue: { count: number; cents: number } | null;
  expiringQuotes: { count: number; cents: number } | null;
  schedule: { jobs: number; unassigned: number; firstAt: string | null } | null;  // firstAt already formatted, e.g. "8:30 AM"
  weather: { risk: "none" | "watch" | "severe"; kind: WeatherKind } | null;
  onCall: string | null;
  /** The viewer may hear dollar figures (owner or can_view_billing). When false, money facts are dropped entirely. */
  canSeeMoney: boolean;
}

export interface EvidenceItem { key: string; label: string; value: string | number; href: string }
export interface BriefResult {
  script: string;
  wordCount: number;
  evidence: EvidenceItem[];
  recommended: { key: string; text: string } | null;
  notable: boolean;
}

// ------------------------------------------------------------------ copy (add a language = add one block)
interface Copy {
  hello: (name: string | null) => string;
  calls: (total: number, missed: number) => string;
  noMissed: (total: number) => string;
  emergencies: (n: number, unhandled: number) => string;
  bookings: (n: number) => string;
  overdue: (n: number, amount: string) => string;
  expiring: (n: number, amount: string) => string;
  schedule: (jobs: number, first: string | null, unassigned: number) => string;
  noJobs: string;
  weather: (kind: WeatherKind, severe: boolean) => string;
  onCall: (name: string) => string;
  action: (text: string) => string;
  act: {
    emergency: (n: number) => string; unassigned: (n: number) => string; weather: string;
    overdue: (n: number) => string; quotes: (n: number) => string; missed: (n: number) => string;
  };
  money: (cents: number) => string;
}
const grp = (n: number, sep: string) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
const en: Copy = {
  hello: (n) => (n ? `Good morning, ${n}.` : "Good morning."),
  calls: (t, m) => `Yesterday you had ${t} ${t === 1 ? "call" : "calls"}, and ${m} ${m === 1 ? "was" : "were"} missed.`,
  noMissed: (t) => `Yesterday you had ${t} ${t === 1 ? "call" : "calls"}, and none were missed.`,
  emergencies: (n, u) => `${n} emergency ${n === 1 ? "call" : "calls"} came in${u > 0 ? `, and ${u} still ${u === 1 ? "needs" : "need"} a job` : ", all handled"}.`,
  bookings: (n) => `${n} new ${n === 1 ? "job was" : "jobs were"} booked.`,
  overdue: (n, a) => `${n} ${n === 1 ? "invoice is" : "invoices are"} overdue, ${a} in total.`,
  expiring: (n, a) => `${n} ${n === 1 ? "quote" : "quotes"} worth ${a} expire within three days.`,
  schedule: (j, f, u) => `Today you have ${j} ${j === 1 ? "job" : "jobs"}${f ? `, starting at ${f}` : ""}${u > 0 ? `. ${u} of them ${u === 1 ? "has" : "have"} no technician yet` : ""}.`,
  noJobs: "Nothing is scheduled today.",
  weather: (k, sev) => `${sev ? "Weather warning" : "Weather watch"}: ${({ storm: "storms expected", heat: "extreme heat", cold: "a hard freeze", wind: "high winds", snow: "snow expected", rain: "heavy rain", flood: "flooding risk" })[k]} today.`,
  onCall: (n) => `${n} is on call.`,
  action: (t) => `My suggestion: ${t}`,
  act: {
    emergency: (n) => `call back the ${n === 1 ? "emergency caller" : "emergency callers"} first.`,
    unassigned: (n) => `assign ${n === 1 ? "the open job" : "the open jobs"} before the day starts.`,
    weather: "check the schedule for weather delays.",
    overdue: (n) => `follow up on the ${n === 1 ? "overdue invoice" : "overdue invoices"} today.`,
    quotes: (n) => `follow up on the ${n === 1 ? "quote" : "quotes"} that expire soon.`,
    missed: (n) => `call back the ${n === 1 ? "missed caller" : "missed callers"}.`,
  },
  money: (c) => `$${grp(c / 100, ",")}`,
};
const es: Copy = {
  hello: (n) => (n ? `Buenos días, ${n}.` : "Buenos días."),
  calls: (t, m) => `Ayer tuvo ${t} ${t === 1 ? "llamada" : "llamadas"} y ${m} ${m === 1 ? "se perdió" : "se perdieron"}.`,
  noMissed: (t) => `Ayer tuvo ${t} ${t === 1 ? "llamada" : "llamadas"} y no se perdió ninguna.`,
  emergencies: (n, u) => `Entraron ${n} ${n === 1 ? "llamada de emergencia" : "llamadas de emergencia"}${u > 0 ? ` y ${u} ${u === 1 ? "sigue sin trabajo asignado" : "siguen sin trabajo asignado"}` : ", todas atendidas"}.`,
  bookings: (n) => `Se agendaron ${n} ${n === 1 ? "trabajo nuevo" : "trabajos nuevos"}.`,
  overdue: (n, a) => `${n} ${n === 1 ? "factura está vencida" : "facturas están vencidas"}, ${a} en total.`,
  expiring: (n, a) => `${n} ${n === 1 ? "cotización" : "cotizaciones"} por ${a} ${n === 1 ? "vence" : "vencen"} en tres días.`,
  schedule: (j, f, u) => `Hoy tiene ${j} ${j === 1 ? "trabajo" : "trabajos"}${f ? `, el primero a las ${f}` : ""}${u > 0 ? `. ${u} de ellos ${u === 1 ? "no tiene técnico" : "no tienen técnico"} todavía` : ""}.`,
  noJobs: "No hay trabajos programados para hoy.",
  weather: (k, sev) => `${sev ? "Alerta de clima" : "Atención al clima"}: ${({ storm: "se esperan tormentas", heat: "calor extremo", cold: "helada fuerte", wind: "vientos fuertes", snow: "se espera nieve", rain: "lluvia intensa", flood: "riesgo de inundación" })[k]} hoy.`,
  onCall: (n) => `${n} está de guardia.`,
  action: (t) => `Mi sugerencia: ${t}`,
  act: {
    emergency: (n) => `devuelva primero ${n === 1 ? "la llamada de emergencia" : "las llamadas de emergencia"}.`,
    unassigned: (n) => `asigne ${n === 1 ? "el trabajo abierto" : "los trabajos abiertos"} antes de empezar el día.`,
    weather: "revise la agenda por posibles retrasos del clima.",
    overdue: (n) => `dé seguimiento ${n === 1 ? "a la factura vencida" : "a las facturas vencidas"} hoy.`,
    quotes: (n) => `dé seguimiento ${n === 1 ? "a la cotización que vence" : "a las cotizaciones que vencen"} pronto.`,
    missed: (n) => `devuelva ${n === 1 ? "la llamada perdida" : "las llamadas perdidas"}.`,
  },
  money: (c) => `$${grp(c / 100, ",")}`,
};
const fr: Copy = {
  hello: (n) => (n ? `Bonjour ${n}.` : "Bonjour."),
  calls: (t, m) => `Hier, vous avez eu ${t} ${t === 1 ? "appel" : "appels"}, dont ${m} ${m === 1 ? "manqué" : "manqués"}.`,
  noMissed: (t) => `Hier, vous avez eu ${t} ${t === 1 ? "appel" : "appels"}, aucun n'a été manqué.`,
  emergencies: (n, u) => `${n} ${n === 1 ? "appel d'urgence est arrivé" : "appels d'urgence sont arrivés"}${u > 0 ? `, et ${u} ${u === 1 ? "attend encore une intervention" : "attendent encore une intervention"}` : ", tous traités"}.`,
  bookings: (n) => `${n} ${n === 1 ? "nouvelle intervention a été réservée" : "nouvelles interventions ont été réservées"}.`,
  overdue: (n, a) => `${n} ${n === 1 ? "facture est en retard" : "factures sont en retard"}, ${a} au total.`,
  expiring: (n, a) => `${n} ${n === 1 ? "devis" : "devis"} de ${a} ${n === 1 ? "expire" : "expirent"} dans trois jours.`,
  schedule: (j, f, u) => `Aujourd'hui, vous avez ${j} ${j === 1 ? "intervention" : "interventions"}${f ? `, la première à ${f}` : ""}${u > 0 ? `, dont ${u} sans technicien` : ""}.`,
  noJobs: "Aucune intervention n'est prévue aujourd'hui.",
  weather: (k, sev) => `${sev ? "Alerte météo" : "Météo à surveiller"} : ${({ storm: "orages prévus", heat: "chaleur extrême", cold: "gel intense", wind: "vents forts", snow: "neige prévue", rain: "fortes pluies", flood: "risque d'inondation" })[k]} aujourd'hui.`,
  onCall: (n) => `${n} est d'astreinte.`,
  action: (t) => `Ma suggestion : ${t}`,
  act: {
    emergency: (n) => `rappelez d'abord ${n === 1 ? "l'appel d'urgence" : "les appels d'urgence"}.`,
    unassigned: (n) => `attribuez ${n === 1 ? "l'intervention ouverte" : "les interventions ouvertes"} avant le début de la journée.`,
    weather: "vérifiez le planning en cas de retards dus à la météo.",
    overdue: (n) => `relancez ${n === 1 ? "la facture en retard" : "les factures en retard"} aujourd'hui.`,
    quotes: (n) => `relancez ${n === 1 ? "le devis qui expire" : "les devis qui expirent"} bientôt.`,
    missed: (n) => `rappelez ${n === 1 ? "l'appelant manqué" : "les appelants manqués"}.`,
  },
  money: (c) => `${grp(c / 100, "\u202f")} $`,
};
const COPY: Record<Lang, Copy> = { en, es, fr };

export const countWords = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

// ------------------------------------------------------------------ what counts as "notable"
export function isNotable(f: BriefFacts): boolean {
  if ((f.calls?.missed ?? 0) > 0 || (f.calls?.emergencies ?? 0) > 0) return true;
  if (f.canSeeMoney && ((f.overdue?.count ?? 0) > 0 || (f.expiringQuotes?.count ?? 0) > 0)) return true;
  if ((f.schedule?.unassigned ?? 0) > 0) return true;
  if (f.weather && f.weather.risk !== "none") return true;
  return false;   // a quiet day with a normal schedule is not worth a push
}

// ------------------------------------------------------------------ composer
interface Line { prio: number; ord: number; text: string; keep?: boolean }

export function composeBriefScript(f: BriefFacts, lang: Lang = "en"): BriefResult {
  const c = COPY[lang] ?? en;
  const money = f.canSeeMoney;
  const lines: Line[] = [];
  const evidence: EvidenceItem[] = [];
  const ev = (key: string, label: string, value: string | number, href: string) => evidence.push({ key, label, value, href });

  lines.push({ prio: 0, ord: 0, keep: true, text: c.hello(f.ownerName) });

  if (f.calls) {
    lines.push({ prio: 4, ord: 1, text: f.calls.missed > 0 ? c.calls(f.calls.total, f.calls.missed) : c.noMissed(f.calls.total) });
    ev("calls_total", "Calls yesterday", f.calls.total, HREF.calls);
    ev("calls_missed", "Missed calls yesterday", f.calls.missed, HREF.calls);
    if (f.calls.emergencies > 0) {
      lines.push({ prio: 1, ord: 2, text: c.emergencies(f.calls.emergencies, f.calls.emergenciesUnhandled) });
      ev("emergencies", "Emergency calls (24h)", f.calls.emergencies, HREF.calls);
      ev("emergencies_unhandled", "Emergency calls without a job", f.calls.emergenciesUnhandled, HREF.calls);
    }
  }
  if (f.bookings && f.bookings.created > 0) {
    lines.push({ prio: 7, ord: 3, text: c.bookings(f.bookings.created) });
    ev("bookings", "Jobs booked yesterday", f.bookings.created, HREF.jobs);
  }
  if (money && f.overdue && f.overdue.count > 0) {
    lines.push({ prio: 5, ord: 6, text: c.overdue(f.overdue.count, c.money(f.overdue.cents)) });
    ev("overdue_invoices", "Overdue invoices", f.overdue.count, HREF.invoicing);
    ev("overdue_amount", "Overdue amount", c.money(f.overdue.cents), HREF.invoicing);
  }
  if (money && f.expiringQuotes && f.expiringQuotes.count > 0) {
    lines.push({ prio: 6, ord: 7, text: c.expiring(f.expiringQuotes.count, c.money(f.expiringQuotes.cents)) });
    ev("expiring_quotes", "Quotes expiring within 3 days", f.expiringQuotes.count, HREF.quotes);
    ev("expiring_amount", "Value of expiring quotes", c.money(f.expiringQuotes.cents), HREF.quotes);
  }
  if (f.schedule) {
    lines.push({ prio: 2, ord: 4, text: f.schedule.jobs > 0 ? c.schedule(f.schedule.jobs, f.schedule.firstAt, f.schedule.unassigned) : c.noJobs });
    ev("jobs_today", "Jobs scheduled today", f.schedule.jobs, HREF.dispatch);
    if (f.schedule.unassigned > 0) ev("jobs_unassigned", "Jobs today without a technician", f.schedule.unassigned, HREF.dispatch);
  }
  if (f.weather && f.weather.risk !== "none") {
    lines.push({ prio: 3, ord: 5, text: c.weather(f.weather.kind, f.weather.risk === "severe") });
    ev("weather", "Weather risk", `${f.weather.risk}: ${f.weather.kind}`, HREF.dispatch);
  }
  if (f.onCall) {
    lines.push({ prio: 8, ord: 8, text: c.onCall(f.onCall) });
    ev("on_call", "On call today", f.onCall, HREF.dispatch);
  }

  // One recommended action, strictly from the facts above.
  const rec = pickAction(f, c);
  if (rec) lines.push({ prio: 1.5, ord: 9, keep: true, text: c.action(rec.text) });

  // Fit the word budget: drop the least important facts first; greeting and action are never dropped.
  let kept = [...lines];
  const total = () => countWords(kept.map((l) => l.text).join(" "));
  while (total() > MAX_WORDS) {
    const droppable = kept.filter((l) => !l.keep).sort((a, b) => b.prio - a.prio)[0];
    if (!droppable) break;
    kept = kept.filter((l) => l !== droppable);
  }
  const ordered = kept.sort((a, b) => a.ord - b.ord);
  const script = ordered.map((l) => l.text).join(" ");
  return { script, wordCount: countWords(script), evidence, recommended: rec ? { key: rec.key, text: rec.text } : null, notable: isNotable(f) };
}

function pickAction(f: BriefFacts, c: Copy): { key: string; text: string } | null {
  if ((f.calls?.emergenciesUnhandled ?? 0) > 0) return { key: "emergencies_unhandled", text: c.act.emergency(f.calls!.emergenciesUnhandled) };
  if ((f.schedule?.unassigned ?? 0) > 0) return { key: "jobs_unassigned", text: c.act.unassigned(f.schedule!.unassigned) };
  if (f.weather && f.weather.risk === "severe") return { key: "weather", text: c.act.weather };
  if (f.canSeeMoney && (f.overdue?.count ?? 0) > 0) return { key: "overdue_invoices", text: c.act.overdue(f.overdue!.count) };
  if (f.canSeeMoney && (f.expiringQuotes?.count ?? 0) > 0) return { key: "expiring_quotes", text: c.act.quotes(f.expiringQuotes!.count) };
  if ((f.calls?.missed ?? 0) > 0) return { key: "calls_missed", text: c.act.missed(f.calls!.missed) };
  return null;
}

// ------------------------------------------------------------------ scheduling (pure; the hour/date come from localParts)
export interface SchedulePrefs { sendHour: number; quietStart: number; quietEnd: number; lastBriefOn: string | null; catchUpHours?: number }
/** Is `hour` inside the quiet window? Windows may wrap midnight (21 -> 7). Start == end means "no quiet hours". */
export function inQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}
export type DueDecision = { due: true } | { due: false; reason: "already_sent" | "too_early" | "too_late" | "quiet_hours" };
/** Cron runs hourly. Due from sendHour until sendHour + catchUp, never during quiet hours, once per local day. */
export function dueNow(p: SchedulePrefs, local: { date: string; hour: number }): DueDecision {
  if (p.lastBriefOn === local.date) return { due: false, reason: "already_sent" };
  const catchUp = p.catchUpHours ?? 3;
  if (local.hour < p.sendHour) return { due: false, reason: "too_early" };
  if (local.hour > p.sendHour + catchUp) return { due: false, reason: "too_late" };
  if (inQuietHours(local.hour, p.quietStart, p.quietEnd)) return { due: false, reason: "quiet_hours" };
  return { due: true };
}

/** Lock-screen safe: no numbers, no money, no names. */
export function pushText(lang: Lang): { title: string; body: string } {
  return {
    en: { title: "Your Vireek morning brief", body: "Your 60-second brief is ready to play." },
    es: { title: "Su resumen matutino de Vireek", body: "Su resumen de 60 segundos está listo." },
    fr: { title: "Votre point du matin Vireek", body: "Votre point de 60 secondes est prêt." },
  }[lang];
}
