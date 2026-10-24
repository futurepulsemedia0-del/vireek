// MCP / A2A tool `check_availability`: the same capacity engine the booking page, voice agent and SMS
// use, exposed read-only to connected agents with an explanation of why each time was offered or hidden.
// The definition is pure (no I/O) so tools.ts can include it in TOOLS and vitest can test it;
// the handler (I/O) lives in mcpHandler.ts and is only imported by supabase/functions/mcp-server.

import type { ToolDef, ValidationResult } from "../agent-network/tools.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (error: string): ValidationResult<Obj> => ({ ok: false, error });
const KEYS = ["service_type", "address", "lat", "lon", "emergency", "requested_start", "days", "include_hidden"];

export const CHECK_AVAILABILITY_TOOL: Omit<ToolDef, "name"> & { name: "check_availability" } = {
  name: "check_availability",
  title: "Check bookable times (capacity-aware)",
  description:
    "Bookable start times that a qualified technician can really take (skills, service zone, time off, drive time, predicted duration, buffers, emergency reserve, controlled overbooking), each with an explanation. " +
    "Pass requested_start to test one specific time and get the nearest alternatives. Never promise a time this tool does not return. Needs capacity booking enabled by the business.",
  scope: "schedule:read",
  write: false,
  inputSchema: {
    type: "object",
    properties: {
      service_type: { type: "string", maxLength: 120 },
      address: { type: "string", maxLength: 300 },
      lat: { type: "number", minimum: -90, maximum: 90 },
      lon: { type: "number", minimum: -180, maximum: 180 },
      emergency: { type: "boolean" },
      requested_start: { type: "string", format: "date-time" },
      days: { type: "integer", minimum: 1, maximum: 14 },
      include_hidden: { type: "boolean", description: "Also return unavailable times with the reason they are hidden." },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  validate(args) {
    if (!isObj(args)) return fail("Arguments must be an object");
    for (const k of Object.keys(args)) if (!KEYS.includes(k)) return fail(`Unknown argument "${k}"`);
    const out: Obj = {};
    for (const [k, max] of [["service_type", 120], ["address", 300]] as const) {
      const v = args[k];
      if (v === undefined) continue;
      if (typeof v !== "string" || v.trim().length < 1 || v.length > max) return fail(`"${k}" must be 1-${max} characters`);
      out[k] = v.trim();
    }
    for (const [k, lo, hi] of [["lat", -90, 90], ["lon", -180, 180]] as const) {
      const v = args[k];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) return fail(`"${k}" must be a number between ${lo} and ${hi}`);
      out[k] = v;
    }
    if ((out.lat === undefined) !== (out.lon === undefined)) return fail('"lat" and "lon" must be given together');
    for (const k of ["emergency", "include_hidden"]) {
      if (args[k] === undefined) continue;
      if (typeof args[k] !== "boolean") return fail(`"${k}" must be a boolean`);
      out[k] = args[k];
    }
    if (args.requested_start !== undefined) {
      const t = typeof args.requested_start === "string" ? Date.parse(args.requested_start) : NaN;
      if (!Number.isFinite(t)) return fail('"requested_start" must be an ISO 8601 timestamp');
      out.requested_start = new Date(t).toISOString();
    }
    if (args.days !== undefined) {
      const d = args.days;
      if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 14) return fail('"days" must be an integer 1-14');
      out.days = d;
    }
    return { ok: true, value: out };
  },
};
