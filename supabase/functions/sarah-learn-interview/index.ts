// supabase/functions/sarah-learn-interview/index.ts
//
// Step 3: Sarah interviews the owner ONLY about gaps / low-confidence items.
// Fully deterministic (no model call): the planner in _shared/sarah-learn/
// interview.ts picks the next question from what is still unknown, and the
// owner's answer is stored as an owner-origin field. Voice capture happens in
// the browser (Web Speech API); this function only ever sees text.
//
// POST { run_id, action: "next" | "answer" | "skip", question_id?, answer? }
// -> { question, remaining, estimate_seconds, done }

import { authenticate, handle, HttpError, json, loadRun } from '../_shared/sarah-learn/edge.ts';
import {
  MAX_INTERVIEW_QUESTIONS,
  SKIP_TOKENS,
  estimateRemainingSeconds,
  getQuestionById,
  nextQuestion,
  planInterview,
  questionText,
  type InterviewState,
  type KnownField,
  type Locale,
} from '../_shared/sarah-learn/interview.ts';
import { FIELD_BY_KEY, ownerAnswerField } from '../_shared/sarah-learn/schema.ts';

const MAX_ANSWER = 600;

Deno.serve(
  handle(async (req) => {
    const c = await authenticate(req);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw new HttpError(400, 'Invalid JSON body.');
    const action = body.action;
    if (action !== 'next' && action !== 'answer' && action !== 'skip') throw new HttpError(400, 'Unknown action.');

    const run = await loadRun(c, body.run_id);
    if (run.status === 'live') throw new HttpError(409, 'This run is already live. Start a new run to change it.');
    const locale: Locale = run.locale === 'es' ? 'es' : 'en';
    const runId = run.id as string;
    const asked: string[] = Array.isArray((run.interview_state as InterviewState | null)?.asked) ? [...(run.interview_state as InterviewState).asked] : [];

    const loadFields = async () => {
      const { data, error } = await c.admin.from('sarah_learn_fields').select('key,value,confidence,assumed,status').eq('run_id', runId).eq('user_id', c.ownerId);
      if (error) throw error;
      return data ?? [];
    };

    if (action === 'answer' || action === 'skip') {
      const q = typeof body.question_id === 'string' ? getQuestionById(body.question_id) : undefined;
      if (!q) throw new HttpError(400, 'Unknown question.');
      if (asked.includes(q.id)) throw new HttpError(409, 'That question was already answered.');

      const raw = action === 'answer' && typeof body.answer === 'string' ? body.answer.trim().slice(0, MAX_ANSWER) : '';
      const skipped = action === 'skip' || raw === '' || SKIP_TOKENS.test(raw);

      if (!skipped) {
        const field = ownerAnswerField(q.key, raw);
        if (!field) throw new HttpError(400, 'We could not use that answer. Try rephrasing, or skip the question.');
        const { data: existing } = await c.admin.from('sarah_learn_fields').select('value').eq('run_id', runId).eq('user_id', c.ownerId).eq('key', q.key).maybeSingle();
        const sensitive = FIELD_BY_KEY.get(q.key)?.sensitive ?? false;
        const { error } = await c.admin.from('sarah_learn_fields').upsert(
          {
            run_id: runId,
            user_id: c.ownerId,
            key: q.key,
            value: field.value,
            prev_value: existing && JSON.stringify(existing.value) !== JSON.stringify(field.value) ? existing.value : null,
            confidence: 'high',
            assumed: false,
            sensitive,
            origin: 'interview',
            source_id: null,
            citation: field.citation,
            // Sensitive answers still need an explicit approval on the review screen.
            status: sensitive ? 'pending' : 'approved',
            approved_by: sensitive ? null : c.userId,
            approved_at: sensitive ? null : new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'run_id,key' },
        );
        if (error) throw error;
      }

      asked.push(q.id);
      const { error: upErr } = await c.admin
        .from('sarah_learn_runs')
        .update({
          interview_state: { asked },
          status: 'interviewing',
          // new information invalidates an earlier readiness proof
          readiness_passed: false,
          updated_at: new Date().toISOString(),
        })
        .eq('id', runId)
        .eq('user_id', c.ownerId);
      if (upErr) throw upErr;
    }

    const rows = await loadFields();
    const known: KnownField[] = rows.map((r) => ({
      key: r.key as string,
      confidence: r.confidence as KnownField['confidence'],
      assumed: !!r.assumed,
      status: r.status as KnownField['status'],
      hasValue: r.value !== null && r.value !== undefined,
    }));
    const state: InterviewState = { asked };
    const q = nextQuestion(known, state);
    const remaining = planInterview(known, state).length;
    const businessName = rows.find((r) => r.key === 'business_name')?.value;

    return json({
      question: q
        ? {
            id: q.id,
            key: q.key,
            text: questionText(q, locale, typeof businessName === 'string' ? businessName : undefined),
            choices: q.choices?.map((ch) => ({ value: ch.value, label: ch.label[locale] ?? ch.label.en })) ?? [],
          }
        : null,
      remaining,
      answered: asked.length,
      max_questions: MAX_INTERVIEW_QUESTIONS,
      estimate_seconds: estimateRemainingSeconds(Math.min(remaining, MAX_INTERVIEW_QUESTIONS - asked.length)),
      done: q === null,
    });
  }),
);
