// /staff/marketplace-vetting — third-party agent vetting: review queue, delisting, history (Vireek staff only).
// Access is enforced by RLS + RPC checks (is_vireek_staff); the route sits behind <StaffRoute>.
import { useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Pill, SelectField, formatDateTime, useLoader, type Tone } from '@/components/vehicles/shared';
import { VettingReviewCard } from '@/components/agent-marketplace/VettingReviewCard';
import { useToast } from '@/contexts/ToastContext';
import { useMarketplaceVettingT } from '@/i18n/marketplaceVettingNamespace';
import { fetchReviewQueue, type MarketplaceAgent } from '@/lib/agentMarketplace';
import {
  DELIST_REASONS, classifyError, delistAgent, fetchDelistingEvents, fetchStaffAgents, noteIsValid, reinstateAgent, type DelistReason,
} from '@/lib/marketplaceVetting';
import { useSEO } from '@/lib/seo';

function SEO() {
  useSEO({ title: 'Marketplace vetting — Staff', description: 'Internal: marketplace app vetting.', canonical: 'https://vireek.com/staff/marketplace-vetting' });
  return null;
}

type Tab = 'queue' | 'listed' | 'history';
const AGENT_TONE: Record<string, Tone> = { published: 'success', suspended: 'warning', delisted: 'danger' };

function Gate({ error, onRetry, children, loading }: { error: string | null; loading: boolean; onRetry: () => void; children: ReactNode }) {
  const { t } = useMarketplaceVettingT();
  if (loading) return <div><p role="status" className="sr-only">{t('loading')}</p><SkeletonCardList count={2} rows={3} /></div>;
  if (error) {
    return classifyError(error) === 'forbidden'
      ? <EmptyState variant="no-permission" title={t('errors.forbidden')} />
      : <EmptyState variant="load-failed" title={t('loadError')} onRetry={onRetry} />;
  }
  return <>{children}</>;
}

