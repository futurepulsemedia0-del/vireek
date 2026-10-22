// supabase/functions/job-summary-engine/index.ts
//
// Automatic post-job summaries ("what we did").
//
// Two entry points:
//   1. CRON (header X-Cron-Secret == CRON_SECRET):
//        - ENQUEUE: for every account with auto_generate on, find jobs completed after the moment it was
//          switched on (never the historical backlog), older than a short settle delay (photos/notes are
//          usually added right after "complete"), without a summary yet -> generate it.
//          auto_send + no blocking warning  -> status 'scheduled' after the staff review window
//          otherwise                        -> status 'draft' and the owner gets a notification.
//        - DELIVER: claim due summaries and send SMS (sendCompliantSms: A2P + STOP + quiet hours) and/or
//          email, per-channel state, retries for transient failures.
//   2. USER (Authorization: Bearer <JWT>, body {action, ...}):
//        generate | send | publish | hold | skip
//      Authorisation = can_manage_job_summaries() + the row/job must be readable through the CALLER's
//      RLS-scoped client and belong to the caller's account.
//
// DEPLOYMENT: supabase functions deploy job-summary-engine --no-verify-jwt
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (auto), CRON_SECRET, SITE_URL,
//      Twilio + Resend secrets (already set for your other senders).

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";
import { sendEmail } from "../_shared/notify/deliver.ts";
import { getPreferences } from "../_shared/compliance/preferenceCheck.ts";
import { askVireekAi } from "../_shared/ai-core/index.ts";
import {
  DEFAULT_EMAIL_SUBJECT,
  DEFAULT_SMS_BODY,
  DEFAULT_SUMMARY_SETTINGS,
  SUMMARY_LIMITS,
  buildPolishPrompt,
  buildWarnings,
  composeSummary,
  firstName,
  hasBlockingWarning,
  isoDateInTz,
  netUsedParts,
  parsePolish,
  plainLine,
  renderEmail,
  renderSms,
  splitWorkNotes,
  validatePolish,
  type PartTransactionRow,
  type SourceEquipment,
  type SourcePart,
  type SourcePhoto,
  type SummaryContent,
  type SummaryInput,
  type SummarySettings,
} from "../_shared/job-summary/compose.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const fail = (status: number, error: string, detail: string) => json({ error, detail }, status);

const LOOKBACK_HOURS = 72; // never summarise a job completed longer ago than this
const SETTLE_MINUTES = 10; // let techs finish notes/photos after tapping "complete"
const ENQUEUE_PER_ACCOUNT = 25;
const ENQUEUE_TOTAL = 100;
const DELIVER_BATCH = 50;
const MAX_ATTEMPTS = 3;
const STUCK_SENDING_MINUTES = 15;

type Admin = SupabaseClient;
type Channel = "sms" | "email" | "both";
type ChannelState = "pending" | "sent" | "failed" | "skipped";

interface SettingsRow {
  user_id: string;
  auto_generate: boolean;
  auto_generate_enabled_at: string | null;
  auto_send: boolean;
  review_window_minutes: number;
  channel: Channel;
  ai_polish: boolean;
  include_photos: boolean;
  include_parts: boolean;
  include_warranty: boolean;
  include_tips: boolean;
  max_photos: number;
  labor_warranty_days: number | null;
  parts_warranty_note: string | null;
  default_service_interval_months: number;
  custom_tips: string[];
  sms_body: string;
  email_subject: string;
  timezone: string;
}

interface SummaryRow {
  id: string;
  user_id: string;
  job_id: string;
  customer_id: string | null;
  token: string;
  headline: string;
  intro: string;
  work_summary: string;
  work_items: string[];
  parts: { name: string; quantity: number }[];
  warranty: { label: string; expires_on: string | null; note: string | null }[];
  photos: unknown[];
  maintenance_tips: string[];
  next_service_date: string | null;
  next_service_note: string | null;
  customer_name: string;
  service_type: string | null;
  status: string;
  channel: Channel;
  sms_state: ChannelState;
  email_state: ChannelState;
  sent_at: string | null;
  attempts: number;
}

