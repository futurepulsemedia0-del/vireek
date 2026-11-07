// supabase/functions/sarah-learn-readiness/index.ts
//
// Step 5: Readiness proof. Generates 20 caller scenarios from the profile,
// runs each through the same receptionist prompt style as the live assistant,
// grades the replies with deterministic rules (no model-as-judge), stores the
// scorecard, and sets `readiness_passed` ONLY server-side.
//
// Nothing is dialled, booked or sent: these are text simulations.
//
// POST { run_id } -> { scorecard, results[] }

import { askVireekAi, safeFallbackMessage } from '../_shared/ai-core/index.ts';
import { authenticate, handle, HttpError, json, loadRun } from '../_shared/sarah-learn/edge.ts';
import { buildReceptionistInstructions } from '../_shared/sarah-learn/prompts.ts';
import { buildProfileView, buildScenarios, gradeReply, scorecard, type StoredField } from '../_shared/sarah-learn/scenarios.ts';
import { REQUIRED_KEYS, type FieldValue } from '../_shared/sarah-learn/schema.ts';

const RUNS_PER_HOUR = 6;
const CONCURRENCY = 5;
const MAX_ERRORS_BEFORE_ABORT = 5;

Deno.serve(
  handle(async (req) => {
    const c = await authenticate(req);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw new HttpError(400, 'Invalid JSON body.');
    const run = await loadRun(c, body.run_id);
    const runId = run.id as string;
    if (run.status === 'live') throw new HttpError(409, 'This run is already live.');

    const { data: rows, error } = await c.admin.from('sarah_learn_fields').select('key,value,status').eq('run_id', runId).eq('user_id', c.ownerId);
    if (error) throw error;
    const fields: StoredField[] = (rows ?? []).map((r) => ({ key: r.key as string, value: r.value as FieldValue, status: r.status as string }));
    const have = new Set(fields.filter((f) => f.status !== 'rejected').map((f) => f.key));
    const missing = REQUIRED_KEYS.filter((k) => !have.has(k));
    if (missing.length) throw new HttpError(409, `Add these first: ${missing.join(', ')}.`);

    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await c.admin.from('sarah_learn_events').select('id', { count: 'exact', head: true }).eq('run_id', runId).eq('event', 'readiness_run').gte('created_at', since);
    if ((count ?? 0) >= RUNS_PER_HOUR) throw new HttpError(429, 'You have run the readiness check several times this hour. Please try again shortly.');

    const startedAt = Date.now();
    await c.admin.from('sarah_learn_runs').update({ status: 'readiness', updated_at: new Date().toISOString() }).eq('id', runId).eq('user_id', c.ownerId);

    const profile = buildProfileView(fields);
    const scenarios = buildScenarios(profile);
    const instructions = buildReceptionistInstructions(profile);

    interface Outcome { id: string; category: string; critical: boolean; caller: string; reply: string; passed: boolean; failures: string[]; errored: boolean }
    const outcomes: Outcome[] = [];
    let errors = 0;
    const queue = [...scenarios];
    const worker = async () => {
      for (let sc = queue.shift(); sc; sc = queue.shift()) {
        if (errors > MAX_ERRORS_BEFORE_ABORT) return;
        try {
          const res = await askVireekAi({
            task: 'general',
            maxTokens: 220,
            temperature: 0.4,
            timeoutMs: 20000,
            extraInstructions: instructions,
            messages: [{ role: 'user', content: sc.caller }],
          });
          const g = gradeReply(sc, res.text);
          outcomes.push({ id: sc.id, category: sc.category, critical: sc.critical, caller: sc.caller, reply: res.text.trim().slice(0, 700), passed: g.passed, failures: g.failures, errored: false });
        } catch (e) {
          errors++;
          console.error('[sarah-learn-readiness] scenario failed:', sc.id, e instanceof Error ? e.message : 'unknown');
          outcomes.push({ id: sc.id, category: sc.category, critical: sc.critical, caller: sc.caller, reply: '', passed: false, failures: ['The simulator did not return a reply'], errored: true });
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    if (errors > MAX_ERRORS_BEFORE_ABORT) {
      // Provider outage: do not record a misleading failing score.
      await c.admin.from('sarah_learn_runs').update({ status: 'review', updated_at: new Date().toISOString() }).eq('id', runId).eq('user_id', c.ownerId);
      return json({ error: safeFallbackMessage(new Error('provider')) }, 502);
    }

    const order = new Map(scenarios.map((s, i) => [s.id, i]));
    outcomes.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const card = scorecard(outcomes);

    await c.admin.from('sarah_learn_scenario_results').delete().eq('run_id', runId).eq('user_id', c.ownerId);
    const { error: insErr } = await c.admin.from('sarah_learn_scenario_results').insert(
      outcomes.map((o) => ({ run_id: runId, user_id: c.ownerId, scenario_id: o.id, category: o.category, critical: o.critical, caller_text: o.caller, reply_text: o.reply, passed: o.passed, failures: o.failures })),
    );
    if (insErr) throw insErr;

    const passed = card.meetsThreshold;
    await c.admin
      .from('sarah_learn_runs')
      .update({
        status: passed ? 'readiness' : 'review',
        readiness_passed: passed,
        readiness_score: Math.round(card.rate * 10000) / 10000,
        readiness_run_at: new Date().toISOString(),
        // a changed profile needs a fresh real test call as well
        test_call_confirmed_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', runId)
      .eq('user_id', c.ownerId);
    await c.admin.from('sarah_learn_events').insert({ user_id: c.ownerId, run_id: runId, event: 'readiness_run', ms: Date.now() - startedAt, meta: { passed: card.passed, total: card.total, critical_failed: card.criticalFailed.length } });
    console.log(`[sarah-learn-readiness] run=${runId} passed=${card.passed}/${card.total} critical_failed=${card.criticalFailed.length}`);

    return json({
      scorecard: { ...card, passed_gate: passed },
      results: outcomes.map(({ id, category, critical, caller, reply, passed: ok, failures }) => ({ id, category, critical, caller, reply, passed: ok, failures })),
    });
  }),
);
