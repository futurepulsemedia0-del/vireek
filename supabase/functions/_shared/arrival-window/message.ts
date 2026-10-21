// Pure message builders for arrival-window notifications: no I/O, no Deno APIs, unit-tested with vitest
// (message.test.ts). Used by supabase/functions/arrival-window-notify.

export type WindowNotifyKind = "confirmed" | "narrowed" | "changed";

export interface WindowMessageInput {
  kind: WindowNotifyKind;
  businessName: string | null;
  technicianName: string | null;
  serviceType: string | null;
  windowStart: string; // ISO
  windowEnd: string; // ISO
  previousStart?: string | null;
  previousEnd?: string | null;
  timeZone: string; // IANA
  /** Customer self-service link (reschedule / status). Omitted when the job has no token. */
  link: string | null;
}

const OPT_OUT = "Reply STOP to opt out.";

function part(iso: string, tz: string, o: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { ...o, timeZone: tz }).format(new Date(iso));
}

export const formatTime = (iso: string, tz: string) => part(iso, tz, { hour: "numeric", minute: "2-digit" }).replace(/\s/g, " ");
export const formatDay = (iso: string, tz: string) => part(iso, tz, { weekday: "short", month: "short", day: "numeric" });

/** "9:00 AM and 11:00 AM" style helpers. */
export function describeWindow(startIso: string, endIso: string, tz: string): { day: string; from: string; to: string; range: string } {
  const from = formatTime(startIso, tz);
  const to = formatTime(endIso, tz);
  return { day: formatDay(startIso, tz), from, to, range: `${from} – ${to}` };
}

function who(i: WindowMessageInput): string {
  return i.businessName?.trim() || "Your service provider";
}

function what(i: WindowMessageInput): string {
  return i.serviceType?.trim() ? `your ${i.serviceType.trim()} visit` : "your visit";
}

function previousClause(i: WindowMessageInput): string {
  if (!i.previousStart || !i.previousEnd) return "";
  const prev = describeWindow(i.previousStart, i.previousEnd, i.timeZone);
  const sameDay = formatDay(i.previousStart, i.timeZone) === formatDay(i.windowStart, i.timeZone);
  return ` (was ${sameDay ? prev.range : `${prev.day}, ${prev.range}`})`;
}

function arrivalSentence(i: WindowMessageInput): string {
  const w = describeWindow(i.windowStart, i.windowEnd, i.timeZone);
  const subject = i.technicianName?.trim() ? i.technicianName.trim() : "Our technician";
  return `${subject} will arrive between ${w.from} and ${w.to} on ${w.day}`;
}

export function buildSmsText(i: WindowMessageInput): string {
  const link = i.link ? ` Need another time? ${i.link}` : "";
  switch (i.kind) {
    case "confirmed":
      return `${who(i)}: you're booked for ${what(i)}. ${arrivalSentence(i)}. We'll text you if the window changes.${link} ${OPT_OUT}`;
    case "narrowed":
      return `${who(i)}: we narrowed your arrival window for ${what(i)}. ${arrivalSentence(i)}${previousClause(i)}.${link} ${OPT_OUT}`;
    case "changed":
      return `${who(i)}: your arrival window for ${what(i)} changed. ${arrivalSentence(i)}${previousClause(i)}.${link} ${OPT_OUT}`;
  }
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildEmail(i: WindowMessageInput): { subject: string; text: string; html: string } {
  const w = describeWindow(i.windowStart, i.windowEnd, i.timeZone);
  const subject =
    i.kind === "confirmed"
      ? `Your arrival window: ${w.day}, ${w.range}`
      : i.kind === "narrowed"
        ? `Good news: your arrival window is now ${w.range}`
        : `Your arrival window changed: ${w.day}, ${w.range}`;

  const text = [
    buildSmsText({ ...i, link: null }).replace(` ${OPT_OUT}`, ""),
    i.link ? `Need another time? ${i.link}` : "",
  ].filter(Boolean).join("\n\n");

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#111">
<p style="font-size:13px;color:#666;margin:0 0 8px">${escapeHtml(who(i))}</p>
<h2 style="margin:0 0 12px;font-size:20px">${escapeHtml(`${w.day}, ${w.range}`)}</h2>
<p style="margin:0 0 12px;font-size:15px;line-height:1.5">${escapeHtml(text.split("\n\n")[0])}</p>
${i.link ? `<p style="margin:16px 0"><a href="${escapeHtml(i.link)}" style="background:#111;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-size:14px">Need another time?</a></p>` : ""}
</div>`;

  return { subject, text, html };
}