const siteUrl = () => (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS_ROW = (userId: string): SettingsRow => ({
  user_id: userId,
  auto_generate: false,
  auto_generate_enabled_at: null,
  auto_send: false,
  review_window_minutes: 60,
  channel: "both",
  ai_polish: true,
  include_photos: DEFAULT_SUMMARY_SETTINGS.includePhotos,
  include_parts: DEFAULT_SUMMARY_SETTINGS.includeParts,
  include_warranty: DEFAULT_SUMMARY_SETTINGS.includeWarranty,
  include_tips: DEFAULT_SUMMARY_SETTINGS.includeTips,
  max_photos: DEFAULT_SUMMARY_SETTINGS.maxPhotos,
  labor_warranty_days: null,
  parts_warranty_note: null,
  default_service_interval_months: DEFAULT_SUMMARY_SETTINGS.defaultServiceIntervalMonths,
  custom_tips: [],
  sms_body: DEFAULT_SMS_BODY,
  email_subject: DEFAULT_EMAIL_SUBJECT,
  timezone: DEFAULT_SUMMARY_SETTINGS.timezone,
});

async function loadSettings(admin: Admin, userId: string): Promise<SettingsRow> {
  const { data } = await admin.from("job_summary_settings").select("*").eq("user_id", userId).maybeSingle();
  return (data as SettingsRow | null) ?? DEFAULT_SETTINGS_ROW(userId);
}

function toComposeSettings(s: SettingsRow): SummarySettings {
  return {
    includePhotos: s.include_photos,
    includeParts: s.include_parts,
    includeWarranty: s.include_warranty,
    includeTips: s.include_tips,
    maxPhotos: s.max_photos,
    laborWarrantyDays: s.labor_warranty_days,
    partsWarrantyNote: s.parts_warranty_note,
    defaultServiceIntervalMonths: s.default_service_interval_months,
    customTips: s.custom_tips ?? [],
    timezone: s.timezone,
  };
}

// ---------------------------------------------------------------------------
// Gather source data for one job
// ---------------------------------------------------------------------------

interface JobRow {
  id: string;
  user_id: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  service_type: string | null;
  job_status: string;
  completed_at: string | null;
  assigned_technician_id: string | null;
  work_performed_notes: string | null;
  technician_diagnosis: string | null;
  next_maintenance_date: string | null;
  quality_check_passed: boolean | null;
  customer_disputed: boolean | null;
  before_photos: string[] | null;
  after_photos: string[] | null;
}

const JOB_COLUMNS =
  "id,user_id,customer_id,customer_name,customer_phone,service_type,job_status,completed_at,assigned_technician_id," +
  "work_performed_notes,technician_diagnosis,next_maintenance_date,quality_check_passed,customer_disputed,before_photos,after_photos";

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

async function gatherInput(admin: Admin, job: JobRow): Promise<SummaryInput> {
  const [profile, tech, photoRows, txRows, requiredRows, jobEquip, installedEquip] = await Promise.all([
    admin.from("profiles").select("company_name").eq("id", job.user_id).maybeSingle(),
    job.assigned_technician_id
      ? admin.from("team_members").select("member_name").eq("id", job.assigned_technician_id).maybeSingle()
      : Promise.resolve({ data: null }),
    admin
      .from("job_photos")
      .select("storage_path,kind,caption,pair_id,taken_at")
      .eq("job_id", job.id)
      .eq("user_id", job.user_id)
      .order("taken_at", { ascending: true })
      .limit(60),
    admin
      .from("inventory_transactions")
      .select("part_id,transaction_type,quantity_delta,inventory_parts(name)")
      .eq("job_id", job.id)
      .in("transaction_type", ["usage", "return"]),
    admin
      .from("job_parts_required")
      .select("quantity_required,inventory_parts(name)")
      .eq("job_id", job.id)
      .eq("status", "installed"),
    admin
      .from("job_equipment")
      .select("equipment(equipment_type,make,model,warranty_expires_at,warranty_notes,service_interval_months,status)")
      .eq("job_id", job.id),
    admin
      .from("equipment")
      .select("equipment_type,make,model,warranty_expires_at,warranty_notes,service_interval_months,status")
      .eq("install_job_id", job.id),
  ]);

  const photos: SourcePhoto[] = [];
  for (const p of (photoRows.data ?? []) as {
    storage_path: string;
    kind: SourcePhoto["kind"];
    caption: string | null;
    pair_id: string | null;
    taken_at: string | null;
  }[]) {
    photos.push({ bucket: "job-photos", path: p.storage_path, kind: p.kind, caption: p.caption, pairId: p.pair_id, takenAt: p.taken_at });
  }
  // Legacy before/after photos (public job-room-photos bucket) — shown after the gallery ones.
  for (const path of job.before_photos ?? []) {
    photos.push({ bucket: "job-room-photos", path, kind: "before", caption: null, pairId: null, takenAt: null });
  }
  for (const path of job.after_photos ?? []) {
    photos.push({ bucket: "job-room-photos", path, kind: "after", caption: null, pairId: null, takenAt: null });
  }

  const tx: PartTransactionRow[] = ((txRows.data ?? []) as {
    part_id: string;
    transaction_type: string;
    quantity_delta: number;
    inventory_parts: { name: string } | { name: string }[] | null;
  }[]).map((r) => ({
    partId: r.part_id,
    name: one(r.inventory_parts)?.name ?? "Part",
    transactionType: r.transaction_type,
    quantityDelta: r.quantity_delta,
  }));
  let parts: SourcePart[] = netUsedParts(tx);
  if (parts.length === 0) {
    parts = ((requiredRows.data ?? []) as { quantity_required: number; inventory_parts: { name: string } | { name: string }[] | null }[])
      .map((r) => ({ name: one(r.inventory_parts)?.name ?? "", quantity: r.quantity_required }))
      .filter((p) => p.name);
  }

  type EquipRow = {
    equipment_type: string | null;
    make: string | null;
    model: string | null;
    warranty_expires_at: string | null;
    warranty_notes: string | null;
    service_interval_months: number | null;
    status: string | null;
  };
  const rawEquip: EquipRow[] = [
    ...((jobEquip.data ?? []) as { equipment: EquipRow | EquipRow[] | null }[]).map((r) => one(r.equipment)).filter((e): e is EquipRow => !!e),
    ...((installedEquip.data ?? []) as EquipRow[]),
  ].filter((e) => e.status !== "removed");
  const seen = new Set<string>();
  const equipment: SourceEquipment[] = [];
  for (const e of rawEquip) {
    const key = [e.equipment_type, e.make, e.model, e.warranty_expires_at].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    equipment.push({
      equipmentType: e.equipment_type,
      make: e.make,
      model: e.model,
      warrantyExpiresAt: e.warranty_expires_at,
      warrantyNotes: e.warranty_notes,
      serviceIntervalMonths: e.service_interval_months,
    });
  }

  return {
    businessName: (profile.data as { company_name: string | null } | null)?.company_name ?? null,
    customerName: job.customer_name || "Customer",
    serviceType: job.service_type,
    completedAt: job.completed_at,
    technicianName: (tech.data as { member_name: string | null } | null)?.member_name ?? null,
    workPerformedNotes: job.work_performed_notes,
    diagnosisNotes: job.technician_diagnosis,
    nextMaintenanceDate: job.next_maintenance_date,
    qualityCheckPassed: job.quality_check_passed,
    customerDisputed: !!job.customer_disputed,
    photos,
    parts,
    equipment,
  };
}

async function customerContacts(admin: Admin, job: Pick<JobRow, "customer_id" | "customer_phone" | "user_id">) {
  let email: string | null = null;
  let phone: string | null = job.customer_phone;
  if (job.customer_id) {
    const { data } = await admin.from("customers").select("email,phone").eq("id", job.customer_id).eq("user_id", job.user_id).maybeSingle();
    email = (data as { email: string | null } | null)?.email ?? null;
    phone = phone || (data as { phone: string | null } | null)?.phone || null;
  }
  return { email: email?.trim() || null, phone: phone?.trim() || null };
}

// ---------------------------------------------------------------------------
// Optional AI polish (advisory; falls back to the deterministic text)
// ---------------------------------------------------------------------------

async function tryPolish(input: SummaryInput, content: SummaryContent): Promise<SummaryContent | null> {
  // Only sanitised text goes to the model (internal / cost lines were already removed).
  const items = splitWorkNotes(input.workPerformedNotes, SUMMARY_LIMITS.workItems);
  if (items.join(" ").length < 15) return null;
  const partNames = input.parts.map((p) => p.name);
  try {
    const result = await askVireekAi({
      task: "general",
      maxTokens: 500,
      temperature: 0.3,
      timeoutMs: 20_000,
      messages: [
        {
          role: "user",
          content: buildPolishPrompt({
            serviceType: input.serviceType,
            notes: items.join("\n"),
            diagnosis: content.work_summary,
            parts: partNames,
          }),
        },
      ],
    });
    const parsed = parsePolish(result.text);
    const source = [items.join("\n"), content.work_summary, input.serviceType ?? "", ...input.parts.map((p) => `${p.quantity} ${p.name}`)].join("\n");
    const verdict = validatePolish(parsed, source);
    if (!verdict.ok || !parsed) {
      console.log(JSON.stringify({ event: "job_summary_polish_rejected", reason: verdict.ok ? "empty" : verdict.reason }));
      return null;
    }
    return { ...content, work_summary: parsed.summary, work_items: parsed.items.slice(0, SUMMARY_LIMITS.workItems) };
  } catch (e) {
    console.error(JSON.stringify({ event: "job_summary_polish_failed", error: e instanceof Error ? e.message : String(e) }));
    return null;
  }
}

// ---------------------------------------------------------------------------
// GENERATE
// ---------------------------------------------------------------------------

type GenerateResult =
  | { ok: true; summary: SummaryRow; created: boolean }
  | { ok: false; status: number; error: string; detail: string };

async function generateForJob(
  admin: Admin,
  jobId: string,
  source: "auto" | "manual",
  preloadedSettings?: SettingsRow,
): Promise<GenerateResult> {
  const { data: jobData } = await admin.from("jobs").select(JOB_COLUMNS).eq("id", jobId).maybeSingle();
  const job = jobData as JobRow | null;
  if (!job) return { ok: false, status: 404, error: "NOT_FOUND", detail: "Job not found." };
  if (job.job_status !== "completed") {
    return { ok: false, status: 422, error: "JOB_NOT_COMPLETED", detail: "Summaries can only be generated for completed jobs." };
  }

  const { data: existingData } = await admin.from("job_summaries").select("*").eq("job_id", job.id).maybeSingle();
  const existing = existingData as SummaryRow | null;
  if (existing && source === "auto") return { ok: true, summary: existing, created: false };
  if (existing?.status === "sending") return { ok: false, status: 409, error: "BUSY", detail: "This summary is being sent right now." };
  if (existing?.sent_at) {
    return { ok: false, status: 409, error: "ALREADY_SENT", detail: "This summary was already sent. Edit it instead of regenerating." };
  }

  const settings = preloadedSettings ?? (await loadSettings(admin, job.user_id));
  const composeSettings = toComposeSettings(settings);
  const input = await gatherInput(admin, job);
  let content = composeSummary(input, composeSettings);
  let aiPolished = false;
  if (settings.ai_polish) {
    const polished = await tryPolish(input, content);
    if (polished) {
      content = polished;
      aiPolished = true;
    }
  }

  const contacts = await customerContacts(admin, job);
  const hasContact = !!(contacts.phone || contacts.email);
  content.warnings = buildWarnings(content, {
    qualityFailed: input.qualityCheckPassed === false,
    disputed: input.customerDisputed,
    includePhotos: composeSettings.includePhotos,
    includeWarranty: composeSettings.includeWarranty,
    hasContact,
  });

  const now = new Date();
  const autoSend = source === "auto" && settings.auto_send && !hasBlockingWarning(content.warnings);
  const status = autoSend ? "scheduled" : "draft";
  const scheduledAt = autoSend ? new Date(now.getTime() + settings.review_window_minutes * 60_000).toISOString() : null;

  const contentColumns = {
    headline: content.headline,
    intro: content.intro,
    work_summary: content.work_summary,
    work_items: content.work_items,
    parts: content.parts,
    warranty: content.warranty,
    photos: content.photos,
    maintenance_tips: content.maintenance_tips,
    next_service_date: content.next_service_date,
    next_service_note: content.next_service_note,
    technician_first_name: content.technician_first_name,
    service_type: content.service_type,
    service_date: content.service_date,
    warnings: content.warnings,
    ai_polished: aiPolished,
  };
  const resetDelivery = {
    status,
    channel: settings.channel,
    scheduled_send_at: scheduledAt,
    sms_state: "pending" as ChannelState,
    email_state: "pending" as ChannelState,
    delivery_error: null,
    attempts: 0,
    claimed_at: null,
    generated_at: now.toISOString(),
  };

  if (existing) {
    const { data, error } = await admin
      .from("job_summaries")
      .update({ ...contentColumns, ...resetDelivery, customer_name: input.customerName, trigger_source: source })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) return { ok: false, status: 500, error: "WRITE_FAILED", detail: error.message };
    return { ok: true, summary: data as SummaryRow, created: false };
  }

  const { data, error } = await admin
    .from("job_summaries")
    .insert({
      user_id: job.user_id,
      job_id: job.id,
      customer_id: job.customer_id,
      customer_name: input.customerName,
      trigger_source: source,
      ...contentColumns,
      ...resetDelivery,
    })
    .select("*")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      // A concurrent run won the race — return the winner untouched.
      const { data: winner } = await admin.from("job_summaries").select("*").eq("job_id", job.id).maybeSingle();
      if (winner) return { ok: true, summary: winner as SummaryRow, created: false };
    }
    return { ok: false, status: 500, error: "WRITE_FAILED", detail: error.message };
  }

  if (source === "auto") {
    const created = data as SummaryRow;
    const label = [input.customerName, input.serviceType].filter(Boolean).join(" — ");
    await admin.from("notifications").insert({
      user_id: job.user_id,
      type: "job_summary",
      title: autoSend ? "Job summary will be sent soon" : "Job summary ready for review",
      message: autoSend
        ? `${label}: it goes to the customer in ${settings.review_window_minutes} min unless you edit or hold it.`
        : `${label}: review and send it to the customer.`,
      action_url: `/dashboard/job-summaries?summary=${created.id}`,
    });
  }
  return { ok: true, summary: data as SummaryRow, created: true };
}

