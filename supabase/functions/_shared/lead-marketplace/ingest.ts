// supabase/functions/_shared/lead-marketplace/ingest.ts
//
// The ingestion pipeline: parsed lead -> event row (idempotent) -> lead row ->
// auto-response (SMS and/or email, in parallel) -> measured response time.
// All I/O goes through the injected IngestStore / Responders, so the whole flow
// (idempotency, SLA budget, fallbacks, quiet hours, retries) is unit-tested with
// in-memory fakes. Production wiring lives in runtime.ts.

import { buildAiPrompt, aiBudgetMs, buildEmailTemplate, buildSmsTemplate, firstNameOf, isQuietHours, validateAiSms } from "./autoRespond.ts";
import { buildDedupeKey, fallbackLeadName } from "./parsers.ts";
import { PROVIDER_LABELS, type EventRow, type IngestStore, type ParsedLead, type Responders, type SourceRow } from "./types.ts";

export const MAX_ATTEMPTS = 3;
const RETRY_WINDOW_MS = 24 * 3600_000;
const RAW_RETENTION_MS = 30 * 24 * 3600_000;

export interface IngestDeps {
  store: IngestStore;
  responders: Responders;
  /** Production: EdgeRuntime.waitUntil. Tests: collect and await. */
  schedule: (work: Promise<unknown>) => void;
}

export type IngestOutcome =
  | { status: "lead_created"; leadId: string; eventId: string }
  | { status: "duplicate"; leadId: string | null; eventId: string };

export interface IngestArgs {
  source: SourceRow;
  receivedVia: "webhook" | "email";
  parsed: ParsedLead;
  rawPayload: string;
  receivedAtMs: number;
}

function leadNotes(p: ParsedLead): string | null {
  const parts = [`Via ${PROVIDER_LABELS[p.provider]}`, p.location ? `Location: ${p.location}` : null, p.message ? `Request: ${p.message}` : null];
  return parts.filter(Boolean).join("\n").slice(0, 2000);
}

export async function ingestParsedLead(deps: IngestDeps, args: IngestArgs): Promise<IngestOutcome> {
  const { store } = deps;
  const { source, parsed } = args;
  const receivedAt = new Date(args.receivedAtMs).toISOString();

  const costCents = parsed.costCents ?? source.default_cost_cents ?? null;
  const costSource = parsed.costCents !== null ? "parsed" : source.default_cost_cents !== null ? "default" : null;

  const inserted = await store.insertEvent({
    user_id: source.user_id,
    source_id: source.id,
    provider: source.provider,
    received_via: args.receivedVia,
    dedupe_key: buildDedupeKey(source.provider, parsed, receivedAt),
    external_id: parsed.externalId,
    parsed,
    raw_payload: args.rawPayload.slice(0, 16_000),
    cost_cents: costCents,
    cost_source: costSource,
    received_at: receivedAt,
  });
  const event = inserted.event;

  // Duplicate delivery (provider retry, or webhook + email for the same lead).
  if (!inserted.created && event.lead_id) {
    if (isRetryable(event) && args.receivedAtMs - Date.parse(event.received_at) < RETRY_WINDOW_MS) {
      deps.schedule(respondToLead(deps, source, event, parsed));
    }
    return { status: "duplicate", leadId: event.lead_id, eventId: event.id };
  }

  // New event, or a previous attempt died before the lead row existed.
  let leadId: string;
  try {
    leadId = await store.insertLead({
      user_id: source.user_id,
      name: parsed.name ?? fallbackLeadName(source.provider),
      phone: parsed.phone,
      email: parsed.email,
      service_interested: parsed.service,
      notes: leadNotes(parsed),
      stage: "new",
      source: source.provider,
      source_cost_cents: costCents,
      source_external_id: parsed.externalId,
    });
  } catch (err) {
    await store.updateEvent(event.id, { status: "error", parse_error: `lead_insert_failed: ${errMsg(err)}` }).catch(() => undefined);
    throw err; // 5xx -> the marketplace retries -> duplicate path above re-attempts the lead insert
  }
  await store.updateEvent(event.id, { status: "lead_created", lead_id: leadId });

  deps.schedule(respondToLead(deps, source, { ...event, lead_id: leadId, status: "lead_created" }, parsed));
  return { status: "lead_created", leadId, eventId: event.id };
}

function isRetryable(e: EventRow): boolean {
  return (e.auto_respond_status === "pending" || e.auto_respond_status === "failed") && e.attempt_count < MAX_ATTEMPTS;
}

function errMsg(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}

