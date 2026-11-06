import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList } from '@/components/Skeleton';
import { ErrorState, Pill, Section, formatDateTime, useLoader } from '@/components/vehicles/shared';
import { useToast } from '@/contexts/ToastContext';
import { useAuth } from '@/contexts/AuthContext';
import { listFlags } from '@/lib/featureFlagsApi';
import {
  advanceRollout, completeRollout, createAiVersion, decideRequest, listAiVersions, listChangeRequests, listKillSwitches,
  listRollouts, previewFlagImpact, promoteAiVersion, recordKillSwitchDrill, requestFlagChange, requestKillSwitchResume,
  rollbackAiVersion, rollbackRollout, setKillSwitch, startAiShadow,
} from '@/lib/releaseSafetyApi';
import {
  canDecide, decisionTone, describeRequest, drillStatus, impactSummary, isUuid, nextStages, riskTone, validateReason,
  type AiVersion, type ChangeRequest, type FlagImpact, type KillSwitch, type Rollout,
} from '@/lib/releaseSafety';
import { useSEO } from '@/lib/seo';

function SEO() {
  useSEO({ title: 'Release Safety — Staff', description: 'Internal: kill switches, approvals, staged rollouts and AI versions.', canonical: 'https://vireek.com/staff/release-safety' });
  return null;
}

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/* ------------------------------------------------------------ kill switches */

