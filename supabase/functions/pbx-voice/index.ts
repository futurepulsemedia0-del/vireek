// supabase/functions/pbx-voice/index.ts
//
// Twilio Voice webhook router for the business phone system. Public endpoint
// (verify_jwt=false) protected by X-Twilio-Signature; `action=tick` is protected
// by a shared secret instead. NOT LIVE-VERIFIED against Twilio — see the test
// checklist delivered with this feature before pointing production numbers here.
//
// Every call lives in a Conference ("pbx-<callId>"): hold, park, warm transfer and
// 3-way are all just participant operations on that conference.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { checkInboundBlock } from "../_shared/compliance/callBlockCheck.ts";
import {
  estimateWaitSeconds, isOpenNow, orderCandidates, parseDialString, queueAnnouncement,
  shouldRecord, toE164, xml, type Destination, type Schedule, type Strategy,
} from "../_shared/pbx/logic.ts";
import { LEG_STATUS, twiml, validTwilioSignature } from "../_shared/pbx/twilio.ts";
import {
  appendIvrPath, decideIvr, ivrDepth, ivrPromptText, ivrRetryMessage, IVR_MAX_DEPTH, toIvrMenuConfig,
  type IvrMenuConfig, type IvrReason,
} from "../_shared/pbx/logic.ts";
import {
  FALLBACK_HOLD_MUSIC, TERMINAL, callerIdFor, cancelLegs, confSid, createLeg, endLeg, hook,
  lineE164, loadSettings, resolveCallerId, setHold, storeMedia, twilioApiSafe, type Row,
} from "../_shared/pbx/runtime.ts";

type Admin = SupabaseClient;
const empty = () => new Response(null, { status: 204 });
const bg = (p: Promise<unknown>) => {
  const safe = p.catch((e) => console.error(JSON.stringify({ event: "pbx_bg_error", error: String(e) })));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(safe);
};
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- data helpers
const loadCall = async (a: Admin, id: string): Promise<Row | null> =>
  (await a.from("pbx_calls").select("*").eq("id", id).maybeSingle()).data;

const available = async (a: Admin, owner: string, ids: string[], wrap: number): Promise<string[]> => {
  if (!ids.length) return [];
  const { data } = await a.rpc("pbx_available_extensions", { p_owner: owner, p_ids: ids, p_wrap_seconds: wrap });
  return (data ?? []) as string[];
};

const activeLegs = async (a: Admin, callId: string): Promise<number> =>
  (await a.from("pbx_call_legs").select("id", { count: "exact", head: true })
    .eq("call_id", callId).in("status", ["queued", "ringing"])).count ?? 0;

const setDispatch = (a: Admin, call: Row, dispatch: Row, extra: Row = {}) =>
  a.from("pbx_calls").update({ dispatch, status: "ringing", queue_id: null, ...extra }).eq("id", call.id);

const holdMusic = (s: Row, queueMusic?: string | null) => queueMusic || s.default_hold_music_url || FALLBACK_HOLD_MUSIC;

// ---------------------------------------------------------------- routing
type Routed = { people: true } | { people: false; dest: Destination };

async function route(a: Admin, call: Row, dest: Destination, depth = 0): Promise<Routed> {
  const owner = call.account_owner_id as string;
  if (depth > 3) return { people: false, dest: { type: "voicemail" } };

  if (dest.type === "extension") {
    const { data: ext } = await a.from("pbx_extensions").select("id").eq("id", dest.id!).eq("account_owner_id", owner).maybeSingle();
    if (!ext) return { people: false, dest: { type: "voicemail" } };
    if (!(await available(a, owner, [ext.id], 0)).length) return { people: false, dest: { type: "voicemail", id: ext.id } };
    await setDispatch(a, call, { steps: [[ext.id]], step: 0, noAnswer: { type: "voicemail", id: ext.id }, ringSeconds: 25 });
    return { people: true };
  }

  if (dest.type === "ring_group") {
    const { data: g } = await a.from("pbx_ring_groups")
      .select("id, strategy, ring_seconds, no_answer_destination, rr_cursor")
      .eq("id", dest.id!).eq("account_owner_id", owner).maybeSingle();
    if (!g) return { people: false, dest: { type: "voicemail" } };
    const { data: mem } = await a.from("pbx_ring_group_members")
      .select("extension_id, position, pbx_extensions(last_call_ended_at)").eq("group_id", g.id);
    const rows = (mem ?? []) as Row[];
    const ok = new Set(await available(a, owner, rows.map((m) => m.extension_id), 0));
    const cands = rows.filter((m) => ok.has(m.extension_id)).map((m) => {
      const e = Array.isArray(m.pbx_extensions) ? m.pbx_extensions[0] : m.pbx_extensions;
      return { id: m.extension_id as string, position: m.position as number, lastCallEndedAt: (e?.last_call_ended_at ?? null) as string | null };
    });
    await a.from("pbx_ring_groups").update({ rr_cursor: (g.rr_cursor ?? 0) + 1 }).eq("id", g.id);
    const noAnswer = (g.no_answer_destination ?? { type: "voicemail" }) as Destination;
    const steps = orderCandidates(g.strategy as Strategy, cands, g.rr_cursor ?? 0);
    if (!steps.length) return route(a, call, noAnswer, depth + 1);
    await setDispatch(a, call, { steps, step: 0, noAnswer, ringSeconds: g.ring_seconds }, { ring_group_id: g.id });
    return { people: true };
  }

  if (dest.type === "queue") {
    const { data: q } = await a.from("pbx_queues").select("id, max_size, overflow_destination")
      .eq("id", dest.id!).eq("account_owner_id", owner).maybeSingle();
    if (!q) return { people: false, dest: { type: "voicemail" } };
    const { count } = await a.from("pbx_calls").select("id", { count: "exact", head: true }).eq("queue_id", q.id).eq("status", "queued");
    if ((count ?? 0) >= q.max_size) return route(a, call, (q.overflow_destination ?? { type: "voicemail" }) as Destination, depth + 1);
    await a.from("pbx_calls").update({ queue_id: q.id, status: "queued", queue_entered_at: nowIso(), dispatch: {} }).eq("id", call.id);
    return { people: true };
  }

  return { people: false, dest };
}