/** Never throws: any failure is recorded on the event so the sweeper can retry. */
export async function respondToLead(deps: IngestDeps, source: SourceRow, event: EventRow, parsed: ParsedLead): Promise<void> {
  const { store, responders } = deps;
  try {
    if (!source.auto_respond_enabled) {
      await store.updateEvent(event.id, { auto_respond_status: "skipped_disabled" });
      return;
    }
    if (!parsed.phone && !parsed.email) {
      await store.updateEvent(event.id, { auto_respond_status: "skipped_no_contact" });
      return;
    }

    const quiet = source.sms_quiet_hours && isQuietHours(responders.now(), source.timezone);
    const smsAllowed = Boolean(parsed.phone) && !quiet;
    if (!smsAllowed && !parsed.email) {
      await store.updateEvent(event.id, { auto_respond_status: "deferred_quiet_hours" });
      return;
    }

    if (!(await store.claimEvent(event.id, event.attempt_count))) return; // another worker owns this attempt

    const tenant = await store.getTenant(source.user_id);
    const businessName = tenant.companyName?.trim() || "our team";
    const tplInput = {
      firstName: firstNameOf(parsed.name, parsed.provider),
      businessName,
      provider: parsed.provider,
      service: parsed.service,
      bookingUrl: source.booking_url,
    };

    const receivedMs = Date.parse(event.received_at);
    let smsBody = buildSmsTemplate(tplInput);
    let usedAi = false;
    if (smsAllowed && responders.composeAiSms) {
      const budget = aiBudgetMs(responders.now() - receivedMs);
      if (budget > 0) {
        const prompt = buildAiPrompt(parsed, { businessName, bookingUrl: source.booking_url });
        try {
          const candidate = validateAiSms(await responders.composeAiSms({ ...prompt, timeoutMs: budget }), { bookingUrl: source.booking_url, businessName });
          if (candidate) {
            smsBody = candidate;
            usedAi = true;
          }
        } catch {
          /* template stays */
        }
      }
    }
    const email = buildEmailTemplate(tplInput);

    const [sms, mail] = await Promise.all([
      smsAllowed && parsed.phone ? responders.sendSms(source.user_id, parsed.phone, smsBody).catch((e) => ({ ok: false as const, reason: "EXCEPTION", detail: errMsg(e) })) : Promise.resolve(null),
      parsed.email
        ? responders
            .sendEmail({ userId: source.user_id, to: parsed.email, subject: email.subject, text: email.text, replyTo: tenant.replyToAlias, fromName: tenant.companyName })
            .catch((e) => ({ ok: false as const, reason: "EXCEPTION", detail: errMsg(e) }))
        : Promise.resolve(null),
    ]);

    const channels = [sms?.ok ? "sms" : null, mail?.ok ? "email" : null].filter(Boolean) as string[];
    const errors = [sms && !sms.ok ? `sms:${sms.reason}` : null, mail && !mail.ok ? `email:${mail.reason}` : null].filter(Boolean) as string[];

    if (channels.length) {
      const nowMs = responders.now();
      await store.updateEvent(event.id, {
        auto_respond_status: "sent",
        auto_respond_channel: channels.join("+"),
        auto_respond_error: errors.length ? errors.join(", ") : null,
        auto_respond_ai: usedAi && channels.includes("sms"),
        responded_at: new Date(nowMs).toISOString(),
        response_ms: Math.max(0, nowMs - receivedMs),
      });
      if (event.lead_id) await store.markLeadResponded(event.lead_id, new Date(nowMs).toISOString());
    } else {
      await store.updateEvent(event.id, { auto_respond_status: "failed", auto_respond_error: errors.join(", ") || "no_channel" });
    }
  } catch (err) {
    await store.updateEvent(event.id, { auto_respond_status: "failed", auto_respond_error: `exception: ${errMsg(err)}` }).catch(() => undefined);
  }
}

/** Cron entry: retry stuck/failed/deferred responses, purge old raw payloads. */
export async function sweepPending(deps: IngestDeps): Promise<{ retried: number }> {
  const nowMs = deps.responders.now();
  const events = await deps.store.listRetryable(nowMs, 50);
  let retried = 0;
  for (const event of events) {
    if (!event.parsed || !event.lead_id) continue;
    const source = await deps.store.getSource(event.user_id, event.provider);
    if (!source || !source.enabled) continue;
    await respondToLead(deps, source, event, event.parsed);
    retried++;
  }
  await deps.store.purgeRawPayloads(new Date(nowMs - RAW_RETENTION_MS).toISOString());
  return { retried };
}
