import assert from "node:assert/strict";
import { buildMobilePayload, severityFor, DEFAULT_PREFS, versionAtLeast } from "./mobilePayload.ts";
const n = { type: "emergency_call", title: "Burst pipe — Jane Doe", message: "Jane Doe, 12 Maple St: burst pipe" };
let p = buildMobilePayload(n);
assert.equal(p.title, "Emergency call"); assert.ok(!/Jane|Maple/.test(p.body + p.title)); // default hides PII
assert.equal(p.interruptionLevel, "time-sensitive"); assert.equal(p.androidChannel, "vireek_critical"); assert.equal(p.category, "EMERGENCY_CALL");
p = buildMobilePayload(n, { hide_customer_names: false, time_sensitive_enabled: true });
assert.match(p.body, /Maple/);
p = buildMobilePayload(n, { hide_customer_names: true, time_sensitive_enabled: false });
assert.equal(p.interruptionLevel, "active");
assert.equal(buildMobilePayload({ type: "comment_mention", title: "T", message: "see this" }).body, "see this"); // unknown types unchanged
assert.equal(severityFor("job_summary"), "low");
assert.equal(buildMobilePayload({ type: "job_summary", title: "S", message: "m" }, { hide_customer_names: false, time_sensitive_enabled: true }).interruptionLevel, "passive");
assert.equal(versionAtLeast("1.4.0","1.3.2"),true); assert.equal(versionAtLeast("1.3.2","1.3.2"),true); assert.equal(versionAtLeast("1.3","1.3.1"),false);
assert.equal(versionAtLeast(null,"1.0.0"),false); assert.equal(versionAtLeast("1.0.0",undefined),false); assert.equal(versionAtLeast("x.y","1.0"),false);
// ---- sound tiers ----
assert.equal(buildMobilePayload(n, DEFAULT_PREFS, { appVersion: "1.0.0" }).androidChannel, "vireek_critical");
assert.equal(buildMobilePayload(n, DEFAULT_PREFS, { appVersion: "1.1.0" }).androidChannel, "vireek_emergency_v2");
assert.equal(buildMobilePayload({ type: "missed_call", title: "t", message: "m" }, DEFAULT_PREFS, { appVersion: "2.0.0" }).androidChannel, "vireek_alert_v2");
assert.equal(buildMobilePayload({ type: "job_update", title: "t", message: "m" }, DEFAULT_PREFS, { appVersion: "2.0.0" }).androidChannel, "vireek_normal_v2");
assert.equal(buildMobilePayload({ type: "comment_mention", title: "t", message: "m" }, DEFAULT_PREFS, { appVersion: "2.0.0" }).androidChannel, "vireek_message_v2");
const quiet = buildMobilePayload({ type: "job_summary", title: "S", message: "m" }, DEFAULT_PREFS, { appVersion: "2.0.0" });
assert.equal(quiet.androidChannel, "vireek_quiet_v2"); assert.equal(quiet.iosSound, null); assert.equal(quiet.webSilent, true); assert.equal(quiet.interruptionLevel, "passive");
assert.equal(buildMobilePayload(n).iosSound, "default"); assert.equal(buildMobilePayload(n).tier, "emergency");
const muted = buildMobilePayload(n, { hide_customer_names: true, time_sensitive_enabled: true, sound_off_tiers: ["emergency"] }, { appVersion: "1.1.0" });
assert.equal(muted.iosSound, null); assert.equal(muted.androidChannel, "vireek_quiet_v2"); assert.equal(muted.webSilent, true); assert.equal(muted.title, "Emergency call");
assert.equal(buildMobilePayload({ type: "payment_failed", title: "t", message: "m" }, { hide_customer_names: true, time_sensitive_enabled: false }).interruptionLevel, "active");
assert.equal(buildMobilePayload({ type: "security_alert", title: "t", message: "m" }).interruptionLevel, "time-sensitive");
console.log("ALL PASSED");