// ---------------------------------------------------------------------------
// DELIVER
// ---------------------------------------------------------------------------

async function claim(admin: Admin, id: string): Promise<SummaryRow | null> {
  const { data: peek } = await admin.from("job_summaries").select("attempts").eq("id", id).maybeSingle();
  const { data } = await admin
    .from("job_summaries")
    .update({ status: "sending", claimed_at: new Date().toISOString(), attempts: ((peek as { attempts: number } | null)?.attempts ?? 0) + 1 })
    .eq("id", id)
    .eq("status", "scheduled")
    .select("*")
    .maybeSingle();
  return (data as SummaryRow | null) ?? null;
}

interface DeliveryOutcome {
  status: "scheduled" | "sent" | "failed" | "skipped";
  smsState: ChannelState;
  emailState: ChannelState;
  sentAt: string | null;
  channelUsed: string | null;
  error: string | null;
  nextSendAt: string | null;
  burnAttempt: boolean;
}

async function deliverClaimed(admin: Admin, row: SummaryRow): Promise<DeliveryOutcome> {
  const settings = await loadSettings(admin, row.user_id);
  const { data: jobData } = await admin
    .from("jobs")
    .select("id,user_id,customer_id,customer_phone")
    .eq("id", row.job_id)
    .maybeSingle();
  const job = (jobData as Pick<JobRow, "id" | "user_id" | "customer_id" | "customer_phone"> | null) ?? {
    id: row.job_id,
    user_id: row.user_id,
    customer_id: row.customer_id,
    customer_phone: null,
  };
  const [{ data: profile }, contacts, prefs] = await Promise.all([
    admin.from("profiles").select("company_name").eq("id", row.user_id).maybeSingle(),
    customerContacts(admin, job),
    getPreferences(admin, row.customer_id),
  ]);
  const businessName = plainLine((profile as { company_name: string | null } | null)?.company_name, 80) || "us";
  const link = `${siteUrl()}/summary/${row.token}`;
  const vars = {
    customer_first_name: firstName(row.customer_name) || "there",
    business_name: businessName,
    service_type: row.service_type ?? "service visit",
    link,
  };

  let smsState = row.sms_state;
  let emailState = row.email_state;
  const wantsSms = row.channel === "sms" || row.channel === "both";
  const wantsEmail = row.channel === "email" || row.channel === "both";
  if (!wantsSms && smsState === "pending") smsState = "skipped";
  if (!wantsEmail && emailState === "pending") emailState = "skipped";

  const errors: string[] = [];
  const sentNow: string[] = [];
  let transient = false;
  let nextSendAt: string | null = null;

  // ---- SMS ----
  if (smsState === "pending") {
    if (!contacts.phone) {
      smsState = "skipped";
      errors.push("SMS: no phone number on file.");
    } else if (prefs === "error") {
      transient = true;
      errors.push("SMS: preferences could not be verified.");
    } else if (!prefs.sms) {
      smsState = "skipped";
      errors.push("SMS: customer opted out of text messages.");
    } else {
      const r = await sendCompliantSms(admin, row.user_id, contacts.phone, renderSms(settings.sms_body, vars), {
        purpose: "service",
        customerId: row.customer_id,
        source: "job-summary-engine",
        dedupeKey: `job-summary:${row.id}`,
        onQuiet: "caller",
      });
      if (r.ok) {
        smsState = "sent";
        sentNow.push("sms");
      } else if (r.reason === "QUIET_HOURS") {
        nextSendAt = r.sendAt;
      } else if (r.reason === "OPTED_OUT") {
        smsState = "skipped";
        errors.push("SMS: customer opted out (STOP).");
      } else if (r.reason === "TWILIO_ERROR" || r.reason === "QUEUE_ERROR") {
        transient = true;
        errors.push(`SMS: ${r.reason}${r.detail ? ` (${String(r.detail).slice(0, 120)})` : ""}`);
      } else {
        smsState = "failed";
        errors.push(`SMS: ${r.reason}${r.detail ? ` (${String(r.detail).slice(0, 120)})` : ""}`);
      }
    }
  }

  // ---- Email ----
  if (emailState === "pending") {
    if (!contacts.email) {
      emailState = "skipped";
      errors.push("Email: no email address on file.");
    } else if (prefs === "error") {
      transient = true;
      errors.push("Email: preferences could not be verified.");
    } else if (!prefs.email) {
      emailState = "skipped";
      errors.push("Email: customer opted out of email.");
    } else {
      const mail = renderEmail({
        subjectTemplate: settings.email_subject,
        vars,
        content: {
          headline: row.headline,
          intro: row.intro,
          work_summary: row.work_summary,
          work_items: row.work_items,
          parts: row.parts,
          warranty: row.warranty,
          maintenance_tips: row.maintenance_tips,
          next_service_date: row.next_service_date,
          next_service_note: row.next_service_note,
          photoCount: row.photos.length,
        },
        todayISO: isoDateInTz(new Date(), settings.timezone) ?? new Date().toISOString().slice(0, 10),
      });
      const r = await sendEmail(contacts.email, mail.subject, mail.html, mail.text);
      if (r.ok) {
        emailState = "sent";
        sentNow.push("email");
      } else {
        transient = true;
        errors.push(`Email: ${(r.error ?? "provider error").slice(0, 160)}`);
      }
    }
  }

  const nowIso = new Date().toISOString();
  const sentAt = row.sent_at ?? (sentNow.length > 0 ? nowIso : null);
  const channelUsed = [smsState === "sent" ? "sms" : null, emailState === "sent" ? "email" : null].filter(Boolean).join("+") || null;
  const stillPending = smsState === "pending" || emailState === "pending";

  if (stillPending) {
    if (nextSendAt) {
      // Waiting for the SMS window — doesn't burn an attempt.
      return { status: "scheduled", smsState, emailState, sentAt, channelUsed, error: errors.join(" | ") || null, nextSendAt, burnAttempt: false };
    }
    if (transient && row.attempts < MAX_ATTEMPTS) {
      return {
        status: "scheduled",
        smsState,
        emailState,
        sentAt,
        channelUsed,
        error: errors.join(" | ") || null,
        nextSendAt: new Date(Date.now() + 15 * row.attempts * 60_000).toISOString(),
        burnAttempt: true,
      };
    }
    // Retries exhausted: give up on whatever is still pending.
    if (smsState === "pending") smsState = "failed";
    if (emailState === "pending") emailState = "failed";
    errors.push(`Gave up after ${row.attempts} attempts.`);
  }

  const status: DeliveryOutcome["status"] = sentAt
    ? "sent"
    : smsState === "failed" || emailState === "failed"
      ? "failed"
      : "skipped";
  return { status, smsState, emailState, sentAt, channelUsed, error: errors.join(" | ").slice(0, 500) || null, nextSendAt: null, burnAttempt: true };
}

