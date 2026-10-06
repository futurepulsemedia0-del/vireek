// supabase/functions/_shared/agent-network/tools.ts
//
// Pure (no I/O, no Deno APIs) definition of every tool the Vireek Agent
// Network exposes over MCP and A2A: names, scopes, JSON Schemas, strict
// argument validation, and the small pure helpers the handlers use.
// Kept I/O-free so it is unit-tested with vitest (src/lib/agentNetwork.test.ts).

export type ToolName =
  | "get_customer"
  | "get_equipment"
  | "get_job"
  | "check_schedule"
  | "check_inventory"
  | "create_quote"
  | "dispatch_technician"
  | "send_customer_message"
  | "collect_payment"
  | "get_action_status";

export type AgentScope =
  | "customers:read"
  | "equipment:read"
  | "jobs:read"
  | "schedule:read"
  | "inventory:read"
  | "quotes:create"
  | "dispatch:assign"
  | "messages:send"
  | "payments:collect";

export const ALL_SCOPES: AgentScope[] = [
  "customers:read", "equipment:read", "jobs:read", "schedule:read", "inventory:read",
  "quotes:create", "dispatch:assign", "messages:send", "payments:collect",
];

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ToolDef {
  name: ToolName;
  title: string;
  description: string;
  /** null = always available to any valid key (own-call status only). */
  scope: AgentScope | null;
  write: boolean;
  /** agent_action_catalog slug; set for every write tool. */
  actionSlug?: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  validate: (args: unknown) => ValidationResult<Record<string, unknown>>;
}

// ------------------------------------------------------------------
// Validation primitives
// ------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEM_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const MAX_CENTS = 100_000_000; // $1,000,000 per line / quote

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function strictKeys(a: Obj, allowed: string[]): string | null {
  for (const k of Object.keys(a)) if (!allowed.includes(k)) return `Unknown argument "${k}"`;
  return null;
}

function reqUuid(a: Obj, key: string): ValidationResult<string> {
  const v = a[key];
  if (typeof v !== "string" || !UUID_RE.test(v)) return { ok: false, error: `"${key}" must be a UUID` };
  return { ok: true, value: v.toLowerCase() };
}

function optStr(a: Obj, key: string, min: number, max: number): ValidationResult<string | undefined> {
  const v = a[key];
  if (v === undefined || v === null) return { ok: true, value: undefined };
  if (typeof v !== "string") return { ok: false, error: `"${key}" must be a string` };
  const t = v.trim();
  if (t.length < min || t.length > max) return { ok: false, error: `"${key}" must be ${min}-${max} characters` };
  return { ok: true, value: t };
}

function reqStr(a: Obj, key: string, min: number, max: number): ValidationResult<string> {
  const r = optStr(a, key, min, max);
  if (!r.ok) return r;
  if (r.value === undefined) return { ok: false, error: `"${key}" is required` };
  return { ok: true, value: r.value };
}

function reqIdem(a: Obj): ValidationResult<string> {
  const v = a.idempotency_key;
  if (typeof v !== "string" || !IDEM_RE.test(v)) {
    return { ok: false, error: `"idempotency_key" is required: 8-128 chars of A-Z a-z 0-9 _ . : -` };
  }
  return { ok: true, value: v };
}

function isoDate(a: Obj, key: string): ValidationResult<string> {
  const v = a[key];
  if (typeof v !== "string") return { ok: false, error: `"${key}" must be an ISO 8601 timestamp` };
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return { ok: false, error: `"${key}" is not a valid timestamp` };
  return { ok: true, value: new Date(t).toISOString() };
}

function fail<T>(error: string): ValidationResult<T> {
  return { ok: false, error };
}

// ------------------------------------------------------------------
// Tool definitions
// ------------------------------------------------------------------

const idemProp = {
  type: "string",
  minLength: 8,
  maxLength: 128,
  pattern: "^[A-Za-z0-9_.:-]{8,128}$",
  description: "Unique key you choose for this action. Re-sending the same key never repeats the action and is how you collect the result after human approval.",
};

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE_EXTERNAL = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export interface QuoteLine {
  description: string;
  quantity: number;
  unit_price_cents: number;
}

