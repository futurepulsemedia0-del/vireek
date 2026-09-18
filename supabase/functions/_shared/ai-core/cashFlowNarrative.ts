// supabase/functions/_shared/ai-core/cashFlowNarrative.ts
//
// Cash-Flow Forecast narrative layer. Takes the already-computed 13-week
// forecast (deterministic arithmetic, done in cash-flow-forecast/index.ts)
// and asks the model ONLY to spot and explain risk/opportunity weeks —
// it never recomputes or invents a number.

import { askVireekAi } from "./index.ts";

export interface CashFlowFlag {
  severity: "info" | "warning" | "critical";
  week_index: number; // 0-12, must match an index in the given weeks array
  message: string;
}

const VALID_SEVERITY = new Set(["info", "warning", "critical"]);

export async function analyzeCashFlowForecast(
  weeks: Record<string, unknown>[],
): Promise<CashFlowFlag[]> {
  if (!weeks || weeks.length === 0) return [];

  try {
    const result = await askVireekAi({
      task: "cash_flow_narrative",
      jsonMode: true,
      maxTokens: 700,
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: `13-week cash flow forecast, computed directly from the account's own data — treat every number as ground truth:\n${JSON.stringify(weeks, null, 2)}`,
        },
      ],
    });

    const parsed = JSON.parse(result.text);
    const rawList: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { flags?: unknown[] })?.flags)
      ? (parsed as { flags: unknown[] }).flags
      : [];

    const maxIndex = weeks.length - 1;
    const flags: CashFlowFlag[] = [];
    for (const item of rawList) {
      if (!item || typeof item !== "object") continue;
      const f = item as Record<string, unknown>;
      const severity = typeof f.severity === "string" && VALID_SEVERITY.has(f.severity)
        ? (f.severity as CashFlowFlag["severity"])
        : null;
      const weekIndex = typeof f.week_index === "number" ? Math.round(f.week_index) : null;
      if (!severity || weekIndex === null || weekIndex < 0 || weekIndex > maxIndex || typeof f.message !== "string") {
        continue;
      }
      flags.push({ severity, week_index: weekIndex, message: f.message.slice(0, 300) });
    }

    return flags.slice(0, 5);
  } catch {
    return [];
  }
}
