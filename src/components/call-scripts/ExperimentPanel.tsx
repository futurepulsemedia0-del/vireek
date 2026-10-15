import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlaskConical, RefreshCw, Trophy, Square, Loader2, Info, TriangleAlert as AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Skeleton } from '@/components/Skeleton';
import {
  LIMITS,
  compareArms,
  fetchPerformance,
  rate,
  wilsonInterval,
  type ArmTally,
  type CallScript,
  type CallScriptVersion,
  type Comparison,
  type ScriptPerformance,
} from '@/lib/callScripts';

const SPLIT_OPTIONS = [10, 20, 30, 50];

function pct(n: number | null, digits = 1): string {
  return n === null ? '—' : `${(n * 100).toFixed(digits)}%`;
}

function ArmCard({ title, subtitle, tally, tone }: { title: string; subtitle: string; tally: ArmTally; tone: 'control' | 'challenger' }) {
  const ci = wilsonInterval(tally.booked, tally.calls);
  return (
    <div className={`rounded-2xl border p-5 ${tone === 'challenger' ? 'border-accent/40 bg-accent/5' : 'border-border bg-bg-secondary'}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{title}</p>
      <p className="mt-0.5 text-sm text-text-primary">{subtitle}</p>
      <p className="mt-3 text-3xl font-bold text-text-primary">{pct(rate(tally))}</p>
      <p className="text-xs text-text-secondary">booking rate</p>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt className="text-xs text-text-secondary">Calls</dt>
          <dd className="font-semibold text-text-primary">{tally.calls}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-secondary">Booked</dt>
          <dd className="font-semibold text-text-primary">{tally.booked}</dd>
        </div>
      </dl>
      {ci && <p className="mt-2 text-xs text-text-secondary">95% range: {pct(ci.low, 0)} – {pct(ci.high, 0)}</p>}
    </div>
  );
}

function verdictCopy(c: Comparison, controlCalls: number, challengerCalls: number): { tone: 'info' | 'success' | 'warning'; text: string } {
  const p = c.pValue === null ? '' : ` (p = ${c.pValue < 0.001 ? '<0.001' : c.pValue.toFixed(3)})`;
  switch (c.verdict) {
    case 'insufficient_data':
      return {
        tone: 'info',
        text: `Collecting data — ${Math.min(controlCalls, challengerCalls)} of ${LIMITS.minSamplePerArm} finished calls on the smaller side. A result is shown once both sides reach ${LIMITS.minSamplePerArm}.`,
      };
    case 'challenger_winning':
      return { tone: 'success', text: `The challenger books ${c.liftPoints?.toFixed(1)} points more calls${p}. This is unlikely to be chance. You can promote it.` };
    case 'control_winning':
      return { tone: 'warning', text: `The live version books ${Math.abs(c.liftPoints ?? 0).toFixed(1)} points more calls than the challenger${p}. Consider stopping the test.` };
    default:
      return { tone: 'info', text: `No statistically significant difference yet${p}. Keep it running for more calls, or stop the test.` };
  }
}

interface ExperimentPanelProps {
  script: CallScript | null;
  versions: CallScriptVersion[];
  busy: boolean;
  onStart: (challengerVersionId: string, pct: number) => Promise<void>;
  onSetSplit: (pct: number) => Promise<void>;
  onStop: () => Promise<void>;
  onPromote: () => Promise<void>;
}

export function ExperimentPanel({ script, versions, busy, onStart, onSetSplit, onStop, onPromote }: ExperimentPanelProps) {
  const [performance, setPerformance] = useState<ScriptPerformance | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [challengerId, setChallengerId] = useState('');
  const [startPct, setStartPct] = useState(20);
  const [confirm, setConfirm] = useState<null | 'stop' | 'promote'>(null);

  const hasLive = !!script?.active_version_id;
  const scriptId = script?.id ?? null;
  const experimentKey = `${script?.active_version_id ?? ''}|${script?.challenger_version_id ?? ''}|${script?.experiment_started_at ?? ''}`;

  useEffect(() => {
    if (!script || !script.active_version_id) {
      setPerformance(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPerformance(script)
      .then((p) => {
        if (!cancelled) setPerformance(p);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load call results. Please try again.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `script` is intentionally keyed by id + experiment state, not identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptId, experimentKey, reloadKey]);

  const label = useMemo(() => {
    const map = new Map(versions.map((v) => [v.id, v.version_number] as const));
    return (id: string | null) => {
      const n = id ? map.get(id) : undefined;
      return n === undefined ? '?' : String(n);
    };
  }, [versions]);

  const candidates = versions.filter((v) => v.id !== script?.active_version_id);
  const running = !!script?.challenger_version_id;

  const comparison = useMemo(
    () => (performance ? compareArms(performance.experiment.byArm.control, performance.experiment.byArm.challenger) : null),
    [performance],
  );

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  if (!script || !hasLive) {
    return (
      <EmptyState
        icon={FlaskConical}
        title="Publish a version to start A/B testing"
        description="An A/B test compares a challenger version against the version that is live now. Publish a version from the Editor first."
      />
    );
  }

  return (
    <div className="space-y-6">
      {!running ? (
        candidates.length === 0 ? (
          <EmptyState
            icon={FlaskConical}
            title="Save a second version to test"
            description="Edit your script in the Editor and save it as a new version, then come back to split traffic between the two."
          />
        ) : (
          <div className="rounded-2xl border border-border bg-bg-secondary p-5">
            <h3 className="text-base font-semibold text-text-primary">Start an A/B test</h3>
            <p className="mt-1 text-sm text-text-secondary">
              Live version {label(script.active_version_id)} keeps most calls. The challenger gets the share you choose, picked
              fairly at random per call.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="challenger-select" className="mb-1.5 block text-sm font-medium text-text-primary">
                  Challenger version
                </label>
                <select
                  id="challenger-select"
                  value={challengerId}
                  onChange={(e) => setChallengerId(e.target.value)}
                  className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary"
                >
                  <option value="">Choose a version…</option>
                  {candidates.map((v) => (
                    <option key={v.id} value={v.id}>
                      Version {v.version_number}
                      {v.change_note ? ` — ${v.change_note}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <p className="mb-1.5 text-sm font-medium text-text-primary">Traffic to challenger</p>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Traffic to challenger">
                  {SPLIT_OPTIONS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      aria-pressed={startPct === p}
                      onClick={() => setStartPct(p)}
                      className={`focus-ring min-h-[44px] rounded-xl border px-4 text-sm font-medium transition-colors ${
                        startPct === p ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-primary text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      {p}%
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-5 flex justify-end">
              <Button type="button" onClick={() => onStart(challengerId, startPct)} disabled={!challengerId || busy}>
                {busy ? <Loader2 size={16} className="animate-spin" /> : <FlaskConical size={16} />}
                Start test
              </Button>
            </div>
          </div>
        )
      ) : (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-base font-semibold text-text-primary">
                A/B test: version {label(script.active_version_id)} vs version {label(script.challenger_version_id)}
              </h3>
              {script.experiment_started_at && (
                <p className="text-xs text-text-secondary">
                  Running since {new Date(script.experiment_started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={refresh} disabled={loading}>
                <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
                Refresh
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => setConfirm('stop')} disabled={busy}>
                <Square size={15} />
                Stop test
              </Button>
              <Button type="button" size="sm" onClick={() => setConfirm('promote')} disabled={busy}>
                <Trophy size={15} />
                Promote challenger
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Traffic to challenger">
            <span className="text-sm text-text-secondary">Challenger traffic:</span>
            {[0, ...SPLIT_OPTIONS].map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={script.challenger_traffic_pct === p}
                disabled={busy}
                onClick={() => onSetSplit(p)}
                className={`focus-ring min-h-[40px] rounded-lg border px-3 text-xs font-medium transition-colors disabled:opacity-50 ${
                  script.challenger_traffic_pct === p ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-primary text-text-secondary hover:text-text-primary'
                }`}
              >
                {p === 0 ? 'Pause (0%)' : `${p}%`}
              </button>
            ))}
          </div>

          {loading && !performance ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Skeleton className="h-44 rounded-2xl" />
              <Skeleton className="h-44 rounded-2xl" />
            </div>
          ) : error ? (
            <div role="alert" className="flex flex-col gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <span className="text-text-primary">{error}</span>
              <Button type="button" variant="secondary" size="sm" onClick={refresh}>
                Try again
              </Button>
            </div>
          ) : performance && comparison ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <ArmCard title="Control (live)" subtitle={`Version ${label(script.active_version_id)}`} tally={performance.experiment.byArm.control} tone="control" />
                <ArmCard title="Challenger" subtitle={`Version ${label(script.challenger_version_id)}`} tally={performance.experiment.byArm.challenger} tone="challenger" />
              </div>

              {(() => {
                const v = verdictCopy(comparison, performance.experiment.byArm.control.calls, performance.experiment.byArm.challenger.calls);
                const style =
                  v.tone === 'success'
                    ? 'border-success-500/30 bg-success-500/10'
                    : v.tone === 'warning'
                      ? 'border-warning-500/30 bg-warning-500/10'
                      : 'border-border bg-bg-tertiary';
                return (
                  <div className={`rounded-xl border px-4 py-3 text-sm text-text-primary ${style}`} role="status">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-primary" aria-hidden="true">
                      <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.round(comparison.sampleProgress * 100)}%` }} />
                    </div>
                    <p className="mt-2">{v.text}</p>
                  </div>
                );
              })()}

              <p className="flex items-start gap-2 text-xs text-text-secondary">
                <Info size={14} className="mt-0.5 shrink-0" />
                <span>
                  Counts only finished calls matched to this scenario by their detected intent. {performance.experiment.pending} still waiting to be saved ·{' '}
                  {performance.experiment.excluded} excluded (voicemail, spam, missed, or a different scenario). “Booked” means the call ended with a booking.
                </span>
              </p>
            </>
          ) : null}
        </div>
      )}

      {performance?.truncated && (
        <p role="status" className="flex items-start gap-2 text-xs text-warning-500">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          Only the most recent calls are included in these numbers.
        </p>
      )}

      {performance && Object.keys(performance.allTime.byVersion).length > 0 && (
        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <h3 className="text-base font-semibold text-text-primary">Results by version (all time)</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[420px] text-left text-sm">
              <thead>
                <tr className="text-xs text-text-secondary">
                  <th scope="col" className="py-2 pr-4 font-medium">Version</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Calls</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Booked</th>
                  <th scope="col" className="py-2 font-medium">Booking rate</th>
                </tr>
              </thead>
              <tbody>
                {versions
                  .filter((v) => performance.allTime.byVersion[v.id])
                  .map((v) => {
                    const t = performance.allTime.byVersion[v.id];
                    return (
                      <tr key={v.id} className="border-t border-border">
                        <td className="py-2 pr-4 text-text-primary">v{v.version_number}</td>
                        <td className="py-2 pr-4 text-text-primary">{t.calls}</td>
                        <td className="py-2 pr-4 text-text-primary">{t.booked}</td>
                        <td className="py-2 text-text-primary">{pct(rate(t))}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirm === 'stop'}
        title="Stop this A/B test?"
        description="All calls go back to the live version. The results collected so far stay in the version table."
        confirmLabel="Stop test"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          setConfirm(null);
          await onStop();
        }}
      />
      <ConfirmDialog
        open={confirm === 'promote'}
        title="Promote the challenger?"
        description="The challenger becomes the live version for every call and the A/B test ends."
        confirmLabel="Promote challenger"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          setConfirm(null);
          await onPromote();
        }}
      />
    </div>
  );
}
