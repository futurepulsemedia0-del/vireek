// src/components/support/useSupportDiagnostics.ts
//
// Orchestrates the three levels for the UI:
//   L1 runChecks()   → evidence → findings (pure engine in lib/supportAgent/diagnostics.ts)
//   L2 execute()     → user-confirmed actions through the single policy gate (runAction)
//   L3 monitor       → listens for problems and self-heals ONLY actions flagged `autonomous`
//                      (today: session renewal), inside a retry budget, always verified + logged

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { generateIncidentId } from '@/lib/incident';
import { analyze, buildReport, collectEvidence, summarizeForAi, type Evidence, type Finding } from '@/lib/supportAgent/diagnostics';
import { createHealingBudget, runAction, type ActionId, type ActionOutcome } from '@/lib/supportAgent/actions';
import { subscribeIssues } from '@/lib/supportAgent/errorBuffer';
import { PENDING_VERIFY_KEY, createActionDeps, createEvidenceDeps } from '@/lib/supportAgent/runtime';
import type { SupportAgentIconState } from './SupportAgentIcon';

export type ActionState = 'running' | ActionOutcome;
export interface HealEntry { id: number; at: number; text: string; ok: boolean }

const NUDGE_SNOOZE_KEY = 'vk_agent_nudge_snooze_until';
const SNOOZE_MS = 10 * 60_000;
const BAD_AFTER_RELOAD = new Set(['stale_app', 'backend_unreachable', 'backend_misconfigured', 'offline']);

export function useSupportDiagnostics(enabled: boolean) {
  const evidenceDeps = useMemo(() => createEvidenceDeps(), []);
  const actionDeps = useMemo(() => createActionDeps(), []);
  const budget = useMemo(() => createHealingBudget(), []);

  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [incidentId, setIncidentId] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [healing, setHealing] = useState(false);
  const [outcomes, setOutcomes] = useState<Partial<Record<ActionId, ActionState>>>({});
  const [log, setLog] = useState<HealEntry[]>([]);
  const [nudge, setNudge] = useState<string | null>(null);

  const alive = useRef(true);
  const seq = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const pushLog = useCallback((text: string, ok: boolean) => {
    seq.current += 1;
    const entry: HealEntry = { id: seq.current, at: Date.now(), text, ok };
    setLog((prev) => [entry, ...prev].slice(0, 5));
  }, []);

  const showNudge = useCallback((text: string) => {
    try {
      if (Number(sessionStorage.getItem(NUDGE_SNOOZE_KEY) ?? 0) > Date.now()) return;
    } catch { /* storage blocked: show it */ }
    setNudge(text);
  }, []);

  const dismissNudge = useCallback(() => {
    setNudge(null);
    try { sessionStorage.setItem(NUDGE_SNOOZE_KEY, String(Date.now() + SNOOZE_MS)); } catch { /* ignore */ }
  }, []);

  const runChecks = useCallback(async (): Promise<Finding[]> => {
    setChecking(true);
    try {
      const ev = await collectEvidence(evidenceDeps);
      const f = analyze(ev);
      if (alive.current) {
        setEvidence(ev);
        setFindings(f);
        setIncidentId(generateIncidentId());
      }
      return f;
    } finally {
      if (alive.current) setChecking(false);
    }
  }, [evidenceDeps]);

  /** LEVEL 2 — user pressed an action and confirmed it. */
  const execute = useCallback(async (id: ActionId, email?: string): Promise<ActionOutcome> => {
    setOutcomes((p) => ({ ...p, [id]: 'running' }));
    const out = await runAction(id, actionDeps, { origin: 'user', email });
    if (alive.current) setOutcomes((p) => ({ ...p, [id]: out }));
    if (out.status === 'verified' && id !== 'open_live_chat') void runChecks(); // re-diagnose: did it really go away?
    return out;
  }, [actionDeps, runChecks]);

  /** LEVEL 3 — no user click. Only autonomous-flagged actions pass the gate in runAction. */
  const autoHeal = useCallback(async (id: ActionId) => {
    const expiry = await actionDeps.getSessionExpiry().catch(() => null);
    if (expiry === null) return; // anonymous visitor: nothing to heal
    if (!budget.tryConsume(id, Date.now())) return; // retry budget exhausted: stop, never loop
    setHealing(true);
    const out = await runAction(id, actionDeps, { origin: 'autonomous' });
    if (!alive.current) return;
    setHealing(false);
    const ok = out.status === 'verified';
    pushLog(ok ? 'Your session had expired. I renewed it automatically and confirmed it.' : 'Your session expired and I could not renew it. Please sign in again.', ok);
    if (!ok) showNudge('Your session expired. Open the agent for next steps.');
  }, [actionDeps, budget, pushLog, showNudge]);

  useEffect(() => {
    if (!enabled) return undefined;
    const unsub = subscribeIssues((issue) => {
      if (issue.kind === 'auth_session_expired') void autoHeal('refresh_session');
      else if (issue.kind === 'chunk_load') showNudge('Part of the app failed to load. I can fix that — open the agent.');
      else if (issue.kind.startsWith('auth_')) showNudge('Trouble signing in? I can run a quick check.');
    });
    const onOffline = () => showNudge("You're offline. I'll re-check automatically when you're back.");
    const onOnline = () => {
      setNudge(null);
      void runChecks().then(() => pushLog('Connection restored. I re-ran the checks automatically.', true));
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      unsub();
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, [enabled, autoHeal, runChecks, pushLog, showNudge]);

  // Post-reload verification of "clear app files" / "reload".
  useEffect(() => {
    if (!enabled) return;
    let pending: string | null = null;
    try {
      pending = sessionStorage.getItem(PENDING_VERIFY_KEY);
      if (pending) sessionStorage.removeItem(PENDING_VERIFY_KEY);
    } catch { /* storage blocked */ }
    if (!pending) return;
    void runChecks().then((f) => {
      const bad = f.some((x) => BAD_AFTER_RELOAD.has(x.id));
      pushLog(bad ? 'The page reloaded but problems remain. See the Fix tab.' : 'The page reloaded cleanly and all checks pass.', !bad);
      if (bad) showNudge('Some problems remain after the reload. Open the agent for next steps.');
    });
  }, [enabled, runChecks, pushLog, showNudge]);

  const report = useMemo(
    () => (evidence && incidentId
      ? buildReport(evidence, findings, { incidentId, timeIso: new Date().toISOString(), path: window.location.pathname, userAgent: navigator.userAgent })
      : null),
    [evidence, findings, incidentId],
  );
  const aiSummary = useMemo(() => (evidence ? summarizeForAi(evidence, findings) : undefined), [evidence, findings]);
  const iconState: SupportAgentIconState = healing ? 'healing' : checking ? 'thinking' : 'idle';

  return { evidence, findings, incidentId, report, aiSummary, checking, iconState, outcomes, log, nudge, dismissNudge, runChecks, execute };
}

export type SupportDiagnostics = ReturnType<typeof useSupportDiagnostics>;
