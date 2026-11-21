import { describe, expect, it } from "vitest";
import { purgeClonedVoice, shouldDeferForRestore, type PurgeDeps, type PurgeOutcome, type PurgeTarget } from "./purge.ts";

const T: PurgeTarget = { consentId: "c1", userId: "u1", providerVoiceId: "voice_abcdef123", samplePaths: ["u1/sample-1.mp3"], reason: "retention_expired" };

function deps(over: Partial<PurgeDeps> = {}) {
  const calls: string[] = [];
  const recorded: PurgeOutcome[] = [];
  const d: PurgeDeps = {
    async blockUse() { calls.push("block"); },
    async deleteVoice() { calls.push("delete"); return "deleted"; },
    async verifyGone() { calls.push("verify"); return "gone"; },
    async removeSamples(_u, p) { calls.push("samples"); return { removed: p.length, failed: false }; },
    async record(_t, o) { calls.push("record"); recorded.push(o); },
    ...over,
  };
  return { d, calls, recorded };
}

describe("purgeClonedVoice", () => {
  it("blocks use first, deletes, verifies, then records; reports purged", async () => {
    const { d, calls, recorded } = deps();
    const o = await purgeClonedVoice(T, d);
    expect(calls).toEqual(["block", "samples", "delete", "verify", "record"]);
    expect(o).toEqual({ status: "purged", providerDelete: "deleted", providerVerified: true, samplesRemoved: 1, samplesFailed: false, blockFailed: false, error: null });
    expect(recorded).toHaveLength(1);
  });

  it("treats a provider 404 as deleted but still verifies", async () => {
    const { d, calls } = deps({ async deleteVoice() { return "not_found"; } });
    const o = await purgeClonedVoice(T, d);
    expect(o.status).toBe("purged");
    expect(calls).toContain("verify");
  });

  it("does NOT claim deletion when the provider still has the voice", async () => {
    const { d } = deps({ async verifyGone() { return "still_exists"; } });
    const o = await purgeClonedVoice(T, d);
    expect(o.status).toBe("incomplete");
    expect(o.providerVerified).toBe(false);
    expect(o.error).toContain("provider_still_has_voice");
  });

  it("does NOT claim deletion when verification is inconclusive", async () => {
    const { d } = deps({ async verifyGone() { return "unknown"; } });
    const o = await purgeClonedVoice(T, d);
    expect(o.status).toBe("incomplete");
    expect(o.error).toContain("provider_verify_unknown");
  });

  it("a failed provider delete skips verification and stays incomplete, but sample audio is still removed", async () => {
    const { d, calls } = deps({ async deleteVoice() { return "failed"; } });
    const o = await purgeClonedVoice(T, d);
    expect(o.status).toBe("incomplete");
    expect(o.samplesRemoved).toBe(1);
    expect(calls).not.toContain("verify");
    expect(o.error).toContain("provider_delete_failed");
  });

  it("a sample-removal failure keeps the purge incomplete even if the provider is clean", async () => {
    const { d } = deps({ async removeSamples() { return { removed: 0, failed: true }; } });
    const o = await purgeClonedVoice(T, d);
    expect(o.status).toBe("incomplete");
    expect(o.providerVerified).toBe(true);
    expect(o.samplesFailed).toBe(true);
  });

  it("still deletes at the provider when blocking use throws", async () => {
    const { d, calls } = deps({ async blockUse() { throw new Error("db down"); } });
    const o = await purgeClonedVoice(T, d);
    expect(o.blockFailed).toBe(true);
    expect(calls).toContain("delete");
    expect(o.status).toBe("purged");
    expect(o.error).toContain("block_use");
  });

  it("never throws: thrown provider errors become an incomplete outcome", async () => {
    const { d } = deps({ async deleteVoice() { throw new Error("boom"); } });
    const o = await purgeClonedVoice(T, d);
    expect(o.status).toBe("incomplete");
    expect(o.providerDelete).toBe("failed");
  });

  it("with no provider voice there is nothing to delete or verify", async () => {
    const { d, calls } = deps();
    const o = await purgeClonedVoice({ ...T, providerVoiceId: null }, d);
    expect(o.providerDelete).toBe("skipped");
    expect(o.providerVerified).toBe(true);
    expect(calls).not.toContain("delete");
    expect(calls).not.toContain("verify");
    expect(o.status).toBe("purged");
  });

  it("a failing record() turns the result incomplete and is reported", async () => {
    const { d } = deps({ async record() { throw new Error("write failed"); } });
    const o = await purgeClonedVoice(T, d);
    expect(o.status).toBe("incomplete");
    expect(o.error).toContain("record_failed");
  });

  it("is safe to run twice (idempotent retry)", async () => {
    const { d } = deps({ async deleteVoice() { return "not_found"; } });
    const a = await purgeClonedVoice(T, d);
    const b = await purgeClonedVoice({ ...T, samplePaths: [] }, d);
    expect(a.status).toBe("purged");
    expect(b.status).toBe("purged");
  });
});

describe("shouldDeferForRestore", () => {
  it("defers only a failed restore, only while attempts remain", () => {
    expect(shouldDeferForRestore("failed", 1, 3)).toBe(true);
    expect(shouldDeferForRestore("failed", 3, 3)).toBe(false);
    expect(shouldDeferForRestore("restored", 1, 3)).toBe(false);
    expect(shouldDeferForRestore("no_preset", 1, 3)).toBe(false);
  });
});