function KillSwitchCard({ ks, onChanged }: { ks: KillSwitch; onChanged: () => Promise<void> }) {
  const { toast } = useToast();
  const [mode, setMode] = useState<null | 'stop' | 'org' | 'request'>(null);
  const [reason, setReason] = useState('');
  const [tenant, setTenant] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const drill = drillStatus(ks.last_drill_at);

  const close = () => { setMode(null); setReason(''); setTenant(''); setError(''); };

  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(done, 'success');
      close();
      await onChanged();
    } catch (e) {
      toast(msg(e, 'Action failed.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    const problem = validateReason(reason);
    if (problem) { setError(problem); return; }
    if (mode === 'org' && !isUuid(tenant)) { setError('Enter the account (owner) id as a UUID.'); return; }
    if (mode === 'stop') void run(() => setKillSwitch(ks.key, null, true, reason.trim()), `${ks.label} stopped for everyone.`);
    else if (mode === 'org') void run(() => setKillSwitch(ks.key, tenant.trim(), true, reason.trim()), `${ks.label} stopped for that account.`);
    else if (mode === 'request') void run(() => requestKillSwitchResume(ks.key, reason.trim()), 'Resume requested. A second person must approve it.');
  };

  const resume = () => {
    if (ks.risk === 'medium') void run(() => setKillSwitch(ks.key, null, false, 'resume'), `${ks.label} resumed.`);
    else setMode('request');
  };

  return (
    <li className="rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text-primary">{ks.label}</h3>
          {ks.description && <p className="mt-0.5 text-xs text-text-secondary">{ks.description}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            <Pill tone={ks.stopped ? 'danger' : 'success'}>{ks.stopped ? 'Stopped' : 'Running'}</Pill>
            <Pill tone={riskTone(ks.risk)}>{ks.risk} risk</Pill>
            <Pill tone={drill.tone}>{drill.label}</Pill>
            {ks.org_stops > 0 && <Pill tone="warning">{ks.org_stops} account{ks.org_stops === 1 ? '' : 's'} stopped</Pill>}
          </div>
          {ks.stopped && ks.reason && <p className="mt-2 text-xs text-text-secondary">Reason: {ks.reason}{ks.stopped_at ? ` · ${formatDateTime(ks.stopped_at)}` : ''}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {ks.stopped ? (
            ks.pending_resume
              ? <Pill tone="info">Resume awaiting a second approver</Pill>
              : <Button size="sm" variant="secondary" onClick={resume} disabled={busy}>{ks.risk === 'medium' ? 'Resume' : 'Request resume'}</Button>
          ) : (
            <Button size="sm" variant="danger" onClick={() => setMode('stop')} disabled={busy}>Stop for everyone</Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setMode('org')} disabled={busy}>Stop one account</Button>
          <Button size="sm" variant="ghost" onClick={() => void run(() => recordKillSwitchDrill(ks.key), 'Drill recorded.')} disabled={busy}>Record drill</Button>
        </div>
      </div>

      {mode && (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          {mode === 'org' && <Input label="Account (owner) id" value={tenant} onChange={(e) => setTenant(e.target.value)} spellCheck={false} autoCapitalize="none" placeholder="00000000-0000-0000-0000-000000000000" />}
          <Textarea label={mode === 'request' ? 'Why is it safe to resume?' : 'Reason'} rows={2} maxLength={500} value={reason} onChange={(e) => { setReason(e.target.value); setError(''); }} error={error || undefined} />
          <div className="flex justify-end gap-3">
            <Button size="sm" variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
            <Button size="sm" variant={mode === 'request' ? 'primary' : 'danger'} onClick={submit} loading={busy}>{mode === 'request' ? 'Request resume' : 'Stop now'}</Button>
          </div>
        </div>
      )}
    </li>
  );
}

/* ---------------------------------------------------------------- approvals */

function ApprovalsSection({ requests, onChanged }: { requests: ChangeRequest[]; onChanged: () => Promise<void> }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const [busyId, setBusyId] = useState<string | null>(null);

  const decide = async (r: ChangeRequest, approve: boolean) => {
    setBusyId(r.id);
    try {
      const result = await decideRequest(r.kind, r.id, approve);
      toast(result === 'approved' ? 'Approved and applied.' : result === 'rejected' ? 'Rejected.' : 'That request had expired.', result === 'approved' ? 'success' : 'info');
      await onChanged();
    } catch (e) {
      toast(msg(e, 'Could not record the decision.'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  if (requests.length === 0) return <p className="text-sm text-text-secondary">No change requests yet.</p>;
  return (
    <ul className="space-y-3">
      {requests.map((r) => (
        <li key={r.id} className="rounded-xl border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-text-primary">{describeRequest(r)}</p>
            <Pill tone={r.status === 'pending' ? 'warning' : r.status === 'approved' ? 'success' : 'neutral'}>{r.status}</Pill>
          </div>
          <p className="mt-1 text-xs text-text-secondary">
            Requested by {r.requested_by_email ?? 'staff'} · {formatDateTime(r.requested_at)} · “{r.reason}”
            {r.decided_by_email ? ` · decided by ${r.decided_by_email}` : ''}
          </p>
          {canDecide(r, user?.id) && (
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={() => void decide(r, true)} loading={busyId === r.id}>Approve</Button>
              <Button size="sm" variant="ghost" onClick={() => void decide(r, false)} disabled={busyId === r.id}>Reject</Button>
            </div>
          )}
          {r.status === 'pending' && !canDecide(r, user?.id) && <p className="mt-2 text-xs text-text-secondary">Waiting for a second approver (you cannot approve your own request).</p>}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------- flag change request */

function FlagChangeSection({ onChanged }: { onChanged: () => Promise<void> }) {
  const { toast } = useToast();
  const flags = useLoader(listFlags, 'flags');
  const [key, setKey] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [pct, setPct] = useState('100');
  const [reason, setReason] = useState('');
  const [impact, setImpact] = useState<FlagImpact | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const pctNum = Number(pct);
  const pctOk = Number.isInteger(pctNum) && pctNum >= 0 && pctNum <= 100;
  const reset = () => setImpact(null);

  const preview = async () => {
    if (!key || !pctOk) { setError('Choose a flag and a whole-number percentage between 0 and 100.'); return; }
    setBusy(true);
    try { setImpact(await previewFlagImpact(key, enabled, pctNum)); setError(''); } catch (e) { setError(msg(e, 'Could not preview.')); } finally { setBusy(false); }
  };

  const submit = async () => {
    const problem = validateReason(reason);
    if (!key || !pctOk) { setError('Choose a flag and a whole-number percentage between 0 and 100.'); return; }
    if (problem) { setError(problem); return; }
    setBusy(true);
    try {
      await requestFlagChange(key, enabled, pctNum, reason.trim());
      toast('Change requested. A second person must approve it.', 'success');
      setReason(''); setImpact(null); setError('');
      await onChanged();
    } catch (e) {
      setError(msg(e, 'Could not create the request.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">Use this for high and critical risk flags (the flag console is refused for them). Reducing exposure never needs approval.</p>
      <div>
        <label htmlFor="rs-flag" className="mb-1.5 block text-sm font-medium text-text-primary">Flag</label>
        <select id="rs-flag" value={key} onChange={(e) => { setKey(e.target.value); reset(); }} className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary">
          <option value="">Select a flag…</option>
          {(flags.data ?? []).map((f) => <option key={f.key} value={f.key}>{f.name} ({f.key})</option>)}
        </select>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); reset(); }} /> Master switch on
        </label>
        <div className="w-32"><Input label="Rollout %" type="number" inputMode="numeric" min={0} max={100} value={pct} onChange={(e) => { setPct(e.target.value); reset(); }} /></div>
        <Button size="sm" variant="secondary" onClick={() => void preview()} disabled={busy}>Preview impact</Button>
      </div>
      {impact && <p role="status" className="rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary">{impactSummary(impact)}</p>}
      <Textarea label="Reason" rows={2} maxLength={500} value={reason} onChange={(e) => { setReason(e.target.value); setError(''); }} error={error || undefined} />
      <div className="flex justify-end"><Button size="sm" onClick={() => void submit()} loading={busy}>Request approval</Button></div>
    </div>
  );
}

/* ----------------------------------------------------------------- rollouts */

function RolloutCard({ r, onChanged }: { r: Rollout; onChanged: () => Promise<void> }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [confirmRollback, setConfirmRollback] = useState(false);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok, 'success'); setReason(''); setError(''); await onChanged(); } catch (e) { toast(msg(e, 'Action failed.'), 'error'); } finally { setBusy(false); }
  };

  const advance = async (pct: number) => {
    setBusy(true);
    try {
      const out = await advanceRollout(r.flag_key, pct);
      toast(out.status === 'pending_approval' ? 'Advance requested. A second person must approve it.' : `Advanced to ${pct}%.`, 'success');
      await onChanged();
    } catch (e) {
      toast(msg(e, 'Could not advance.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const askRollback = () => {
    const problem = validateReason(reason);
    if (problem) { setError(problem); return; }
    setConfirmRollback(true);
  };

  return (
    <li className="rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">{r.label}</h3>
          <p className="text-xs text-text-secondary">{r.flag_key} · {r.component}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Pill tone={r.status === 'active' ? 'info' : r.status === 'completed' ? 'success' : 'danger'}>{r.status.replace('_', ' ')}</Pill>
          <Pill tone="neutral">{r.stage_pct}% of accounts</Pill>
          {r.last_decision && <Pill tone={decisionTone(r.last_decision)}>{r.last_decision}</Pill>}
        </div>
      </div>
      {r.last_reasons.length > 0 && <p className="mt-2 text-xs text-text-secondary">{r.last_reasons.join(' · ')}</p>}
      {r.rollback_reason && <p className="mt-2 text-xs text-danger">Rolled back: {r.rollback_reason}</p>}

      {r.status === 'active' && (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <div className="flex flex-wrap gap-2">
            {nextStages(r.stage_pct).map((s) => (
              <Button key={s} size="sm" variant="secondary" disabled={busy || r.last_decision !== 'promote'} onClick={() => void advance(s)}>Advance to {s}%</Button>
            ))}
            {r.stage_pct === 100 && <Button size="sm" onClick={() => void act(() => completeRollout(r.flag_key), 'Rollout completed. Remove the flag and its old code path.')} disabled={busy}>Mark complete</Button>}
          </div>
          {r.last_decision !== 'promote' && <p className="text-xs text-text-secondary">Advancing unlocks when the health check says “promote”.</p>}
          <Input label="Reason to roll back" value={reason} maxLength={500} onChange={(e) => { setReason(e.target.value); setError(''); }} error={error || undefined} />
          <Button size="sm" variant="danger" onClick={askRollback} disabled={busy}>Roll back now</Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmRollback}
        title={`Roll back ${r.label}?`}
        description="The flag turns off for every account and traffic returns to the stable version."
        confirmLabel="Roll back"
        onCancel={() => setConfirmRollback(false)}
        onConfirm={async () => { setConfirmRollback(false); await act(() => rollbackRollout(r.flag_key, reason.trim()), 'Rolled back.'); }}
      />
    </li>
  );
}

/* -------------------------------------------------------------- AI versions */

function AiVersionsSection({ versions, onChanged }: { versions: AiVersion[]; onChanged: () => Promise<void> }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState('');
  const [confirm, setConfirm] = useState<AiVersion | null>(null);
  const [kind, setKind] = useState<'prompt' | 'route'>('prompt');
  const [task, setTask] = useState('');
  const [payload, setPayload] = useState('{"system_suffix": ""}');
  const [formError, setFormError] = useState('');

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok, 'success'); await onChanged(); } catch (e) { toast(msg(e, 'Action failed.'), 'error'); } finally { setBusy(false); }
  };

  const create = async () => {
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { setFormError('Payload must be valid JSON.'); return; }
    if (!/^[a-z][a-z0-9_]{1,62}[a-z0-9]$/.test(task)) { setFormError('Task key: lowercase letters, digits and underscores.'); return; }
    setFormError('');
    await act(() => createAiVersion(kind, task, parsed, ''), 'Draft version created.');
  };

  const rollback = (v: AiVersion) => {
    const problem = validateReason(reason);
    if (problem) { setReasonError(problem); return; }
    setReasonError('');
    void act(() => rollbackAiVersion(v.kind, v.task_key, reason.trim()), 'Rolled back.');
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">Draft → shadow (sampled, no customer impact) → active. Promotion is allowed only when the shadow and eval thresholds pass; rollback is instant. Stopping the “AI model / prompt versions” kill switch returns everything to the code defaults.</p>
      <Input label="Reason (used for rollback)" value={reason} maxLength={500} onChange={(e) => { setReason(e.target.value); setReasonError(''); }} error={reasonError || undefined} />
      {versions.length === 0 ? <p className="text-sm text-text-secondary">No versions yet.</p> : (
        <ul className="space-y-2">
          {versions.map((v) => (
            <li key={`${v.kind}-${v.task_key}-${v.version}`} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-primary">{v.task_key} · {v.kind} v{v.version}</p>
                <p className="text-xs text-text-secondary">{v.status === 'shadow' ? `Shadow ${v.shadow_sample_pct}% · ` : ''}eval {v.eval_score === null ? 'not recorded' : v.eval_score.toFixed(2)}{v.promoted_at ? ` · promoted ${formatDateTime(v.promoted_at)}` : ''}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={v.status === 'active' ? 'success' : v.status === 'shadow' ? 'info' : 'neutral'}>{v.status}</Pill>
                {v.status === 'draft' && <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act(() => startAiShadow(v.kind, v.task_key, v.version, 5), 'Shadow mode started at 5%.')}>Start shadow</Button>}
                {v.status === 'shadow' && <Button size="sm" disabled={busy} onClick={() => setConfirm(v)}>Promote</Button>}
                {v.status === 'active' && <Button size="sm" variant="danger" disabled={busy} onClick={() => rollback(v)}>Roll back</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="space-y-3 border-t border-border pt-4">
        <h4 className="text-sm font-semibold text-text-primary">New draft version</h4>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="ai-kind" className="mb-1.5 block text-sm font-medium text-text-primary">Kind</label>
            <select id="ai-kind" value={kind} onChange={(e) => setKind(e.target.value === 'route' ? 'route' : 'prompt')} className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary">
              <option value="prompt">Prompt (system suffix)</option>
              <option value="route">Route (provider chain)</option>
            </select>
          </div>
          <div className="min-w-[12rem] flex-1"><Input label="Task key" value={task} onChange={(e) => setTask(e.target.value)} autoCapitalize="none" spellCheck={false} /></div>
        </div>
        <Textarea label="Payload (JSON)" rows={4} value={payload} onChange={(e) => setPayload(e.target.value)} error={formError || undefined} helperText={kind === 'prompt' ? '{"system_suffix": "…"}' : '{"route": [{"provider": "gemini", "model": "…"}]}'} spellCheck={false} />
        <div className="flex justify-end"><Button size="sm" variant="secondary" onClick={() => void create()} disabled={busy}>Create draft</Button></div>
      </div>
      <ConfirmDialog
        open={confirm !== null}
        title={confirm ? `Promote ${confirm.task_key} v${confirm.version}?` : ''}
        description="It becomes the production version for all traffic. The server re-checks the shadow and eval thresholds and refuses if they are not met."
        confirmLabel="Promote"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => { const v = confirm; setConfirm(null); if (v) await act(() => promoteAiVersion(v.kind, v.task_key, v.version), 'Promoted.'); }}
      />
    </div>
  );
}

/* --------------------------------------------------------------------- page */

function Block<T>({ title, loader, render }: { title: string; loader: ReturnType<typeof useLoader<T>>; render: (data: T) => JSX.Element }) {
  return (
    <Section title={title}>
      {loader.loading && !loader.data ? <SkeletonCardList count={2} rows={2} /> : loader.error && !loader.data ? <ErrorState message={loader.error} onRetry={loader.reload} /> : loader.data ? render(loader.data) : null}
    </Section>
  );
}

export function ReleaseSafetyAdminPage() {
  const switches = useLoader(listKillSwitches, 'kill-switches');
  const requests = useLoader(listChangeRequests, 'change-requests');
  const rollouts = useLoader(listRollouts, 'rollouts');
  const versions = useLoader(listAiVersions, 'ai-versions');

  const refreshAll = async () => { await Promise.all([switches.reload(), requests.reload(), rollouts.reload(), versions.reload()]); };

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen bg-bg-primary px-6 pb-20 pt-28">
        <div className="mx-auto max-w-5xl space-y-6">
          <div>
            <div className="flex items-center gap-2">
              <ShieldAlert className="text-accent" size={22} aria-hidden="true" />
              <h1 className="text-2xl font-bold tracking-tight text-text-primary">Release Safety</h1>
            </div>
            <p className="mt-2 max-w-2xl text-sm text-text-secondary">Stop risky capabilities in one click, approve high-risk changes with a second person, and watch staged rollouts. Every action is audited.</p>
          </div>

          <Block title="Kill switches" loader={switches} render={(list) => (
            <ul className="space-y-3">{list.map((k) => <KillSwitchCard key={k.key} ks={k} onChanged={refreshAll} />)}</ul>
          )} />

          <Block title="Approvals" loader={requests} render={(list) => <ApprovalsSection requests={list} onChanged={refreshAll} />} />

          <Section title="Request a flag change (two-person approval)"><FlagChangeSection onChanged={refreshAll} /></Section>

          <Block title="Staged rollouts" loader={rollouts} render={(list) => list.length === 0
            ? <p className="text-sm text-text-secondary">No rollouts yet. Start one from a flag that is off.</p>
            : <ul className="space-y-3">{list.map((r) => <RolloutCard key={`${r.flag_key}-${r.started_at}`} r={r} onChanged={refreshAll} />)}</ul>} />

          <Block title="AI prompt and route versions" loader={versions} render={(list) => <AiVersionsSection versions={list} onChanged={refreshAll} />} />
        </div>
      </main>
    </>
  );
}
