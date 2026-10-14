import { supabase } from '@/lib/supabase';
import {
  buildLinkFilter,
  buildStoragePath,
  emailVariants,
  mapCall,
  mapEmail,
  mapInvoice,
  mapJob,
  mapOutboundSms,
  mapPayment,
  mapQuote,
  mapReview,
  mapSms,
  phoneVariants,
  uniqueById,
  type CustomerNote,
  type CustomerNoteAttachment,
  type RawCall,
  type RawEmail,
  type RawInvoice,
  type RawJob,
  type RawOutboundSms,
  type RawPayment,
  type RawQuote,
  type RawReview,
  type RawSms,
  type TimelineEvent,
  type TimelineKind,
} from '@/lib/customerTimeline';

/**
 * Customer timeline — Supabase access. Tenant scoping and permissions are
 * enforced by RLS (see 20270610000000_customer_notes.sql and each source
 * table's own policies); nothing here trusts the client.
 */

export const NOTE_FILES_BUCKET = 'customer-note-files';

const DEFAULT_LIMIT = 200;
const FULL_LIMIT = 1000; // PostgREST default max-rows
const MAX_JOB_IDS = 200; // keeps `in.(...)` filters well under URL length limits
const SIGNED_URL_SECONDS = 120;

const ATTACHMENT_COLUMNS = 'id, note_id, storage_path, file_name, mime_type, size_bytes, created_at';
const NOTE_SELECT = `*, attachments:customer_note_attachments(${ATTACHMENT_COLUMNS})`;

export interface TimelineContext {
  customerId: string;
  phone: string | null;
  email: string | null;
  /** invoices + payments are only fetched when the viewer has can_view_billing. */
  includeBilling: boolean;
}

export interface FeedResult {
  events: TimelineEvent[];
  /** At least one source hit its row limit, so older history may exist. */
  capped: boolean;
  /** Sources that failed to load (the rest of the feed still renders). */
  failed: TimelineKind[];
}

interface QueryResult {
  data: unknown;
  error: { message: string } | null;
}

async function rows<T>(query: PromiseLike<QueryResult>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as T[];
}

type SourceResult = { kind: TimelineKind; events: TimelineEvent[]; count: number };

