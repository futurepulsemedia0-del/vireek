// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { analyzePhotoAuthenticity } from "./analyze.ts";
import { nodeC2paDeps } from "./c2paNodeDeps.testkit.ts";
import { ANALYZER_VERSION } from "./types.ts";

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const context = { captureSource: "gallery_import" as const, serverReceivedAt: "2026-11-10T09:05:00Z", deviceCapturedAt: null, deviceTimeStatus: "missing" as const, offlineQueued: false, job: null };

describe("analyzePhotoAuthenticity", () => {
  it("produces a bounded, privacy-safe report", async () => {
    const r = await analyzePhotoAuthenticity({ bytes: fx("sample-camera-consistent.jpg"), mime: "image/jpeg", sha256: "a".repeat(64), context, c2pa: nodeC2paDeps() });
    expect(r.analyzerVersion).toBe(ANALYZER_VERSION);
    expect(r.analyzedSha256).toBe("a".repeat(64));
    expect(r.metadata.camera).toEqual({ make: "TestCam", model: "TC-100" });
    expect(r.metadata.exifCapturedAt).toBe("2026-11-10T10:00:00+01:00");
    expect(r.c2pa.status).toBe("not_present");
    expect(r.consistency.notAVerdict).toBe(true);
    const json = JSON.stringify(r);
    expect(json.length).toBeLessThan(6000);
    expect(json).not.toMatch(/serial|latitude|longitude|thumbnail"/i);
  });
  it("still returns metadata when the C2PA reader is not configured", async () => {
    const r = await analyzePhotoAuthenticity({ bytes: fx("sample-edited-software.jpg"), mime: "image/jpeg", sha256: "b".repeat(64), context, c2pa: null });
    expect(r.c2pa.status).toBe("unavailable");
    expect(r.consistency.reasons.some((x) => x.code === "editing_software")).toBe(true);
  });
  it("end to end on a tampered C2PA file", async () => {
    const r = await analyzePhotoAuthenticity({ bytes: fx("c2pa-asset-tampered.jpg"), mime: "image/jpeg", sha256: "c".repeat(64), context, c2pa: nodeC2paDeps() });
    expect(r.c2pa.validation).toBe("invalid");
    expect(r.consistency.reasons.map((x) => x.code)).toContain("c2pa_validation_failed");
  });
});
