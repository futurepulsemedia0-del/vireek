// src/lib/telephonyBrand.ts
//
// Branded telephony helpers: CNAM validation, A2P checklist, inbound SMS keyword
// classification, branded voicemail-transcription email.
// NOT LEGAL ADVICE: carrier/registry rules change; verify with your CPaaS and counsel.

import { renderScript, type MergeValues } from "../../supabase/functions/_shared/voice-brand/scripts";

// ---------- CNAM (caller-ID display name) ----------

export const CNAM_MAX = 15;

export function suggestCnam(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\b(LLC|INC|CORP|CO|LTD)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CNAM_MAX)
    .trim();
}

export function validateCnam(name: string): { ok: boolean; suggested: string; issues: string[] } {
  const issues: string[] = [];
  const suggested = suggestCnam(name);
  if (!name.trim()) issues.push("Enter your business name.");
  if (name.trim() && name.trim().length > CNAM_MAX) issues.push(`CNAM is limited to ${CNAM_MAX} characters; use the suggested short name.`);
  if (/[^A-Za-z0-9 ]/.test(name)) issues.push("Use only letters, numbers and spaces.");
  if (suggested.length < 3) issues.push("Name is too short after cleanup.");
  return { ok: issues.length === 0, suggested, issues };
}

// ---------- A2P 10DLC / SMS registration checklist ----------

export interface ChecklistItem { id: string; title: string; detail: string; needsLegal: boolean }

export const A2P_CHECKLIST: readonly ChecklistItem[] = [
  { id: "legal_name", title: "Legal business name matches everywhere", detail: "Brand registration, website footer, and invoices must use the same legal name and EIN.", needsLegal: false },
  { id: "website", title: "Public website with privacy policy and terms", detail: "Reviewers open your site. Privacy policy must state mobile numbers are not sold or shared for marketing.", needsLegal: true },
  { id: "use_case", title: "Campaign use case chosen honestly", detail: "Customer care / account notifications for service updates; separate marketing registration if you send promotions.", needsLegal: true },
  { id: "opt_in", title: "Opt-in method documented", detail: "Describe exactly how consent is collected (verbal on call, web form, booking). Keep proof of consent.", needsLegal: true },
  { id: "samples", title: "Sample messages match your live templates", detail: "Use the generated samples below; they include business name and opt-out wording.", needsLegal: true },
  { id: "keywords", title: "STOP / HELP / START handled", detail: "STOP must immediately end messages; HELP replies with contact info.", needsLegal: true },
  { id: "number_type", title: "Sender number type decided", detail: "US/Canada do not support alphanumeric sender names; use a registered 10DLC number or verified toll-free number.", needsLegal: false },
  { id: "cnam", title: "Caller-ID name (CNAM) registered", detail: "Register the short name with your voice carrier; display is not guaranteed on every network.", needsLegal: false },
  { id: "stir", title: "STIR/SHAKEN branded calling reviewed", detail: "Ask your carrier about attestation and branded calling to reduce 'Spam Likely' labels.", needsLegal: false },
];

export function checklistProgress(done: Record<string, boolean>): { done: number; total: number; legalPending: string[] } {
  const total = A2P_CHECKLIST.length;
  const count = A2P_CHECKLIST.filter((i) => done[i.id]).length;
  return { done: count, total, legalPending: A2P_CHECKLIST.filter((i) => i.needsLegal && !done[i.id]).map((i) => i.id) };
}

export function a2pSampleMessages(values: MergeValues): string[] {
  const full: MergeValues = { callback_number: "555-0100", appointment_time: "Tue 2-4pm", tech_name: "Alex", eta_window: "2-3pm", ...values };
  return ["sms_missed_call", "sms_booking_confirmation", "sms_eta", "sms_opt_in_confirm", "sms_help_reply"].map((id) => renderScript(id, full).text);
}

// ---------- Inbound SMS keywords (CTIA-style) ----------

export type SmsKeyword = "stop" | "start" | "help";
const STOP_WORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"];
const START_WORDS = ["START", "UNSTOP", "YES"];
const HELP_WORDS = ["HELP", "INFO"];

export function classifyInboundKeyword(body: string): SmsKeyword | null {
  const w = body.trim().toUpperCase().replace(/[^A-Z]/g, "");
  if (STOP_WORDS.includes(w)) return "stop";
  if (START_WORDS.includes(w)) return "start";
  if (HELP_WORDS.includes(w)) return "help";
  return null;
}

// ---------- Branded voicemail transcription email ----------

export interface VoicemailEmailInput {
  businessName: string;
  callerName?: string | null;
  callerNumber?: string | null;
  receivedAt: Date;
  durationSeconds?: number | null;
  transcript?: string | null;
  listenUrl?: string | null;
  primaryColor?: string | null;
  footer?: string | null;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export function buildVoicemailEmail(i: VoicemailEmailInput): { subject: string; text: string; html: string } {
  const who = oneLine(i.callerName || i.callerNumber || "an unknown caller").slice(0, 80);
  const biz = oneLine(i.businessName).slice(0, 80) || "Your business";
  const subject = `New voicemail from ${who} — ${biz}`.slice(0, 150);
  const color = /^#[0-9a-fA-F]{6}$/.test(i.primaryColor ?? "") ? (i.primaryColor as string) : "#1d4ed8";
  const link = i.listenUrl && /^https:\/\//i.test(i.listenUrl) ? i.listenUrl : null;
  const transcript = (i.transcript ?? "").trim().slice(0, 2000) || "(No transcript available.)";
  const when = i.receivedAt.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const dur = i.durationSeconds ? `${Math.floor(i.durationSeconds / 60)}:${String(Math.round(i.durationSeconds % 60)).padStart(2, "0")}` : null;
  const note = "Transcribed automatically by an AI system; it may contain errors.";
  const footer = oneLine(i.footer ?? "").slice(0, 200);

  const text = [`${biz} — new voicemail`, `From: ${who}`, `Received: ${when}`, dur ? `Length: ${dur}` : "", "", transcript, "", link ? `Listen: ${link}` : "", note, footer].filter((l, idx, a) => l !== "" || (a[idx - 1] ?? "") !== "").join("\n");
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto"><div style="background:${color};color:#fff;padding:14px 18px;font-weight:bold">${esc(biz)}</div><div style="padding:18px"><p style="margin:0 0 8px"><strong>New voicemail</strong> from ${esc(who)}</p><p style="margin:0 0 12px;color:#555;font-size:13px">${esc(when)}${dur ? ` · ${esc(dur)}` : ""}</p><blockquote style="margin:0 0 14px;padding:10px 14px;background:#f4f4f5;border-left:4px solid ${color};white-space:pre-wrap">${esc(transcript)}</blockquote>${link ? `<p><a href="${esc(link)}" style="color:${color}">Listen to the recording</a></p>` : ""}<p style="color:#777;font-size:12px">${esc(note)}</p>${footer ? `<p style="color:#777;font-size:12px">${esc(footer)}</p>` : ""}</div></div>`;
  return { subject, text, html };
}
