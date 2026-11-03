// supabase/functions/_shared/consumer-agent/spec.ts
//
// Pure (no I/O, no Deno APIs) definition of the PUBLIC Consumer Agent surface: the four tools a homeowner's
// AI agent may call, their JSON Schemas, strict argument validation, and the API version constants.
// Deliberately separate from _shared/agent-network/tools.ts (owner-authenticated, 11 tools). This surface can
// never reach customers, jobs, equipment, inventory, quotes, dispatch, messaging or payments.

import type { ValidationResult } from "../agent-network/tools.ts";
import { normalizeEmail, normalizePhone, POSTAL_RE, sanitizeFreeText, sanitizeLabel, type RiskFlag } from "./sanitize.ts";

export const CONSUMER_API_VERSION = "1.0.0";
export const CONSUMER_API_MAJOR = "v1";
export const SANDBOX_SLUG = "vireek-sandbox";
export const SLUG_RE = /^[a-z0-9-]{3,60}$/;
export const IDEM_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

export type ConsumerToolName = "get_business_info" | "get_price_range" | "check_availability" | "request_booking";

export const SECTIONS = ["services", "service_area", "hours", "prices", "reviews", "policies", "contact"] as const;
export type Section = (typeof SECTIONS)[number];

export interface ConsumerToolDef {
  name: ConsumerToolName;
  title: string;
  description: string;
  write: boolean;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  validate: (args: unknown) => ValidationResult<Record<string, unknown>>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function strictKeys(a: Obj, allowed: readonly string[]): string | null {
  for (const k of Object.keys(a)) if (!allowed.includes(k)) return `Unknown argument "${k}"`;
  return null;
}

function optLabel(a: Obj, key: string, min: number, max: number, flags: RiskFlag[]): ValidationResult<string | undefined> {
  const v = a[key];
  if (v === undefined) return { ok: true, value: undefined };
  if (typeof v !== "string") return fail(`"${key}" must be a string`);
  if (v.length > max * 4) return fail(`"${key}" is too long (max ${max} characters)`);
  const s = sanitizeLabel(v, max);
  if (s.text.length < min) return fail(`"${key}" must be ${min}-${max} characters`);
  flags.push(...s.flags);
  return { ok: true, value: s.text };
}

function isoTime(a: Obj, key: string): ValidationResult<string | undefined> {
  const v = a[key];
  if (v === undefined) return { ok: true, value: undefined };
  const t = typeof v === "string" && v.length <= 40 ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) return fail(`"${key}" must be an ISO 8601 timestamp`);
  return { ok: true, value: new Date(t).toISOString() };
}

function postal(a: Obj, required: boolean): ValidationResult<string | undefined> {
  const v = a.postal_code;
  if (v === undefined) return required ? fail('"postal_code" is required') : { ok: true, value: undefined };
  if (typeof v !== "string" || !POSTAL_RE.test(v.trim())) return fail('"postal_code" must be 3-10 letters, digits, spaces or hyphens');
  return { ok: true, value: v.trim().toUpperCase().replace(/\s+/g, " ") };
}

// ------------------------------------------------------------------