async function ringExtension(a: Admin, call: Row, extId: string, from: string, secs: number, round: number): Promise<number> {
  const { data: ext } = await a.from("pbx_extensions").select("id, ring_mobile, mobile_e164").eq("id", extId).maybeSingle();
  if (!ext) return 0;
  let n = 0;
  if (await createLeg(a, call, { role: "agent", target: { extensionId: ext.id }, from, ringSeconds: secs, joinAction: "agent-join", round })) n++;
  if (ext.ring_mobile && ext.mobile_e164 &&
      await createLeg(a, call, { role: "agent", target: { extensionId: ext.id, number: ext.mobile_e164 }, from, ringSeconds: secs, joinAction: "agent-join", round })) n++;
  return n;
}

/** Walks the dispatch steps; each step rings together. Event-driven: leg-status callbacks call this again. */
async function runDispatch(a: Admin, callId: string): Promise<void> {
  const call = await loadCall(a, callId);
  if (!call || !["ringing", "queued"].includes(call.status)) return;
  if ((await activeLegs(a, call.id)) > 0) return;
  const d = (call.dispatch ?? {}) as Row;
  const steps: string[][] = d.steps ?? [];
  let step: number = d.step ?? 0;
  const from = await callerIdFor(a, call);
  while (step < steps.length) {
    const ids = steps[step];
    step++;
    await a.from("pbx_calls").update({ dispatch: { ...d, step } }).eq("id", call.id);
    let started = 0;
    for (const id of await available(a, call.account_owner_id, ids, 0)) {
      started += await ringExtension(a, call, id, from, d.ringSeconds ?? 25, step);
    }
    if (started > 0) return;
  }
  await exhausted(a, call);
}

async function exhausted(a: Admin, call: Row): Promise<void> {
  if (call.queue_id && call.status === "queued") return; // stays in queue; retried by the wait poll / serveQueue
  const dest = ((call.dispatch ?? {}).noAnswer ?? { type: "voicemail" }) as Destination;
  const r = await route(a, call, dest, 1);
  if (r.people) return kick(a, call.id);
  await redirectCustomer(a, call, r.dest);
}

const kick = async (a: Admin, callId: string) => {
  const c = await loadCall(a, callId);
  if (!c) return;
  if (c.queue_id && c.status === "queued") return serveQueue(a, c.queue_id);
  return runDispatch(a, callId);
};

async function serveQueue(a: Admin, queueId: string): Promise<void> {
  const { data: q } = await a.from("pbx_queues")
    .select("id, account_owner_id, strategy, ring_seconds, wrap_up_seconds, rr_cursor").eq("id", queueId).maybeSingle();
  if (!q) return;
  const { data: waiting } = await a.from("pbx_calls").select("*").eq("queue_id", q.id).eq("status", "queued")
    .order("queue_entered_at").limit(10);
  for (const call of (waiting ?? []) as Row[]) {
    if ((await activeLegs(a, call.id)) > 0) continue;
    const { data: mem } = await a.from("pbx_queue_members")
      .select("extension_id, pbx_extensions(last_call_ended_at)").eq("queue_id", q.id).eq("paused", false);
    const rows = (mem ?? []) as Row[];
    const ok = new Set(await available(a, q.account_owner_id, rows.map((m) => m.extension_id), q.wrap_up_seconds));
    const cands = rows.filter((m) => ok.has(m.extension_id)).map((m, i) => {
      const e = Array.isArray(m.pbx_extensions) ? m.pbx_extensions[0] : m.pbx_extensions;
      return { id: m.extension_id as string, position: i, lastCallEndedAt: (e?.last_call_ended_at ?? null) as string | null };
    });
    if (!cands.length) break; // nobody free: later calls cannot be served either
    await a.from("pbx_queues").update({ rr_cursor: (q.rr_cursor ?? 0) + 1 }).eq("id", q.id);
    const steps = orderCandidates(q.strategy === "ringall" ? "simultaneous" : (q.strategy as Strategy), cands, q.rr_cursor ?? 0);
    await a.from("pbx_calls").update({ dispatch: { steps, step: 0, ringSeconds: q.ring_seconds } }).eq("id", call.id);
    await runDispatch(a, call.id);
  }
}

/** Moves the (inbound / internal-caller) leg out of the conference to a non-people destination. */
async function redirectCustomer(a: Admin, call: Row, dest: Destination): Promise<void> {
  await cancelLegs(a, call.id);
  await twilioApiSafe(`Calls/${call.call_sid}.json`, { Url: hook("direct", { call: call.id, t: dest.type, n: dest.number ?? "", mb: dest.id ?? "" }), Method: "POST" });
}

