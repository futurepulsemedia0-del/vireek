// src/lib/operatorAgent.ts
//
// Client contract for the Operator Agent (Cmd+K). All network access lives here;
// the panel stays presentational. Types mirror supabase/functions/operator-agent.

import { supabase } from '@/lib/supabase';

export type OperatorTool = 'reschedule_jobs' | 'reassign_jobs' | 'message_customers';

export interface PreviewEffect {
  label: string;
  before: string;
  after: string;
  status: 'planned' | 'skipped';
  reason: string | null;
}

export interface PreviewStep {
  key: string;
  tool: OperatorTool;
  title: string;
  affected: number;
  skipped: number;
  note: string | null;
  warnings: string[];
  needs_approval: boolean;
  reasons: string[];
  effects: PreviewEffect[];
  more: number;
}

export interface PlanPreview {
  status: 'awaiting_approval' | 'ready';
  run_id: string;
  summary: string;
  timezone: string;
  expires_at: string;
  approval: { required: boolean; reasons: string[] };
  steps: PreviewStep[];
}

export interface RunSummary {
  status: 'completed' | 'partial' | 'failed';
  applied: number;
  failed: number;
  skipped: number;
  steps: { key: string; tool: string; status: string; applied: number; failed: number; skipped: number; error: string | null }[];
}

export type PlanResponse =
  | PlanPreview
  | { status: 'refused' | 'blocked' | 'failed' | 'clarify'; message: string };

export interface ExecuteResponse {
  status: 'completed' | 'partial' | 'failed' | 'cancelled';
  run_id?: string;
  summary?: RunSummary;
  problems?: { label: string; status: string; reason: string }[];
  undo_available?: boolean;
}

export interface UndoResponse {
  status: 'undone' | 'undo_partial';
  summary: { undone: number; failed: number; irreversible: number };
}

export interface OperatorRunRow {
  id: string;
  instruction: string;
  status: string;
  summary: string | null;
  created_at: string;
  finished_at: string | null;
}

export class OperatorError extends Error {
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'OperatorError';
    this.status = status;
  }
}

async function readFunctionError(error: unknown): Promise<OperatorError> {
  const ctx = (error as { context?: unknown })?.context;
  if (ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: string };
      if (body?.error) return new OperatorError(body.error, ctx.status);
    } catch {
      /* body was not JSON */
    }
    return new OperatorError('Operator could not complete that right now. Please try again.', ctx.status);
  }
  return new OperatorError('Could not reach Operator. Check your connection and try again.');
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const { data, error } = await supabase.functions.invoke('operator-agent', {
    body,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (error) throw await readFunctionError(error);
  if (!data) throw new OperatorError('Operator returned an empty response.');
  return data as T;
}

export const planOperator = (instruction: string) => call<PlanResponse>({ action: 'plan', instruction });
export const executeOperator = (runId: string, approve: boolean) => call<ExecuteResponse>({ action: 'execute', run_id: runId, approve });
export const undoOperator = (runId: string) => call<UndoResponse>({ action: 'undo', run_id: runId });

export async function fetchRecentRuns(limit = 5): Promise<OperatorRunRow[]> {
  const { data, error } = await supabase
    .from('operator_runs')
    .select('id, instruction, status, summary, created_at, finished_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as OperatorRunRow[];
}

// ---- pure helpers ----------------------------------------------------

export const UNDO_WINDOW_HOURS = 24;

export function isPreview(r: PlanResponse): r is PlanPreview {
  return r.status === 'awaiting_approval' || r.status === 'ready';
}

/** Undo is offered for finished runs for 24 hours. */
export function canUndo(run: Pick<OperatorRunRow, 'status' | 'finished_at'>, now = Date.now()): boolean {
  if (!['completed', 'partial', 'undo_partial'].includes(run.status)) return false;
  if (!run.finished_at) return false;
  return now - Date.parse(run.finished_at) <= UNDO_WINDOW_HOURS * 3_600_000;
}

export function describeResult(r: ExecuteResponse): string {
  if (r.status === 'cancelled') return 'Cancelled — nothing was changed.';
  const s = r.summary;
  if (!s) return 'Finished.';
  const base = `${s.applied} change${s.applied === 1 ? '' : 's'} applied`;
  const extra = [s.skipped ? `${s.skipped} skipped` : '', s.failed ? `${s.failed} failed` : ''].filter(Boolean).join(', ');
  if (r.status === 'failed') return s.applied === 0 ? 'Nothing was changed.' : base;
  return extra ? `${base} · ${extra}` : base;
}
