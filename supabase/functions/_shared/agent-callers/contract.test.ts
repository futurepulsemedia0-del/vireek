// Drift guards between code that cannot import each other (Deno edge function, SQL migration, dashboard, docs).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { settingsToPayload } from "../../../../src/lib/agentCallers";
import { DEFAULT_AGENT_CALLER_SETTINGS } from "./settings.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const migration = read("../../../migrations/20280402000000_ai_agent_callers.sql");
const webhook = read("../../vapi-webhook/index.ts");
const docs = read("../../../../docs/voice/ai-agent-callers.md");
const funnel = read("./funnel.ts");

describe("agent-caller contracts", () => {
  it("every funnel event type is allowed by the migration CHECK constraint", () => {
    const block = funnel.match(/export type AgentEventType =([\s\S]*?);/)?.[1] ?? "";
    const types = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(types.length).toBeGreaterThanOrEqual(13);
    for (const t of types) expect(migration, t).toContain(`'${t}'`);
  });

  it("every settings payload key is a column of agent_caller_settings and is read by the RPC", () => {
    for (const key of Object.keys(settingsToPayload(DEFAULT_AGENT_CALLER_SETTINGS))) {
      expect(migration, `column ${key}`).toMatch(new RegExp(`\\b${key}\\b`));
      const list = key === "blocked_zips" || key === "never_discuss";
      expect(migration, `rpc ${key}`).toContain(list ? `p ? '${key}'` : `p->>'${key}'`);
    }
  });

  it("the webhook handles all four tools, and the docs define the same four", () => {
    for (const tool of ["identify_caller_type", "agent_quote", "agent_hold_slot", "agent_send_summary"]) {
      expect(webhook, tool).toContain(`case "${tool}"`);
      expect(docs, tool).toContain(`"name": "${tool}"`);
    }
  });

  it("lookup_price cannot be used as a side door by a classified agent caller", () => {
    expect(webhook).toMatch(/sess\?\.kind === "ai_agent"[\s\S]{0,200}Use agent_quote/);
  });

  it("assistant-request (AI disclosure + block check) is not touched by this feature", () => {
    const assistantRequest = webhook.slice(webhook.indexOf("async function handleAssistantRequest"), webhook.indexOf("function buildSurgeContextVariable"));
    expect(assistantRequest).toContain("planDisclosure");
    expect(assistantRequest).not.toMatch(/agent_caller|identifyCaller/);
  });
});
