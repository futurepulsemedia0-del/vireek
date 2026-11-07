// @vitest-environment node
// Golden-file tests: any change to a tool schema, a tool name or the agent card must be a deliberate,
// reviewed edit of __golden__/*.json (regenerate with: GOLDEN_UPDATE=1 npx vitest run golden).
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { ALL_SCOPES } from "./tools.ts";
import { buildAgentCard, mcpToolsList } from "./protocol.ts";

const file = (n: string) => new URL(`./__golden__/${n}`, import.meta.url);
const check = (name: string, actual: unknown) => {
  const text = JSON.stringify(actual, null, 2) + "\n";
  if (process.env.GOLDEN_UPDATE === "1") { writeFileSync(file(name), text); return; }
  expect(JSON.parse(readFileSync(file(name), "utf8"))).toEqual(JSON.parse(text));
};

describe("golden contracts", () => {
  it("MCP tools/list for a full-scope key", () => check("mcp-tools.json", mcpToolsList(ALL_SCOPES)));
  it("A2A agent card", () => check("agent-card.json", buildAgentCard({ endpointUrl: "https://x.supabase.co/functions/v1/mcp-server/a2a", siteUrl: "https://vireek.com" })));
  it("every write tool requires idempotency_key and no tool lists in bulk", () => {
    for (const t of mcpToolsList(ALL_SCOPES).tools) {
      const schema = t.inputSchema as { required?: string[]; additionalProperties?: boolean };
      expect(schema.additionalProperties).toBe(false);
      if (t.annotations?.readOnlyHint === false && t.name !== "get_action_status") expect(schema.required ?? []).toContain("idempotency_key");
    }
  });
});
