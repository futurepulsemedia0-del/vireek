// Recreated: verify against original intent
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, Lock, ShieldCheck, Target, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Panel } from '@/components/ui/Panel';
import { EmptyState } from '@/components/EmptyState';
import { OperatorPanel } from '@/components/operator/OperatorPanel';
import { useToast } from '@/contexts/ToastContext';
import { useChiefT } from '@/i18n/chiefOfStaffNamespace';
import {
  claimRecommendation,
  formatUsdFromCents,
  impactView,
  resolveRecommendation,
  trustTests,
  type Recommendation,
} from '@/lib/chiefOfStaff';

interface Props {
  recs: Recommendation[];
  moreCount: number;
  canAct: boolean;
  onChanged: () => void;
}

/** Only same-origin app paths may be navigated to; the href comes from the server and is never trusted blindly. */
function safeInternalPath(href: string | null): string | null {
  if (!href) return null;
  return href.startsWith('/') && !href.startsWith('//') && !href.includes('\\') ? href : null;
}

export function TopActions({ recs, moreCount, canAct, onChanged }: Props) {
  const { t } = useChiefT();

  return (
    <Panel title={t('actions.title')} aria-label={t('actions.title')}>
      <p className="mb-4 text-xs text-text-secondary">{t('actions.subtitle')}</p>

      {recs.length === 0 ? (
        <EmptyState compact icon={Target} title={t('actions.empty.title')} description={t('actions.empty.body')} />
      ) : (
        <ol className="space-y-4">
          {recs.map((rec) => (
            <RecommendationCard key={rec.id} rec={rec} canAct={canAct} onChanged={onChanged} />
          ))}
        </ol>
      )}

      {moreCount > 0 && <p className="mt-4 text-xs text-text-secondary">{t('actions.more', { count: moreCount })}</p>}
    </Panel>
  );
}

