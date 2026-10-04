// src/components/jobs/AdaptiveDiagnosticJobPanel.tsx
//
// Staff view of the Adaptive Customer Diagnostic for one job: send the customer link, see the live
// diagnosis ranking, what to bring, and record the real outcome — which is what teaches the system.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BrainCircuit, CheckCircle2, Clipboard, Loader2, ShieldAlert, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import type { Job } from '@/lib/supabase';
import {
  OTHER_OUTCOME,
  STATUS_META,
  confidenceLabel,
  diagnosticMessage,
  friendlyDiagError,
  getDiagnoseLink,
  pct,
  type DiagHypothesisRow,
  type DiagQuestionRow,
  type DiagSession,
} from '@/lib/adaptiveDiagnostic';
import { confirmOutcome, fetchCatalog, fetchJobSessions } from '@/lib/adaptiveDiagnosticApi';

const POLL_MS = 10_000;

export function AdaptiveDiagnosticJobPanel({ job }: { job: Job }) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const [sessions, setSessions] = useState<DiagSession[]>([]);
  const [hyps, setHyps] = useState<DiagHypothesisRow[]>([]);
  const [questions, setQuestions] = useState<DiagQuestionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [choice, setChoice] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const session = sessions[0] ?? null;
  const domain = session?.domain_code ?? null;
  const closed = ['completed', 'cancelled', 'no_show'].includes(job.job_status);

  const load = useCallback(async () => {
    try {
      setSessions(await fetchJobSessions(job.id));
    } catch {
      /* keep the last good state; the panel is non-critical */
    } finally {
      setLoading(false);
    }
  }, [job.id]);

  useEffect(() => {
    setLoading(true);
    setChoice('');
    setNote('');
    void load();
  }, [load]);

  // Poll only while the customer is still answering.
  useEffect(() => {
    if (session?.status !== 'open') return;
    const t = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(t);
  }, [session?.status, load]);

  useEffect(() => {
    if (!domain) return;
    let cancelled = false;
    fetchCatalog(domain)
      .then((c) => {
        if (cancelled) return;
        setHyps(c.hypotheses);
        setQuestions(c.questions);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [domain]);

  const hypLabel = useMemo(() => new Map(hyps.map((h) => [h.code, h])), [hyps]);
  const qMap = useMemo(() => new Map(questions.map((q) => [q.code, q])), [questions]);
  const link = getDiagnoseLink(job.reschedule_token);

  const copy = async (value: string, okMessage: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast(okMessage, 'success');
    } catch {
      toast('Could not copy. Select and copy it manually.', 'error');
    }
  };

  const submit = async () => {
    if (!session || !choice) return;
    setSaving(true);
    try {
      const res = await confirmOutcome(session.id, choice, note);
      toast(
        res.unmapped
          ? 'Saved for review. It will not change the model until it is mapped.'
          : res.top1_correct
            ? 'Recorded. The diagnostic called this one correctly.'
            : 'Recorded. The diagnostic will adjust from this outcome.',
        'success',
      );
      await load();
    } catch (e) {
      toast(friendlyDiagError(e, 'Could not record the outcome.'), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-bg-primary px-4 py-3 text-sm text-text-secondary">
        <Loader2 size={14} className="animate-spin" /> Loading diagnostic…
      </div>
    );
  }

  const ranked = (session?.posterior ?? []).slice(0, 3);
  const top = ranked[0] ? hypLabel.get(ranked[0].code) : null;
  const canConfirm = !!session && !session.outcome_applied_at && session.status !== 'unsupported' && (session.answers.length > 0 || session.status === 'completed');

  return (
    <section className="rounded-xl border border-border bg-bg-primary p-4" aria-label="Adaptive customer diagnostic">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <BrainCircuit size={16} className="text-accent" /> Adaptive Diagnostic
        </h3>
        {session && <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_META[session.status].tone}`}>{STATUS_META[session.status].label}</span>}
      </div>

      {!session && (
        <p className="mt-2 text-xs text-text-secondary">
          Send the customer a one-minute question flow. The next question adapts to each answer, and you see the likely cause and what to bring before you arrive.
        </p>
      )}

      {session?.hazard && (
        <div role="alert" className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
          <span>The customer reported a possible safety hazard (gas, burning, sparks or similar). Call them before dispatching.</span>
        </div>
      )}

      {session?.status === 'unsupported' && (
        <p className="mt-3 text-xs text-text-secondary">This complaint type is not covered by the diagnostic yet. The customer&apos;s description is below.</p>
      )}

      {ranked.length > 0 && !session?.hazard && (
        <div className="mt-3 space-y-2">
          {ranked.map((r) => (
            <div key={r.code}>
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium text-text-primary">{hypLabel.get(r.code)?.label ?? r.code}</span>
                <span className="tabular-nums text-text-secondary">{pct(r.p)}</span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
                <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(r.p * 100)}%` }} />
              </div>
            </div>
          ))}
          <p className="text-xs text-text-secondary">
            Confidence: <strong className="text-text-primary">{confidenceLabel(session?.confidence)}</strong> · {session?.answers.length ?? 0} answers
          </p>
          {top?.parts_hint && (
            <p className="flex items-start gap-2 rounded-lg bg-bg-secondary px-3 py-2 text-xs text-text-primary">
              <Wrench size={14} className="mt-0.5 shrink-0 text-accent" />
              <span><strong>Bring:</strong> {top.parts_hint}</span>
            </p>
          )}
        </div>
      )}

      {session && session.answers.length > 0 && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer font-medium text-text-secondary">Customer answers</summary>
          <ul className="mt-2 space-y-1">
            {session.answers.map((a) => (
              <li key={a.q} className="text-text-secondary">
                <span className="text-text-primary">{qMap.get(a.q)?.text ?? a.q}</span>{' '}
                → {a.a === 'unsure' ? 'Not sure' : (qMap.get(a.q)?.options.find((o) => o.id === a.a)?.label ?? a.a)}
              </li>
            ))}
          </ul>
        </details>
      )}

      {session?.customer_text && (
        <p className="mt-3 whitespace-pre-wrap rounded-lg bg-bg-secondary px-3 py-2 text-xs text-text-secondary">{session.customer_text}</p>
      )}

      {session?.outcome_applied_at ? (
        <p className="mt-3 flex items-center gap-2 text-xs text-text-secondary">
          <CheckCircle2 size={14} className="text-emerald-500" />
          Outcome recorded: <strong className="text-text-primary">{session.confirmed_hypothesis === OTHER_OUTCOME ? 'Other (flagged for review)' : (hypLabel.get(session.confirmed_hypothesis ?? '')?.label ?? session.confirmed_hypothesis)}</strong>
          {session.top1_correct != null && <span>· {session.top1_correct ? 'predicted correctly' : 'prediction missed — learned'}</span>}
        </p>
      ) : canConfirm ? (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <label htmlFor="diag-outcome" className="block text-xs font-medium text-text-primary">What was the actual problem?</label>
          <select
            id="diag-outcome"
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            className="focus-ring w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary"
          >
            <option value="">Select the confirmed diagnosis…</option>
            {hyps.map((h) => (
              <option key={h.code} value={h.code}>{h.label}</option>
            ))}
            <option value={OTHER_OUTCOME}>Something else / none of these</option>
          </select>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 1000))}
            placeholder="Optional note (what you actually found)"
            className="focus-ring w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary"
            aria-label="Outcome note"
          />
          <Button size="sm" disabled={!choice || saving || hyps.length === 0} onClick={submit}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            Record outcome
          </Button>
        </div>
      ) : null}

      {!closed && (!session || session.status === 'unsupported' || session.status === 'open') && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => copy(link, 'Diagnostic link copied.')}>
            <Clipboard size={14} /> Copy link
          </Button>
          <Button size="sm" variant="ghost" onClick={() => copy(diagnosticMessage(profile?.company_name ?? null, link), 'Message copied.')}>
            Copy SMS text
          </Button>
        </div>
      )}
      {!closed && session && session.status === 'open' && (
        <p className="mt-3 text-xs text-text-secondary">Waiting for the customer… this updates automatically.</p>
      )}
    </section>
  );
}
