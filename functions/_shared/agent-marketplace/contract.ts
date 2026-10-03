// supabase/functions/_shared/agent-marketplace/contract.ts
//
// The sandbox contract between Vireek and any marketplace agent. Pure
// functions only (no I/O, no Deno globals) so every rule below is unit
// tested in contract.test.ts. The agent-runtime edge function is the only
// caller.
//
// Security model in one paragraph: an agent NEVER gets credentials or DB
// access. It receives a scope-minimized snapshot of data and returns a list
// of PROPOSED actions. Each proposal is (1) schema-validated here, (2)
// checked against the scopes the account owner granted, (3) passed through
// evaluate_agent_action() (approval queue / spend limits / audit), and only
// then (4) executed by Vireek's own executors.

export type ActionType = "record_insight" | "create_task" | "send_sms";

export const ACTION_SCOPE: Record<ActionType, string> = {
  record_insight: "act:record_insight",
  create_task: "act:create_task",
  send_sms: "act:send_sms",
};

export const ACTION_GOVERNANCE_SLUG: Record<ActionType, string> = {
  record_insight: "mkt_record_insight",
  create_task: "mkt_create_task",
  send_sms: "mkt_send_sms",
};

export interface AgentManifest {
  scopes: string[];
  triggers: string[];
  limits?: { timeout_ms?: number; max_actions?: number };
  system_prompt?: string;
}

export interface ProposedAction {
  type: ActionType;
  reasoning: string;
  params: Record<string, unknown>;
}

export interface ParsedAgentResponse {
  summary: string;
  actions: ProposedAction[];
  rejected: { index: number; error: string }[];
}

export const MAX_RESPONSE_BYTES = 256 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}
const TASK_TYPE_RE = /^[a-z0-9_]{3,80}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|co|app|ly|me|info|biz|xyz|link|click|top|site|online)\b)/i;

export function manifestLimits(m: AgentManifest): { timeoutMs: number; maxActions: number } {
  const t = Number(m.limits?.timeout_ms);
  const a = Number(m.limits?.max_actions);
  return {
    timeoutMs: Number.isFinite(t) ? Math.min(15000, Math.max(1000, Math.round(t))) : 8000,
    maxActions: Number.isFinite(a) ? Math.min(10, Math.max(1, Math.round(a))) : 5,
  };
}

export function allowedActions(granted: readonly string[]): ActionType[] {
  return (Object.keys(ACTION_SCOPE) as ActionType[]).filter((t) => granted.includes(ACTION_SCOPE[t]));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, min: number, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length < min || t.length > max) return null;
  if (CONTROL_CHARS_RE.test(t)) return null;
  return t;
}

export type ValidationResult = { ok: true; action: ProposedAction } | { ok: false; error: string };

export function validateAction(raw: unknown, granted: readonly string[]): ValidationResult {
  if (!isPlainObject(raw)) return { ok: false, error: "Action must be an object." };
  const type = raw.type;
  if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(ACTION_SCOPE, type)) {
    return { ok: false, error: "Unknown action type." };
  }
  const t = type as ActionType;
  if (!granted.includes(ACTION_SCOPE[t])) return { ok: false, error: `Scope ${ACTION_SCOPE[t]} was not granted.` };

  const reasoning = str(raw.reasoning, 3, 400);
  if (!reasoning) return { ok: false, error: "reasoning (3-400 chars) is required." };
  if (!isPlainObject(raw.params)) return { ok: false, error: "params must be an object." };
  const p = raw.params;
  const out: Record<string, unknown> = {};

  if (t === "record_insight") {
    const title = str(p.title, 3, 140);
    const body = str(p.body, 3, 1200);
    if (!title || !body) return { ok: false, error: "record_insight needs title (3-140) and body (3-1200)." };
    const severity = p.severity ?? "info";
    if (!["info", "warning", "critical"].includes(severity as string)) return { ok: false, error: "Invalid severity." };
    out.title = title;
    out.body = body;
    out.severity = severity;
    if (p.entity_type !== undefined || p.entity_id !== undefined) {
      if (!["job", "customer"].includes(p.entity_type as string) || typeof p.entity_id !== "string" || !UUID_RE.test(p.entity_id)) {
        return { ok: false, error: "entity_type (job|customer) and a uuid entity_id must be given together." };
      }
      out.entity_type = p.entity_type;
      out.entity_id = p.entity_id;
    }
  } else if (t === "create_task") {
    if (typeof p.task_type !== "string" || !TASK_TYPE_RE.test(p.task_type)) {
      return { ok: false, error: "task_type must match [a-z0-9_]{3,80}." };
    }
    const priority = p.priority ?? "normal";
    if (!["low", "normal", "high", "urgent"].includes(priority as string)) return { ok: false, error: "Invalid priority." };
    out.task_type = p.task_type;
    out.priority = priority;
    if (p.target_table !== undefined || p.target_id !== undefined) {
      if (!["jobs", "customers"].includes(p.target_table as string) || typeof p.target_id !== "string" || !UUID_RE.test(p.target_id)) {
        return { ok: false, error: "target_table (jobs|customers) and a uuid target_id must be given together." };
      }
      out.target_table = p.target_table;
      out.target_id = p.target_id;
    }
    if (p.payload !== undefined) {
      if (!isPlainObject(p.payload) || JSON.stringify(p.payload).length > 2048) {
        return { ok: false, error: "payload must be an object up to 2KB." };
      }
      out.payload = p.payload;
    }
  } else {
    if (typeof p.customer_id !== "string" || !UUID_RE.test(p.customer_id)) return { ok: false, error: "send_sms needs a uuid customer_id." };
    const body = str(p.body, 1, 320);
    if (!body) return { ok: false, error: "send_sms body must be 1-320 characters." };
    if (LINK_RE.test(body)) return { ok: false, error: "Links are not allowed in marketplace SMS." };
    out.customer_id = p.customer_id;
    out.body = body;
  }

  return { ok: true, action: { type: t, reasoning, params: out } };
}

