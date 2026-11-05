import { useState } from 'react';
import { RefreshCw, Square, Trophy, Loader2, Info } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useAutopilotT } from '@/i18n/autopilotNamespace';
import {
  GUARDRAIL_IDS, lookThresholds,
  type MetricId, type VoiceExperiment, type VoiceExperimentLook,
} from '@/lib/voiceAutopilot';
import { wilsonInterval } from '@/lib/callScripts';
import { formatEffect, formatRate, unitOf } from './format';

export interface ArmCounts { calls: number; booked: number }
interface Props {
  experiment: VoiceExperiment;
  looks: VoiceExperimentLook[];
  control: ArmCounts;
  challenger: ArmCounts;
  pending: number;
  excluded: number;
  versionLabel: (id: string) => string;
  busy: boolean;
  evaluating: boolean;
  onEvaluate: () => void;
  onStop: () => Promise<void>;
  onApprove: () => Promise<void>;
}

function Arm({ title, subtitle, tally, tone }: { title: string; subtitle: string; tally: ArmCounts; tone: 'control' | 'challenger' }) {
  const { t } = useAutopilotT();
  const ci = wilsonInterval(tally.booked, tally.calls);
  const r = tally.calls > 0 ? tally.booked / tally.calls : null;
  return (
    <div className={`rounded-2xl border p-5 ${tone === 'challenger' ? 'border-accent/40 bg-accent/5' : 'border-border bg-bg-secondary'}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{title}</p>
      <p className="mt-0.5 text-sm text-text-primary">{subtitle}</p>
      <p className="mt-3 text-3xl font-bold text-text-primary">{formatRate(r)}</p>
      <p className="text-xs text-text-secondary">{t('live.rate')}</p>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
        <div><dt className="text-xs text-text-secondary">{t('common.calls')}</dt><dd className="font-semibold text-text-primary">{tally.calls}</dd></div>
        <div><dt className="text-xs text-text-secondary">{t('common.booked')}</dt><dd className="font-semibold text-text-primary">{tally.booked}</dd></div>
      </dl>
      {ci && <p className="mt-2 text-xs text-text-secondary">{t('live.range', { low: formatRate(ci.low), high: formatRate(ci.high) })}</p>}
    </div>
  );
}

export function LiveExperimentCard({ experiment: e, looks, control, challenger, pending, excluded, versionLabel, busy, evaluating, onEvaluate, onStop, onApprove }: Props) {
  const { t } = useAutopilotT();
  const [confirm, setConfirm] = useState(false);
  const thresholds = lookThresholds(e.prereg.nMaxPerArm);
  const nMin = Math.min(control.calls, challenger.calls);
  const progress = Math.min(1, nMin / e.prereg.nMaxPerArm);
  const lastLook = looks[looks.length - 1] ?? null;
  const guardrails = lastLook?.result.guardrails ?? [];
  const metric = e.prereg.primaryMetric as MetricId;
  const reasonText = (code: string): string => {
    const [base, arg] = code.split(':');
    return t(`reason.${base}`, { defaultValue: code, metric: arg ? t(`metric.${arg}`, { defaultValue: arg }) : '' });
  };

  return (
    <section aria-labelledby="live-exp-title" className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 id="live-exp-title" className="text-base font-semibold text-text-primary">{t('live.title', { name: e.name })}</h3>
          <p className="text-xs text-text-secondary">
            {t('live.versions', { a: versionLabel(e.control_version_id), b: versionLabel(e.challenger_version_id) })} · {t(`dimension.${e.dimension}`)} · {t('live.since', { date: new Date(e.started_at).toLocaleDateString() })}
          </p>
          <p className="text-xs text-text-secondary">{t(`metric.${metric}`)} · {e.traffic_pct}%</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onEvaluate} disabled={evaluating}>
            <RefreshCw size={15} className={evaluating ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden="true" />
            {evaluating ? t('live.evaluating') : t('live.evaluate')}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => setConfirm(true)} disabled={busy}>
            <Square size={15} aria-hidden="true" />
            {t('live.stop')}
          </Button>
        </div>
      </div>

      {e.status === 'awaiting_approval' && (
        <div role="status" className="rounded-xl border border-success-500/30 bg-success-500/10 px-4 py-3 text-sm text-text-primary">
          <p className="font-semibold">{t('live.approvalTitle')}</p>
          <p className="mt-1 text-text-secondary">{t('live.approvalBody')}</p>
          <div className="mt-3">
            <Button type="button" size="sm" onClick={onApprove} disabled={busy}>
              {busy ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Trophy size={15} aria-hidden="true" />}
              {busy ? t('live.approving') : t('live.approve')}
            </Button>
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Arm title={t('live.control')} subtitle={`v${versionLabel(e.control_version_id)}`} tally={control} tone="control" />
        <Arm title={t('live.challenger')} subtitle={`v${versionLabel(e.challenger_version_id)}`} tally={challenger} tone="challenger" />
      </div>

      <div className="rounded-xl border border-border bg-bg-tertiary px-4 py-3 text-sm text-text-primary" role="status">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-primary" role="progressbar" aria-valuemin={0} aria-valuemax={e.prereg.nMaxPerArm} aria-valuenow={Math.min(nMin, e.prereg.nMaxPerArm)} aria-label={t('live.progress', { n: nMin, target: e.prereg.nMaxPerArm })}>
          <div className="h-full rounded-full bg-accent transition-all motion-reduce:transition-none" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <p className="mt-2">{t('live.progress', { n: nMin, target: e.prereg.nMaxPerArm })}</p>
        <p className="mt-1 text-xs text-text-secondary">{t('live.descriptiveNote')}</p>
      </div>

      <div className="rounded-2xl border border-border bg-bg-secondary p-5">
        <h4 className="text-sm font-semibold text-text-primary">{t('live.checkpoints')}</h4>
        <ol className="mt-2 space-y-2 text-sm">
          {thresholds.map((n, i) => {
            const done = looks.find((l) => l.look === i + 1);
            const isNext = !done && i === e.last_look_done;
            return (
              <li key={n + '-' + i} className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 first:border-t-0 first:pt-0">
                <span className="text-text-primary">{t('live.checkpointRow', { i: i + 1, n })}</span>
                <span className="text-xs text-text-secondary">
                  {done ? t('live.checkpointDone', { decision: t(`decision.${done.decision}`, { defaultValue: done.decision }) }) : isNext ? t('live.checkpointNext') : t('live.checkpointPending')}
                </span>
              </li>
            );
          })}
        </ol>
        {lastLook?.result.look && lastLook.result.primary.diff && (
          <p className="mt-3 text-sm text-text-primary">
            {t('live.intervalLabel', {
              estimate: formatEffect(metric, lastLook.result.primary.diff.estimate),
              low: formatEffect(metric, lastLook.result.look.rci.low),
              high: formatEffect(metric, lastLook.result.look.rci.high),
            })}{' '}
            <span className="text-xs text-text-secondary">({unitOf(metric)})</span>
          </p>
        )}
        {lastLook && <p className="mt-1 text-xs text-text-secondary">{t('live.intervalNote')}</p>}
        {lastLook && lastLook.result.reasons.length > 0 && (
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-text-secondary">
            {lastLook.result.reasons.map((r) => (<li key={r}>{reasonText(r)}</li>))}
          </ul>
        )}
      </div>

      <div className="rounded-2xl border border-border bg-bg-secondary p-5">
        <h4 className="text-sm font-semibold text-text-primary">{t('guardrail.title')}</h4>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[420px] text-left text-sm">
            <thead><tr className="text-xs text-text-secondary"><th scope="col" className="py-2 pr-4 font-medium">{t('guardrail.title')}</th><th scope="col" className="py-2 font-medium">{t('common.none')}</th></tr></thead>
            <tbody>
              {GUARDRAIL_IDS.map((id) => {
                const waived = (e.prereg.waivedGuardrails ?? []).includes(id);
                const g = guardrails.find((x) => x.metric === id);
                const status = waived && !g ? 'waived' : g?.status ?? 'pending';
                const tone = status === 'pass' ? 'text-success-500' : status === 'breach' || status === 'fail_promote' ? 'text-danger' : 'text-text-secondary';
                return (
                  <tr key={id} className="border-t border-border">
                    <td className="py-2 pr-4 text-text-primary">{t(`metric.${id}`)}</td>
                    <td className={`py-2 ${tone}`}>
                      {t(`guardrail.${status}`)}
                      {g && g.harm !== null && g.status !== 'waived' ? <span className="block text-xs text-text-secondary">{t('guardrail.harm', { harm: formatEffect(id, g.harm, false), margin: formatEffect(id, g.margin, false) })}</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="flex items-start gap-2 text-xs text-text-secondary">
        <Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>{t('live.pending', { n: pending, m: excluded })}</span>
      </p>

      <ConfirmDialog open={confirm} title={t('live.stopTitle')} description={t('live.stopBody')} confirmLabel={t('live.stopConfirm')} onCancel={() => setConfirm(false)} onConfirm={async () => { setConfirm(false); await onStop(); }} />
    </section>
  );
}
