// supabase/functions/_shared/agent-network/guards.ts
//
// Pure edge guards for the Agent Network door (no I/O, unit-tested):
//   * Origin validation (MCP Streamable HTTP: servers MUST validate Origin against DNS rebinding)
//   * CORS that reflects only allow-listed origins (no wildcard)
//   * MCP-Protocol-Version header validation
//   * rate-limit cost of a JSON-RPC batch (a batch of N costs N, not 1)

import { MCP_SUPPORTED_VERSIONS } from "./protocol.ts";

export function parseAllowedOrigins(raw: string | undefined | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, "").toLowerCase())
    .filter((s) => /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(s));
}

/**
 * No Origin header = non-browser client (servers, CLIs): allowed, bearer key still required.
 * Origin present = must be in the allow-list; an empty allow-list therefore blocks all browsers.
 */
export function originAllowed(origin: string | null, allowed: readonly string[]): boolean {
  if (origin === null || origin === "") return true;
  return allowed.includes(origin.trim().replace(/\/$/, "").toLowerCase());
}

export function corsHeadersFor(origin: string | null, allowed: readonly string[]): Record<string, string> {
  const base: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && originAllowed(origin, allowed)) base["Access-Control-Allow-Origin"] = origin;
  return base;
}

/** Absent header is allowed (spec: server assumes 2025-03-26). A present but unsupported value is a 400. */
export function protocolHeaderValid(value: string | null): boolean {
  if (value === null || value === "") return true;
  return (MCP_SUPPORTED_VERSIONS as readonly string[]).includes(value.trim());
}

/** Number of gate units one HTTP request consumes: every JSON-RPC message that is not a pure notification. */
export function batchCost(itemCount: number): number {
  if (!Number.isFinite(itemCount) || itemCount < 1) return 1;
  return Math.min(Math.floor(itemCount), 20);
}