export const TOOLS: ToolDef[] = [
  {
    name: "get_customer",
    title: "Get customer",
    description: "Look up ONE customer by exactly one of customer_id, phone or email. Returns contact details and lifecycle stage. Never lists or searches all customers.",
    scope: "customers:read",
    write: false,
    inputSchema: {
      type: "object",
      properties: {
        customer_id: { type: "string", format: "uuid" },
        phone: { type: "string", maxLength: 32 },
        email: { type: "string", maxLength: 254 },
      },
      additionalProperties: false,
      oneOf: [{ required: ["customer_id"] }, { required: ["phone"] }, { required: ["email"] }],
    },
    annotations: READ,
    validate(args) {
      if (!isObj(args)) return fail("Arguments must be an object");
      const k = strictKeys(args, ["customer_id", "phone", "email"]);
      if (k) return fail(k);
      const present = ["customer_id", "phone", "email"].filter((x) => args[x] !== undefined);
      if (present.length !== 1) return fail("Provide exactly one of customer_id, phone or email");
      if (present[0] === "customer_id") {
        const r = reqUuid(args, "customer_id");
        return r.ok ? { ok: true, value: { customer_id: r.value } } : r;
      }
      if (present[0] === "phone") {
        const r = reqStr(args, "phone", 7, 32);
        if (!r.ok) return r;
        const digits = r.value.replace(/\D/g, "");
        if (digits.length < 7 || digits.length > 15) return fail('"phone" must contain 7-15 digits');
        return { ok: true, value: { phone: r.value } };
      }
      const r = reqStr(args, "email", 5, 254);
      if (!r.ok) return r;
      if (!EMAIL_RE.test(r.value)) return fail('"email" is not a valid address');
      return { ok: true, value: { email: r.value.toLowerCase() } };
    },
  },
  {
    name: "get_equipment",
    title: "Get customer equipment",
    description: "List the equipment installed for one customer (type, make, model, serial, install date, warranty expiry, service interval).",
    scope: "equipment:read",
    write: false,
    inputSchema: {
      type: "object",
      properties: {
        customer_id: { type: "string", format: "uuid" },
        status: { type: "string", enum: ["active", "replaced", "removed", "all"], default: "active" },
      },
      required: ["customer_id"],
      additionalProperties: false,
    },
    annotations: READ,
    validate(args) {
      if (!isObj(args)) return fail("Arguments must be an object");
      const k = strictKeys(args, ["customer_id", "status"]);
      if (k) return fail(k);
      const id = reqUuid(args, "customer_id");
      if (!id.ok) return id;
      const status = args.status ?? "active";
      if (!["active", "replaced", "removed", "all"].includes(status as string)) return fail('"status" must be active, replaced, removed or all');
      return { ok: true, value: { customer_id: id.value, status } };
    },
  },
  {
    name: "get_job",
    title: "Get job",
    description: "Fetch one job by id: status, schedule, address, assigned technician and invoice status.",
    scope: "jobs:read",
    write: false,
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string", format: "uuid" } },
      required: ["job_id"],
      additionalProperties: false,
    },
    annotations: READ,
    validate(args) {
      if (!isObj(args)) return fail("Arguments must be an object");
      const k = strictKeys(args, ["job_id"]);
      if (k) return fail(k);
      const id = reqUuid(args, "job_id");
      return id.ok ? { ok: true, value: { job_id: id.value } } : id;
    },
  },
  {
    name: "check_schedule",
    title: "Check schedule & technician availability",
    description: "Jobs booked in a time window (max 14 days) and, per technician, how many job slots remain each UTC day. Use before dispatch_technician.",
    scope: "schedule:read",
    write: false,
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", format: "date-time" },
        to: { type: "string", format: "date-time" },
        technician_id: { type: "string", format: "uuid" },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    annotations: READ,
    validate(args) {
      if (!isObj(args)) return fail("Arguments must be an object");
      const k = strictKeys(args, ["from", "to", "technician_id"]);
      if (k) return fail(k);
      const from = isoDate(args, "from");
      if (!from.ok) return from;
      const to = isoDate(args, "to");
      if (!to.ok) return to;
      const span = Date.parse(to.value) - Date.parse(from.value);
      if (span <= 0) return fail('"to" must be after "from"');
      if (span > 14 * 86_400_000) return fail("The window can be at most 14 days");
      const out: Obj = { from: from.value, to: to.value };
      if (args.technician_id !== undefined) {
        const t = reqUuid(args, "technician_id");
        if (!t.ok) return t;
        out.technician_id = t.value;
      }
      return { ok: true, value: out };
    },
  },
  {
    name: "check_inventory",
    title: "Check parts inventory",
    description: "Stock for parts matching an exact part_number or a name search: on hand, reserved and available per location, plus a below-reorder-point flag. Max 20 parts.",
    scope: "inventory:read",
    write: false,
    inputSchema: {
      type: "object",
      properties: {
        part_number: { type: "string", maxLength: 64 },
        query: { type: "string", minLength: 2, maxLength: 60 },
      },
      additionalProperties: false,
      oneOf: [{ required: ["part_number"] }, { required: ["query"] }],
    },
    annotations: READ,
    validate(args) {
      if (!isObj(args)) return fail("Arguments must be an object");
      const k = strictKeys(args, ["part_number", "query"]);
      if (k) return fail(k);
      const present = ["part_number", "query"].filter((x) => args[x] !== undefined);
      if (present.length !== 1) return fail("Provide exactly one of part_number or query");
      const key = present[0];
      const r = reqStr(args, key, key === "query" ? 2 : 1, key === "query" ? 60 : 64);
      return r.ok ? { ok: true, value: { [key]: r.value } } : r;
    },
  },
  {
    name: "create_quote",
    title: "Create draft quote",
    description: "Create a DRAFT quote (never sent to the customer). Needs human approval by default. A person reviews and sends it from Vireek. Amounts are integer cents.",
    scope: "quotes:create",
    write: true,
    actionSlug: "agent_net_create_quote",
    inputSchema: {
      type: "object",
      properties: {
        idempotency_key: idemProp,
        customer_name: { type: "string", minLength: 1, maxLength: 120 },
        customer_phone: { type: "string", maxLength: 32 },
        customer_email: { type: "string", maxLength: 254 },
        line_items: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              description: { type: "string", minLength: 1, maxLength: 200 },
              quantity: { type: "number", exclusiveMinimum: 0, maximum: 10000 },
              unit_price_cents: { type: "integer", minimum: 0, maximum: MAX_CENTS },
            },
            required: ["description", "quantity", "unit_price_cents"],
            additionalProperties: false,
          },
        },
        tax_percent: { type: "number", minimum: 0, maximum: 30, default: 0 },
        valid_days: { type: "integer", minimum: 1, maximum: 90, default: 14 },
      },
      required: ["idempotency_key", "customer_name", "line_items"],
      additionalProperties: false,
    },
    annotations: WRITE,
    validate(args) {
      if (!isObj(args)) return fail("Arguments must be an object");
      const k = strictKeys(args, ["idempotency_key", "customer_name", "customer_phone", "customer_email", "line_items", "tax_percent", "valid_days"]);
      if (k) return fail(k);
      const idem = reqIdem(args);
      if (!idem.ok) return idem;
      const name = reqStr(args, "customer_name", 1, 120);
      if (!name.ok) return name;
      const phone = optStr(args, "customer_phone", 7, 32);
      if (!phone.ok) return phone;
      const email = optStr(args, "customer_email", 5, 254);
      if (!email.ok) return email;
      if (email.value && !EMAIL_RE.test(email.value)) return fail('"customer_email" is not a valid address');
      if (!Array.isArray(args.line_items) || args.line_items.length < 1 || args.line_items.length > 50) {
        return fail('"line_items" must be an array of 1-50 items');
      }
      const lines: QuoteLine[] = [];
      for (const [i, raw] of args.line_items.entries()) {
        if (!isObj(raw)) return fail(`line_items[${i}] must be an object`);
        const lk = strictKeys(raw, ["description", "quantity", "unit_price_cents"]);
        if (lk) return fail(`line_items[${i}]: ${lk}`);
        const d = reqStr(raw, "description", 1, 200);
        if (!d.ok) return fail(`line_items[${i}]: ${d.error}`);
        const q = raw.quantity;
        if (typeof q !== "number" || !Number.isFinite(q) || q <= 0 || q > 10000) return fail(`line_items[${i}].quantity must be a number > 0 and <= 10000`);
        const p = raw.unit_price_cents;
        if (typeof p !== "number" || !Number.isInteger(p) || p < 0 || p > MAX_CENTS) return fail(`line_items[${i}].unit_price_cents must be an integer 0-${MAX_CENTS}`);
        lines.push({ description: d.value, quantity: Math.round(q * 100) / 100, unit_price_cents: p });
      }
      const tax = args.tax_percent ?? 0;
      if (typeof tax !== "number" || !Number.isFinite(tax) || tax < 0 || tax > 30) return fail('"tax_percent" must be 0-30');
      const days = args.valid_days ?? 14;
      if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 90) return fail('"valid_days" must be an integer 1-90');
      const totals = quoteTotals(lines, tax);
      if (totals.totalCents > MAX_CENTS) return fail(`Quote total exceeds the ${MAX_CENTS / 100} USD limit`);
      return {
        ok: true,
        value: {
          idempotency_key: idem.value, customer_name: name.value,
          customer_phone: phone.value, customer_email: email.value?.toLowerCase(),
          line_items: lines, tax_percent: tax, valid_days: days,
        },
      };
    },
  },
  {
    name: "dispatch_technician",
    title: "Assign technician to job",
    description: "Assign one technician to one scheduled job. Enforces the technician's daily capacity. Needs human approval by default. Call check_schedule first.",
    scope: "dispatch:assign",
    write: true,
    actionSlug: "agent_net_dispatch_technician",
    inputSchema: {
      type: "object",
      properties: {
        idempotency_key: idemProp,
        job_id: { type: "string", format: "uuid" },
        technician_id: { type: "string", format: "uuid" },
        reason: { type: "string", maxLength: 300, description: "Shown to the human approver." },
      },
      required: ["idempotency_key", "job_id", "technician_id"],
      additionalProperties: false,
    },
    annotations: WRITE,
    validate(args) {
      if (!isObj(args)) return fail("Arguments must be an object");
      const k = strictKeys(args, ["idempotency_key", "job_id", "technician_id", "reason"]);
      if (k) return fail(k);
      const idem = reqIdem(args);
      if (!idem.ok) return idem;
      const job = reqUuid(args, "job_id");
      if (!job.ok) return job;
      const tech = reqUuid(args, "technician_id");
      if (!tech.ok) return tech;
      const reason = optStr(args, "reason", 1, 300);
      if (!reason.ok) return reason;
      return { ok: true, value: { idempotency_key: idem.value, job_id: job.value, technician_id: tech.value, reason: reason.value } };
    },
  },
  {
    name: "send_customer_message",
    title: "Send customer SMS",
    description: "Send an SMS to an EXISTING customer (by customer_id). Goes through A2P registration and do-not-contact checks. Needs human approval by default.",
    scope: "messages:send",
    write: true,
    actionSlug: "agent_net_send_message",
    inputSchema: {
      type: "object",
      properties: {
        idempotency_key: idemProp,
        customer_id: { type: "string", format: "uuid" },
        body: { type: "string", minLength: 1, maxLength: 480 },
      },
      required: ["idempotency_key", "customer_id", "body"],
      additionalProperties: false,
    },
    annotations: WRITE_EXTERNAL,
    validate(args) {
      if (!isObj(args)) return fail("Arguments must be an object");
      const k = strictKeys(args, ["idempotency_key", "customer_id", "body"]);
      if (k) return fail(k);
      const idem = reqIdem(args);
      if (!idem.ok) return idem;
      const cust = reqUuid(args, "customer_id");
      if (!cust.ok) return cust;
      const body = reqStr(args, "body", 1, 480);
      if (!body.ok) return body;
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(body.value)) return fail('"body" contains control characters');
      return { ok: true, value: { idempotency_key: idem.value, customer_id: cust.value, body: body.value } };
    },
  },
  {
    name: "collect_payment",
    title: "Create payment link for a job",
    description: "Create a Stripe payment link for a job's invoice amount (the amount cannot be chosen by the caller). Does NOT message the customer. Use send_customer_message for that. Needs human approval by default.",
    scope: "payments:collect",
    write: true,
    actionSlug: "agent_net_collect_payment",
    inputSchema: {
      type: "object",
      properties: { idempotency_key: idemProp, job_id: { type: "string", format: "uuid" } },
      required: ["idempotency_key", "job_id"],
      additionalProperties: false,
    },
    annotations: WRITE_EXTERNAL,
    validate(args) {
      if (!isObj(args)) return fail("Arguments must be an object");
      const k = strictKeys(args, ["idempotency_key", "job_id"]);
      if (k) return fail(k);
      const idem = reqIdem(args);
      if (!idem.ok) return idem;
      const job = reqUuid(args, "job_id");
      if (!job.ok) return job;
      return { ok: true, value: { idempotency_key: idem.value, job_id: job.value } };
    },
  },
  {
    name: "get_action_status",
    title: "Get action status",
    description: "Status and result of one of YOUR earlier calls (call_id). If a human has approved a pending action, calling this runs it and returns the result.",
    scope: null,
    write: false,
    inputSchema: {
      type: "object",
      properties: { call_id: { type: "string", format: "uuid" } },
      required: ["call_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    validate(args) {
      if (!isObj(args)) return fail("Arguments must be an object");
      const k = strictKeys(args, ["call_id"]);
      if (k) return fail(k);
      const id = reqUuid(args, "call_id");
      return id.ok ? { ok: true, value: { call_id: id.value } } : id;
    },
  },
];

