import { afterEach, describe, expect, it, vi } from "vitest";
import { logError, logInfo, logWarn } from "./log.ts";

afterEach(() => vi.restoreAllMocks());

describe("shared logger", () => {
  it("info keeps the legacy { event, ...fields } shape", () => {
    const s = vi.spyOn(console, "info").mockImplementation(() => undefined);
    logInfo({ event: "x_done", n: 2 });
    expect(JSON.parse(s.mock.calls[0][0] as string)).toEqual({ event: "x_done", n: 2 });
  });
  it("warn/error add a level and use the matching console method", () => {
    const w = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const e = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logWarn({ event: "a" }); logError({ event: "b" });
    expect(JSON.parse(w.mock.calls[0][0] as string)).toEqual({ level: "warn", event: "a" });
    expect(JSON.parse(e.mock.calls[0][0] as string)).toEqual({ level: "error", event: "b" });
  });
  it("never throws on circular input", () => {
    const s = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const o: Record<string, unknown> = { event: "loop" }; o.self = o;
    expect(() => logInfo(o)).not.toThrow();
    expect(s).toHaveBeenCalledTimes(1);
  });
});
