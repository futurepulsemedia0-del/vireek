import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertOctagon, AlertTriangle, CheckCircle2, ClipboardList, ExternalLink, Info, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { EmptyState } from '@/components/EmptyState';
import { Stat } from '@/components/workorderguard/shared';
import { fetchCatalog, type RuleVersion } from '@/lib/complianceRules';
import {
  applyLineFix,
  checkBeforeSending,
  moneyAtRisk,
  orderToFmFacts,
  suggestRuleCandidates,
  type FixItem,
  type FmFix,
  type RiskBucket,
} from '@/lib/fmCheck';
import { formatUsd, type PortalRules, type WorkOrder } from '@/lib/workOrderGuard';
import { useFmcheckT } from '@/i18n/fmcheckNamespace';

type Billing = '' | 'portal' | 'customer';
type Tone = { box: string; Icon: typeof Info };
const TONES: Record<FixItem['severity'], Tone> = {
  block: { box: 'border-danger-500/40 bg-danger-500/10', Icon: AlertOctagon },
  require: { box: 'border-warning-500/40 bg-warning-500/10', Icon: AlertTriangle },
  warn: { box: 'border-warning-500/40 bg-warning-500/10', Icon: AlertTriangle },
  info: { box: 'border-border bg-bg-secondary', Icon: Info },
};
const orderKey = (o: WorkOrder): string => o.id ?? o.woNumber;

export function FmCheckPanel({ orders, rules, timezone }: { orders: WorkOrder[]; rules: PortalRules; timezone: string }) {
  const { t } = useFmcheckT();
  const [state, setState] = useState<{ status: 'loading' | 'error' | 'ready'; catalog: RuleVersion[] }>({ status: 'loading', catalog: [] });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, status: 'loading' }));
    try { setState({ status: 'ready', catalog: await fetchCatalog() }); }
    catch { setState({ status: 'error', catalog: [] }); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (state.status === 'loading') return <p className="text-sm text-text-secondary" role="status">{t('check.loading')}</p>;
  if (state.status === 'error') return <EmptyState icon={ShieldAlert} variant="load-failed" title={t('check.loadFailed')} action={{ label: t('check.retry'), onClick: () => { void load(); } }} />;

  return (
    <div className="space-y-8">
      <PreSendCheck orders={orders} catalog={state.catalog} timezone={timezone} />
      <RiskView orders={orders} rules={rules} timezone={timezone} />
      <CandidatesView orders={orders} catalog={state.catalog} />
    </div>
  );
}

// ------------------------------------------------------------------ Fix before sending