// ---------------------------------------------------------------- TwiML builders
const recordNotice = "This call may be recorded for quality and training purposes.";

function confAttrs(call: Row, start: boolean, endOnExit: boolean, opts: { wait?: boolean; record?: boolean } = {}): string {
  return `beep="false" startConferenceOnEnter="${start}" endConferenceOnExit="${endOnExit}"` +
    (opts.wait ? ` waitUrl="${xml(hook("wait", { call: call.id }))}" waitMethod="POST"` : "") +
    (opts.record
      ? ` record="record-from-start" recordingStatusCallback="${xml(hook("recording-status", { call: call.id }))}" recordingStatusCallbackEvent="completed"`
      : "") +
    (opts.wait ? ` statusCallback="${xml(hook("conf-status", { call: call.id }))}" statusCallbackEvent="start end"` : "");
}

const customerConference = (call: Row, settings: Row) =>
  (call.recording_enabled && settings.recording_announcement ? `<Say>${xml(recordNotice)}</Say>` : "") +
  `<Dial action="${xml(hook("customer-done", { call: call.id }))}"><Conference ${confAttrs(call, false, true, { wait: true, record: call.recording_enabled })}>${xml(call.conference_name)}</Conference></Dial>`;

const agentConference = (call: Row) =>
  `<Dial><Conference ${confAttrs(call, true, false)}>${xml(call.conference_name)}</Conference></Dial>`;

async function voicemailTwiml(a: Admin, call: Row, mailboxId: string | undefined, settings: Row): Promise<string> {
  let greeting: string = settings.voicemail_greeting;
  let mb = "";
  if (mailboxId) {
    const { data: ext } = await a.from("pbx_extensions").select("id, display_name, voicemail_enabled, voicemail_greeting")
      .eq("id", mailboxId).eq("account_owner_id", call.account_owner_id).maybeSingle();
    if (ext?.voicemail_enabled) {
      mb = ext.id;
      greeting = ext.voicemail_greeting || `You have reached ${ext.display_name}. Please leave a message after the tone.`;
    }
  }
  await a.from("pbx_calls").update({ status: "voicemail" }).eq("id", call.id).in("status", ["ringing", "queued", "in_progress"]);
  const t = settings.voicemail_transcribe
    ? ` transcribe="true" transcribeCallback="${xml(hook("vm-transcript", { call: call.id, mb }))}"` : "";
  return `<Say>${xml(greeting)}</Say><Record maxLength="180" playBeep="true" finishOnKey="#" timeout="6" action="${xml(hook("vm-done", { call: call.id }))}" recordingStatusCallback="${xml(hook("vm-recording", { call: call.id, mb }))}" recordingStatusCallbackEvent="completed"${t}/>`;
}

async function directTwiml(a: Admin, call: Row, dest: Destination, settings: Row): Promise<string> {
  if (dest.type === "external" && dest.number) {
    await a.from("pbx_calls").update({ status: "in_progress", answered_at: nowIso() }).eq("id", call.id).in("status", ["ringing", "queued"]);
    const id = (await lineE164(a, call.line_id)) ?? call.from_number ?? "";
    return `<Dial callerId="${xml(id)}" timeout="30" action="${xml(hook("direct-done", { call: call.id }))}"><Number>${xml(dest.number)}</Number></Dial>`;
  }
  if (dest.type === "ai" && call.line_id) {
    const { data: line } = await a.from("pbx_lines").select("ai_fallback_url").eq("id", call.line_id).maybeSingle();
    if (line?.ai_fallback_url) {
      await a.from("pbx_calls").update({ status: "ai_handled", ended_at: nowIso() }).eq("id", call.id).in("status", ["ringing", "queued", "in_progress"]);
      return `<Redirect method="POST">${xml(line.ai_fallback_url)}</Redirect>`;
    }
  }
  if (dest.type === "hangup") {
    await a.from("pbx_calls").update({ status: "completed", ended_at: nowIso() }).eq("id", call.id).in("status", ["ringing", "queued"]);
    return "<Hangup/>";
  }
  return voicemailTwiml(a, call, dest.type === "voicemail" ? dest.id : undefined, settings);
}

// ---------------------------------------------------------------- phone menu (IVR)
const sayAttrs = (m: Row) => ` language="${xml(m.language || "en-US")}"` + (m.voice ? ` voice="${xml(m.voice)}"` : "");

/** Same rule as the main router: no schedule => open (a misconfiguration never silences the phones). */
async function lineIsOpen(a: Admin, call: Row): Promise<boolean> {
  if (!call.line_id) return true;
  const { data: line } = await a.from("pbx_lines").select("schedule_id").eq("id", call.line_id).maybeSingle();
  if (!line?.schedule_id) return true;
  const { data: s } = await a.from("pbx_schedules").select("timezone, weekly, exceptions, include_business_holidays")
    .eq("id", line.schedule_id).eq("account_owner_id", call.account_owner_id).maybeSingle();
  const { data: bp } = await a.from("business_profile").select("holidays").eq("user_id", call.account_owner_id).maybeSingle();
  const holidays = ((bp?.holidays ?? []) as Row[]).map((h) => String(h?.date ?? "")).filter(Boolean);
  return isOpenNow((s as Schedule | null) ?? null, new Date(), holidays).open;
}

