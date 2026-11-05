// TwiML for degradation levels L2-L4 (and the emergency path that works at every level). Pure string builders.
// Everything here runs on Twilio alone: no voice engine, no LLM, no CRM. That independence is the point.

import { EMERGENCY_DTMF } from "./emergencyFastPath.ts";
import type { Level } from "./ladder.ts";

export const xmlEsc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export const wrap = (inner: string): string => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

export type HookFn = (action: string, params?: Record<string, string>) => string;

export interface FallbackCtx {
  businessName: string;
  /** Ordered E.164 numbers: on-call first. Already validated by the caller. */
  forwardTargets: string[];
  language: "en" | "es";
  hook: HookFn;
  /** Caller ID shown to the owner when forwarding (the business line, so they know which line is ringing). */
  callerId?: string;
  /** Static message override (L4). */
  staticMessage?: string;
}

const L = {
  en: {
    unavailable: (b: string) => `Thanks for calling ${b}. Our phone assistant is temporarily unavailable.`,
    pressForEmergency: `If this is an emergency, press ${EMERGENCY_DTMF} now, or say emergency.`,
    leaveMessage: "Otherwise, after the tone, please say your name, phone number, address, and what is wrong. We will call you back as soon as we can.",
    connecting: "Connecting you now. Please hold.",
    emergencyConnecting: "This is being treated as an emergency. Connecting you now.",
    noOneAvailable: "We could not reach anyone right now. After the tone, please leave your name, number, and address. We are alerting the team.",
    staticDefault: (b: string) => `Thanks for calling ${b}. We are unable to take your call right now.`,
    danger: "If anyone is in danger, hang up and call 9 1 1. If you smell gas, leave the building first.",
    callBack: "Please try again in a few minutes, or text this number and we will respond.",
    thanks: "Thank you. Your message has been recorded. Goodbye.",
    lang: "en-US",
  },
  es: {
    unavailable: (b: string) => `Gracias por llamar a ${b}. Nuestro asistente telefónico no está disponible temporalmente.`,
    pressForEmergency: `Si es una emergencia, presione ${EMERGENCY_DTMF} ahora, o diga emergencia.`,
    leaveMessage: "De lo contrario, después del tono, diga su nombre, número de teléfono, dirección y qué sucede. Le devolveremos la llamada lo antes posible.",
    connecting: "Conectándolo ahora. Por favor espere.",
    emergencyConnecting: "Esto se trata como una emergencia. Conectándolo ahora.",
    noOneAvailable: "No pudimos comunicarnos con nadie en este momento. Después del tono, deje su nombre, número y dirección. Estamos avisando al equipo.",
    staticDefault: (b: string) => `Gracias por llamar a ${b}. No podemos atender su llamada en este momento.`,
    danger: "Si alguien está en peligro, cuelgue y llame al 9 1 1. Si huele a gas, salga primero del edificio.",
    callBack: "Intente de nuevo en unos minutos, o envíe un mensaje de texto a este número.",
    thanks: "Gracias. Su mensaje fue grabado. Adiós.",
    lang: "es-US",
  },
} as const;

const say = (t: string, lang: string) => `<Say language="${lang}">${xmlEsc(t)}</Say>`;

/** L2: emergency key first, then voicemail with transcription. */
export function voicemailTwiml(c: FallbackCtx, opts: { skipPrompt?: boolean; noOneAvailable?: boolean } = {}): string {
  const t = L[c.language];
  const record =
    `<Record maxLength="180" playBeep="true" timeout="6" finishOnKey="#" transcribe="true" ` +
    `transcribeCallback="${xmlEsc(c.hook("vm-transcript"))}" action="${xmlEsc(c.hook("vm-done"))}" ` +
    `recordingStatusCallback="${xmlEsc(c.hook("vm-recording"))}" recordingStatusCallbackEvent="completed"/>`;
  if (opts.skipPrompt) return wrap(say(t.leaveMessage, t.lang) + record);
  if (opts.noOneAvailable) return wrap(say(t.noOneAvailable, t.lang) + record);
  const gather =
    `<Gather input="dtmf speech" numDigits="1" timeout="4" speechTimeout="2" language="${t.lang}" ` +
    `hints="emergency,gas,fire,flood,smoke,emergencia" action="${xmlEsc(c.hook("emergency-check"))}" method="POST">` +
    say(`${t.unavailable(c.businessName)} ${t.pressForEmergency}`, t.lang) +
    `</Gather>`;
  return wrap(gather + say(t.leaveMessage, t.lang) + record);
}

/** Dial target `index`; on failure the action URL advances to the next target, then to voicemail. */
export function forwardTwiml(c: FallbackCtx, index: number, emergency: boolean): string {
  const t = L[c.language];
  const target = c.forwardTargets[index];
  if (!target) return voicemailTwiml(c, { noOneAvailable: true });
  const intro = index === 0 ? say(emergency ? t.emergencyConnecting : t.connecting, t.lang) : "";
  const cid = c.callerId ? ` callerId="${xmlEsc(c.callerId)}"` : "";
  return wrap(
    `${intro}<Dial timeout="${emergency ? 30 : 25}"${cid} answerOnBridge="true" action="${xmlEsc(c.hook("forward-done", { i: String(index + 1), e: emergency ? "1" : "0" }))}"><Number>${xmlEsc(target)}</Number></Dial>`,
  );
}

/** L4: static message. If any forwarding number exists, the emergency key still tries it (last resort). */
export function staticTwiml(c: FallbackCtx): string {
  const t = L[c.language];
  const msg = c.staticMessage?.trim() || t.staticDefault(c.businessName);
  const emergencyGather = c.forwardTargets.length
    ? `<Gather input="dtmf" numDigits="1" timeout="5" action="${xmlEsc(c.hook("emergency-check"))}" method="POST">${say(`${msg} ${t.pressForEmergency}`, t.lang)}</Gather>`
    : say(msg, t.lang);
  return wrap(`${emergencyGather}${say(`${t.danger} ${t.callBack}`, t.lang)}<Hangup/>`);
}

export function thanksTwiml(c: FallbackCtx): string {
  return wrap(say(L[c.language].thanks, L[c.language].lang) + "<Hangup/>");
}

/** The entry TwiML for a level (L2..L4). L0/L1 are handled by the engine and are not TwiML. */
export function twimlForLevel(level: Level, c: FallbackCtx): string {
  if (level <= 2) return voicemailTwiml(c);
  if (level === 3) return c.forwardTargets.length ? forwardTwiml(c, 0, false) : voicemailTwiml(c);
  return staticTwiml(c);
}

/** What to do when the emergency key / keyword fires, at ANY level. */
export function emergencyTwiml(c: FallbackCtx): string {
  return c.forwardTargets.length ? forwardTwiml(c, 0, true) : voicemailTwiml(c, { noOneAvailable: true });
}
