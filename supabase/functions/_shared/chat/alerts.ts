// supabase/functions/_shared/chat/alerts.ts
//
// Pure logic for Slack/Teams alerts: event types, rule validation, message
// building + escaping, OAuth state packing and the permission rule. No Deno,
// fetch or Supabase imports, so vitest covers every line without mocks.

export type ChatProvider = "slack" | "teams";
export type AlertEventType = "emergency" | "new_job" | "missed_call" | "low_csat";

export const CHAT_PROVIDERS: readonly ChatProvider[] = ["slack", "teams"];
export const ALERT_EVENT_TYPES: readonly AlertEventType[] = ["emergency", "new_job", "missed_call", "low_csat"];
export const CSAT_DEFAULT_THRESHOLD = 3;

const isProvider = (v: unknown): v is ChatProvider => v === "slack" || v === "teams";
const isEventType = (v: unknown): v is AlertEventType => ALERT_EVENT_TYPES.includes(v as AlertEventType);

// ---------------------------------------------------------------- access

type PermissionMap = Partial<Record<string, boolean>> | null | undefined;

export interface ChatAdminInput {
  profileRole: string | null | undefined;
  /** null when the signed-in user has no team_members row. */
  member: { inviteStatus: string | null | undefined; permissions: PermissionMap; customRolePermissions: PermissionMap } | null;
}

/** Owners, or active team members whose merged permissions grant can_manage_team (custom role wins, like AuthContext). */
export function canManageChatIntegrations({ profileRole, member }: ChatAdminInput): boolean {
  if (profileRole === "owner") return true;
  if (!member || member.inviteStatus !== "active") return false;
  const merged = { ...(member.permissions ?? {}), ...(member.customRolePermissions ?? {}) };
  return merged.can_manage_team === true;
}

// ----------------------------------------------------------- OAuth state

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Payload for the HMAC-signed `state` param. No dots allowed (the signer splits on them). */
export function packChatState(provider: ChatProvider, ownerId: string, actorId: string): string {
  return `${provider}|${ownerId}|${actorId}`;
}

export function unpackChatState(payload: string): { provider: ChatProvider; ownerId: string; actorId: string } | null {
  const [provider, ownerId, actorId, extra] = payload.split("|");
  if (extra !== undefined || !isProvider(provider) || !UUID.test(ownerId ?? "") || !UUID.test(actorId ?? "")) return null;
  return { provider, ownerId, actorId };
}

// -------------------------------------------------------- rule validation

export interface RuleInput {
  eventType: AlertEventType;
  enabled: boolean;
  channelId: string | null;
  channelName: string | null;
  containerId: string | null;
  containerName: string | null;
  threshold: number | null;
}

export type RulesResult = { ok: true; rules: RuleInput[] } | { ok: false; error: string };

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  // deno-lint-ignore no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return s ? s.slice(0, max) : null;
};

/** Validates the save_rules payload from the browser. Never trusts shape, size or types. */
export function sanitizeRules(input: unknown): RulesResult {
  if (!Array.isArray(input) || input.length > ALERT_EVENT_TYPES.length) return { ok: false, error: "Invalid alert rules." };
  const seen = new Set<string>();
  const rules: RuleInput[] = [];
  for (const raw of input) {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (!isEventType(r.eventType) || seen.has(r.eventType)) return { ok: false, error: "Invalid alert rules." };
    seen.add(r.eventType);
    const enabled = r.enabled === true;
    const channelId = clean(r.channelId, 200);
    if (enabled && !channelId) return { ok: false, error: "Pick a channel for every enabled alert." };
    let threshold: number | null = null;
    if (r.eventType === "low_csat") {
      const t = Number(r.threshold ?? CSAT_DEFAULT_THRESHOLD);
      if (!Number.isInteger(t) || t < 1 || t > 5) return { ok: false, error: "CSAT threshold must be between 1 and 5." };
      threshold = t;
    }
    rules.push({
      eventType: r.eventType,
      enabled,
      channelId,
      channelName: clean(r.channelName, 120),
      containerId: channelId ? clean(r.containerId, 200) : null,
      containerName: channelId ? clean(r.containerName, 120) : null,
      threshold,
    });
  }
  return { ok: true, rules };
}

/** Only low-CSAT alerts are conditional: they fire at or below the rule's threshold. */
export function shouldSendAlert(
  rule: { enabled: boolean; threshold: number | null },
  eventType: AlertEventType,
  record: Record<string, unknown>,
): boolean {
  if (!rule.enabled) return false;
  if (eventType !== "low_csat") return true;
  const rating = Number(record.rating);
  return Number.isFinite(rating) && rating >= 1 && rating <= (rule.threshold ?? CSAT_DEFAULT_THRESHOLD);
}