/** Menu + options, always scoped to the call's account. null => disabled / missing / no usable options. */
async function loadIvr(a: Admin, owner: string, menuId: string): Promise<{ menu: Row; config: IvrMenuConfig } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(menuId)) return null;
  const { data: menu } = await a.from("pbx_ivr_menus").select("*").eq("id", menuId).eq("account_owner_id", owner).eq("enabled", true).maybeSingle();
  if (!menu) return null;
  const { data: opts } = await a.from("pbx_ivr_options").select("digit, label, destination, closed_destination, position")
    .eq("menu_id", menu.id).eq("account_owner_id", owner);
  const config = toIvrMenuConfig(menu, (opts ?? []) as Row[]);
  return config.options.length ? { menu, config } : null;
}

/** Greeting + "press 1 for..." inside a <Gather> (callers can key in early). Silence falls through to the Redirect. */
async function ivrTwiml(a: Admin, call: Row, menuId: string, attempt: number, reason: IvrReason | null, settings: Row): Promise<string> {
  const loaded = await loadIvr(a, call.account_owner_id, menuId);
  if (!loaded || ivrDepth(call.ivr_path) > IVR_MAX_DEPTH) return voicemailTwiml(a, call, undefined, settings); // fallback: voicemail
  const { menu, config } = loaded;
  if (attempt === 0 && !reason) {
    await a.from("pbx_calls").update({ ivr_menu_id: menu.id }).eq("id", call.id).in("status", ["ringing", "queued"]);
  }
  const say = (t: string) => `<Say${sayAttrs(menu)}>${xml(t)}</Say>`;
  const greeting = menu.greeting_audio_url ? `<Play>${xml(menu.greeting_audio_url)}</Play>` : say(menu.greeting_text);
  const spoken = ivrPromptText(config.options);
  const options = menu.read_options && spoken ? say(spoken) : "";
  const inner = attempt === 0 ? greeting + options : (options || greeting); // retries replay only the options
  const retry = reason ? ivrRetryMessage(reason, { invalid: menu.invalid_message, timeout: menu.timeout_message }) : "";
  const q = { call: call.id, menu: menu.id, try: String(attempt) };
  return (retry ? say(retry) : "") +
    `<Gather input="dtmf" numDigits="1" timeout="${Number(menu.timeout_seconds) || 6}" method="POST" action="${xml(hook("ivr-choice", q))}">${inner}</Gather>` +
    `<Redirect method="POST">${xml(hook("ivr-choice", { ...q, to: "1" }))}</Redirect>`;
}

// ---------------------------------------------------------------- call lifecycle
async function mirrorToCalls(a: Admin, call: Row, duration: number, extra: Row = {}): Promise<void> {
  if (call.direction === "internal" || call.calls_id) return;
  const { data: row } = await a.from("calls").insert({
    user_id: call.account_owner_id, external_id: `pbx:${call.id}`,
    caller_phone: call.direction === "inbound" ? call.from_number : call.to_number,
    call_datetime: call.started_at, duration_seconds: duration,
    summary: `Phone system ${call.direction} call`, ...extra,
  }).select("id").single();
  if (row) await a.from("pbx_calls").update({ calls_id: row.id }).eq("id", call.id);
}

async function finalizeCall(a: Admin, callId: string): Promise<void> {
  const call = await loadCall(a, callId);
  if (!call || !["ringing", "queued", "in_progress"].includes(call.status)) return;
  const status = call.status === "in_progress" ? "completed" : call.direction === "inbound" ? "abandoned" : "missed";
  const now = new Date();
  const duration = call.answered_at ? Math.max(0, Math.round((now.getTime() - Date.parse(call.answered_at)) / 1000)) : 0;
  const { data: done } = await a.from("pbx_calls")
    .update({ status, ended_at: now.toISOString(), duration_seconds: duration })
    .eq("id", call.id).in("status", ["ringing", "queued", "in_progress"]).select("id");
  if (!done?.length) return; // someone else finalized it
  await cancelLegs(a, call.id);
  await a.from("pbx_parking_slots").delete().eq("call_id", call.id);
  await mirrorToCalls(a, call, duration);
  if (call.queue_id) await serveQueue(a, call.queue_id);
}

/** A conversation needs two live parties; fewer than two ends it (never while parked or a transfer target is ringing). */
async function maybeEndCall(a: Admin, callId: string): Promise<void> {
  const call = await loadCall(a, callId);
  if (!call || call.status !== "in_progress") return;
  const { data: legs } = await a.from("pbx_call_legs").select("role, status").eq("call_id", callId).in("status", ["ringing", "in_progress"]);
  const rows = (legs ?? []) as Row[];
  if (rows.some((l) => l.role === "consult" && l.status === "ringing")) return;
  if (rows.filter((l) => l.status === "in_progress").length > 1) return;
  await finalizeCall(a, callId);
}

async function onLegTerminal(a: Admin, callId: string, leg: Row): Promise<void> {
  const call = await loadCall(a, callId);
  if (!call) return;
  if (leg.extension_id && leg.answered_at) {
    await a.from("pbx_extensions").update({ last_call_ended_at: nowIso() }).eq("id", leg.extension_id);
  }
  if (["ringing", "queued"].includes(call.status)) {
    if (call.direction !== "inbound" && (leg.role === "customer" || (leg.role === "agent" && call.direction === "outbound"))) {
      return finalizeCall(a, callId); // callee did not answer, or the originator hung up while ringing
    }
    return runDispatch(a, callId); // this step failed: try the next one
  }
  await maybeEndCall(a, callId);
  if (call.queue_id) await serveQueue(a, call.queue_id);
}

