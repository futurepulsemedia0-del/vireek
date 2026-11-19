// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { evaluateConsistency, MAX_SCORE_WITHOUT_VALID_C2PA, WEIGHTS } from "./heuristics.ts";
import { parseImageMetadata } from "./metadata.ts";
import { readC2pa } from "./c2pa.ts";
import { nodeC2paDeps } from "./c2paNodeDeps.testkit.ts";
import type { C2paReport, CaptureContext } from "./types.ts";

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const meta = (n: string) => parseImageMetadata(fx(n));
const noC2pa: C2paReport = {
  status: "not_present", validation: "unknown", trust: "not_evaluated", problems: [], statusCodes: [], manifestCount: 0, claimGenerator: null, signer: null,
  actions: [], digitalSourceTypes: [], ingredientCount: 0, declaresGeneratedMedia: false, declaresCapture: false, declaresEdits: false,
};
// The camera sample says 10:00:00 +01:00 = 09:00:00Z.
const ctx = (over: Partial<CaptureContext> = {}): CaptureContext => ({
  captureSource: "in_app_camera", serverReceivedAt: "2026-11-10T09:00:30.000Z", deviceCapturedAt: "2026-11-10T09:00:00.000Z",
  deviceTimeStatus: "ok", offlineQueued: false, job: null, ...over,
});
const codes = (r: ReturnType<typeof evaluateConsistency>) => r.reasons.map((x) => x.code);

describe("evaluateConsistency", () => {
  it("never claims a verdict and keeps the qualifier on every result", () => {
    const r = evaluateConsistency(meta("sample-camera-consistent.jpg"), noC2pa, ctx());
    expect(r.kind).toBe("metadata_consistency");
    expect(r.notAVerdict).toBe(true);
  });

  it("consistent camera file: supported, but capped below the C2PA ceiling", () => {
    const r = evaluateConsistency(meta("sample-camera-consistent.jpg"), noC2pa, ctx());
    expect(codes(r)).toEqual(expect.arrayContaining(["camera_tags_present", "maker_note_present", "capture_time_matches_device"]));
    expect(r.confidence).toBeLessThanOrEqual(MAX_SCORE_WITHOUT_VALID_C2PA);
    expect(r.confidence).toBeGreaterThanOrEqual(70);
    expect(r.level).toBe("strong");
    expect(codes(r)).not.toContain("thumbnail_mismatch"); // 160x120 thumbnail of a 16x12 image: same 4:3 shape
  });

  it("no metadata is INSUFFICIENT (null), never 'low'", () => {
    const r = evaluateConsistency(meta("sample-no-metadata.jpg"), noC2pa, ctx({ captureSource: "gallery_import" }));
    expect(r.confidence).toBeNull();
    expect(r.level).toBe("insufficient");
    expect(codes(r)).toContain("no_metadata");
    const inApp = evaluateConsistency(meta("sample-no-metadata.jpg"), noC2pa, ctx());
    expect(codes(inApp)).toContain("no_metadata_expected_in_app");
  });

  it("editing software, XMP history and a later modify date weaken it with reasons", () => {
    const r = evaluateConsistency(meta("sample-edited-software.jpg"), noC2pa, ctx());
    expect(codes(r)).toEqual(expect.arrayContaining(["editing_software", "xmp_edit_history", "modified_after_capture"]));
    expect(r.confidence!).toBeLessThan(evaluateConsistency(meta("sample-camera-consistent.jpg"), noC2pa, ctx()).confidence!);
    expect(r.reasons.find((x) => x.code === "editing_software")?.detail?.software).toContain("Photoshop");
  });

  it("flags stale thumbnail and wrong EXIF dimensions", () => {
    const r = evaluateConsistency(meta("sample-thumbnail-and-size-mismatch.jpg"), noC2pa, ctx());
    expect(codes(r)).toEqual(expect.arrayContaining(["thumbnail_mismatch", "dimensions_mismatch"]));
  });

  it("a capture time in the future is flagged; a 14-hour zone ambiguity is not", () => {
    expect(codes(evaluateConsistency(meta("sample-future-timestamp.jpg"), noC2pa, ctx()))).toContain("capture_time_in_future");
    const m = meta("sample-camera-consistent.jpg");
    const noOffset = { ...m, dateTimeOriginal: { ...m.dateTimeOriginal!, offsetMinutes: null } };
    // local 10:00 with unknown zone, device UTC 09:00 => zone +1h inferred
    const r = evaluateConsistency(noOffset, noC2pa, ctx());
    expect(codes(r)).toContain("capture_time_matches_device");
    expect(r.reasons.find((x) => x.code === "capture_time_matches_device")?.weight).toBe(WEIGHTS.deviceTimeMatchInferred);
  });

  it("EXIF time far from the device clock weakens (in-app camera only)", () => {
    const r = evaluateConsistency(meta("sample-camera-consistent.jpg"), noC2pa, ctx({ deviceCapturedAt: "2026-11-10T14:00:00.000Z" }));
    expect(codes(r)).toContain("capture_time_differs_from_device");
    const gallery = evaluateConsistency(meta("sample-camera-consistent.jpg"), noC2pa, ctx({ captureSource: "gallery_import", deviceCapturedAt: "2026-11-10T14:00:00.000Z" }));
    expect(codes(gallery)).not.toContain("capture_time_differs_from_device");
  });

  it("a photo that predates the job by more than a day is flagged; inside the window it supports", () => {
    const old = evaluateConsistency(meta("sample-camera-consistent.jpg"), noC2pa, ctx({ captureSource: "gallery_import", job: { arrivedAt: "2026-11-20T08:00:00Z", startedAt: null, completedAt: null } }));
    expect(codes(old)).toContain("predates_job");
    const inside = evaluateConsistency(meta("sample-camera-consistent.jpg"), noC2pa, ctx({ job: { arrivedAt: "2026-11-10T08:30:00Z", startedAt: null, completedAt: "2026-11-10T12:00:00Z" } }));
    expect(codes(inside)).toContain("capture_time_in_job_window");
  });

  it("generator fingerprints weaken strongly", () => {
    const r = evaluateConsistency(meta("sample-generator-tag.jpg"), noC2pa, ctx({ captureSource: "gallery_import" }));
    expect(codes(r)).toEqual(expect.arrayContaining(["generator_software", "xmp_declares_generated"]));
    expect(r.level).toBe("weak");
  });

  it("GPS presence is information only and carries no weight", () => {
    const m = { ...meta("sample-camera-consistent.jpg"), hasGps: true };
    const r = evaluateConsistency(m, noC2pa, ctx());
    expect(r.reasons.find((x) => x.code === "exif_gps_present")).toMatchObject({ effect: "info", weight: 0 });
  });

  it("score is clamped and deterministic", () => {
    const a = evaluateConsistency(meta("sample-generator-tag.jpg"), { ...noC2pa, status: "read", validation: "invalid", problems: ["signature_invalid"] }, ctx());
    expect(a.confidence).toBeGreaterThanOrEqual(5);
    expect(evaluateConsistency(meta("sample-generator-tag.jpg"), noC2pa, ctx())).toEqual(evaluateConsistency(meta("sample-generator-tag.jpg"), noC2pa, ctx()));
  });
});

