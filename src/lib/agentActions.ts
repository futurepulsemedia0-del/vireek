// Recreated: verify against original intent
// src/lib/agentActions.ts
//
// Types and pure helpers for the Agent Action Framework UI (src/pages/AgentActionsPage.tsx).
// Shapes mirror supabase/migrations/20290301000000_agent_action_framework.sql (column names are the DB's).
// TODO(vireek): the server-side `types.ts` (supabase/functions/_shared/agent-actions/types.ts) is absent from this
// repository, so `ToolMeta` and the preview `diff` entries are modelled defensively from how the edge function and
// engine use them. Verify both against the real server types.

export type Autonomy = 'suggest' | 'require_approval' | 'auto_notify';
export type LimitKind = 'spend_cents' | 'messages' | 'rate_calls' | 'discount_pct' | 'time_window';
export type ActionStatus =
  | 'suggested'
  | 'pending_approval'
  | 'approved'
  | 'executing'
  | 'executed'
  | 'failed'
  | 'rejected'
  | 'blocked'
  | 'expired'
  | 'undone';

export interface ModuleState {
  enabled: boolean;
  paused: boolean;
  canManage: boolean;
}

/** One entry of a read-only preview. Free text from the server: always rendered as text, never as HTML. */
export interface DiffEntry {
  label?: unknown;
  field?: unknown;
  before?: unknown;
  after?: unknown;
  [key: string]: unknown;
}

export interface ActionPreview {
  summary: string;
  diff: DiffEntry[];
}

export interface ActionRow {
  id: string;
  user_id: string;
  agent_id: string;
  tool_slug: string;
  status: ActionStatus;
  autonomy: Autonomy | null;
  reason: string;
  input_hash: string;
  preview: ActionPreview | null;
  model: string;
  prompt_version: string;
  sources: unknown[];
  decision_code: string | null;
  decision_detail: string[];
  expires_at: string | null;
  executed_at: string | null;
  undo_until: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuditRow {
  seq: number;
  request_id: string | null;
  event: string;
  actor: string;
  snapshot: Record<string, unknown>;
  created_at: string;
}

export interface GrantRow {
  agent_id: string;
  scope: string;
  autonomy: Autonomy;
}

export interface ToolPolicyRow {
  tool_slug: string;
  enabled: boolean;
  autonomy: Autonomy | null;
}

export interface LimitRow {
  id: string;
  kind: LimitKind;
  agent_id: string | null;
  tool_slug: string | null;
  window_sec: number | null;
  max_value: number | string | null;
  on_exceed: 'block' | 'approval';
  tw_days: number[] | null;
  tw_start_min: number | null;
  tw_end_min: number | null;
  tw_tz: string | null;
}

export interface ToolMeta {
  slug: string;
  description: string;
  risk: string;
  scopes: string[];
  maxAutonomy: Autonomy;
  defaultAutonomy: Autonomy;
}

export const AUTONOMY_LABELS: Record<Autonomy, string> = {
  suggest: 'Suggest only',
  require_approval: 'Ask for approval',
  auto_notify: 'Run automatically, then notify',
};

export const LIMIT_LABELS: Record<LimitKind, string> = {
  spend_cents: 'Spend (cents)',
  messages: 'Messages',
  rate_calls: 'Agent calls',
  discount_pct: 'Discount %',
  time_window: 'Allowed hours',
};

export const STATUS_LABELS: Record<ActionStatus, string> = {
  suggested: 'Suggested',
  pending_approval: 'Needs approval',
  approved: 'Approved',
  executing: 'Running',
  executed: 'Done',
  failed: 'Failed',
  rejected: 'Rejected',
  blocked: 'Blocked',
  expired: 'Expired',
  undone: 'Undone',
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RECENT_LIMIT = 20;

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Undo is offered only for an executed action whose undo window is still open (the server re-checks). */
export function canUndo(row: Pick<ActionRow, 'status' | 'undo_until'>, now: number = Date.now()): boolean {
  const until = ms(row.undo_until);
  return row.status === 'executed' && until !== null && until > now;
}

/** "expires in 2h 5m" for an open request; "expired" once past; null when it has no expiry or is not open. */
export function expiresIn(row: Pick<ActionRow, 'status' | 'expires_at'>, now: number = Date.now()): string | null {
  if (row.status !== 'pending_approval' && row.status !== 'suggested') return null;
  const at = ms(row.expires_at);
  if (at === null) return null;
  const left = at - now;
  if (left <= 0) return 'expired';
  const mins = Math.floor(left / 60_000);
  if (mins < 1) return 'expires in under a minute';
  if (mins < 60) return `expires in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `expires in ${hours}h ${mins % 60}m`;
  return `expires in ${Math.floor(hours / 24)}d`;
}

/** Extra caution shown on a card when the proposal was influenced by external (untrusted) text. */
export function riskHint(row: Pick<ActionRow, 'sources'>): string | null {
  return Array.isArray(row.sources) && row.sources.length > 0
    ? 'This proposal was based on external content (for example a customer message). Check the preview before approving.'
    : null;
}

export function groupInbox(rows: ActionRow[]): { pending: ActionRow[]; suggested: ActionRow[]; recent: ActionRow[] } {
  const byNewest = (a: ActionRow, b: ActionRow) => (ms(b.created_at) ?? 0) - (ms(a.created_at) ?? 0);
  const pending = rows.filter((r) => r.status === 'pending_approval').sort(byNewest);
  const suggested = rows.filter((r) => r.status === 'suggested').sort(byNewest);
  const recent = rows
    .filter((r) => r.status !== 'pending_approval' && r.status !== 'suggested')
    .sort(byNewest)
    .slice(0, RECENT_LIMIT);
  return { pending, suggested, recent };
}

function windowText(sec: number | null): string {
  if (sec === null) return '';
  if (sec % 86_400 === 0) return sec === 86_400 ? 'per day' : `per ${sec / 86_400} days`;
  if (sec % 3_600 === 0) return sec === 3_600 ? 'per hour' : `per ${sec / 3_600} hours`;
  if (sec % 60 === 0) return sec === 60 ? 'per minute' : `per ${sec / 60} minutes`;
  return `per ${sec}s`;
}

function clock(min: number | null): string {
  if (min === null) return '--:--';
  const m = min === 1440 ? 0 : min;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function describeLimit(l: LimitRow): string {
  const scope = `${l.agent_id ?? 'all agents'} · ${l.tool_slug ?? 'all tools'}`;
  const exceed = l.on_exceed === 'block' ? 'then blocked' : 'then needs approval';
  const max = l.max_value === null ? null : Number(l.max_value);
  switch (l.kind) {
    case 'time_window': {
      const days = (l.tw_days ?? []).slice().sort((a, b) => a - b).map((d) => DAY_NAMES[d] ?? '?').join(', ');
      return `${LIMIT_LABELS.time_window}: ${days} ${clock(l.tw_start_min)}–${clock(l.tw_end_min)} (${l.tw_tz ?? 'UTC'}) · ${scope} · outside it ${l.on_exceed === 'block' ? 'blocked' : 'needs approval'}`;
    }
    case 'discount_pct':
      return `${LIMIT_LABELS.discount_pct}: up to ${max ?? '?'}% · ${scope} · ${exceed}`;
    default:
      return `${LIMIT_LABELS[l.kind]}: ${max ?? '?'} ${windowText(l.window_sec)} · ${scope} · ${exceed}`.replace(/\s+·/g, ' ·');
  }
}
