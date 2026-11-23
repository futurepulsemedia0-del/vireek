import { supabase } from '@/lib/supabase';

/**
 * Customer incident communication — client library for /staff/incident-comms.
 * Reads go through staff_incident_comms_overview(); EVERY write goes through the `incident-comms` edge function,
 * which authenticates staff, lints the text and enforces the draft -> approval -> send state machine.
 */

export const PHASES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
export const SEVERITIES = ['sev1', 'sev2', 'sev3', 'sev4'] as const;
export const AUDIENCES = ['status_page', 'status_page_and_subscribers'] as const;
export type Phase = (typeof PHASES)[number];
export type Severity = (typeof SEVERITIES)[number];
export type Audience = (typeof AUDIENCES)[number];
export type DraftState = 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'sending' | 'sent' | 'send_failed';
const STATES: DraftState[] = ['draft', 'pending_approval', 'approved', 'rejected', 'sending', 'sent', 'send_failed'];

export const LIMITS = { statusPost: 600, emailSubject: 150, emailBody: 4000 } as const;

export interface CommsIncident {
  id: string;
  title: string;
  impact: 'minor' | 'major';
  status: string;
  componentId: string;
  region: string | null;
  startedAt: string | null;
  resolvedAt: string | null;
  lastUpdate: string | null;
}

export interface CommsDraft {
  id: string;
  incidentId: string;
  phase: Phase;
  severity: Severity;
  audience: Audience;
  statusPostText: string;
  emailSubject: string | null;
  emailBody: string | null;
  nextUpdateAt: string | null;
  state: DraftState;
  createdBy: string;
  submittedBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectReason: string | null;
  statusPostedAt: string | null;
  emailSentAt: string | null;
  emailResult: { sent: number; failed: number; total: number } | null;
  sendError: string | null;
  contentHash: string;
  updatedAt: string | null;
}

export interface CommsOverview {
  me: string;
  requireSecondApprover: boolean;
  incidents: CommsIncident[];
  drafts: CommsDraft[];
}

export interface LintIssue {
  code: string;
  level: 'block' | 'warn';
  message: string;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const sOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(rec) : []);

export function parseOverview(raw: unknown): CommsOverview {
  const o = rec(raw);
  return {
    me: typeof o.me === 'string' ? o.me : '',
    requireSecondApprover: o.require_second_approver_major !== false,
    incidents: list(o.incidents)
      .filter((r) => typeof r.id === 'string')
      .map((r) => ({
        id: String(r.id),
        title: String(r.title ?? ''),
        impact: r.impact === 'major' ? 'major' : 'minor',
        status: String(r.status ?? ''),
        componentId: String(r.component_id ?? ''),
        region: sOrNull(r.region),
        startedAt: sOrNull(r.started_at),
        resolvedAt: sOrNull(r.resolved_at),
        lastUpdate: sOrNull(r.last_update),
      })),
    drafts: list(o.drafts)
      .filter((r) => typeof r.id === 'string' && (PHASES as readonly string[]).includes(String(r.phase)) && STATES.includes(r.state as DraftState))
      .map((r) => {
        const er = rec(r.email_result);
        return {
          id: String(r.id),
          incidentId: String(r.incident_id),
          phase: r.phase as Phase,
          severity: ((SEVERITIES as readonly string[]).includes(String(r.severity)) ? r.severity : 'sev3') as Severity,
          audience: (r.audience === 'status_page_and_subscribers' ? 'status_page_and_subscribers' : 'status_page') as Audience,
          statusPostText: String(r.status_post_text ?? ''),
          emailSubject: sOrNull(r.email_subject),
          emailBody: sOrNull(r.email_body),
          nextUpdateAt: sOrNull(r.next_update_at),
          state: r.state as DraftState,
          createdBy: String(r.created_by ?? ''),
          submittedBy: sOrNull(r.submitted_by),
          approvedBy: sOrNull(r.approved_by),
          approvedAt: sOrNull(r.approved_at),
          rejectReason: sOrNull(r.reject_reason),
          statusPostedAt: sOrNull(r.status_posted_at),
          emailSentAt: sOrNull(r.email_sent_at),
          emailResult: 'sent' in er ? { sent: Number(er.sent) || 0, failed: Number(er.failed) || 0, total: Number(er.total) || 0 } : null,
          sendError: sOrNull(r.send_error),
          contentHash: String(r.content_hash ?? ''),
          updatedAt: sOrNull(r.updated_at),
        };
      }),
  };
}