function AgentRow({ agent, onChanged }: { agent: MarketplaceAgent; onChanged: () => void }) {
  const { t } = useMarketplaceVettingT();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<DelistReason>('policy');
  const [internal, setInternal] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const delisted = agent.status === 'delisted';
  const valid = noteIsValid(internal) && noteIsValid(message);

  const submit = async () => {
    if (!valid) { toast(t('review.noteRequired'), 'error'); return; }
    setBusy(true);
    try {
      if (delisted) {
        await reinstateAgent(agent.id, internal.trim());
        toast(t('listed.reinstated'), 'success');
      } else {
        const res = await delistAgent(agent.id, reason, internal.trim(), message.trim());
        toast(t('listed.delistedDone', { count: res.installs_revoked }), 'success');
      }
      setOpen(false); setInternal(''); setMessage('');
      onChanged();
    } catch (e) {
      toast(t(`errors.${classifyError(e instanceof Error ? e.message : '')}`), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li>
      <Card interactive={false} padding="sm" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary">{agent.name} <span dir="ltr" className="text-xs font-normal text-text-secondary">· {agent.slug}</span></p>
            <p className="text-xs text-text-secondary">{agent.publisher_id === null ? t('listed.firstParty') : agent.publisher_name}</p>
          </div>
          <div className="flex items-center gap-2">
            <Pill tone={AGENT_TONE[agent.status] ?? 'neutral'}>{t(`status.${agent.status}`)}</Pill>
            <Button variant={delisted ? 'secondary' : 'danger'} onClick={() => setOpen((o) => !o)} aria-expanded={open}>{delisted ? t('listed.reinstate') : t('listed.delist')}</Button>
          </div>
        </div>
        {delisted && agent.suspended_reason && <p className="text-xs text-text-secondary">{agent.suspended_reason}</p>}
        {open && (
          <div className="space-y-3 rounded-xl border border-border bg-bg-primary p-3">
            {!delisted && (
              <>
                <p role="note" className="text-sm text-text-primary">{t('listed.warning')}</p>
                <SelectField label={t('listed.reason')} value={reason} onChange={(e) => setReason(e.target.value as DelistReason)}>
                  {DELIST_REASONS.map((r) => <option key={r} value={r}>{t(`reasons.${r}`)}</option>)}
                </SelectField>
              </>
            )}
            <Textarea label={t('listed.internal')} helperText={t('listed.internalHelp')} rows={3} maxLength={2000} value={internal} onChange={(e) => setInternal(e.target.value)} />
            {!delisted && <Textarea label={t('listed.publisherMessage')} helperText={t('listed.publisherMessageHelp')} rows={2} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} />}
            <div className="flex gap-2">
              <Button variant={delisted ? 'primary' : 'danger'} onClick={() => void submit()} loading={busy} disabled={!(delisted ? noteIsValid(internal) : valid)}>{delisted ? t('listed.confirmReinstate') : t('listed.confirmDelist')}</Button>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>{t('listed.cancel')}</Button>
            </div>
          </div>
        )}
      </Card>
    </li>
  );
}

export function StaffMarketplaceVettingPage() {
  const { t } = useMarketplaceVettingT();
  const [tab, setTab] = useState<Tab>('queue');
  const queue = useLoader(fetchReviewQueue, 'queue');
  const agents = useLoader(fetchStaffAgents, 'agents');
  const events = useLoader(() => fetchDelistingEvents(50), 'events');
  const reloadAll = () => { void queue.reload(); void agents.reload(); void events.reload(); };
  const tabs: Tab[] = ['queue', 'listed', 'history'];

  return (
    <>
      <SEO />
      <Header />
      <main id="main-content" className="min-h-screen bg-bg-primary px-4 pb-20 pt-28 sm:px-6">
        <div className="mx-auto max-w-5xl space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold text-text-primary">{t('title')}</h1>
              <p className="mt-1 max-w-2xl text-sm text-text-secondary">{t('subtitle')}</p>
            </div>
            <Button variant="secondary" onClick={reloadAll}><RefreshCw className="h-4 w-4" aria-hidden="true" />{t('refresh')}</Button>
          </div>

          <div role="tablist" aria-label={t('title')} className="flex flex-wrap gap-1 rounded-xl bg-bg-secondary p-1">
            {tabs.map((k) => (
              <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)}
                className={`focus-ring min-h-[44px] flex-1 rounded-lg px-3 py-2 text-sm font-medium ${tab === k ? 'bg-accent text-on-accent' : 'text-text-secondary hover:text-text-primary'}`}>
                {t(`tabs.${k}`)}{k === 'queue' && queue.data ? ` (${queue.data.length})` : ''}
              </button>
            ))}
          </div>

          {tab === 'queue' && (
            <Gate loading={queue.loading && !queue.data} error={queue.error} onRetry={() => void queue.reload()}>
              {(queue.data ?? []).length === 0
                ? <EmptyState variant="no-data" title={t('queue.emptyTitle')} description={t('queue.emptyDescription')} />
                : <ul className="space-y-4">{(queue.data ?? []).map((q) => <li key={q.version_id}><VettingReviewCard item={q} onDecided={reloadAll} /></li>)}</ul>}
            </Gate>
          )}

          {tab === 'listed' && (
            <Gate loading={agents.loading && !agents.data} error={agents.error} onRetry={() => void agents.reload()}>
              {(agents.data ?? []).length === 0
                ? <EmptyState variant="no-data" title={t('listed.emptyTitle')} description={t('listed.emptyDescription')} />
                : <ul className="space-y-3">{(agents.data ?? []).map((a) => <AgentRow key={a.id} agent={a} onChanged={reloadAll} />)}</ul>}
            </Gate>
          )}

          {tab === 'history' && (
            <Gate loading={events.loading && !events.data} error={events.error} onRetry={() => void events.reload()}>
              {(events.data ?? []).length === 0
                ? <EmptyState variant="no-data" title={t('history.emptyTitle')} description={t('history.emptyDescription')} />
                : (
                  <ul className="space-y-2">
                    {(events.data ?? []).map((e) => (
                      <li key={e.id} className="rounded-xl border border-border bg-bg-secondary p-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <Pill tone={e.action === 'delisted' ? 'danger' : 'success'}>{t(`history.${e.action}`)}</Pill>
                          <span dir="ltr" className="font-medium text-text-primary">{e.agent_slug}</span>
                          {e.reason_code && <span className="text-text-secondary">{t(`reasons.${e.reason_code}`)}</span>}
                          <span className="text-xs text-text-secondary">{formatDateTime(e.created_at)}</span>
                        </div>
                        <p className="mt-1 text-text-secondary">{e.detail}</p>
                        {e.action === 'delisted' && <p className="mt-1 text-xs text-text-secondary">{t('history.installs', { count: e.installs_revoked })}</p>}
                      </li>
                    ))}
                  </ul>
                )}
            </Gate>
          )}
        </div>
      </main>
    </>
  );
}
