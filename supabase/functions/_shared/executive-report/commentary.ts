// supabase/functions/_shared/executive-report/commentary.ts
// AI commentary with a hard safety net: any number the model cites must appear
// in the computed facts, otherwise we fall back to deterministic commentary.

import { askVireekAi } from "../ai-core/index.ts";
import type { Commentary, ExecutiveMetrics } from "./types.ts";
import { buildFacts } from "./format.ts";
import { deterministicCommentary, validateAiCommentary } from "./commentaryCore.ts";

export async function generateCommentary(metrics: ExecutiveMetrics, aiEnabled: boolean): Promise<Commentary> {
  const fallback = deterministicCommentary(metrics);
  if (!aiEnabled) return fallback;
  const facts = buildFacts(metrics);
  try {
    const result = await askVireekAi({
      task: "executive_report_commentary",
      jsonMode: true,
      maxTokens: 700,
      temperature: 0.2,
      timeoutMs: 20000,
      messages: [{
        role: "user",
        content: `Monthly performance facts, computed from the account's own data — every number is ground truth:\n${facts.map((f) => `- ${f}`).join("\n")}`,
      }],
    });
    return validateAiCommentary(result.text, facts) ?? fallback;
  } catch {
    return fallback;
  }
}