/** Parses the agent's JSON reply. Never throws; malformed input yields zero actions. */
export function parseAgentResponse(raw: unknown, granted: readonly string[], maxActions: number): ParsedAgentResponse {
  const empty: ParsedAgentResponse = { summary: "", actions: [], rejected: [] };
  if (!isPlainObject(raw)) return empty;
  const summary = typeof raw.summary === "string" ? raw.summary.replace(CONTROL_CHARS_RE, "").trim().slice(0, 500) : "";
  const list = Array.isArray(raw.actions) ? raw.actions : [];
  const actions: ProposedAction[] = [];
  const rejected: { index: number; error: string }[] = [];
  list.forEach((item, index) => {
    if (index >= maxActions) {
      rejected.push({ index, error: "Exceeds max_actions per run." });
      return;
    }
    const v = validateAction(item, granted);
    if (v.ok) actions.push(v.action);
    else rejected.push({ index, error: v.error });
  });
  return { summary, actions, rejected };
}

/** Tolerant JSON extraction (models sometimes wrap JSON in prose or code fences). */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------
// Data minimization — only fields the granted scopes allow ever leave
// Vireek. Fields that don't exist on a row are simply absent.
// ---------------------------------------------------------------------
const JOB_BASE = ["id", "service_type", "scheduled_datetime", "job_status", "created_at", "arrived_at", "started_at", "expected_duration_minutes", "safety_flag", "safety_flag_note"];
const JOB_FINANCIAL = ["invoice_amount", "invoice_status"];
const JOB_CUSTOMER = ["customer_name", "customer_id"];
const JOB_CONTACT = ["address"];
const CUSTOMER_PROFILE = ["id", "name", "customer_type", "lifecycle_stage", "tags", "last_contacted_at", "created_at"];
const CUSTOMER_CONTACT = ["phone", "email", "address"];

function pick(row: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f in row && row[f] !== undefined) out[f] = row[f];
  return out;
}

export function projectJob(row: Record<string, unknown>, granted: readonly string[]): Record<string, unknown> {
  if (!granted.includes("read:jobs")) return {};
  let fields = [...JOB_BASE];
  if (granted.includes("read:job_financials")) fields = fields.concat(JOB_FINANCIAL);
  if (granted.includes("read:customers")) fields = fields.concat(JOB_CUSTOMER);
  if (granted.includes("read:customer_contact")) fields = fields.concat(JOB_CONTACT);
  return pick(row, fields);
}

export function projectCustomer(row: Record<string, unknown>, granted: readonly string[]): Record<string, unknown> {
  if (!granted.includes("read:customers")) return {};
  let fields = [...CUSTOMER_PROFILE];
  if (granted.includes("read:customer_contact")) fields = fields.concat(CUSTOMER_CONTACT);
  return pick(row, fields);
}

// ---------------------------------------------------------------------
// Outbound endpoint safety (SSRF). Runtime additionally resolves DNS and
// rejects private ranges with isPrivateIp().
// ---------------------------------------------------------------------
const BLOCKED_SUFFIXES = [".local", ".internal", ".localhost", ".lan", ".home", ".corp", ".intranet", ".private"];

export type EndpointCheck = { ok: true; url: URL } | { ok: false; reason: string };

export function checkEndpointShape(input: string): EndpointCheck {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "Invalid URL." };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "Endpoint must use https." };
  if (url.username || url.password) return { ok: false, reason: "Credentials in URL are not allowed." };
  if (url.port && url.port !== "443") return { ok: false, reason: "Only port 443 is allowed." };
  const host = url.hostname.toLowerCase();
  if (host.includes(":") || host.startsWith("[")) return { ok: false, reason: "IP literals are not allowed." };
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return { ok: false, reason: "Internal hostnames are not allowed." };
  const labels = host.split(".");
  if (labels.length < 2) return { ok: false, reason: "Hostname must be a public domain." };
  const tld = labels[labels.length - 1];
  if (!/^([a-z]{2,24}|xn--[a-z0-9-]{2,59})$/.test(tld)) return { ok: false, reason: "Hostname must be a public domain." };
  return { ok: true, url };
}

export function isPrivateIp(ip: string): boolean {
  const v = ip.trim().toLowerCase();
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const candidate = mapped ? mapped[1] : v;
  const m4 = candidate.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m4) {
    const [a, b] = [Number(m4[1]), Number(m4[2])];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && Number(m4[3]) === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (v.includes(":")) {
    return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || /^fe[89ab]/.test(v);
  }
  return false;
}

// ---------------------------------------------------------------------
// Request signing (HMAC-SHA256 over `${timestamp}.${body}`), Stripe-style.
// Agents verify the signature and reject timestamps older than 5 minutes.
// ---------------------------------------------------------------------
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signRequest(secret: string, timestamp: number, body: string): Promise<string> {
  return `v1=${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}