async function applyOutcome(admin: Admin, row: SummaryRow, o: DeliveryOutcome): Promise<void> {
  await admin
    .from("job_summaries")
    .update({
      status: o.status,
      sms_state: o.smsState,
      email_state: o.emailState,
      sent_at: o.sentAt,
      channel_used: o.channelUsed,
      delivery_error: o.error ? o.error.slice(0, 500) : null,
      scheduled_send_at: o.status === "scheduled" ? o.nextSendAt : null,
      attempts: o.burnAttempt ? row.attempts : Math.max(0, row.attempts - 1),
      claimed_at: null,
    })
    .eq("id", row.id);
}

async function deliverOne(admin: Admin, id: string): Promise<{ row: SummaryRow; outcome: DeliveryOutcome } | null> {
  const row = await claim(admin, id);
  if (!row) return null;
  let outcome: DeliveryOutcome;
  try {
    outcome = await deliverClaimed(admin, row);
  } catch (e) {
    const message = String((e as Error).message ?? e).slice(0, 300);
    outcome =
      row.attempts < MAX_ATTEMPTS
        ? {
            status: "scheduled",
            smsState: row.sms_state,
            emailState: row.email_state,
            sentAt: row.sent_at,
            channelUsed: null,
            error: message,
            nextSendAt: new Date(Date.now() + 15 * row.attempts * 60_000).toISOString(),
            burnAttempt: true,
          }
        : {
            status: "failed",
            smsState: row.sms_state === "pending" ? "failed" : row.sms_state,
            emailState: row.email_state === "pending" ? "failed" : row.email_state,
            sentAt: row.sent_at,
            channelUsed: null,
            error: message,
            nextSendAt: null,
            burnAttempt: true,
          };
  }
  await applyOutcome(admin, row, outcome);
  return { row, outcome };
}