async function resumeParked(a: Admin, call: Row): Promise<void> {
  await a.from("pbx_calls").update({ status: "in_progress" }).eq("id", call.id).eq("status", "parked");
  await a.from("pbx_parking_slots").delete().eq("call_id", call.id);
  const cs = await confSid(a, call);
  const { data: others } = await a.from("pbx_call_legs").select("call_sid").eq("call_id", call.id).eq("status", "in_progress").not("call_sid", "is", null);
  if (cs) for (const o of (others ?? []) as Row[]) { try { await setHold(cs, o.call_sid, false, ""); } catch { /* ignore */ } }
}

async function joinAgent(a: Admin, call: Row, leg: Row): Promise<Response> {
  if (leg.role === "agent") {
    const { data: ok } = await a.rpc("pbx_claim_call", { p_call_id: call.id, p_extension_id: leg.extension_id });
    if (ok !== true) {
      await a.from("pbx_call_legs").update({ status: "canceled", answered_at: null }).eq("id", leg.id);
      return twiml("<Say>This call was answered by a colleague.</Say><Hangup/>");
    }
    await a.from("pbx_call_legs").update({ status: "in_progress", answered_at: nowIso() }).eq("id", leg.id);
    await cancelLegs(a, call.id, leg.id); // stop the other phones ringing
    return twiml(agentConference(call));
  }
  // consult / added participant / parked-call retrieval
  if (call.status === "parked") await resumeParked(a, call);
  else if (call.status !== "in_progress") return twiml("<Hangup/>");
  await a.from("pbx_call_legs").update({ status: "in_progress", answered_at: nowIso() }).eq("id", leg.id);
  // Blind transfer: nobody else on the call -> bring the held party back.
  const { data: peers } = await a.from("pbx_call_legs").select("id").eq("call_id", call.id).eq("status", "in_progress")
    .not("extension_id", "is", null).neq("id", leg.id);
  if (!peers?.length) {
    const cs = await confSid(a, call);
    const { data: held } = await a.from("pbx_call_legs").select("call_sid").eq("call_id", call.id).eq("status", "in_progress").is("extension_id", null);
    if (cs) for (const h of (held ?? []) as Row[]) { try { await setHold(cs, h.call_sid, false, ""); } catch { /* ignore */ } }
  }
  return twiml(agentConference(call));
}

// ---------------------------------------------------------------- recordings & voicemail
async function saveConferenceRecording(a: Admin, call: Row, p: Record<string, string>): Promise<void> {
  if (p.RecordingStatus !== "completed" || !p.RecordingSid || !p.RecordingUrl) return;
  const settings = await loadSettings(a, call.account_owner_id);
  const path = `${call.account_owner_id}/rec/${call.id}/${p.RecordingSid}.mp3`;
  const size = await storeMedia(a, path, p.RecordingUrl, p.RecordingSid);
  await a.from("pbx_recordings").upsert({
    account_owner_id: call.account_owner_id, call_id: call.id, recording_sid: p.RecordingSid, storage_path: path,
    duration_seconds: Number(p.RecordingDuration) || null, size_bytes: size,
    retention_until: new Date(Date.now() + settings.recording_retention_days * 86_400_000).toISOString(),
  }, { onConflict: "recording_sid" });
}

async function saveVoicemail(a: Admin, call: Row, mb: string, p: Record<string, string>): Promise<void> {
  if (p.RecordingStatus !== "completed" || !p.RecordingSid || !p.RecordingUrl) return;
  const path = `${call.account_owner_id}/vm/${call.id}/${p.RecordingSid}.mp3`;
  await storeMedia(a, path, p.RecordingUrl, p.RecordingSid);
  const duration = Number(p.RecordingDuration) || 0;
  await a.from("pbx_voicemails").upsert({
    account_owner_id: call.account_owner_id, call_id: call.id, line_id: call.line_id,
    mailbox_extension_id: mb || null, caller_phone: call.from_number, recording_sid: p.RecordingSid,
    duration_seconds: duration, storage_path: path,
  }, { onConflict: "recording_sid" });
  await a.from("pbx_calls").update({ ended_at: nowIso(), duration_seconds: duration }).eq("id", call.id);
  await mirrorToCalls(a, call, duration, { is_voicemail: true });
}

