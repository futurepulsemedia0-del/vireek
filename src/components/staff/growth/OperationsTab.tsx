import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useGrowthT } from '@/i18n/growthNamespace';
import { acknowledgeAlert, fetchAlerts, fetchDataQuality, fetchReconciliation, runReconciliation, setAlertRule, type AlertRule } from '@/lib/growth/growthApi';
import { AsyncBoundary, DataTable, Notice, SectionTitle, Td, useAsync, useFormatters } from './growthShared';

export function OperationsTab() {
  const { t } = useGrowthT();
  const f = useFormatters();
  const alerts = useAsync(fetchAlerts, 'alerts');
  const dq = useAsync(fetchDataQuality, 'dq');
  const rec = useAsync(fetchReconciliation, 'rec');
  const [busy, setBusy] = useState(false);
  const [recErr, setRecErr] = useState(false);

  const run = async () => {
    setBusy(true);
    setRecErr(false);
    try {
      await runReconciliation();
      rec.reload();
    } catch {
      setRecErr(true);
    } finally {
      setBusy(false);
    }
  };
  const bad = (k: string, v: number | boolean | string): boolean => {
    if (k === 'has_subscription_created_events') return v === false;
    if (typeof v === 'number') return !['subscription_events_total_90d', 'distinct_currencies'].includes(k) && v > 0;
    return false;
  };

  return (
    <div className="space-y-8">
      <section aria-labelledby="g-alerts" className="space-y-3">
        <SectionTitle id="g-alerts" hint={t('ops.alertsHint')}>{t('ops.alerts')}</SectionTitle>
        <AsyncBoundary state={alerts}>
          {(d) => (
            <div className="space-y-4">
              {d.events.filter((e) => !e.acknowledgedAt).length === 0 ? <Notice>{t('ops.noOpenAlerts')}</Notice> : (
                <DataTable caption={t('ops.alerts')} head={[t('ops.rule'), t('ops.value'), t('ops.firedAt'), t('common.actions')]}>
                  {d.events.filter((e) => !e.acknowledgedAt).map((e) => (
                    <tr key={e.id}>
                      <Td>{d.rules.find((r) => r.key === e.ruleKey)?.description ?? e.ruleKey}</Td>
                      <Td>{e.value ?? '—'}</Td>
                      <Td>{e.firedAt ? f.date(e.firedAt) : '—'}</Td>
                      <Td><Button size="xs" variant="secondary" onClick={async () => { await acknowledgeAlert(e.id); alerts.reload(); }}>{t('ops.acknowledge')}</Button></Td>
                    </tr>
                  ))}
                </DataTable>
              )}
              <h3 className="text-sm font-semibold text-text-primary">{t('ops.rules')}</h3>
              <DataTable caption={t('ops.rules')} head={[t('ops.rule'), t('ops.threshold'), t('ops.enabled'), t('common.actions')]}>
                {d.rules.map((r) => <RuleRow key={r.key} rule={r} onSaved={alerts.reload} />)}
              </DataTable>
            </div>
          )}
        </AsyncBoundary>
      </section>

      <section aria-labelledby="g-dq" className="space-y-3">
        <SectionTitle id="g-dq" hint={t('ops.dqHint')}>{t('ops.dq')}</SectionTitle>
        <AsyncBoundary state={dq}>
          {(d) => (
            <DataTable caption={t('ops.dq')} head={[t('ops.check'), t('ops.value'), t('ops.status')]}>
              {Object.entries(d).filter(([k]) => k !== 'generated_at').map(([k, v]) => (
                <tr key={k}>
                  <Td>{t(`dq.${k}`, { defaultValue: k })}</Td>
                  <Td>{String(v)}</Td>
                  <Td>{k === 'stripe_live_reconciliation' ? t('ops.seeBelow') : bad(k, v) ? t('ops.needsAttention') : t('ops.ok')}</Td>
                </tr>
              ))}
            </DataTable>
          )}
        </AsyncBoundary>
      </section>

      <section aria-labelledby="g-rec" className="space-y-3">
        <SectionTitle id="g-rec" hint={t('ops.recHint')}>{t('ops.rec')}</SectionTitle>
        <Button size="sm" onClick={run} loading={busy}>{t('ops.runRec')}</Button>
        {recErr && <p role="alert" className="text-xs text-danger">{t('ops.recFailed')}</p>}
        <AsyncBoundary state={rec}>
          {(r) => r === null ? <Notice>{t('ops.noRec')}</Notice> : (
            <div className="space-y-3">
              <p className="text-sm text-text-primary">
                {t('ops.recSummary', { when: r.ranAt ? f.date(r.ranAt) : '—', n: r.stripeSubscriptions, m: r.mismatches })}
              </p>
              {!r.complete && <Notice>{t('ops.recTruncated')}</Notice>}
              {r.details.length > 0 && (
                <DataTable caption={t('ops.rec')} head={[t('ops.kind'), t('ops.subscription'), t('ops.stripeSide'), t('ops.factSide'), t('ops.explained')]}>
                  {r.details.map((d) => (
                    <tr key={`${d.kind}-${d.subscriptionId}`}>
                      <Td>{t(`ops.kinds.${d.kind}`, { defaultValue: d.kind })}</Td>
                      <Td><code className="text-xs">{d.subscriptionId}</code></Td>
                      <Td>{d.stripeStatus ?? '—'} · {d.stripeMrr ?? '—'}</Td>
                      <Td>{d.factStatus ?? '—'} · {d.factMrr ?? '—'}</Td>
                      <Td>{d.explained ? t('ops.yes') : t('ops.no')}</Td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </div>
          )}
        </AsyncBoundary>
      </section>
    </div>
  );
}

function RuleRow({ rule, onSaved }: { rule: AlertRule; onSaved: () => void }) {
  const { t } = useGrowthT();
  const [threshold, setThreshold] = useState(String(rule.threshold));
  const [enabled, setEnabled] = useState(rule.enabled);
  const [busy, setBusy] = useState(false);
  const valid = threshold !== '' && Number(threshold) >= 0;
  return (
    <tr>
      <Td>{rule.description}</Td>
      <Td>
        <label className="sr-only" htmlFor={`thr-${rule.key}`}>{t('ops.threshold')} {rule.key}</label>
        <input id={`thr-${rule.key}`} inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} aria-invalid={!valid} className="focus-ring w-20 rounded-lg border border-border bg-bg-secondary px-2 py-1 text-sm text-text-primary" />
      </Td>
      <Td>
        <input id={`en-${rule.key}`} type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <label htmlFor={`en-${rule.key}`} className="ms-2 text-xs">{t('ops.enabled')}</label>
      </Td>
      <Td>
        <Button size="xs" variant="secondary" loading={busy} disabled={!valid} onClick={async () => { setBusy(true); try { await setAlertRule(rule.key, enabled, Number(threshold)); onSaved(); } finally { setBusy(false); } }}>
          {t('common.save')}<span className="sr-only"> {rule.key}</span>
        </Button>
      </Td>
    </tr>
  );
}