function RecommendationCard({ rec, canAct, onChanged }: { rec: Recommendation; canAct: boolean; onChanged: () => void }) {
  const { t, language } = useChiefT();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<null | 'claim' | 'done' | 'release' | 'dismiss'>(null);
  const [planning, setPlanning] = useState(false);
  const lock = useRef(false); // synchronous: two clicks in the same tick cannot start two requests

  const trust = trustTests(rec);
  const impact = impactView(rec);
  const href = safeInternalPath(rec.action_href);
  const command = rec.action_kind === 'operator_command' ? rec.action_command?.trim() || null : null;

  const impactText =
    impact.kind === 'none'
      ? t('rec.impactNone')
      : impact.kind === 'point'
        ? t('rec.impactPoint', { value: formatUsdFromCents(impact.cents, language) })
        : t('rec.impactRange', { low: formatUsdFromCents(impact.low, language), high: formatUsdFromCents(impact.high, language) });

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(kind);
    try {
      await fn();
    } catch {
      toast(t('rec.actionFailed'), 'error');
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  const takeOn = () =>
    run('claim', async () => {
      const res = await claimRecommendation(rec.id);
      if (!res.claimed) {
        toast(t('rec.claimFailed'), 'error');
        onChanged();
        return;
      }
      if (command) {
        setPlanning(true);
        onChanged();
      } else if (href) {
        onChanged();
        navigate(href);
      } else {
        onChanged();
      }
    });

  const resolve = (kind: 'done' | 'release' | 'dismiss', outcome: 'executed' | 'released' | 'dismissed', message: string) =>
    run(kind, async () => {
      const res = await resolveRecommendation(rec.id, outcome);
      if (!res.ok) {
        toast(t('rec.actionFailed'), 'error');
      } else {
        toast(message, 'success');
        setPlanning(false);
      }
      onChanged();
    });

  const takeOnLabel = command ? t('rec.runCommand') : href ? t('rec.takeOnOpen') : t('rec.takeOn');

  return (
    <li className="rounded-xl border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
            <span className="rounded-full bg-bg-tertiary px-2 py-0.5">{t(`rec.kind.${rec.kind}`)}</span>
            <span>{t(`rec.engine.${rec.source_engine}`, { defaultValue: rec.source_engine })}</span>
          </div>
          <h3 className="mt-1.5 text-base font-semibold text-text-primary">{rec.title}</h3>
        </div>
        {canAct && !rec.claimed_by_other && (
          <button
            type="button"
            onClick={() => void resolve('dismiss', 'dismissed', t('rec.dismissedToast'))}
            disabled={busy !== null}
            aria-label={t('rec.dismissAria', { title: rec.title })}
            className="focus-ring shrink-0 rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </div>

      <dl className="mt-3 space-y-3 text-sm">
        <div>
          <dt className="text-xs font-semibold text-text-secondary">{t('rec.why')}</dt>
          <dd className="mt-0.5 text-text-primary">{rec.why_it_matters}</dd>
        </div>

        {rec.evidence.length > 0 && (
          <div>
            <dt className="text-xs font-semibold text-text-secondary">{t('rec.evidence')}</dt>
            <dd>
              <ul className="mt-0.5 list-disc space-y-0.5 ps-5 text-xs text-text-secondary">
                {rec.evidence.map((e, i) => (
                  <li key={`${e.source_table}:${e.ref}:${i}`}>
                    {t('rec.evidenceItem', { metric: e.metric, value: e.value, table: e.source_table, ref: e.ref })}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-xs font-semibold text-text-secondary">{t('rec.impact')}</dt>
            <dd className="mt-0.5 text-text-primary">{impactText}</dd>
            {impact.kind === 'point' && <dd className="text-[11px] text-text-secondary">{t('rec.impactPointNote')}</dd>}
            {rec.impact_basis && <dd className="text-[11px] text-text-secondary">{rec.impact_basis}</dd>}
          </div>
          <div>
            <dt className="text-xs font-semibold text-text-secondary">{t('rec.confidence')}</dt>
            <dd className="mt-0.5 text-text-primary">
              {rec.confidence === null ? t('rec.confidenceNone') : t('rec.confidenceValue', { value: Math.round(rec.confidence * 100) })}
            </dd>
            {rec.confidence_basis && <dd className="text-[11px] text-text-secondary">{rec.confidence_basis}</dd>}
          </div>
          <div>
            <dt className="text-xs font-semibold text-text-secondary">{t('rec.owner')}</dt>
            <dd className="mt-0.5 text-text-primary">{t(`rec.role.${rec.owner_role}`)}</dd>
          </div>
        </div>
      </dl>

      <div className="mt-3 rounded-lg bg-bg-tertiary/60 px-3 py-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">{t('rec.trust.title')}</p>
        <ul className="mt-1 space-y-0.5 text-xs text-text-secondary">
          <TrustLine ok={trust.showsReasoning} label={t('rec.trust.reasoning')} />
          <TrustLine ok={trust.asksBeforeActing} label={t('rec.trust.asks')} />
          <TrustLine ok={trust.usesExistingTools} label={t('rec.trust.tools')} />
        </ul>
      </div>

      {planning && command && rec.claimed_by_me && (
        <div className="mt-3 overflow-hidden rounded-lg border border-border">
          <OperatorPanel
            instruction={command}
            onBack={() => void resolve('release', 'released', t('rec.releasedToast'))}
            onClose={() => void resolve('done', 'executed', t('rec.doneToast'))}
          />
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {!canAct ? (
          <p className="flex items-center gap-1.5 text-xs text-text-secondary">
            <Lock size={13} aria-hidden="true" />
            {t('rec.noAct')}
          </p>
        ) : rec.claimed_by_other ? (
          <p role="status" className="text-xs text-text-secondary">{t('rec.claimedByOther')}</p>
        ) : rec.claimed_by_me ? (
          <>
            <p role="status" className="me-auto text-xs text-text-secondary">
              <span className="font-semibold text-text-primary">{t('rec.inProgress')}</span> · {t('rec.inProgressHint')}
            </p>
            {href && !command && (
              <Button size="sm" variant="secondary" onClick={() => navigate(href)}>
                {t('rec.open')}
              </Button>
            )}
            {command && !planning && (
              <Button size="sm" variant="secondary" onClick={() => setPlanning(true)}>
                {t('rec.open')}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => void resolve('release', 'released', t('rec.releasedToast'))} loading={busy === 'release'} disabled={busy !== null}>
              {t('rec.release')}
            </Button>
            <Button size="sm" onClick={() => void resolve('done', 'executed', t('rec.doneToast'))} loading={busy === 'done'} disabled={busy !== null}>
              <CheckCircle2 size={14} aria-hidden="true" />
              {t('rec.markDone')}
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={() => void takeOn()} loading={busy === 'claim'} disabled={busy !== null}>
            {takeOnLabel}
          </Button>
        )}
      </div>
    </li>
  );
}

function TrustLine({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <ShieldCheck size={12} aria-hidden="true" className={ok ? 'text-success-500' : 'text-text-secondary/50'} />
      <span className={ok ? '' : 'line-through opacity-70'}>{label}</span>
    </li>
  );
}