// ---------------------------------------------------------------------------
// Which actions the UI offers (the database enforces the same rules)
// ---------------------------------------------------------------------------

/** Severities that may email subscribers (mirrors SEVERITY_MATRIX). */
export const EMAIL_SEVERITIES: Severity[] = ['sev1', 'sev2'];
/** SEV4 has no public message at all. */
export const PUBLIC_SEVERITIES: Severity[] = ['sev1', 'sev2', 'sev3'];

export const allowedAudiences = (sev: Severity): Audience[] =>
  EMAIL_SEVERITIES.includes(sev) ? ['status_page', 'status_page_and_subscribers'] : PUBLIC_SEVERITIES.includes(sev) ? ['status_page'] : [];

export type ApproveBlock = 'not_pending' | 'second_person' | null;

/** Why this person cannot approve right now (null = they can). */
export function approveBlock(d: Pick<CommsDraft, 'state' | 'severity' | 'createdBy' | 'submittedBy'>, me: string, requireSecond: boolean, impact: 'minor' | 'major'): ApproveBlock {
  if (d.state !== 'pending_approval') return 'not_pending';
  const strict = requireSecond && (d.severity === 'sev1' || d.severity === 'sev2' || impact === 'major');
  if (strict && (me === d.createdBy || me === d.submittedBy)) return 'second_person';
  return null;
}

export const isLocked = (s: DraftState): boolean => s === 'sending' || s === 'sent' || s === 'rejected';
export const canSend = (s: DraftState): boolean => s === 'approved' || s === 'send_failed';

/** True when a non-final phase promised an update time that has passed. */
export function isStale(d: Pick<CommsDraft, 'phase' | 'nextUpdateAt' | 'statusPostedAt'>, now: Date = new Date()): boolean {
  if (d.phase === 'resolved' || !d.nextUpdateAt || d.statusPostedAt) return false;
  const t = Date.parse(d.nextUpdateAt);
  return Number.isFinite(t) && t < now.getTime();
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export async function fetchOverview(): Promise<CommsOverview> {
  const { data, error } = await supabase.rpc('staff_incident_comms_overview');
  if (error) throw new Error(error.message);
  return parseOverview(data);
}

export interface CommsResult {
  ok: boolean;
  error?: string;
  message?: string;
  issues: LintIssue[];
  id?: string;
}

async function call(payload: Record<string, unknown>): Promise<CommsResult> {
  const { data: { session } } = await supabase.auth.getSession();
  const base = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!session || !base || !anon) return { ok: false, error: 'not_ready', issues: [] };
  const res = await fetch(`${base.replace(/\/$/, '')}/functions/v1/incident-comms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, apikey: anon },
    body: JSON.stringify(payload),
  });
  const out = rec(await res.json().catch(() => ({})));
  return {
    ok: res.ok && out.ok === true,
    error: typeof out.error === 'string' ? out.error : res.ok ? undefined : 'server_error',
    message: typeof out.message === 'string' ? out.message : undefined,
    issues: list(out.issues).filter((i) => typeof i.message === 'string').map((i) => ({ code: String(i.code), level: i.level === 'block' ? 'block' : 'warn', message: String(i.message) })),
    id: typeof out.id === 'string' ? out.id : undefined,
  };
}

export const createDraft = (p: { incidentId: string; phase: Phase; severity: Severity; audience: Audience; customerAction: string }) =>
  call({ action: 'draft', incident_id: p.incidentId, phase: p.phase, severity: p.severity, audience: p.audience, customer_action: p.customerAction });
export const updateDraft = (id: string, p: { statusPost: string; emailSubject: string | null; emailBody: string | null }) =>
  call({ action: 'update', id, status_post_text: p.statusPost, email_subject: p.emailSubject, email_body: p.emailBody });
export const submitDraft = (id: string) => call({ action: 'submit', id });
export const approveDraft = (id: string, contentHash: string) => call({ action: 'approve', id, content_hash: contentHash });
export const rejectDraft = (id: string, reason: string) => call({ action: 'reject', id, reason });
export const sendDraft = (id: string) => call({ action: 'send', id });

export async function saveRequireSecondApprover(value: boolean): Promise<void> {
  const { error } = await supabase.rpc('staff_incident_comms_update_settings', { p_require_second: value });
  if (error) throw new Error(error.message);
}