describe("C2PA influence (real files)", () => {
  it("a failed validation weakens; the broken files never raise confidence", async () => {
    const c = await readC2pa(nodeC2paDeps(), fx("c2pa-asset-tampered.jpg"), "image/jpeg");
    const r = evaluateConsistency(parseImageMetadata(fx("c2pa-asset-tampered.jpg")), c, ctx({ captureSource: "gallery_import" }));
    expect(codes(r)).toContain("c2pa_validation_failed");
    expect(r.confidence!).toBeLessThan(50);
  });
  it("a valid manifest that declares generated media weakens even though it validates", async () => {
    const c = await readC2pa(nodeC2paDeps(), fx("c2pa-valid-test-signer.jpg"), "image/jpeg");
    const r = evaluateConsistency(parseImageMetadata(fx("c2pa-valid-test-signer.jpg")), c, ctx({ captureSource: "gallery_import" }));
    expect(codes(r)).toContain("c2pa_declares_generated");
    expect(r.level).not.toBe("strong");
  });
  it("only a valid, capture-declaring manifest may exceed the no-C2PA ceiling", () => {
    const valid: C2paReport = { ...noC2pa, status: "read", validation: "valid", trust: "trusted", declaresCapture: true };
    const r = evaluateConsistency(meta("sample-camera-consistent.jpg"), valid, ctx());
    expect(r.confidence!).toBeGreaterThan(MAX_SCORE_WITHOUT_VALID_C2PA);
    expect(codes(r)).toContain("c2pa_valid_capture_claim");
  });
});