const BY_NAME = new Map<string, ToolDef>(TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}

export function toolsForScopes(scopes: readonly string[]): ToolDef[] {
  return TOOLS.filter((t) => t.scope === null || scopes.includes(t.scope));
}

export function hasScope(scopes: readonly string[], tool: ToolDef): boolean {
  return tool.scope === null || scopes.includes(tool.scope);
}

// ------------------------------------------------------------------
// Pure helpers used by handlers
// ------------------------------------------------------------------

export function quoteTotals(lines: QuoteLine[], taxPercent: number): { subtotalCents: number; taxCents: number; totalCents: number } {
  const subtotalCents = lines.reduce((s, l) => s + Math.round(l.quantity * l.unit_price_cents), 0);
  const taxCents = Math.round((subtotalCents * taxPercent) / 100);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

/** Stable JSON (sorted keys) so the same arguments always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObj(value)) {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Escape LIKE wildcards so a caller's text can never widen a search. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface ScheduleJob {
  id: string;
  scheduled_datetime: string | null;
  job_status: string;
  assigned_technician_id: string | null;
  service_type: string | null;
}
export interface ScheduleTech {
  id: string;
  member_name: string | null;
  max_jobs_per_day: number | null;
}
export interface TechAvailability {
  technician_id: string;
  name: string | null;
  capacity: number;
  days: Array<{ date: string; booked: number; available: number }>;
}

const ACTIVE_JOB = new Set(["scheduled", "en_route", "in_progress"]);

export function utcDays(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  const start = new Date(fromIso);
  const end = new Date(toIso);
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  while (d.getTime() < end.getTime() && out.length < 16) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function computeAvailability(jobs: ScheduleJob[], techs: ScheduleTech[], fromIso: string, toIso: string): TechAvailability[] {
  const days = utcDays(fromIso, toIso);
  return techs.map((t) => {
    const capacity = t.max_jobs_per_day ?? 6;
    return {
      technician_id: t.id,
      name: t.member_name,
      capacity,
      days: days.map((date) => {
        const booked = jobs.filter(
          (j) => j.assigned_technician_id === t.id && ACTIVE_JOB.has(j.job_status) && j.scheduled_datetime?.slice(0, 10) === date,
        ).length;
        return { date, booked, available: Math.max(0, capacity - booked) };
      }),
    };
  });
}

export interface StockPart {
  id: string;
  part_number: string | null;
  name: string;
  unit_label: string | null;
  reorder_point: number;
}
export interface StockLevel {
  part_id: string;
  location_id: string;
  quantity_on_hand: number;
  quantity_reserved: number;
}
export interface StockLocation {
  id: string;
  name: string;
  location_type: string;
  active: boolean;
}

export function summarizeStock(parts: StockPart[], levels: StockLevel[], locations: StockLocation[]) {
  const locById = new Map(locations.map((l) => [l.id, l]));
  return parts.map((p) => {
    const mine = levels.filter((l) => l.part_id === p.id && locById.get(l.location_id)?.active !== false);
    const onHand = mine.reduce((s, l) => s + l.quantity_on_hand, 0);
    const reserved = mine.reduce((s, l) => s + l.quantity_reserved, 0);
    const available = onHand - reserved;
    return {
      part_id: p.id,
      part_number: p.part_number,
      name: p.name,
      unit: p.unit_label,
      total_on_hand: onHand,
      total_reserved: reserved,
      total_available: available,
      below_reorder_point: p.reorder_point > 0 && available <= p.reorder_point,
      locations: mine.map((l) => ({
        name: locById.get(l.location_id)?.name ?? "unknown",
        type: locById.get(l.location_id)?.location_type ?? "other",
        on_hand: l.quantity_on_hand,
        reserved: l.quantity_reserved,
        available: l.quantity_on_hand - l.quantity_reserved,
      })),
    };
  });
}
