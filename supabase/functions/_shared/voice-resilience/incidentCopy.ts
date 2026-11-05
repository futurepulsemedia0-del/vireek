// Communication copy for degradation changes. Pure. Owner alerts are tenant-specific; the public status
// copy is generic (no vendor names, no tenant data, no phone numbers).

import type { Level } from "./ladder.ts";

export type Lang = "en" | "es";

const WHAT: Record<Lang, Record<Level, string>> = {
  en: {
    0: "Your AI phone assistant is back to full service.",
    1: "Your AI assistant is running in reduced mode: it still answers every call and captures name, number, address and emergencies, but cannot book or look things up.",
    2: "Your AI assistant is unavailable. Callers hear an emergency option and can leave a voicemail; we text you the transcript.",
    3: "Your AI assistant is unavailable. Incoming calls are being forwarded to your on-call phone.",
    4: "Calls cannot be answered or forwarded right now. Callers hear a recorded message with emergency instructions.",
  },
  es: {
    0: "Su asistente telefónico de IA volvió al servicio completo.",
    1: "Su asistente de IA funciona en modo reducido: contesta todas las llamadas y toma nombre, número, dirección y emergencias, pero no puede agendar ni consultar datos.",
    2: "Su asistente de IA no está disponible. Quien llama escucha una opción de emergencia y puede dejar un mensaje; le enviamos la transcripción por texto.",
    3: "Su asistente de IA no está disponible. Las llamadas entrantes se están desviando a su teléfono de guardia.",
    4: "No se pueden contestar ni desviar llamadas ahora. Quien llama escucha un mensaje grabado con instrucciones de emergencia.",
  },
};

export function ownerAlert(from: Level, to: Level, lang: Lang = "en"): { title: string; body: string; sms: string; severity: "info" | "warning" | "critical" } {
  const recovered = to < from;
  const severity = to === 0 ? "info" : to >= 3 ? "critical" : "warning";
  const titleEn = recovered ? (to === 0 ? "Phone assistant recovered" : `Phone assistant improving (level ${to})`) : `Phone assistant degraded (level ${to})`;
  const titleEs = recovered ? (to === 0 ? "Asistente telefónico recuperado" : `Asistente telefónico mejorando (nivel ${to})`) : `Asistente telefónico degradado (nivel ${to})`;
  const title = lang === "es" ? titleEs : titleEn;
  const body = WHAT[lang][to];
  const tail = lang === "es" ? " Ninguna llamada se pierde: revise Llamadas en Vireek." : " No call is dropped: check Calls in Vireek.";
  return { title, body: body + (to === 0 ? "" : tail), sms: `Vireek: ${title}. ${body}`.slice(0, 320), severity };
}

/** Public status component text. Generic by design. */
export function publicIncident(to: Level, from: Level): { title: string; impact: "minor" | "major"; message: string; resolved: boolean } {
  if (to === 0) return { title: "Phone answering degraded", impact: "minor", message: "AI phone answering has recovered and is operating normally.", resolved: true };
  const impact = to >= 3 ? "major" : "minor";
  const message =
    to === 1 ? "AI phone answering is running in reduced mode. Calls are still answered and details are captured." :
    to === 2 ? "AI phone answering is degraded. Callers can leave voicemail and reach an emergency option; businesses are alerted instantly." :
    to === 3 ? "AI phone answering is unavailable for some calls. Calls are being forwarded to each business's own phone." :
    "Phone answering is severely degraded. We are working to restore service.";
  return { title: "Phone answering degraded", impact, message: from > to ? `${message} Service is improving.` : message, resolved: false };
}