function PreSendCheck({ orders, catalog, timezone }: { orders: WorkOrder[]; catalog: RuleVersion[]; timezone: string }) {
  const { t } = useFmcheckT();
  const candidates = useMemo(() => orders.filter((o) => o.outcome === 'open').sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)), [orders]);
  const [key, setKey] = useState('');
  const [billing, setBilling] = useState<Billing>('');
  const [hasSub, setHasSub] = useState(false);
  const [subAttached, setSubAttached] = useState(false);
  const [edit, setEdit] = useState<{ forKey: string; lines: ReturnType<typeof orderToFmFacts>['lineItems']; total: number | null } | null>(null);
  const [notice, setNotice] = useState('');

  const order = candidates.find((o) => orderKey(o) === key) ?? null;
  const base = useMemo(
    () => (order ? orderToFmFacts(order, { timezone, billingParty: billing || null, hasSubcontractor: hasSub, attachments: subAttached ? ['subcontractor_invoice'] : [] }) : null),
    [order, timezone, billing, hasSub, subAttached],
  );
  const facts = base && edit && edit.forKey === key ? { ...base, lineItems: edit.lines, totalCents: edit.total } : base;
  const result = useMemo(() => (facts ? checkBeforeSending(facts, catalog) : null), [facts, catalog]);

  const apply = (fix: FmFix) => {
    if (!facts?.lineItems) return;
    const idx = typeof fix.params?.index === 'number' ? fix.params.index : -1;
    const removed = facts.lineItems[idx];
    const lines = applyLineFix(facts.lineItems, fix);
    if (!removed || lines.length === facts.lineItems.length) return;
    setEdit({ forKey: key, lines, total: facts.totalCents == null ? null : Math.max(0, facts.totalCents - removed.amountCents) });
    setNotice(t('check.lineRemoved'));
  };

  const field = 'focus-ring mt-1 block w-full max-w-xs rounded-xl border border-border bg-bg-primary px-3 py-3 text-base text-text-primary';
  return (
    <section aria-labelledby="fm-check-h" className="space-y-4">
      <div>
        <h2 id="fm-check-h" className="text-lg font-semibold text-text-primary">{t('check.title')}</h2>
        <p className="mt-1 text-sm text-text-secondary">{t('check.intro')}</p>
      </div>
      {candidates.length === 0 ? (
        <EmptyState icon={ClipboardList} variant="no-data" title={t('check.noOrders')} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs font-medium text-text-secondary">{t('check.orderLabel')}
              <select className={field} value={key} onChange={(e) => { setKey(e.target.value); setEdit(null); setNotice(''); }}>
                <option value="">{t('check.orderPlaceholder')}</option>
                {candidates.map((o) => <option key={orderKey(o)} value={orderKey(o)}>{o.woNumber}</option>)}
              </select>
            </label>
            <label className="block text-xs font-medium text-text-secondary">{t('check.billingLabel')}
              <select className={field} value={billing} onChange={(e) => setBilling(e.target.value as Billing)}>
                <option value="">{t('check.billingUnknown')}</option>
                <option value="portal">{t('check.billingPortal')}</option>
                <option value="customer">{t('check.billingCustomer')}</option>
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <label className="flex min-h-[44px] items-center gap-2 text-sm text-text-primary">
              <input type="checkbox" className="h-5 w-5 accent-accent" checked={hasSub} onChange={(e) => { setHasSub(e.target.checked); if (!e.target.checked) setSubAttached(false); }} />{t('check.subcontractor')}
            </label>
            {hasSub && (
              <label className="flex min-h-[44px] items-center gap-2 text-sm text-text-primary">
                <input type="checkbox" className="h-5 w-5 accent-accent" checked={subAttached} onChange={(e) => setSubAttached(e.target.checked)} />{t('check.subInvoiceAttached')}
              </label>
            )}
          </div>
        </>
      )}

      <p className="sr-only" role="status" aria-live="polite">{notice}</p>

      {result && facts && (
        <div className="space-y-3">
          <p className="text-xs text-text-secondary">{t('check.draftNote')}{facts.totalCents != null ? ` ${t('check.draftTotal', { amount: formatUsd(facts.totalCents) })}` : ''}</p>
          {result.noActiveRules ? (
            <p className="rounded-xl border border-border bg-bg-secondary px-3 py-3 text-sm text-text-secondary" role="status">{t('check.noActiveRules')}</p>
          ) : (
            <p className="flex items-center gap-2 text-sm font-semibold text-text-primary" role="status">
              {result.outcome === 'allow' && <CheckCircle2 size={18} className="text-success-500" aria-hidden="true" />}
              {t(`check.outcome.${result.outcome}`, { count: result.passed })}
            </p>
          )}
          <ul className="space-y-2">
            {result.items.map((it) => <FixRow key={it.versionId} item={it} onApply={apply} />)}
          </ul>
        </div>
      )}
    </section>
  );
}