// -------------------------------------------------------------- messages

export type AlertSeverity = "critical" | "warning" | "info";

export interface AlertMessage {
  severity: AlertSeverity;
  title: string;
  fields: Array<{ label: string; value: string }>;
  /** Path inside the Vireek dashboard, e.g. /dashboard/calls */
  path: string;
}

const clip = (v: unknown, max: number): string => {
  // deno-lint-ignore no-control-regex
  const s = String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

const whenUtc = (v: unknown): string => {
  const d = new Date(String(v ?? ""));
  return Number.isNaN(d.getTime()) ? "" : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
};

const pushIf = (fields: AlertMessage["fields"], label: string, value: string) => {
  if (value) fields.push({ label, value });
};

export interface CallContext {
  callerName?: string | null;
  callerPhone?: string | null;
}

export function buildAlertMessage(eventType: AlertEventType, record: Record<string, unknown>, call?: CallContext): AlertMessage {
  const fields: AlertMessage["fields"] = [];
  switch (eventType) {
    case "emergency":
      pushIf(fields, "Caller", clip(record.caller_name, 80) || "Unknown caller");
      pushIf(fields, "Phone", clip(record.caller_phone, 40));
      pushIf(fields, "Summary", clip(record.summary, 280));
      return { severity: "critical", title: "Emergency call", fields, path: "/dashboard/calls" };
    case "missed_call":
      pushIf(fields, "Caller", clip(record.caller_name, 80) || "Unknown caller");
      pushIf(fields, "Phone", clip(record.caller_phone, 40));
      pushIf(fields, "When", whenUtc(record.call_datetime));
      return { severity: "warning", title: "Missed call", fields, path: "/dashboard/calls" };
    case "new_job":
      pushIf(fields, "Customer", clip(record.customer_name, 80));
      pushIf(fields, "Service", clip(record.service_type, 80));
      pushIf(fields, "Address", clip(record.address, 160));
      pushIf(fields, "Scheduled", whenUtc(record.scheduled_datetime));
      return { severity: "info", title: "New job booked", fields, path: "/dashboard/jobs" };
    case "low_csat":
      pushIf(fields, "Rating", `${clip(record.rating, 3)}/5`);
      pushIf(fields, "Comment", clip(record.comment, 280));
      pushIf(fields, "Caller", clip(call?.callerName, 80));
      pushIf(fields, "Phone", clip(call?.callerPhone, 40));
      return { severity: "warning", title: "Low CSAT rating", fields, path: "/dashboard/calls" };
  }
}

export function buildTestMessage(eventType: AlertEventType): AlertMessage {
  return {
    severity: "info",
    title: "Test alert from Vireek",
    fields: [{ label: "Alert type", value: eventType.replace("_", " ") }, { label: "Status", value: "Your channel mapping works." }],
    path: "/dashboard/settings/slack-teams",
  };
}

// ------------------------------------------------------------ rendering

/** Slack mrkdwn treats & < > as control characters (<!channel>, <@U123>, links). */
export const escapeSlack = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const SLACK_EMOJI: Record<AlertSeverity, string> = { critical: "🚨", warning: "⚠️", info: "✅" };

export function toSlackPayload(msg: AlertMessage, siteUrl: string): { text: string; blocks: unknown[] } {
  const link = `${siteUrl}${msg.path}`;
  const head = `${SLACK_EMOJI[msg.severity]} *${escapeSlack(msg.title)}*`;
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: head } }];
  if (msg.fields.length > 0) {
    blocks.push({
      type: "section",
      fields: msg.fields.slice(0, 10).map((f) => ({ type: "mrkdwn", text: `*${escapeSlack(f.label)}*\n${escapeSlack(f.value)}` })),
    });
  }
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `<${link}|Open in Vireek>` }] });
  const first = msg.fields[0] ? ` — ${msg.fields[0].value}` : "";
  return { text: `${msg.title}${first}`, blocks };
}

export function toTeamsHtml(msg: AlertMessage, siteUrl: string): string {
  const rows = msg.fields.map((f) => `<li><b>${escapeHtml(f.label)}:</b> ${escapeHtml(f.value)}</li>`).join("");
  const href = escapeHtml(`${siteUrl}${msg.path}`);
  return `<h3>${escapeHtml(msg.title)}</h3>${rows ? `<ul>${rows}</ul>` : ""}<p><a href="${href}">Open in Vireek</a></p>`;
}