// ---------------------------------------------------------------------------
// CRON
// ---------------------------------------------------------------------------

async function enqueueAuto(admin: Admin): Promise<{ generated: number; scheduled: number; drafted: number; errors: number }> {
  const result = { generated: 0, scheduled: 0, drafted: 0, errors: 0 };
  const { data: accounts } = await admin.from("job_summary_settings").select("*").eq("auto_generate", true);
  const now = Date.now();
  let total = 0;

  for (const s of (accounts ?? []) as SettingsRow[]) {
    if (total >= ENQUEUE_TOTAL) break;
    const enabledAt = s.auto_generate_enabled_at ? Date.parse(s.auto_generate_enabled_at) : now;
    const from = new Date(Math.max(now - LOOKBACK_HOURS * 3_600_000, enabledAt)).toISOString();
    const settledBefore = new Date(now - SETTLE_MINUTES * 60_000).toISOString();

    const { data: jobs } = await admin
      .from("jobs")
      .select("id")
      .eq("user_id", s.user_id)
      .eq("job_status", "completed")
      .gte("completed_at", from)
      .lte("completed_at", settledBefore)
      .order("completed_at", { ascending: true })
      .limit(ENQUEUE_PER_ACCOUNT * 2);
    if (!jobs?.length) continue;

    const ids = (jobs as { id: string }[]).map((j) => j.id);
    const { data: existing } = await admin.from("job_summaries").select("job_id").in("job_id", ids);
    const have = new Set(((existing ?? []) as { job_id: string }[]).map((r) => r.job_id));
    const fresh = ids.filter((id) => !have.has(id)).slice(0, ENQUEUE_PER_ACCOUNT);

    for (const id of fresh) {
      if (total >= ENQUEUE_TOTAL) break;
      try {
        const r = await generateForJob(admin, id, "auto", s);
        if (!r.ok) {
          result.errors++;
          continue;
        }
        if (r.created) {
          total++;
          result.generated++;
          if (r.summary.status === "scheduled") result.scheduled++;
          else result.drafted++;
        }
      } catch (e) {
        result.errors++;
        console.error(JSON.stringify({ event: "job_summary_generate_failed", jobId: id, error: e instanceof Error ? e.message : String(e) }));
      }
    }
  }
  return result;
}