// ---------------------------------------------------------------- scheduled maintenance
async function tick(a: Admin): Promise<void> {
  const now = nowIso();
  await a.from("pbx_extensions").update({ presence: "offline" })
    .eq("presence", "available").lt("last_seen_at", new Date(Date.now() - 3 * 60_000).toISOString());

  const { data: due } = await a.from("pbx_parking_slots").select("*").lt("expires_at", now).limit(25);
  for (const s of (due ?? []) as Row[]) {
    const call = await loadCall(a, s.call_id);
    if (!call || call.status !== "parked") { await a.from("pbx_parking_slots").delete().eq("id", s.id); continue; }
    if (s.ring_backs >= 2 || !s.parked_by_extension_id) {
      await a.from("pbx_parking_slots").delete().eq("id", s.id);
      await a.from("pbx_calls").update({ status: "in_progress" }).eq("id", call.id);
      await redirectCustomer(a, call, { type: "voicemail" });
      continue;
    }
    await a.from("pbx_parking_slots").update({ ring_backs: s.ring_backs + 1, expires_at: new Date(Date.now() + 60_000).toISOString() }).eq("id", s.id);
    await createLeg(a, call, { role: "consult", target: { extensionId: s.parked_by_extension_id }, from: await callerIdFor(a, call), ringSeconds: 30, joinAction: "agent-join" });
  }

  const stale = new Date(Date.now() - 6 * 3_600_000).toISOString();
  await a.from("pbx_call_legs").update({ status: "failed", ended_at: now }).in("status", ["queued", "ringing", "in_progress"]).lt("created_at", stale);
  await a.from("pbx_calls").update({ status: "failed", ended_at: now }).in("status", ["ringing", "queued", "in_progress", "parked"]).lt("started_at", stale);
  await a.from("pbx_calls").update({ ended_at: now }).eq("status", "voicemail").is("ended_at", null)
    .lt("started_at", new Date(Date.now() - 15 * 60_000).toISOString());

  const { data: old } = await a.from("pbx_recordings").select("id, storage_path")
    .is("deleted_at", null).eq("legal_hold", false).lt("retention_until", now).limit(50);
  for (const r of (old ?? []) as Row[]) {
    await a.storage.from("pbx-media").remove([r.storage_path]);
    await a.from("pbx_recordings").update({ deleted_at: now }).eq("id", r.id);
  }
}