function FixRow({ item, onApply }: { item: FixItem; onApply: (fix: FmFix) => void }) {
  const { t } = useFmcheckT();
  const tone = TONES[item.severity];
  return (
    <li className={`rounded-xl border px-3 py-3 ${tone.box}`}>
      <p className="flex items-start gap-2 text-sm font-semibold text-text-primary">
        <tone.Icon size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span><span className="text-xs font-medium uppercase tracking-wide text-text-secondary">{t(`check.severity.${item.severity}`)}</span><br />{item.title}</span>
      </p>
      <p className="mt-1 text-sm text-text-primary">{item.message}</p>
      <ul className="mt-2 space-y-1">
        {item.fixes.map((f, i) => (
          <li key={`${f.kind}-${i}`} className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
            <span>{t(`check.fix.${f.kind}`)}</span>
            {f.oneClick && <Button type="button" size="xs" variant="secondary" onClick={() => onApply(f)}>{t('check.removeLine')}</Button>}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-text-secondary">
        {item.sourceRefs.map((s, i) => (
          <span key={`${s.citation}-${i}`} className="mr-3 inline-flex flex-wrap items-center gap-1">
            {t('check.source')}: {s.url?.startsWith('https://')
              ? <a className="focus-ring inline-flex items-center gap-1 underline" href={s.url} target="_blank" rel="noopener noreferrer">{s.citation}<ExternalLink size={12} aria-hidden="true" /></a>
              : s.citation}
            {s.retrievedOn ? ` (${t('check.retrieved', { date: s.retrievedOn })})` : ''}
          </span>
        ))}
      </p>
    </li>
  );
}

// ------------------------------------------------------------------ Money at risk

function RiskView({ orders, rules, timezone }: { orders: WorkOrder[]; rules: PortalRules; timezone: string }) {
  const { t } = useFmcheckT();
  const m = useMemo(() => moneyAtRisk(orders, rules, timezone), [orders, rules, timezone]);
  return (
    <section aria-labelledby="fm-risk-h" className="space-y-4">
      <div>
        <h2 id="fm-risk-h" className="text-lg font-semibold text-text-primary">{t('risk.title')}</h2>
        <p className="mt-1 text-sm text-text-secondary">{t('risk.intro')}</p>
      </div>
      {m.items.length === 0 ? (
        <p className="text-sm text-text-secondary">{t('risk.empty')}</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label={t('risk.measured')} value={formatUsd(m.measuredCents)} />
            <Stat label={t('risk.estimated')} value={formatUsd(m.estimatedCents)} />
            <Stat label={t('risk.unknown')} value={String(m.unknownCount)} hint={m.unknownCount > 0 ? t('risk.unknownHint', { count: m.unknownCount }) : undefined} />
          </div>
          <ul className="space-y-2">
            {m.items.map((i) => (
              <li key={`${i.orderId ?? i.woNumber}-${i.bucket}`} className="rounded-xl border border-border bg-bg-secondary px-3 py-3 text-sm">
                <p className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold text-text-primary">{i.woNumber} · {t(`risk.bucket.${i.bucket satisfies RiskBucket}`)}</span>
                  <span className="text-text-primary">{i.amountCents != null ? formatUsd(i.amountCents) : '—'} <span className="text-xs text-text-secondary">({t(`risk.basis.${i.basis}`)})</span></span>
                </p>
                <p className="text-xs text-text-secondary">{i.detail}{i.deadline ? ` · ${t('risk.deadline', { date: i.deadline })}` : ''}{i.counted ? '' : ` · ${t('risk.notCounted')}`}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ Rejection patterns

function CandidatesView({ orders, catalog }: { orders: WorkOrder[]; catalog: RuleVersion[] }) {
  const { t } = useFmcheckT();
  const list = useMemo(() => suggestRuleCandidates(orders, catalog), [orders, catalog]);
  return (
    <section aria-labelledby="fm-cand-h" className="space-y-4">
      <div>
        <h2 id="fm-cand-h" className="text-lg font-semibold text-text-primary">{t('candidates.title')}</h2>
        <p className="mt-1 text-sm text-text-secondary">{t('candidates.intro')}</p>
      </div>
      {list.length === 0 ? (
        <p className="text-sm text-text-secondary">{t('candidates.empty')}</p>
      ) : (
        <ul className="space-y-2">
          {list.map((c) => (
            <li key={c.candidateKey} className="rounded-xl border border-border bg-bg-secondary px-3 py-3 text-sm">
              <p className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-text-primary">{c.kind} · {t('candidates.evidence', { count: c.evidenceCount })}</span>
                <CopyButton text={() => JSON.stringify({ kind: c.kind, suggestedParams: c.suggestedParams, evidenceCount: c.evidenceCount, exampleReasons: c.exampleReasons }, null, 2)} label={t('candidates.copy')} copiedLabel={t('candidates.copied')} />
              </p>
              <p className="text-xs text-text-secondary">{c.alreadyCovered ? t('candidates.covered') : t('candidates.notCovered')}</p>
              <p className="mt-1 text-xs text-text-secondary">{t('candidates.examples')}: {c.exampleReasons.join(' · ')}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
