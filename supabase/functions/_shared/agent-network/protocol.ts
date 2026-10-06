// supabase/functions/_shared/agent-network/protocol.ts
//
// Pure protocol layer for the Vireek Agent Network: JSON-RPC 2.0 framing,
// MCP (Model Context Protocol) message builders, and A2A (Agent2Agent)
// agent card / task mapping. No I/O, so it is unit-tested with vitest.
//
// Spec versions this targets (verify against the live specs when upgrading):
//   MCP  Streamable HTTP, JSON responses, tools capability only
//   A2A  protocol 0.3 JSON-RPC: message/send, tasks/get, tasks/cancel

import { TOOLS, toolsForScopes, type ToolDef } from "./tools.ts";

// ------------------------------------------------------------------
// JSON-RPC 2.0
// ------------------------------------------------------------------

export type RpcId = string | number | null;

export interface RpcRequest {
  jsonrpc: "2.0";
  id?: RpcId; // absent = notification
  method: string;
  params?: unknown;
}

export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // A2A-specific
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  UNSUPPORTED_OPERATION: -32004,
} as const;

export type ParsedBody =
  | { kind: "invalid"; error: { code: number; message: string } }
  | { kind: "requests"; items: Array<RpcRequest | { invalid: true; id: RpcId }>; batch: boolean };

export const MAX_BATCH = 20;

export function parseRpcBody(text: string): ParsedBody {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "invalid", error: { code: RPC.PARSE_ERROR, message: "Parse error" } };
  }
  const batch = Array.isArray(raw);
  const list = batch ? (raw as unknown[]) : [raw];
  if (list.length === 0) return { kind: "invalid", error: { code: RPC.INVALID_REQUEST, message: "Empty batch" } };
  if (list.length > MAX_BATCH) return { kind: "invalid", error: { code: RPC.INVALID_REQUEST, message: `Batch too large (max ${MAX_BATCH})` } };
  const items = list.map((r): RpcRequest | { invalid: true; id: RpcId } => {
    if (typeof r !== "object" || r === null || Array.isArray(r)) return { invalid: true, id: null };
    const o = r as Record<string, unknown>;
    const id = typeof o.id === "string" || typeof o.id === "number" ? (o.id as RpcId) : o.id === undefined ? undefined : null;
    if (o.jsonrpc !== "2.0" || typeof o.method !== "string" || o.method.length === 0 || o.method.length > 100) {
      return { invalid: true, id: id ?? null };
    }
    return { jsonrpc: "2.0", id, method: o.method, params: o.params };
  });
  return { kind: "requests", items, batch };
}

export const rpcResult = (id: RpcId, result: unknown) => ({ jsonrpc: "2.0" as const, id, result });
export const rpcError = (id: RpcId, code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0" as const,
  id,
  error: data === undefined ? { code, message } : { code, message, data },
});

// ------------------------------------------------------------------
// MCP
// ------------------------------------------------------------------

export const MCP_SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const SERVER_INFO = { name: "vireek", title: "Vireek Field Service", version: "1.0.0" };

export function negotiateMcpVersion(requested: unknown): string {
  return typeof requested === "string" && (MCP_SUPPORTED_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : MCP_SUPPORTED_VERSIONS[0];
}

export function mcpInitializeResult(requested: unknown) {
  return {
    protocolVersion: negotiateMcpVersion(requested),
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions:
      "Vireek field-service tools. Read tools return live data scoped to one business. Write tools (create_quote, dispatch_technician, send_customer_message, collect_payment) " +
      "require an idempotency_key and may return status \"pending_approval\": a human must approve in Vireek, then call get_action_status with the returned call_id to run it and fetch the result.",
  };
}

export function mcpToolDescriptor(t: ToolDef) {
  return { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations };
}

export function mcpToolsList(scopes: readonly string[]) {
  return { tools: toolsForScopes(scopes).map(mcpToolDescriptor) };
}

export type ToolOutcome =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; code: string; message: string };

export function mcpToolResult(outcome: ToolOutcome) {
  if (outcome.ok) {
    return { content: [{ type: "text", text: JSON.stringify(outcome.data) }], structuredContent: outcome.data, isError: false };
  }
  return {
    content: [{ type: "text", text: JSON.stringify({ error: outcome.code, message: outcome.message }) }],
    isError: true,
  };
}