export async function fetchFeed(ctx: TimelineContext, opts: { full?: boolean } = {}): Promise<FeedResult> {
  const limit = opts.full ? FULL_LIMIT : DEFAULT_LIMIT;
  const phones = phoneVariants(ctx.phone);
  const emails = emailVariants(ctx.email);

  // Jobs first: invoices, payments, reviews and automated SMS link through job ids.
  let jobRows: RawJob[] = [];
  const failed = new Set<TimelineKind>();
  try {
    const filter = buildLinkFilter({ customerIdColumn: 'customer_id', customerId: ctx.customerId, phoneColumn: 'customer_phone', phones });
    jobRows = await rows<RawJob>(
      supabase
        .from('jobs')
        .select('id, service_type, job_status, invoice_status, scheduled_datetime, created_at')
        .or(filter ?? `customer_id.eq.${ctx.customerId}`)
        .order('created_at', { ascending: false })
        .limit(limit),
    );
  } catch {
    failed.add('job');
  }
  const jobIds = jobRows.slice(0, MAX_JOB_IDS).map((j) => j.id);

  const sources: Array<{ kind: TimelineKind; run: () => Promise<SourceResult> }> = [
    {
      kind: 'job',
      run: async () => ({ kind: 'job', events: jobRows.map(mapJob), count: jobRows.length }),
    },
    {
      kind: 'call',
      run: async () => {
        const filter = buildLinkFilter({ customerIdColumn: 'customer_id', customerId: ctx.customerId, phoneColumn: 'caller_phone', phones });
        const data = await rows<RawCall>(
          supabase
            .from('calls')
            .select('id, call_datetime, summary, status, sentiment, duration_seconds, is_emergency')
            .or(filter ?? `customer_id.eq.${ctx.customerId}`)
            .order('call_datetime', { ascending: false })
            .limit(limit),
        );
        return { kind: 'call', events: data.map(mapCall), count: data.length };
      },
    },
    {
      kind: 'sms',
      run: async () => {
        const events: TimelineEvent[] = [];
        let count = 0;
        if (phones.length > 0) {
          const convs = await rows<{ id: string }>(supabase.from('sms_conversations').select('id').in('customer_phone', phones).limit(20));
          if (convs.length > 0) {
            const msgs = await rows<RawSms>(
              supabase
                .from('sms_messages')
                .select('id, direction, body, created_at')
                .in('conversation_id', convs.map((c) => c.id))
                .order('created_at', { ascending: false })
                .limit(limit),
            );
            count = Math.max(count, msgs.length);
            events.push(...msgs.map(mapSms));
          }
        }
        const autoFilter = buildLinkFilter({ jobColumn: 'job_id', jobIds, phoneColumn: 'customer_phone', phones });
        if (autoFilter) {
          const auto = uniqueById(
            await rows<RawOutboundSms>(
              supabase
                .from('outbound_sms')
                .select('id, body, status, sent_at, created_at')
                .or(autoFilter)
                .order('created_at', { ascending: false })
                .limit(limit),
            ),
          );
          count = Math.max(count, auto.length);
          events.push(...auto.map(mapOutboundSms));
        }
        return { kind: 'sms', events, count };
      },
    },
    {
      kind: 'email',
      run: async () => {
        if (emails.length === 0) return { kind: 'email', events: [], count: 0 };
        const convs = await rows<{ id: string }>(supabase.from('email_conversations').select('id').in('customer_email', emails).limit(20));
        if (convs.length === 0) return { kind: 'email', events: [], count: 0 };
        const msgs = await rows<RawEmail>(
          supabase
            .from('email_messages')
            .select('id, direction, subject, body_text, created_at')
            .in('conversation_id', convs.map((c) => c.id))
            .order('created_at', { ascending: false })
            .limit(limit),
        );
        return { kind: 'email', events: msgs.map(mapEmail), count: msgs.length };
      },
    },
    {
      kind: 'quote',
      run: async () => {
        const filter = buildLinkFilter({
          customerIdColumn: 'customer_id',
          customerId: ctx.customerId,
          phoneColumn: 'customer_phone',
          phones,
          emailColumn: 'customer_email',
          emails,
        });
        const data = await rows<RawQuote>(
          supabase
            .from('quotes')
            .select('id, status, line_items, tax_percent, sent_at, responded_at, created_at')
            .or(filter ?? `customer_id.eq.${ctx.customerId}`)
            .order('created_at', { ascending: false })
            .limit(limit),
        );
        return { kind: 'quote', events: data.flatMap(mapQuote), count: data.length };
      },
    },
    {
      kind: 'review',
      run: async () => {
        const filter = buildLinkFilter({ jobColumn: 'job_id', jobIds, phoneColumn: 'customer_phone', phones });
        if (!filter) return { kind: 'review', events: [], count: 0 };
        const data = await rows<RawReview>(
          supabase
            .from('review_requests')
            .select('id, status, rating, sent_at, completed_at')
            .or(filter)
            .order('sent_at', { ascending: false })
            .limit(limit),
        );
        return { kind: 'review', events: data.flatMap(mapReview), count: data.length };
      },
    },
  ];

  if (ctx.includeBilling) {
    sources.push(
      {
        kind: 'invoice',
        run: async () => {
          // invoices has no customer_id column: link through jobs, phone and email.
          const filter = buildLinkFilter({ jobColumn: 'job_id', jobIds, phoneColumn: 'customer_phone', phones, emailColumn: 'customer_email', emails });
          if (!filter) return { kind: 'invoice', events: [], count: 0 };
          const data = await rows<RawInvoice>(
            supabase
              .from('invoices')
              .select('id, job_id, invoice_number, status, line_items, tax_percent, payment_method, sent_at, viewed_at, paid_at, created_at, updated_at')
              .or(filter)
              .order('created_at', { ascending: false })
              .limit(limit),
          );
          return { kind: 'invoice', events: data.flatMap(mapInvoice), count: data.length };
        },
      },
      {
        kind: 'payment',
        run: async () => {
          if (jobIds.length === 0) return { kind: 'payment', events: [], count: 0 };
          const data = await rows<RawPayment>(
            supabase
              .from('job_payments')
              .select('id, job_id, method, status, amount_cents, card_brand, card_last4, check_number, note, received_at')
              .in('job_id', jobIds)
              .order('received_at', { ascending: false })
              .limit(limit),
          );
          return { kind: 'payment', events: data.map(mapPayment), count: data.length };
        },
      },
    );
  }

  // Jobs were already loaded above; every other source runs in parallel and
  // may fail independently without taking the whole feed down.
  const settled = await Promise.allSettled(sources.map((s) => s.run()));
  const events: TimelineEvent[] = [];
  let capped = false;
  settled.forEach((res, i) => {
    const kind = sources[i].kind;
    if (res.status === 'fulfilled') {
      if (kind === 'job' && failed.has('job')) return; // job query failed earlier
      events.push(...res.value.events);
      if (res.value.count >= limit) capped = true;
    } else {
      failed.add(kind);
    }
  });

  return { events, capped, failed: [...failed] };
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export async function fetchNotes(customerId: string): Promise<CustomerNote[]> {
  const data = await rows<CustomerNote>(
    supabase.from('customer_notes').select(NOTE_SELECT).eq('customer_id', customerId).order('created_at', { ascending: false }).limit(500),
  );
  return data.map((n) => ({ ...n, attachments: n.attachments ?? [] }));
}

export interface CreateNoteInput {
  customerId: string;
  ownerId: string;
  authorName: string | null;
  body: string;
  pinned: boolean;
  files: File[];
}

export interface CreateNoteResult {
  note: CustomerNote;
  /** Names of files that could not be uploaded (the note itself was saved). */
  failedFiles: string[];
}

export async function createNote(input: CreateNoteInput): Promise<CreateNoteResult> {
  const { data, error } = await supabase
    .from('customer_notes')
    .insert({ customer_id: input.customerId, author_name: input.authorName, body: input.body.trim(), pinned: input.pinned })
    .select('*')
    .single();
  if (error || !data) throw error ?? new Error('Could not save the note');

  const note = { ...(data as CustomerNote), attachments: [] as CustomerNoteAttachment[] };
  const failedFiles: string[] = [];

  for (const file of input.files) {
    const path = buildStoragePath({
      ownerId: input.ownerId,
      customerId: input.customerId,
      noteId: note.id,
      fileId: crypto.randomUUID(),
      fileName: file.name,
    });
    const upload = await supabase.storage.from(NOTE_FILES_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
    if (upload.error) {
      failedFiles.push(file.name);
      continue;
    }
    const { data: att, error: attError } = await supabase
      .from('customer_note_attachments')
      .insert({
        note_id: note.id,
        customer_id: input.customerId,
        storage_path: path,
        file_name: file.name.slice(0, 255),
        mime_type: file.type,
        size_bytes: file.size,
      })
      .select(ATTACHMENT_COLUMNS)
      .single();
    if (attError || !att) {
      await supabase.storage.from(NOTE_FILES_BUCKET).remove([path]); // don't leave an orphan
      failedFiles.push(file.name);
      continue;
    }
    note.attachments.push(att as CustomerNoteAttachment);
  }

  return { note, failedFiles };
}

export type NotePatch = Pick<CustomerNote, 'id' | 'body' | 'pinned' | 'pinned_at' | 'edited_at' | 'updated_at'>;

async function patchNote(id: string, patch: { body?: string; pinned?: boolean }): Promise<NotePatch> {
  const { data, error } = await supabase
    .from('customer_notes')
    .update(patch)
    .eq('id', id)
    .select('id, body, pinned, pinned_at, edited_at, updated_at')
    .single();
  if (error || !data) throw error ?? new Error('Could not update the note');
  return data as NotePatch;
}

export const updateNoteBody = (id: string, body: string) => patchNote(id, { body: body.trim() });
export const setNotePinned = (id: string, pinned: boolean) => patchNote(id, { pinned });

/** Deletes the row first (authoritative), then removes the files best-effort. */
export async function deleteNote(note: CustomerNote): Promise<void> {
  const { error } = await supabase.from('customer_notes').delete().eq('id', note.id);
  if (error) throw error;
  const paths = note.attachments.map((a) => a.storage_path);
  if (paths.length > 0) await supabase.storage.from(NOTE_FILES_BUCKET).remove(paths);
}

export async function deleteAttachment(att: CustomerNoteAttachment): Promise<void> {
  const { error } = await supabase.from('customer_note_attachments').delete().eq('id', att.id);
  if (error) throw error;
  await supabase.storage.from(NOTE_FILES_BUCKET).remove([att.storage_path]);
}

/** Short-lived signed URL — files are never publicly addressable. */
export async function getAttachmentUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(NOTE_FILES_BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
  if (error || !data?.signedUrl) throw error ?? new Error('Could not open the file');
  return data.signedUrl;
}
