// supabase/functions/_shared/agent-actions/engine.ts
//
// The single choke point every agent module (dispatch, remote resolution, supply, ...) calls:
//
//   const engine = createActionEngine({ registry, store, state, usage, kill, ownsResource, notify });
//   const r = await engine.propose(identity, { tool: 'job.reschedule', input, reason, idempotencyKey, sources });
//
// Order of defences in propose(): module on? -> idempotency -> kill switch -> allow-list -> strict schema ->
// tenant ownership of the target -> read-only preview -> policy (scopes, autonomy, limits, taint) -> rate limit ->
// persist (append-only audit by DB trigger) -> maybe execute. Approvals re-run the policy at execution time.

import type { ActionRecord, ActionStatus, AgentIdentity, Approver, Autonomy, ExecutionResult, Preview, ProposeOutcome, ToolDefinition, UntrustedSource } from './types.ts';
import type { ActionStorePort, KillPort, NotifyPort, OwnsResource, PolicyStatePort, UsagePort } from './ports.ts';
import type { ToolRegistry } from './registry.ts';
import { evaluatePolicy, type PolicyDecision, type Reservation } from './policy.ts';
import { hashInput, maskDeep, maskFreeText, redactInputs } from './untrusted.ts';

export interface EngineDeps {
  registry: ToolRegistry;
  store: ActionStorePort;
  state: PolicyStatePort;
  usage: UsagePort;
  kill: KillPort;
  ownsResource: OwnsResource;
  notify?: NotifyPort;
  now?: () => number;
  newId?: () => string;
  approvalTtlMs?: number;
  injectionBlockScore?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface ProposeRequest { tool: string; input: unknown; reason: string; idempotencyKey: string; sources?: UntrustedSource[]; dryRun?: boolean }

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_RE = /^[a-z][a-z0-9_-]{1,62}$/;
const KEY_RE = /^[A-Za-z0-9:_.-]{8,120}$/;
const DAY = 24 * 3600 * 1000;

export class ActionError extends Error {
  constructor(public code: 'not_found' | 'invalid_state' | 'input_changed' | 'forbidden' | 'undo_unavailable' | 'bad_request', message: string) { super(message); }
}

const safeError = (e: unknown): string => maskFreeText(e instanceof Error ? e.message : String(e), 200);

export function createActionEngine(deps: EngineDeps) {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const ttl = deps.approvalTtlMs ?? 3 * DAY;
  const log = deps.log ?? (() => undefined);

  function assertIdentity(id: AgentIdentity, key?: string) {
    if (!ID_RE.test(id.accountOwnerId) || !AGENT_RE.test(id.agentId) || !id.model || !id.promptVersion || id.model.length > 80 || id.promptVersion.length > 80)
      throw new ActionError('bad_request', 'Invalid agent identity (owner/agent/model/promptVersion are required and server-derived).');
    if (key !== undefined && !KEY_RE.test(key)) throw new ActionError('bad_request', 'idempotencyKey must be 8-120 chars of [A-Za-z0-9:_.-]');
  }

  async function autoStopped(owner: string): Promise<boolean> {
    try { return await deps.kill.isStopped('agent_auto_actions', owner); } catch { return true; } // fail closed
  }
  async function frameworkStopped(owner: string): Promise<boolean> {
    try { return await deps.kill.isStopped('agent_action_framework', owner); } catch { return true; } // fail closed
  }

  function baseRecord(id: AgentIdentity, req: ProposeRequest, rid: string, tool: ToolDefinition | undefined): ActionRecord {
    return {
      id: rid, accountOwnerId: id.accountOwnerId, agentId: id.agentId, toolSlug: req.tool.slice(0, 80), toolVersion: tool?.version ?? 0,
      idempotencyKey: req.idempotencyKey, status: 'blocked', autonomy: null, reason: maskFreeText(req.reason, 500), inputHash: '',
      inputsRedacted: null, execPayload: null, preview: null, outputsRedacted: null, undo: null, undoUntil: null,
      model: id.model, promptVersion: id.promptVersion, sources: (req.sources ?? []).slice(0, 20), decisionCode: null, decisionDetail: [],
      decidedBy: null, expiresAt: null, executedAt: null, error: null, createdAt: now(),
    };
  }

  async function persistBlocked(rec: ActionRecord, code: string, reasons: string[], actor: string): Promise<ProposeOutcome> {
    const { record, created } = await deps.store.insert({ ...rec, status: 'blocked', decisionCode: code, decisionDetail: reasons.slice(0, 6), execPayload: null });
    if (!created) return { outcome: 'existing', record };
    log('agent_action_blocked', { owner: rec.accountOwnerId, agent: rec.agentId, tool: rec.toolSlug, code, actor });
    return { outcome: 'blocked', code, reasons, record };
  }

  async function reserveAll(rec: ActionRecord, rs: Reservation[], honorSoft: boolean, kinds?: Reservation['kind'][]): Promise<{ ok: true } | { ok: false; kind: string; onExceed: 'block' | 'approval' }> {
    for (const r of rs) {
      if (kinds && !kinds.includes(r.kind)) continue;
      const res = await deps.usage.reserve({ owner: rec.accountOwnerId, requestId: rec.id, agentId: rec.agentId, toolSlug: rec.toolSlug, kind: r.kind, amount: r.amount, checks: r.checks, honorSoft });
      if (!res.ok) { await deps.usage.release(rec.accountOwnerId, rec.id); return { ok: false, kind: r.kind, onExceed: res.onExceed }; }
    }
    return { ok: true };
  }

  // ------------------------------------------------------------------ propose
  async function propose(id: AgentIdentity, req: ProposeRequest): Promise<ProposeOutcome> {
    assertIdentity(id, req.idempotencyKey);
    const owner = id.accountOwnerId;
    const tool = deps.registry.get(req.tool);
    const snap = await deps.state.load(owner, id.agentId, req.tool);
    if (!snap.moduleEnabled) return { outcome: 'module_disabled' }; // zero side effects when the module is OFF

    if (!req.dryRun) {
      const existing = await deps.store.findByKey(owner, id.agentId, req.tool, req.idempotencyKey);
      if (existing) return { outcome: 'existing', record: existing };
    }
    const rid = newId();
    const rec = baseRecord(id, req, rid, tool);
    const dry = (decision: 'execute' | 'pending_approval' | 'suggested' | 'blocked', code: string, reasons: string[], preview: Preview | null): ProposeOutcome =>
      ({ outcome: 'dry_run', decision, code, reasons, preview });
    const stop = (code: string, reasons: string[]) => (req.dryRun ? dry('blocked', code, reasons, null) : persistBlocked(rec, code, reasons, id.agentId));

    if (await frameworkStopped(owner)) return stop('kill_switch', ['Agent actions are stopped by a kill switch.']);
    if (!tool) return stop('tool_not_allowlisted', ['Unknown tool.']);

    const parsed = tool.inputSchema.parse(req.input);
    if (!parsed.ok) return stop('invalid_input', parsed.errors.slice(0, 8));
    const input = parsed.value;
    rec.inputHash = await hashInput(input);
    rec.inputsRedacted = redactInputs(tool.inputSchema, input);

    const res = tool.resource(input);
    if (res && !(await deps.ownsResource(owner, res))) return stop('resource_not_in_account', ['Target not found in this account.']);

    const decision: PolicyDecision = evaluatePolicy({
      mode: 'propose', tool, input, agentId: id.agentId, sources: rec.sources, snapshot: snap,
      autoStopped: await autoStopped(owner), nowMs: now(), injectionBlockScore: deps.injectionBlockScore,
    });
    if (decision.decision === 'block') return stop(decision.code, decision.reasons);

    let preview: Preview;
    try { preview = await tool.preview({ accountOwnerId: owner, agentId: id.agentId, executionKey: rid }, input); }
    catch (e) { return stop('preview_failed', [safeError(e)]); }
    rec.preview = { summary: maskFreeText(preview.summary, 300), diff: preview.diff.slice(0, 40) };

    let autonomy: Autonomy = decision.autonomy;
    let escalations = [...decision.escalations];
    const wantsAuto = autonomy === 'auto_notify' && escalations.length === 0;

    if (req.dryRun) {
      const d = wantsAuto ? 'execute' : autonomy === 'suggest' ? 'suggested' : 'pending_approval';
      return dry(d, escalations[0] ?? autonomy, escalations, rec.preview);
    }

    // rate limit: every proposal counts (spam resistance), hard block
    const rate = await reserveAll(rec, decision.reservations, true, ['rate_calls']);
    if (!rate.ok) return persistBlocked(rec, 'rate_limited', ['Too many agent actions; retry later.'], id.agentId);

    if (wantsAuto) {
      const vol = await reserveAll(rec, decision.reservations, true, ['spend_cents', 'messages']);
      if (!vol.ok) {
        if (vol.onExceed === 'block') return persistBlocked(rec, `limit_exceeded_${vol.kind}`, [`${vol.kind} limit reached.`], id.agentId);
        escalations = ['volume_limit']; autonomy = 'require_approval';
      }
    }

    const auto = autonomy === 'auto_notify' && escalations.length === 0;
    const status: ActionStatus = auto ? 'approved' : autonomy === 'suggest' ? 'suggested' : 'pending_approval';
    rec.status = status; rec.autonomy = autonomy; rec.execPayload = input;
    rec.decisionCode = auto ? 'auto' : escalations[0] ?? autonomy; rec.decisionDetail = escalations;
    rec.expiresAt = auto ? null : now() + ttl;
    const { record, created } = await deps.store.insert(rec);
    if (!created) { await deps.usage.release(owner, rid); return { outcome: 'existing', record }; }

    if (!auto) {
      await deps.notify?.notifyPending?.(record).catch(() => undefined);
      return { outcome: status === 'suggested' ? 'suggested' : 'pending_approval', record };
    }
    return runExecution(tool, record, id.agentId, true);
  }

  // ------------------------------------------------------------------ execute (shared by auto + approve)
  async function runExecution(tool: ToolDefinition, rec: ActionRecord, actor: string, notify: boolean): Promise<ProposeOutcome> {
    const claimed = await deps.store.transition(rec.accountOwnerId, rec.id, ['approved'], 'executing', { actor });
    if (!claimed) { const cur = await deps.store.get(rec.accountOwnerId, rec.id); return cur ? { outcome: 'existing', record: cur } : { outcome: 'blocked', code: 'not_found', reasons: [], record: null }; }
    let result: ExecutionResult<unknown, unknown>;
    try {
      result = await tool.execute({ accountOwnerId: rec.accountOwnerId, agentId: rec.agentId, executionKey: rec.id }, rec.execPayload as never);
    } catch (e) {
      await deps.usage.release(rec.accountOwnerId, rec.id);
      const failed = await deps.store.transition(rec.accountOwnerId, rec.id, ['executing'], 'failed', { actor, error: safeError(e), execPayload: null });
      log('agent_action_failed', { owner: rec.accountOwnerId, tool: rec.toolSlug });
      return { outcome: 'failed', record: failed ?? { ...rec, status: 'failed' } };
    }
    const t = now();
    const done = await deps.store.transition(rec.accountOwnerId, rec.id, ['executing'], 'executed', {
      actor, outputsRedacted: maskDeep(result.output), undo: result.undo ?? null,
      undoUntil: result.undo !== undefined && tool.undoWindowMs ? t + tool.undoWindowMs : null, executedAt: t, execPayload: null,
    });
    const final = done ?? { ...rec, status: 'executed' as const };
    if (notify) await deps.notify?.notifyExecuted(final).catch(() => undefined);
    return { outcome: 'executed', record: final };
  }

  // ------------------------------------------------------------------ approve / reject / undo
  async function loadOpen(owner: string, requestId: string): Promise<ActionRecord> {
    const rec = await deps.store.get(owner, requestId);
    if (!rec) throw new ActionError('not_found', 'Request not found.');
    return rec;
  }

  async function approve(p: { accountOwnerId: string; approver: Approver; requestId: string; expectedInputHash: string }): Promise<ProposeOutcome> {
    if (!ID_RE.test(p.accountOwnerId) || !ID_RE.test(p.requestId) || p.approver.verified !== true) throw new ActionError('forbidden', 'Approver not verified.');
    const rec = await loadOpen(p.accountOwnerId, p.requestId);
    if (rec.status !== 'pending_approval' && rec.status !== 'suggested') throw new ActionError('invalid_state', `Cannot approve a request in state ${rec.status}.`);
    if (rec.inputHash !== p.expectedInputHash) throw new ActionError('input_changed', 'The request changed after it was shown to you.');
    const block = async (code: string, reasons: string[]): Promise<ProposeOutcome> => {
      const row = await deps.store.transition(rec.accountOwnerId, rec.id, ['pending_approval', 'suggested'], 'blocked', { actor: p.approver.userId, decisionCode: code, decisionDetail: reasons, execPayload: null });
      return { outcome: 'blocked', code, reasons, record: row };
    };
    if (rec.expiresAt !== null && now() > rec.expiresAt) {
      const row = await deps.store.transition(rec.accountOwnerId, rec.id, ['pending_approval', 'suggested'], 'expired', { actor: 'system', execPayload: null });
      return { outcome: 'blocked', code: 'expired', reasons: ['Approval window elapsed.'], record: row };
    }
    // TOCTOU: everything is re-checked NOW, with the stored input, not trusted from proposal time.
    const snap = await deps.state.load(rec.accountOwnerId, rec.agentId, rec.toolSlug);
    if (!snap.moduleEnabled) return { outcome: 'module_disabled' };
    if (await frameworkStopped(rec.accountOwnerId)) return block('kill_switch', ['Agent actions are stopped by a kill switch.']);
    const tool = deps.registry.get(rec.toolSlug);
    if (!tool) return block('tool_not_allowlisted', ['Tool no longer registered.']);
    if (tool.version !== rec.toolVersion) return block('tool_version_changed', ['The tool changed since this was proposed; ask the agent to propose again.']);
    const parsed = tool.inputSchema.parse(rec.execPayload);
    if (!parsed.ok || (await hashInput(parsed.value)) !== rec.inputHash) return block('input_integrity', ['Stored input failed integrity check.']);
    const res = tool.resource(parsed.value);
    if (res && !(await deps.ownsResource(rec.accountOwnerId, res))) return block('resource_not_in_account', ['Target not found in this account.']);
    const decision = evaluatePolicy({ mode: 'approve', tool, input: parsed.value, agentId: rec.agentId, sources: rec.sources, snapshot: snap, autoStopped: false, nowMs: now(), injectionBlockScore: deps.injectionBlockScore });
    if (decision.decision === 'block') return block(decision.code, decision.reasons);
    const vol = await reserveAll(rec, decision.reservations, false, ['spend_cents', 'messages']);
    if (!vol.ok) return block(`limit_exceeded_${vol.kind}`, [`${vol.kind} hard limit reached.`]);

    const approved = await deps.store.transition(rec.accountOwnerId, rec.id, ['pending_approval', 'suggested'], 'approved', { actor: p.approver.userId, decidedBy: p.approver.userId, decisionCode: 'human_approved' });
    if (!approved) { await deps.usage.release(rec.accountOwnerId, rec.id); throw new ActionError('invalid_state', 'Request was decided by someone else.'); }
    return runExecution(tool, approved, p.approver.userId, false);
  }

  async function reject(p: { accountOwnerId: string; approver: Approver; requestId: string; reason?: string }): Promise<ActionRecord> {
    if (p.approver.verified !== true) throw new ActionError('forbidden', 'Approver not verified.');
    const rec = await loadOpen(p.accountOwnerId, p.requestId);
    const row = await deps.store.transition(rec.accountOwnerId, rec.id, ['pending_approval', 'suggested'], 'rejected', {
      actor: p.approver.userId, decidedBy: p.approver.userId, decisionCode: 'human_rejected', decisionDetail: p.reason ? [maskFreeText(p.reason, 300)] : [], execPayload: null,
    });
    if (!row) throw new ActionError('invalid_state', `Cannot reject a request in state ${rec.status}.`);
    return row;
  }

  async function undo(p: { accountOwnerId: string; approver: Approver; requestId: string }): Promise<ActionRecord> {
    if (p.approver.verified !== true) throw new ActionError('forbidden', 'Approver not verified.');
    const rec = await loadOpen(p.accountOwnerId, p.requestId);
    const snap = await deps.state.load(rec.accountOwnerId, rec.agentId, rec.toolSlug);
    if (!snap.moduleEnabled) throw new ActionError('forbidden', 'Agent actions are not enabled.');
    const tool = deps.registry.get(rec.toolSlug);
    if (rec.status !== 'executed' || !tool?.undo || rec.undo === null || rec.undoUntil === null) throw new ActionError('undo_unavailable', 'This action cannot be undone.');
    if (now() > rec.undoUntil) throw new ActionError('undo_unavailable', 'The undo window has closed.');
    // Undo is restorative, so it stays available while paused / kill-switched. The tool's undo is idempotent.
    await tool.undo({ accountOwnerId: rec.accountOwnerId, agentId: rec.agentId, executionKey: `${rec.id}:undo` }, rec.undo as never);
    const row = await deps.store.transition(rec.accountOwnerId, rec.id, ['executed'], 'undone', { actor: p.approver.userId, decidedBy: p.approver.userId, undo: null, undoUntil: null });
    if (!row) throw new ActionError('invalid_state', 'Request was already undone.');
    return row;
  }

  return { propose, approve, reject, undo };
}

export type ActionEngine = ReturnType<typeof createActionEngine>;