// ------------------------------------------------------------------
// A2A
// ------------------------------------------------------------------

export const A2A_PROTOCOL_VERSION = "0.3.0";

const SKILL_TAGS: Record<string, string[]> = {
  get_customer: ["crm", "customer"], get_equipment: ["equipment", "warranty"], get_job: ["jobs"],
  check_schedule: ["schedule", "dispatch"], check_inventory: ["inventory", "parts"],
  create_quote: ["quote", "sales"], dispatch_technician: ["dispatch"], send_customer_message: ["messaging"],
  collect_payment: ["payments"], get_action_status: ["status"],
};

export function buildAgentCard(opts: { endpointUrl: string; siteUrl: string }) {
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: "Vireek",
    description:
      "Field-service operations agent: customers, equipment, jobs, schedule, parts inventory, quotes, dispatch, customer messaging and payment links. " +
      "Skills are invoked with a data part {\"skill\": <id>, \"arguments\": {...}}. Writes are human-approved by default.",
    url: opts.endpointUrl,
    preferredTransport: "JSONRPC",
    version: "1.0.0",
    provider: { organization: "Vireek", url: opts.siteUrl },
    documentationUrl: `${opts.siteUrl}/docs`,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    securitySchemes: {
      agentKey: {
        type: "http",
        scheme: "bearer",
        description: "Vireek agent key (vrk_agent_...) created by the business in Dashboard > Agent Network.",
      },
    },
    security: [{ agentKey: [] }],
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: TOOLS.map((t) => ({
      id: t.name,
      name: t.title,
      description: t.description,
      tags: SKILL_TAGS[t.name] ?? [],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    })),
  };
}

export type A2aState = "submitted" | "working" | "input-required" | "completed" | "canceled" | "failed" | "rejected" | "auth-required" | "unknown";

/** Maps agent_network_calls.status to an A2A task state. */
export function a2aStateForStatus(status: string): A2aState {
  switch (status) {
    case "ok":
    case "executed":
      return "completed";
    case "pending_approval":
      return "input-required";
    case "received":
      return "submitted";
    case "executing":
      return "working";
    case "rejected":
      return "rejected";
    case "canceled":
      return "canceled";
    case "failed":
    case "error":
      return "failed";
    default:
      return "unknown";
  }
}

export interface A2aInvocation {
  skill: string;
  args: unknown;
}

/** Finds the first data part carrying {skill|tool, arguments|args}. Text-only messages return null. */
export function extractA2aInvocation(message: unknown): A2aInvocation | null {
  if (typeof message !== "object" || message === null) return null;
  const parts = (message as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return null;
  for (const p of parts) {
    if (typeof p !== "object" || p === null) continue;
    const part = p as { kind?: unknown; type?: unknown; data?: unknown };
    const isData = part.kind === "data" || part.type === "data";
    if (!isData || typeof part.data !== "object" || part.data === null) continue;
    const d = part.data as Record<string, unknown>;
    const skill = typeof d.skill === "string" ? d.skill : typeof d.tool === "string" ? d.tool : null;
    if (!skill) continue;
    return { skill, args: d.arguments ?? d.args ?? {} };
  }
  return null;
}

export function a2aTask(opts: {
  id: string;
  contextId: string;
  status: string;
  data?: Record<string, unknown> | null;
  statusText?: string;
  now?: Date;
}) {
  const state = a2aStateForStatus(opts.status);
  return {
    kind: "task" as const,
    id: opts.id,
    contextId: opts.contextId,
    status: {
      state,
      timestamp: (opts.now ?? new Date()).toISOString(),
      ...(opts.statusText
        ? { message: { kind: "message", role: "agent", messageId: crypto.randomUUID(), parts: [{ kind: "text", text: opts.statusText }] } }
        : {}),
    },
    artifacts: opts.data
      ? [{ artifactId: `${opts.id}-result`, name: "result", parts: [{ kind: "data", data: opts.data }] }]
      : [],
  };
}

export function a2aSkillListMessage(scopes: readonly string[]) {
  const ids = toolsForScopes(scopes).map((t) => t.name).join(", ");
  return {
    kind: "message" as const,
    role: "agent" as const,
    messageId: crypto.randomUUID(),
    parts: [{
      kind: "text",
      text: `Send a data part {"skill": <id>, "arguments": {...}}. Skills available to this key: ${ids}.`,
    }],
  };
}