// ---------------------------------------------------------------- server
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "";
  const q = (k: string) => url.searchParams.get(k) ?? "";
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  if (action === "tick") {
    const secret = Deno.env.get("PBX_TICK_SECRET");
    if (!secret || req.headers.get("x-pbx-tick-secret") !== secret) return new Response("Forbidden", { status: 403 });
    await tick(admin);
    return empty();
  }

  const params: Record<string, string> = {};
  (await req.formData()).forEach((v, k) => { if (typeof v === "string") params[k] = v; });
  const base = Deno.env.get("PBX_WEBHOOK_BASE") ?? "";
  if (!(await validTwilioSignature(base + url.search, params, req.headers.get("X-Twilio-Signature"), Deno.env.get("TWILIO_AUTH_TOKEN") ?? ""))) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    switch (action) {
      // ---- inbound call on a business number
      case "inbound": {
        const to = toE164(params.To) ?? params.To;
        const from = params.From ?? "";
        const { data: pn } = await admin.from("phone_numbers").select("id, account_id").eq("phone_number", to).maybeSingle();
        if (!pn) return twiml("<Say>This number is not in service.</Say><Hangup/>");
        const owner = pn.account_id as string;
        const { data: line } = await admin.from("pbx_lines").select("*").eq("phone_number_id", pn.id).eq("account_owner_id", owner).eq("enabled", true).maybeSingle();
        if (!line) return twiml("<Say>This number is not configured yet.</Say><Hangup/>");

        const block = await checkInboundBlock(admin, owner, from, to); // fail-open by design
        if (block.blocked) return twiml("<Reject/>");

        const settings = await loadSettings(admin, owner);
        let schedule: Schedule | null = null;
        if (line.schedule_id) {
          const { data: s } = await admin.from("pbx_schedules").select("timezone, weekly, exceptions, include_business_holidays").eq("id", line.schedule_id).maybeSingle();
          schedule = (s as Schedule | null) ?? null;
        }
        const { data: bp } = await admin.from("business_profile").select("holidays").eq("user_id", owner).maybeSingle();
        const holidays = ((bp?.holidays ?? []) as Row[]).map((h) => String(h?.date ?? "")).filter(Boolean);
        const dest = (isOpenNow(schedule, new Date(), holidays).open ? line.open_destination : line.closed_destination) as Destination;

        const record = shouldRecord(settings.recording_mode, "inbound", line.recording_override);
        const id = crypto.randomUUID();
        const row = {
          id, account_owner_id: owner, call_sid: params.CallSid, direction: "inbound", from_number: from, to_number: to,
          line_id: line.id, status: "ringing", conference_name: `pbx-${id}`, recording_enabled: record,
        };
        const { error: insErr } = await admin.from("pbx_calls").insert(row);
        if (insErr) {
          if (insErr.code === "23505") { // Twilio retried the webhook
            const { data: ex } = await admin.from("pbx_calls").select("*").eq("account_owner_id", owner).eq("call_sid", params.CallSid).maybeSingle();
            if (ex) return twiml(customerConference(ex, settings));
          }
          throw insErr;
        }
        await admin.from("pbx_call_legs").insert({ account_owner_id: owner, call_id: id, role: "customer", call_sid: params.CallSid, status: "in_progress", answered_at: nowIso() });

        const routed = await route(admin, row, dest);
        if (!routed.people) return twiml(await directTwiml(admin, row, routed.dest, settings));
        bg(kick(admin, id));
        return twiml(customerConference({ ...row }, settings));
      }

      // ---- TwiML App: the browser/mobile softphone placed a call
      case "app": {
        const extId = (params.From ?? "").replace(/^client:pbx_/, "");
        const { data: ext } = await admin.from("pbx_extensions").select("*").eq("id", extId).maybeSingle();
        if (!ext?.user_id) return twiml("<Reject/>");
        const owner = ext.account_owner_id as string;
        const target = parseDialString(params.To ?? "");
        if (!target) return twiml("<Say>That number is not valid.</Say><Hangup/>");
        const settings = await loadSettings(admin, owner);
        const id = crypto.randomUUID();
        const base = { id, account_owner_id: owner, call_sid: params.CallSid, extension_id: ext.id, conference_name: `pbx-${id}` };
        const agentLeg = { account_owner_id: owner, call_id: id, role: "agent", extension_id: ext.id, call_sid: params.CallSid, status: "in_progress", answered_at: nowIso() };

        if (target.kind === "extension") {
          const { data: t } = await admin.from("pbx_extensions").select("id, display_name").eq("account_owner_id", owner).eq("extension", target.extension).maybeSingle();
          if (!t) return twiml("<Say>That extension does not exist.</Say><Hangup/>");
          const call = { ...base, direction: "internal", from_number: ext.extension, to_number: target.extension, status: "ringing", recording_enabled: false };
          await admin.from("pbx_calls").insert(call);
          await admin.from("pbx_call_legs").insert(agentLeg);
          const r = await route(admin, call, { type: "extension", id: t.id });
          if (!r.people) return twiml(`<Say>${xml(`${t.display_name} is unavailable.`)}</Say><Hangup/>`);
          bg(kick(admin, id));
          return twiml(`<Dial><Conference ${confAttrs(call, false, false, { wait: true })}>${xml(call.conference_name)}</Conference></Dial>`);
        }

        if (!(settings.outbound_country_codes as string[]).some((p) => target.e164.startsWith(p))) {
          return twiml("<Say>Calls to that destination are not permitted.</Say><Hangup/>");
        }
        const cid = await resolveCallerId(admin, ext);
        if (!cid) return twiml("<Say>No outbound caller ID is assigned to your extension.</Say><Hangup/>");
        const { data: ln } = await admin.from("pbx_lines").select("recording_override").eq("id", cid.lineId).maybeSingle();
        const record = shouldRecord(settings.recording_mode, "outbound", ln?.recording_override);
        const call = { ...base, direction: "outbound", from_number: cid.e164, to_number: target.e164, line_id: cid.lineId, status: "ringing", recording_enabled: record };
        await admin.from("pbx_calls").insert(call);
        await admin.from("pbx_call_legs").insert(agentLeg);
        bg(createLeg(admin, call, { role: "customer", target: { number: target.e164 }, from: cid.e164, ringSeconds: 30, joinAction: "pstn-join" }));
        return twiml(`<Dial><Conference ${confAttrs(call, false, false, { wait: true, record })}>${xml(call.conference_name)}</Conference></Dial>`);
      }

      // ---- hold music / queue announcements while a caller waits
      case "wait": {
        const call = await loadCall(admin, q("call"));
        if (!call) return twiml("<Pause length=\"5\"/>");
        const settings = await loadSettings(admin, call.account_owner_id);
        if (call.direction !== "inbound") return twiml("<Pause length=\"5\"/>");
        if (call.queue_id && call.status === "queued") {
          const { data: queue } = await admin.from("pbx_queues").select("*").eq("id", call.queue_id).maybeSingle();
          if (queue) {
            const waited = (Date.now() - Date.parse(call.queue_entered_at)) / 1000;
            if (waited > queue.max_wait_seconds) {
              const r = await route(admin, call, (queue.overflow_destination ?? { type: "voicemail" }) as Destination, 1);
              if (r.people) bg(kick(admin, call.id)); else bg(redirectCustomer(admin, call, r.dest));
              return twiml("<Say>Please hold.</Say><Pause length=\"5\"/>");
            }
            const { data: st } = await admin.rpc("pbx_queue_stats", { p_queue_id: queue.id });
            const stats = (Array.isArray(st) ? st[0] : st) as Row | null;
            const { count } = await admin.from("pbx_calls").select("id", { count: "exact", head: true })
              .eq("queue_id", queue.id).eq("status", "queued").lte("queue_entered_at", call.queue_entered_at);
            const position = count ?? 1;
            const agents = stats?.agents_available || stats?.agents_total || 1;
            const wait = estimateWaitSeconds(position, stats?.avg_handle_seconds ?? 240, agents);
            const text = queueAnnouncement(position, wait, { position: queue.announce_position, wait: queue.announce_wait });
            bg(serveQueue(admin, queue.id)); // the wait poll doubles as the queue's retry heartbeat
            return twiml((text ? `<Say>${xml(text)}</Say>` : "") + `<Play>${xml(holdMusic(settings, queue.hold_music_url))}</Play>`);
          }
        }
        return twiml(`<Play>${xml(holdMusic(settings))}</Play>`);
      }

      // ---- a leg we dialled was answered: decide whether it may join
      case "agent-join": {
        const [call, leg] = await Promise.all([
          loadCall(admin, q("call")),
          admin.from("pbx_call_legs").select("*").eq("id", q("leg")).maybeSingle().then((r) => r.data as Row | null),
        ]);
        if (!call || !leg) return twiml("<Hangup/>");
        if (leg.target_number && leg.role === "agent") {
          return twiml(`<Gather input="dtmf" numDigits="1" timeout="8" method="POST" action="${xml(hook("agent-accept", { call: call.id, leg: leg.id }))}"><Say>Incoming business call. Press 1 to accept.</Say></Gather><Hangup/>`);
        }
        return joinAgent(admin, call, leg);
      }

      case "agent-accept": {
        const [call, leg] = await Promise.all([
          loadCall(admin, q("call")),
          admin.from("pbx_call_legs").select("*").eq("id", q("leg")).maybeSingle().then((r) => r.data as Row | null),
        ]);
        if (!call || !leg) return twiml("<Hangup/>");
        if (params.Digits !== "1") {
          await admin.from("pbx_call_legs").update({ status: "canceled", answered_at: null }).eq("id", leg.id);
          bg(runDispatch(admin, call.id));
          return twiml("<Hangup/>");
        }
        return joinAgent(admin, call, leg);
      }

      // ---- outbound / external consult leg answered
      case "pstn-join": {
        const [call, leg] = await Promise.all([
          loadCall(admin, q("call")),
          admin.from("pbx_call_legs").select("*").eq("id", q("leg")).maybeSingle().then((r) => r.data as Row | null),
        ]);
        if (!call || !leg) return twiml("<Hangup/>");
        const settings = await loadSettings(admin, call.account_owner_id);
        const isCustomer = leg.role === "customer";
        if (isCustomer) await admin.from("pbx_calls").update({ status: "in_progress", answered_at: nowIso() }).eq("id", call.id).eq("status", "ringing");
        await admin.from("pbx_call_legs").update({ status: "in_progress", answered_at: nowIso() }).eq("id", leg.id);
        const notice = isCustomer && call.recording_enabled && settings.recording_announcement ? `<Say>${xml(recordNotice)}</Say>` : "";
        return twiml(`${notice}<Dial><Conference ${confAttrs(call, true, isCustomer)}>${xml(call.conference_name)}</Conference></Dial>`);
      }

      case "leg-status": {
        const s = LEG_STATUS[params.CallStatus];
        if (!s || !q("leg")) return empty();
        const terminal = TERMINAL.includes(s);
        const patch: Row = { status: s, call_sid: params.CallSid };
        if (terminal) patch.ended_at = nowIso();
        if (s === "in_progress") patch.answered_at = nowIso();
        let upd = admin.from("pbx_call_legs").update(patch).eq("id", q("leg")).eq("call_id", q("call"));
        if (!terminal) upd = upd.not("status", "in", `(${TERMINAL.join(",")})`); // callbacks can arrive out of order
        const { data: leg } = await upd.select("id, role, extension_id, answered_at").maybeSingle();
        if (leg && terminal) bg(onLegTerminal(admin, q("call"), leg));
        return empty();
      }

      case "conf-status": {
        if (params.StatusCallbackEvent === "conference-start") {
          await admin.from("pbx_calls").update({ conference_sid: params.ConferenceSid }).eq("id", q("call"));
        } else if (params.StatusCallbackEvent === "conference-end") {
          bg(finalizeCall(admin, q("call")));
        }
        return empty();
      }

      case "customer-done":
        bg(finalizeCall(admin, q("call")));
        return twiml("<Hangup/>");

      case "recording-status": {
        const call = await loadCall(admin, q("call"));
        if (call) bg(saveConferenceRecording(admin, call, params));
        return empty();
      }

      // ---- non-people destinations (also reached via REST redirect)
      case "direct": {
        const call = await loadCall(admin, q("call"));
        if (!call) return twiml("<Hangup/>");
        const settings = await loadSettings(admin, call.account_owner_id);
        const dest = { type: q("t") as Destination["type"], id: q("mb") || undefined, number: q("n") || undefined };
        return twiml(await directTwiml(admin, call, dest, settings));
      }

      case "direct-done": {
        const call = await loadCall(admin, q("call"));
        if (!call) return twiml("<Hangup/>");
        if (params.DialCallStatus === "completed") { await finalizeCall(admin, call.id); return twiml("<Hangup/>"); }
        const settings = await loadSettings(admin, call.account_owner_id);
        return twiml(await voicemailTwiml(admin, call, undefined, settings));
      }

      case "vm-done":
        return twiml("<Say>Thank you. Goodbye.</Say><Hangup/>");

      case "vm-recording": {
        const call = await loadCall(admin, q("call"));
        if (call) bg(saveVoicemail(admin, call, q("mb"), params));
        return empty();
      }

      case "vm-transcript": {
        const call = await loadCall(admin, q("call"));
        if (!call || !params.RecordingSid) return empty();
        const ok = params.TranscriptionStatus === "completed" && params.TranscriptionText;
        await admin.from("pbx_voicemails").upsert({
          account_owner_id: call.account_owner_id, call_id: call.id, recording_sid: params.RecordingSid,
          mailbox_extension_id: q("mb") || null,
          transcript: ok ? params.TranscriptionText.slice(0, 20000) : null,
          transcript_status: ok ? "completed" : "failed",
        }, { onConflict: "recording_sid" });
        if (ok && call.calls_id) await admin.from("calls").update({ transcript: params.TranscriptionText.slice(0, 20000) }).eq("id", call.calls_id);
        return empty();
      }

      default:
        return new Response("Unknown action", { status: 400 });
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "pbx_voice_error", action, error: String(e) }));
    const voice = ["inbound", "app", "agent-join", "agent-accept", "pstn-join", "direct", "direct-done", "wait"].includes(action);
    return voice ? twiml("<Say>We are sorry, something went wrong. Please try again later.</Say><Hangup/>") : empty();
  }
});
