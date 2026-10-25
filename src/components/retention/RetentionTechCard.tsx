import { useState } from 'react';
import { Check, ChevronDown, Lock, Snowflake, TrendingDown, TrendingUp, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useRetentionT } from '@/i18n/retentionNamespace';
import {
  formatTenure, formatUsd,
  type RetentionAction, type RetentionFreeze, type RetentionTech, type RiskBand, type TechRiskScore,
} from '@/lib/technicianRetention';

const BAND_STYLE: Record<RiskBand, { chip: string; bar: string }> = {
  high: { chip: 'bg-danger/10 text-danger', bar: 'bg-danger' },
  elevated: { chip: 'bg-warning-500/10 text-warning-500', bar: 'bg-warning-500' },
  low: { chip: 'bg-success-500/10 text-success-500', bar: 'bg-success-500' },
  insufficient: { chip: 'bg-bg-tertiary text-text-secondary', bar: 'bg-border' },
};

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 72;
  const h = 24;
  const max = Math.max(100, ...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / max) * h}`).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="text-accent">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface Props {
  score: TechRiskScore;
  tech: RetentionTech;
  history: number[];
  actions: RetentionAction[];
  freeze: RetentionFreeze | undefined;
  busyIds: Set<string>;
  onApprove: (action: RetentionAction, title: string, detail: string) => void;
  onDismiss: (action: RetentionAction) => void;
  onLift: (freeze: RetentionFreeze) => void;
}

export function RetentionTechCard({ score, tech, history, actions, freeze, busyIds, onApprove, onDismiss, onLift }: Props) {
  const { t, language } = useRetentionT();
  const [open, setOpen] = useState(score.risk_band === 'high');
  const style = BAND_STYLE[score.risk_band];
  const tenure = formatTenure(tech.tenureDays);
  const insufficient = score.risk_band === 'insufficient';
  const delta = score.score_delta;

  const driverText = (key: string, params: Record<string, number | string>, fallback: string) =>
    t(`drivers.${key}.text`, { ...params, defaultValue: fallback });
  const actionTitle = (a: RetentionAction) =>
    t(`actions.types.${a.action_type}.title`, { name: tech.name, defaultValue: a.title });
  const actionDetail = (a: RetentionAction) =>
    t(`actions.types.${a.action_type}.detail`, {
      name: tech.name, driver: driverText(a.driver_key, a.params, ''), defaultValue: a.detail,
    });

  const open_ = actions.filter((a) => a.status === 'suggested');
  const decided = actions.filter((a) => a.status === 'approved').slice(0, 3);
  const until = freeze
    ? new Intl.DateTimeFormat(language, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(freeze.ends_at))
    : '';

  return (
    <Card className="!p-4 sm:!p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-text-primary">{tech.name}</h2>
          <p className="text-xs text-text-secondary">{t(`tech.tenure_${tenure.unit}`, { count: tenure.value })}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${style.chip}`}>{t(`band.${score.risk_band}`)}</span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="col-span-2 sm:col-span-1">
          <p className="text-xs text-text-secondary">{t('tech.score')}</p>
          {insufficient ? (
            <p className="mt-1 text-sm text-text-secondary">—</p>
          ) : (
            <>
              <div className="mt-1 flex items-center gap-3">
                <span className="text-3xl font-bold tabular-nums text-text-primary">{score.score}</span>
                <Sparkline values={history} />
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary" role="img" aria-label={`${t('tech.score')}: ${score.score}/100`}>
                <div className={`h-full rounded-full ${style.bar}`} style={{ width: `${score.score}%` }} />
              </div>
              {delta !== null && (
                <p className="mt-1.5 flex items-center gap-1 text-xs text-text-secondary">
                  {delta > 0 ? <TrendingUp size={12} className="text-danger" /> : delta < 0 ? <TrendingDown size={12} className="text-success-500" /> : null}
                  {delta > 0 ? t('tech.trendUp', { n: delta }) : delta < 0 ? t('tech.trendDown', { n: Math.abs(delta) }) : t('tech.trendFlat')}
                </p>
              )}
            </>
          )}
        </div>
        <div>
          <p className="text-xs text-text-secondary">{t('tech.costIfLost')}</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-text-primary">{formatUsd(score.est_replacement_cost, language)}</p>
        </div>
        <div>
          <p className="text-xs text-text-secondary">{t('tech.expectedCost')}</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-text-primary">{formatUsd(score.expected_annual_cost, language)}</p>
        </div>
        <div className="col-span-2 flex items-end justify-end sm:col-span-1">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="focus-ring flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10"
          >
            {open ? t('tech.collapse') : t('tech.expand')}
            <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </div>

      {freeze && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-text-primary">
          <span className="flex items-center gap-2"><Snowflake size={14} className="text-accent" />{t('tech.frozen', { until })}</span>
          <Button variant="ghost" size="sm" disabled={busyIds.has(freeze.id)} onClick={() => onLift(freeze)}>
            <Lock size={14} />{t('tech.lift')}
          </Button>
        </div>
      )}

      {open && (
        <div className="mt-4 space-y-4 border-t border-border/70 pt-4">
          {insufficient ? (
            <p className="text-sm text-text-secondary">{t('tech.insufficientText')}</p>
          ) : (
            <section>
              <h3 className="mb-2 text-sm font-semibold text-text-primary">{t('tech.driversTitle')}</h3>
              {score.data_quality === 'limited' && (
                <p className="mb-2 text-xs text-text-secondary">{tech.tenureDays < 56 ? t('tech.newHire') : t('tech.provisional')}</p>
              )}
              {score.top_drivers.length === 0 ? (
                <p className="text-sm text-text-secondary">{t('tech.noDrivers')}</p>
              ) : (
                <ol className="space-y-2">
                  {score.top_drivers.map((d) => (
                    <li key={d.key} className="rounded-xl border border-border/70 bg-bg-tertiary/40 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-medium text-text-primary">{t(`drivers.${d.key}.name`, { defaultValue: d.key })}</span>
                        <span className="shrink-0 text-xs font-semibold tabular-nums text-accent">{t('tech.points', { points: d.points })}</span>
                      </div>
                      <p className="mt-1 text-sm text-text-secondary">{driverText(d.key, d.params, d.message)}</p>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}

          <section>
            <h3 className="mb-2 text-sm font-semibold text-text-primary">{t('actions.title')}</h3>
            {open_.length === 0 && decided.length === 0 && <p className="text-sm text-text-secondary">{t('actions.none')}</p>}
            <ul className="space-y-2">
              {open_.map((a) => {
                const title = actionTitle(a);
                const detail = actionDetail(a);
                const busy = busyIds.has(a.id);
                return (
                  <li key={a.id} className="rounded-xl border border-border p-3">
                    <p className="text-sm font-semibold text-text-primary">{title}</p>
                    <p className="mt-1 text-sm text-text-secondary">{detail}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button size="sm" disabled={busy} onClick={() => onApprove(a, title, detail)}><Check size={16} />{t('actions.approve')}</Button>
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDismiss(a)}><X size={16} />{t('actions.dismiss')}</Button>
                    </div>
                  </li>
                );
              })}
              {decided.map((a) => (
                <li key={a.id} className="rounded-xl border border-border/70 bg-bg-tertiary/40 p-3">
                  <p className="flex items-center gap-2 text-sm font-medium text-text-primary"><Check size={14} className="text-success-500" />{actionTitle(a)}</p>
                  <p className="mt-1 text-xs text-text-secondary">
                    {a.outcome
                      ? t(`actions.outcome.${a.outcome}`, { before: a.baseline_score ?? '—', after: a.score_after ?? '—' })
                      : t('actions.measuring')}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Card>
  );
}
