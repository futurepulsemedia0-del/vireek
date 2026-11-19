// Regenerates the sample-*.jpg fixtures. Run:
//   node --experimental-strip-types supabase/functions/_shared/photo-authenticity/fixtures/build-samples.ts
import { writeFileSync } from "node:fs";
import { buildJpeg, TINY_JPEG_HEIGHT, TINY_JPEG_WIDTH } from "../testkit.ts";

const here = new URL(".", import.meta.url).pathname;
const out = (name: string, bytes: Uint8Array) => writeFileSync(here + name, bytes);
const camera = {
  make: "TestCam", model: "TC-100", orientation: 1, captureSettings: 5, makerNote: true,
  dateTimeOriginal: "2026:11:10 10:00:00", dateTimeDigitized: "2026:11:10 10:00:00", dateTimeModified: "2026:11:10 10:00:00",
  offsetTimeOriginal: "+01:00", pixelWidth: TINY_JPEG_WIDTH, pixelHeight: TINY_JPEG_HEIGHT,
};
out("sample-camera-consistent.jpg", buildJpeg({ exif: { ...camera, thumbnail: { width: 160, height: 120 } } }));
out("sample-edited-software.jpg", buildJpeg({ exif: { ...camera, software: "Adobe Photoshop 25.1", dateTimeModified: "2026:11:12 18:30:00" }, xmp: { creatorTool: "Adobe Photoshop 25.1", history: true } }));
out("sample-thumbnail-and-size-mismatch.jpg", buildJpeg({ exif: { ...camera, pixelWidth: 4000, pixelHeight: 3000, thumbnail: { width: 120, height: 120 } } }));
out("sample-future-timestamp.jpg", buildJpeg({ exif: { ...camera, dateTimeOriginal: "2031:01:01 10:00:00", dateTimeDigitized: "2031:01:01 10:00:00", dateTimeModified: undefined } }));
out("sample-no-metadata.jpg", buildJpeg());
out("sample-generator-tag.jpg", buildJpeg({ exif: { make: "x", software: "Midjourney V6" }, xmp: { digitalSourceType: "trainedAlgorithmicMedia" } }));