async function deliverDue(admin: Admin): Promise<{ sent: number; retried: number; failed: number; skipped: number }> {
  const result = { sent: 0, retried: 0, failed: 0, skipped: 0 };

  // Crash recovery: anything stuck in 'sending' goes back to the queue.
  await admin
    .from("job_summaries")
    .update({ status: "scheduled", claimed_at: null })
    .eq("status", "sending")
    .lt("claimed_at", new Date(Date.now() - STUCK_SENDING_MINUTES * 60_000).toISOString());

  const { data: due } = await admin
    .from("job_summaries")
    .select("id")
    .eq("status", "scheduled")
    .lte("scheduled_send_at", new Date().toISOString())
    .order("scheduled_send_at", { ascending: true })
    .limit(DELIVER_BATCH);

  for (const { id } of (due ?? []) as { id: string }[]) {
    const r = await deliverOne(admin, id);
    if (!r) continue;
    if (r.outcome.status === "sent") result.sent++;
    else if (r.outcome.status === "scheduled") result.retried++;
    else if (r.outcome.status === "failed") result.failed++;
    else result.skipped++;
  }
  return result;
}

// ---------------------------------------------------------------------------
// USER ACTIONS
// ---------------------------------------------------------------------------

async function handleUser(admin: Admin, accessToken: string, body: Record<string, unknown>): Promise<Response> {
  const userClient = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false },
  });

  const { data: userData } = await userClient.auth.getUser();
  if (!userData?.user) return fail(401, "UNAUTHORIZED", "Please sign in again.");
  const { data: allowed } = await userClient.rpc("can_manage_job_summaries");
  if (!allowed) return fail(403, "FORBIDDEN", "You don't have permission to manage job summaries.");
  const { data: ownerId } = await userClient.rpc("get_account_owner_id");
  if (!isUuid(ownerId)) return fail(403, "FORBIDDEN", "Your account could not be resolved.");

  const action = String(body.action ?? "");

  if (action === "generate") {
    if (!isUuid(body.jobId)) return fail(400, "INVALID", "jobId is required.");
    // RLS-scoped read = authorisation for this job.
    const { data: job } = await userClient.from("jobs").select("id,user_id").eq("id", body.jobId).maybeSingle();
    if (!job || (job as { user_id: string }).user_id !== ownerId) return fail(404, "NOT_FOUND", "Job not found.");
    const r = await generateForJob(admin, body.jobId, "manual");
    if (!r.ok) return fail(r.status, r.error, r.detail);
    return json({ summary: r.summary });
  }

  if (!["send", "publish", "hold", "skip"].includes(action)) return fail(400, "INVALID", "Unknown action.");
  if (!isUuid(body.summaryId)) return fail(400, "INVALID", "summaryId is required.");

  const { data: visible } = await userClient.from("job_summaries").select("id,user_id").eq("id", body.summaryId).maybeSingle();
  if (!visible || (visible as { user_id: string }).user_id !== ownerId) return fail(404, "NOT_FOUND", "Summary not found.");

  const { data: currentData } = await admin.from("job_summaries").select("*").eq("id", body.summaryId).eq("user_id", ownerId).maybeSingle();
  const current = currentData as SummaryRow | null;
  if (!current) return fail(404, "NOT_FOUND", "Summary not found.");
  if (current.status === "sending") return fail(409, "BUSY", "This summary is being sent right now. Try again in a moment.");

  if (action === "send") {
    if (current.sent_at && body.resend !== true) {
      return fail(409, "ALREADY_SENT", "This summary was already sent. Use Resend to send it again.");
    }
    const channel = body.channel === "sms" || body.channel === "email" || body.channel === "both" ? body.channel : current.channel;
    const { error } = await admin
      .from("job_summaries")
      .update({
        status: "scheduled",
        channel,
        scheduled_send_at: new Date().toISOString(),
        sms_state: "pending",
        email_state: "pending",
        delivery_error: null,
        attempts: 0,
        claimed_at: null,
      })
      .eq("id", current.id)
      .eq("user_id", ownerId);
    if (error) return fail(500, "WRITE_FAILED", error.message);
    const delivered = await deliverOne(admin, current.id);
    const { data: fresh } = await admin.from("job_summaries").select("*").eq("id", current.id).maybeSingle();
    return json({
      status: delivered?.outcome.status ?? (fresh as SummaryRow | null)?.status ?? "scheduled",
      channel: delivered?.outcome.channelUsed ?? null,
      error: delivered?.outcome.error ?? null,
      summary: fresh,
    });
  }

  if (action === "publish") {
    // Portal-only: visible to the customer in their portal and via the link, but nothing is texted or emailed.
    const { data, error } = await admin
      .from("job_summaries")
      .update({
        status: "sent",
        sent_at: current.sent_at ?? new Date().toISOString(),
        channel_used: current.channel_used ?? "portal",
        sms_state: current.sms_state === "sent" ? "sent" : "skipped",
        email_state: current.email_state === "sent" ? "sent" : "skipped",
        scheduled_send_at: null,
        delivery_error: null,
      })
      .eq("id", current.id)
      .eq("user_id", ownerId)
      .select("*")
      .single();
    if (error) return fail(500, "WRITE_FAILED", error.message);
    return json({ summary: data });
  }

  if (action === "hold") {
    if (current.sent_at) return fail(409, "ALREADY_SENT", "This summary was already sent.");
    const { data, error } = await admin
      .from("job_summaries")
      .update({ status: "draft", scheduled_send_at: null, delivery_error: null })
      .eq("id", current.id)
      .eq("user_id", ownerId)
      .select("*")
      .single();
    if (error) return fail(500, "WRITE_FAILED", error.message);
    return json({ summary: data });
  }

  // skip
  if (current.sent_at) return fail(409, "ALREADY_SENT", "This summary was already sent.");
  const { data, error } = await admin
    .from("job_summaries")
    .update({ status: "skipped", scheduled_send_at: null, delivery_error: "Skipped by staff — not sent to the customer." })
    .eq("id", current.id)
    .eq("user_id", ownerId)
    .select("*")
    .single();
  if (error) return fail(500, "WRITE_FAILED", error.message);
  return json({ summary: data });
}

// ---------------------------------------------------------------------------
// ENTRY
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "Method not allowed.");

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  try {
    const cronHeader = req.headers.get("x-cron-secret");
    if (cronHeader) {
      const secret = Deno.env.get("CRON_SECRET") ?? "";
      if (!secret || !timingSafeEqual(cronHeader, secret)) return fail(401, "UNAUTHORIZED", "Bad cron secret.");
      const enqueued = await enqueueAuto(admin);
      const delivered = await deliverDue(admin);
      return json({ ok: true, enqueued, delivered });
    }

    const auth = req.headers.get("authorization") ?? "";
    const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    if (!token) return fail(401, "UNAUTHORIZED", "Please sign in.");
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return await handleUser(admin, token, body);
  } catch (e) {
    console.error(JSON.stringify({ event: "job_summary_engine_failed", error: e instanceof Error ? e.message : String(e) }));
    return fail(500, "INTERNAL", "Something went wrong. Please try again.");
  }
});
