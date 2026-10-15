// Pure, runtime-agnostic (Deno + Node/Vitest). No imports on purpose.

export const CHAT_EVENT_TYPES = [
  "emergency_call",
  "missed_call",
  "new_job",
  "job_completed",
  "low_csat",
  "payment_failed",
] as const;
export type ChatEventType = (typeof CHAT_EVENT_TYPES)[number];

export type ChatAction = "acknowledge" | "assign";
export type Severity = "critical" | "warning" | "info" | "success";

export interface EventMeta {
  label: string;
  emoji: string;
  severity: Severity;
  /** Buttons offered by default when the route has actions enabled. */
  actions: ChatAction[];
  dashboardPath: string;
}

export const EVENT_META: Record<ChatEventType, EventMeta> = {
  emergency_call: { label: "Emergency call", emoji: "🚨", severity: "critical", actions: ["acknowledge", "assign"], dashboardPath: "/dashboard/calls" },
  missed_call: { label: "Missed call", emoji: "📵", severity: "warning", actions: ["acknowledge", "assign"], dashboardPath: "/dashboard/calls" },
  new_job: { label: "New job", emoji: "🛠️", severity: "info", actions: ["assign"], dashboardPath: "/dashboard/jobs" },
  job_completed: { label: "Job completed", emoji: "✅", severity: "success", actions: [], dashboardPath: "/dashboard/jobs" },
  low_csat: { label: "Low CSAT", emoji: "⭐", severity: "warning", actions: ["acknowledge"], dashboardPath: "/dashboard/calls" },
  payment_failed: { label: "Payment failed", emoji: "💳", severity: "critical", actions: ["acknowledge"], dashboardPath: "/dashboard/payments" },
};

export function isChatEventType(v: unknown): v is ChatEventType {
  return typeof v === "string" && (CHAT_EVENT_TYPES as readonly string[]).includes(v);
}

export interface Technician {
  id: string;
  name: string;
}

export interface RenderableEvent {
  id: string;
  eventType: ChatEventType;
  payload: Record<string, unknown>;
  acknowledgedBy?: string | null;
  assignedToName?: string | null;
}

export interface MessageModel {
  eventId: string;
  eventType: ChatEventType;
  emoji: string;
  severity: Severity;
  title: string;
  summary: string;
  fields: { label: string; value: string }[];
  link: { label: string; url: string };
  /** Human status line, e.g. "Acknowledged by Sam · Assigned to Alex". */
  status: string | null;
  /** Buttons still available (an acknowledged event no longer offers Acknowledge). */
  actions: ChatAction[];
  technicians: Technician[];
}

export interface BuildOptions {
  siteUrl: string;
  /** false -> phone / email / street address are never put in the message. */
  includeContact: boolean;
  actionsEnabled: boolean;
  technicians: Technician[];
}

export function truncate(value: string, max: number): string {
  const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function str(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

export function formatMoney(amount: unknown, currency: unknown): string {
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return "";
  const code = typeof currency === "string" && /^[a-zA-Z]{3}$/.test(currency) ? currency.toUpperCase() : "USD";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(n);
  } catch {
    return `${n.toFixed(2)} ${code}`;
  }
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : "";
}

function who(p: Record<string, unknown>, include: boolean, nameKey = "caller_name", phoneKey = "caller_phone"): string {
  const name = str(p, nameKey) || "Unknown caller";
  const phone = str(p, phoneKey);
  if (!phone) return name;
  return include ? `${name} (${phone})` : `${name} (${maskPhone(phone)})`;
}

export function buildMessageModel(ev: RenderableEvent, opts: BuildOptions): MessageModel {
  const meta = EVENT_META[ev.eventType];
  const p = ev.payload ?? {};
  const fields: { label: string; value: string }[] = [];
  const add = (label: string, value: string) => {
    if (value) fields.push({ label, value: truncate(value, 200) });
  };
  let summary = "";

  switch (ev.eventType) {
    case "emergency_call":
    case "missed_call": {
      summary = ev.eventType === "emergency_call" ? "An emergency call needs immediate attention." : "A call was not answered — follow up before the customer goes elsewhere.";
      add("Caller", who(p, opts.includeContact));
      add("Summary", str(p, "summary"));
      break;
    }
    case "new_job": {
      summary = "A new job was booked.";
      add("Customer", str(p, "customer_name"));
      add("Service", str(p, "service_type"));
      if (opts.includeContact) add("Address", str(p, "address"));
      add("Scheduled", str(p, "scheduled_datetime"));
      break;
    }
    case "job_completed": {
      summary = "A job was marked completed.";
      add("Customer", str(p, "customer_name"));
      add("Service", str(p, "service_type"));
      break;
    }
    case "low_csat": {
      const rating = Number(p.rating);
      summary = "A customer left a low satisfaction score.";
      add("Rating", Number.isFinite(rating) ? `${rating} / 5` : "");
      add("Comment", str(p, "comment"));
      break;
    }
    case "payment_failed": {
      const subscription = str(p, "source") === "subscription";
      summary = subscription ? "Your Vireek subscription payment failed — update your payment method to avoid interruption." : "A customer payment failed.";
      if (!subscription) {
        add("Customer", str(p, "customer_name"));
        add("Amount", formatMoney(p.amount, p.currency));
      }
      break;
    }
  }

  const statusParts: string[] = [];
  if (ev.acknowledgedBy) statusParts.push(`Acknowledged by ${truncate(ev.acknowledgedBy, 60)}`);
  if (ev.assignedToName) statusParts.push(`Assigned to ${truncate(ev.assignedToName, 60)}`);

  const actions = opts.actionsEnabled
    ? meta.actions.filter((a) => {
        if (a === "acknowledge") return !ev.acknowledgedBy;
        if (a === "assign") return opts.technicians.length > 0;
        return true;
      })
    : [];

  const base = opts.siteUrl.replace(/\/+$/, "");
  return {
    eventId: ev.id,
    eventType: ev.eventType,
    emoji: meta.emoji,
    severity: meta.severity,
    title: meta.label,
    summary,
    fields,
    link: { label: "Open in Vireek", url: `${base}${meta.dashboardPath}` },
    status: statusParts.length ? statusParts.join(" · ") : null,
    actions,
    technicians: opts.technicians.slice(0, 25),
  };
}

/** Used by "Send test message" so owners can preview each notification safely. */
export const SAMPLE_PAYLOADS: Record<ChatEventType, Record<string, unknown>> = {
  emergency_call: { caller_name: "Jordan Lee", caller_phone: "+15551230000", summary: "Test: no heat, elderly resident at home." },
  missed_call: { caller_name: "Jordan Lee", caller_phone: "+15551230000" },
  new_job: { customer_name: "Jordan Lee", service_type: "AC repair", address: "12 Example St", scheduled_datetime: "Tomorrow 9:00 AM" },
  job_completed: { customer_name: "Jordan Lee", service_type: "AC repair" },
  low_csat: { rating: 2, comment: "Test: technician arrived late." },
  payment_failed: { customer_name: "Jordan Lee", amount: 245, currency: "usd" },
};