const GET_BUSINESS_INFO: ConsumerToolDef = {
  name: "get_business_info",
  title: "Get business information",
  description:
    "Public profile of this home-service business: name, services, service area, opening hours, owner-published price ranges, " +
    "a real-review summary, policies and contact options. Returns ONLY the sections the owner chose to publish. Read-only.",
  write: false,
  inputSchema: {
    type: "object",
    properties: { sections: { type: "array", items: { type: "string", enum: [...SECTIONS] }, maxItems: SECTIONS.length, uniqueItems: true } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  validate(args) {
    if (args === undefined || args === null) return { ok: true, value: {} };
    if (!isObj(args)) return fail("Arguments must be an object");
    const bad = strictKeys(args, ["sections"]);
    if (bad) return fail(bad);
    if (args.sections === undefined) return { ok: true, value: {} };
    if (!Array.isArray(args.sections) || args.sections.length > SECTIONS.length) return fail('"sections" must be an array of section names');
    const out: string[] = [];
    for (const s of args.sections) {
      if (typeof s !== "string" || !(SECTIONS as readonly string[]).includes(s)) return fail(`Unknown section "${String(s).slice(0, 30)}"`);
      if (!out.includes(s)) out.push(s);
    }
    return { ok: true, value: { sections: out } };
  },
};

const GET_PRICE_RANGE: ConsumerToolDef = {
  name: "get_price_range",
  title: "Get published price range",
  description:
    "Price range for a service, ONLY if the owner published one. A range is an estimate for planning, not a quote and not a charge. " +
    "If nothing is published the answer says so; use request_booking to ask the business for a quote. Read-only.",
  write: false,
  inputSchema: {
    type: "object",
    properties: { service: { type: "string", minLength: 1, maxLength: 120, description: "Service name or keywords, e.g. \"drain cleaning\". Omit to list every published price." } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  validate(args) {
    if (args === undefined || args === null) return { ok: true, value: {} };
    if (!isObj(args)) return fail("Arguments must be an object");
    const bad = strictKeys(args, ["service"]);
    if (bad) return fail(bad);
    const flags: RiskFlag[] = [];
    const s = optLabel(args, "service", 1, 120, flags);
    if (!s.ok) return s;
    return { ok: true, value: s.value === undefined ? {} : { service: s.value } };
  },
};

const CHECK_AVAILABILITY: ConsumerToolDef = {
  name: "check_availability",
  title: "Check verified availability windows",
  description:
    "Start times the business can really take, computed from its live schedule and capacity (no staff names or customer data). " +
    "Windows expire after about two minutes. Pass requested_start to test one time. Never promise a time this tool did not return; " +
    "a request is only a request until the business confirms. Read-only.",
  write: false,
  inputSchema: {
    type: "object",
    properties: {
      service_type: { type: "string", minLength: 1, maxLength: 120 },
      postal_code: { type: "string", minLength: 3, maxLength: 10, description: "Checks the address is inside the service area." },
      days: { type: "integer", minimum: 1, maximum: 14, default: 7 },
      requested_start: { type: "string", format: "date-time" },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  validate(args) {
    if (args === undefined || args === null) return { ok: true, value: { days: 7 } };
    if (!isObj(args)) return fail("Arguments must be an object");
    const bad = strictKeys(args, ["service_type", "postal_code", "days", "requested_start"]);
    if (bad) return fail(bad);
    const flags: RiskFlag[] = [];
    const out: Obj = { days: 7 };
    const svc = optLabel(args, "service_type", 1, 120, flags);
    if (!svc.ok) return svc;
    if (svc.value !== undefined) out.service_type = svc.value;
    const pc = postal(args, false);
    if (!pc.ok) return pc;
    if (pc.value !== undefined) out.postal_code = pc.value;
    if (args.days !== undefined) {
      if (typeof args.days !== "number" || !Number.isInteger(args.days) || args.days < 1 || args.days > 14) return fail('"days" must be an integer 1-14');
      out.days = args.days;
    }
    const rs = isoTime(args, "requested_start");
    if (!rs.ok) return rs;
    if (rs.value !== undefined) out.requested_start = rs.value;
    return { ok: true, value: out };
  },
};

const REQUEST_BOOKING: ConsumerToolDef = {
  name: "request_booking",
  title: "Request a service visit (pending, never confirmed or paid)",
  description:
    "Sends the business a REQUEST for a visit at a time returned by check_availability. It creates only a pending request (or a short held slot, " +
    "if the owner allows holds). It does NOT confirm the appointment, does NOT take or promise payment, and the business may decline. " +
    "Only call after the homeowner agreed to share their contact details with this business (homeowner_consent: true). " +
    "idempotency_key is required: repeating the same key returns the same request. Unknown agents must also solve the proof-of-work challenge " +
    "from GET /v1/challenge. Poll the A2A tasks/get method with request_id + status_token for the outcome.",
  write: true,
  inputSchema: {
    type: "object",
    required: ["idempotency_key", "service_type", "requested_start", "contact_name", "postal_code", "homeowner_consent"],
    properties: {
      idempotency_key: { type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9_.:-]{8,128}$" },
      service_type: { type: "string", minLength: 1, maxLength: 120 },
      requested_start: { type: "string", format: "date-time" },
      contact_name: { type: "string", minLength: 2, maxLength: 80 },
      contact_phone: { type: "string", minLength: 7, maxLength: 20 },
      contact_email: { type: "string", maxLength: 254 },
      postal_code: { type: "string", minLength: 3, maxLength: 10 },
      address_line: { type: "string", maxLength: 120 },
      description: { type: "string", maxLength: 500, description: "What needs doing. Plain text only; links and markup are removed." },
      homeowner_consent: { type: "boolean", const: true },
      agent_name: { type: "string", maxLength: 60, description: "Your assistant's name, shown to the business." },
      challenge: {
        type: "object", required: ["token", "nonce"], additionalProperties: false,
        properties: { token: { type: "string", maxLength: 600 }, nonce: { type: "string", maxLength: 64 } },
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  validate(args) {
    if (!isObj(args)) return fail("Arguments must be an object");
    const bad = strictKeys(args, [
      "idempotency_key", "service_type", "requested_start", "contact_name", "contact_phone", "contact_email",
      "postal_code", "address_line", "description", "homeowner_consent", "agent_name", "challenge",
    ]);
    if (bad) return fail(bad);

    if (typeof args.idempotency_key !== "string" || !IDEM_RE.test(args.idempotency_key)) {
      return fail('"idempotency_key" is required: 8-128 chars of A-Z a-z 0-9 _ . : -');
    }
    if (args.homeowner_consent !== true) return fail('"homeowner_consent" must be true: the homeowner must agree to share contact details with this business');

    const flags: RiskFlag[] = [];
    const svc = optLabel(args, "service_type", 1, 120, flags);
    if (!svc.ok) return svc;
    if (svc.value === undefined) return fail('"service_type" is required');
    const name = optLabel(args, "contact_name", 2, 80, flags);
    if (!name.ok) return name;
    if (name.value === undefined) return fail('"contact_name" is required');
    const agent = optLabel(args, "agent_name", 1, 60, flags);
    if (!agent.ok) return agent;

    const start = isoTime(args, "requested_start");
    if (!start.ok) return start;
    if (start.value === undefined) return fail('"requested_start" is required');

    const pc = postal(args, true);
    if (!pc.ok) return pc;

    let phone: string | null = null;
    if (args.contact_phone !== undefined) {
      phone = normalizePhone(args.contact_phone);
      if (!phone) return fail('"contact_phone" is not a valid phone number');
    }
    let email: string | null = null;
    if (args.contact_email !== undefined) {
      email = normalizeEmail(args.contact_email);
      if (!email) return fail('"contact_email" is not a valid email address');
    }
    if (!phone && !email) return fail("Provide contact_phone or contact_email so the business can reach the homeowner");

    let address: string | null = null;
    if (args.address_line !== undefined) {
      if (typeof args.address_line !== "string" || args.address_line.length > 500) return fail('"address_line" must be at most 120 characters');
      const a = sanitizeLabel(args.address_line, 120);
      flags.push(...a.flags);
      address = a.text || null;
    }
    let description: string | null = null;
    if (args.description !== undefined) {
      if (typeof args.description !== "string" || args.description.length > 4000) return fail('"description" must be at most 500 characters');
      const d = sanitizeFreeText(args.description, 500);
      flags.push(...d.flags);
      description = d.text || null;
    }

    let challenge: { token: string; nonce: string } | null = null;
    if (args.challenge !== undefined) {
      const c = args.challenge;
      if (!isObj(c) || strictKeys(c, ["token", "nonce"]) || typeof c.token !== "string" || typeof c.nonce !== "string"
          || c.token.length > 600 || c.nonce.length === 0 || c.nonce.length > 64 || !/^[A-Za-z0-9_.-]+$/.test(c.nonce)) {
        return fail('"challenge" must be {token, nonce} exactly as described by GET /v1/challenge');
      }
      challenge = { token: c.token, nonce: c.nonce };
    }

    return {
      ok: true,
      value: {
        idempotency_key: args.idempotency_key,
        service_type: svc.value, requested_start: start.value, contact_name: name.value,
        contact_phone: phone, contact_email: email, postal_code: pc.value,
        address_line: address, description, agent_name: agent.value ?? null, challenge,
        risk_flags: [...new Set(flags)],
      },
    };
  },
};

export const CONSUMER_TOOLS: readonly ConsumerToolDef[] = [GET_BUSINESS_INFO, GET_PRICE_RANGE, CHECK_AVAILABILITY, REQUEST_BOOKING];
export const getConsumerTool = (name: string): ConsumerToolDef | undefined => CONSUMER_TOOLS.find((t) => t.name === name);

export const mcpConsumerToolDescriptor = (t: ConsumerToolDef) => ({
  name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations,
});
