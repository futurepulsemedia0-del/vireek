// Run: node --experimental-strip-types --no-warnings supabase/functions/_shared/notify/fcm.test.mjs
// Regression: every FCM message carries a channel id (notification block AND data), and iOS `sound` follows the tier.
import assert from "node:assert/strict";
import { buildFcmDataMessage, buildFcmMessage, DEFAULT_ANDROID_CHANNEL } from "./fcm.ts";
import { buildMobilePayload } from "./mobilePayload.ts";
import { TIER_BY_TYPE } from "./soundTiers.ts";

const base = { url: "/dashboard", tag: "t" };
for (const type of [...Object.keys(TIER_BY_TYPE), "unknown_future_type"]) {
  for (const appVersion of [undefined, "1.0.0", "1.1.0", "9.9.9"]) {
    const mp = buildMobilePayload({ type, title: "T", message: "M" }, undefined, { appVersion });
    const msg = buildFcmMessage("tok", {
      ...base, title: mp.title, body: mp.body, androidChannel: mp.androidChannel, interruptionLevel: mp.interruptionLevel,
      category: mp.category, severity: mp.severity, haptic: mp.haptic, tier: mp.tier, iosSound: mp.iosSound,
    });
    const id = msg.android.notification.channel_id;
    assert.match(id, /^vireek_[a-z_0-9]+$/, `${type}@${appVersion}`);
    assert.equal(msg.data.channel, id, "data.channel must equal android channel_id");
    assert.equal(msg.data.tier, mp.tier);
    const aps = msg.apns.payload.aps;
    if (mp.tier === "quiet") { assert.ok(!("sound" in aps), `quiet ${type} must omit aps.sound`); assert.equal(aps["interruption-level"], "passive"); }
    else assert.equal(aps.sound, "default");
    assert.ok(!("critical" in aps) && !JSON.stringify(aps).includes("critical"), "Critical Alerts are never requested");
  }
}

// Callers that pass no channel / no iosSound keep today's behaviour and still get a channel id.
const legacy = buildFcmMessage("tok", { ...base, title: "T", body: "B" });
assert.equal(legacy.android.notification.channel_id, DEFAULT_ANDROID_CHANNEL);
assert.equal(legacy.data.channel, DEFAULT_ANDROID_CHANNEL);
assert.equal(legacy.apns.payload.aps.sound, "default");
assert.equal(buildFcmMessage("tok", { ...base, title: "T", body: "B", iosSound: null }).apns.payload.aps.sound, undefined);

// Data-only (live call) path: the channel is always present so VireekNotifier never guesses.
assert.equal(buildFcmDataMessage("tok", { kind: "live", tag: "c1" }, { androidChannel: "vireek_emergency_v2" }).data.channel, "vireek_emergency_v2");
assert.equal(buildFcmDataMessage("tok", { kind: "live", channel: "vireek_alert_v2" }).data.channel, "vireek_alert_v2");
assert.equal(buildFcmDataMessage("tok", { kind: "live" }).data.channel, DEFAULT_ANDROID_CHANNEL);

console.log("fcm: ALL PASSED");
