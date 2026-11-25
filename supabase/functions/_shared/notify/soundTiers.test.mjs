// Run: node --experimental-strip-types --no-warnings supabase/functions/_shared/notify/soundTiers.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ANDROID_V2_CHANNELS_MIN_VERSION, SOUND_TIERS, TIER_BY_PREFIX, TIER_BY_TYPE, TIER_CONFIG, TIER_RATIONALE,
  isKnownType, parseSoundOffTiers, resolveTier, tierFor,
} from "./soundTiers.ts";
import { scanNotificationTypes } from "../../../../scripts/notifications/scanTypes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../../..");

// 1. Tier definitions: exactly the five tiers, system sounds only, ids end in _v2.
assert.deepEqual([...SOUND_TIERS], ["emergency", "alert", "normal", "message", "quiet"]);
for (const t of SOUND_TIERS) {
  assert.match(TIER_CONFIG[t].androidChannel, /^vireek_[a-z]+_v2$/);
  assert.ok(TIER_CONFIG[t].iosSound === "default" || TIER_CONFIG[t].iosSound === null);
}
assert.equal(new Set(SOUND_TIERS.map((t) => TIER_CONFIG[t].androidChannel)).size, 5);
assert.equal(TIER_CONFIG.quiet.iosSound, null);
assert.equal(TIER_CONFIG.quiet.interruptionLevel, "passive");
assert.equal(TIER_CONFIG.quiet.webSilent, true);
for (const t of ["emergency", "alert", "normal", "message"]) assert.equal(TIER_CONFIG[t].webSilent, false);
assert.equal(TIER_CONFIG.emergency.androidImportance, "high");
assert.equal(TIER_CONFIG.alert.androidImportance, "high");
assert.equal(TIER_CONFIG.normal.androidImportance, "default");
assert.equal(TIER_CONFIG.quiet.androidImportance, "low");

// 2. The tiers the brief names.
for (const [type, tier] of Object.entries({
  emergency_call: "emergency", on_call: "alert", missed_call: "alert", payment_failed: "alert", security_alert: "alert",
  job: "normal", job_update: "normal", payment_request: "normal", comment_mention: "message", job_summary: "quiet",
})) assert.equal(tierFor(type), tier, type);
assert.equal(tierFor("some_future_type"), "normal"); // unknown -> normal
assert.equal(tierFor("EMERGENCY_CALL"), "emergency"); // case-insensitive, like routing.ts
assert.equal(tierFor("proactive_minutes_80"), "normal");
assert.equal(tierFor(undefined), "normal");

// 3. Every explicit entry has a rationale and a valid tier.
for (const [type, tier] of Object.entries(TIER_BY_TYPE)) {
  assert.ok(SOUND_TIERS.includes(tier), type);
  assert.ok(TIER_RATIONALE[type]?.length > 10, `rationale for ${type}`);
}

// 4. Inventory guard: every type the code can emit must have an EXPLICIT tier (fails when someone adds a new one).
const { types, dynamic } = scanNotificationTypes(root);
const missing = [...types.keys()].filter((t) => !(t in TIER_BY_TYPE)).sort();
assert.deepEqual(missing, [], `notification types without an explicit tier in soundTiers.ts: ${missing.join(", ")}`);
const missingPrefix = [...dynamic.keys()].filter((p) => !(p in TIER_BY_PREFIX));
assert.deepEqual(missingPrefix, [], `dynamic type families without a TIER_BY_PREFIX entry: ${missingPrefix.join(", ")}`);
assert.ok(types.size >= 50, "scanner found suspiciously few types; the scanner is probably broken");
assert.ok([...types.keys()].every(isKnownType));

// 5. docs/notifications/sound-tiers.md lists every type with the same tier (generated file must not drift).
const doc = readFileSync(join(root, "docs/notifications/sound-tiers.md"), "utf8");
for (const [type, tier] of Object.entries(TIER_BY_TYPE)) {
  assert.ok(doc.includes(`| \`${type}\` | ${tier} |`), `docs row missing or stale for ${type} (run scripts/notifications/gen-sound-tiers-doc.mjs)`);
}

// 6. resolveTier: version gating fails closed; mute and time-sensitive behave as documented.
assert.equal(resolveTier("emergency_call").androidChannel, "vireek_critical");
assert.equal(resolveTier("emergency_call", { appVersion: "garbage" }).androidChannel, "vireek_critical");
assert.equal(resolveTier("emergency_call", { appVersion: ANDROID_V2_CHANNELS_MIN_VERSION }).androidChannel, "vireek_emergency_v2");
assert.equal(resolveTier("job_summary").androidChannel, "vireek_low");
assert.equal(resolveTier("on_call", { timeSensitiveEnabled: false }).interruptionLevel, "active");
assert.equal(resolveTier("on_call", { soundOff: true, appVersion: "9.0.0" }).androidChannel, "vireek_quiet_v2");
assert.equal(resolveTier("job_summary", { soundOff: true }).iosSound, null);
assert.deepEqual(parseSoundOffTiers(["alert", "bogus", "alert", 5, null]), ["alert"]);
assert.deepEqual(parseSoundOffTiers("alert"), []);
assert.deepEqual(parseSoundOffTiers(null), []);

console.log("soundTiers: ALL PASSED");
