import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Bot, CheckCircle2, Clock, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { formatDateTime } from '@/lib/format';
import { AGENT_CALLERS_NS } from '@/i18n/agentCallersNamespace';
import {
  AGENT_CALLER_LIMITS,
  DEFAULT_AGENT_CALLER_SETTINGS,
  computeAgentFunnel,
  computeHumanWinRate,
  holdsExpiringSoon,
  parseLines,
  type AgentCallRow,
  type AgentCallerSettings,
  type AgentHold,
  type AgentQuotableItem,
  type FunnelCall,
  type FunnelEvent,
} from '@/lib/agentCallers';
import { decideHold, fetchCalls30d, fetchFunnelEvents, fetchHolds, fetchQuotableItems, fetchSettings, saveSettings, setItemQuotable } from '@/lib/agentCallersApi';

type Tab = 'overview' | 'holds' | 'settings' | 'services';
const TABS: Tab[] = ['overview', 'holds', 'settings', 'services'];

const pct = (n: number | null) => (n == null ? null : Math.round(n * 100));

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card interactive={false} className="p-4">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </Card>
  );
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <Input
      label={label}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(Math.min(max, Math.max(min, Math.round(Number(e.target.value) || min))))}
    />
  );
}

export function AgentCallersPage() {
  const { t, i18n } = useTranslation(AGENT_CALLERS_NS);
  const { profile, teamMember, isOwner } = useAuth();
  const { toast } = useToast();
  const ownerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const [tab, setTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [settings, setSettings] = useState<AgentCallerSettings>(DEFAULT_AGENT_CALLER_SETTINGS);
  const [calls, setCalls] = useState<AgentCallRow[]>([]);
  const [events, setEvents] = useState<FunnelEvent[]>([]);
  const [holds, setHolds] = useState<AgentHold[]>([]);
  const [items, setItems] = useState<AgentQuotableItem[]>([]);
  const [zipText, setZipText] = useState('');
  const [topicText, setTopicText] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyHold, setBusyHold] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ownerId) return;
    setLoading(true);
    setError(false);
    try {
      const [s, c, e, h, i] = await Promise.all([fetchSettings(ownerId), fetchCalls30d(ownerId), fetchFunnelEvents(ownerId), fetchHolds(ownerId), fetchQuotableItems(ownerId)]);
      setSettings(s); setCalls(c); setEvents(e); setHolds(h); setItems(i);
      setZipText(s.blockedZips.join('\n'));
      setTopicText(s.neverDiscuss.join('\n'));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [ownerId]);

  useEffect(() => { void load(); }, [load]);

  const funnelCalls: FunnelCall[] = useMemo(
    () => calls.map((c) => ({ id: c.id, kind: c.caller_kind ?? 'unknown', booked: c.status === 'booked' || c.booking_outcome === 'booked' })),
    [calls],
  );
  const funnel = useMemo(() => computeAgentFunnel(funnelCalls, events, Object.fromEntries(calls.map((c) => [c.id, c.agent_platform_claimed]))), [funnelCalls, events, calls]);
  const human = useMemo(() => computeHumanWinRate(funnelCalls), [funnelCalls]);
  const agentCalls = useMemo(() => calls.filter((c) => c.caller_kind === 'ai_agent').slice(0, 20), [calls]);
  const expiring = useMemo(() => holdsExpiringSoon(holds.map((h) => ({ ...h, expiresAt: h.expires_at ?? '' })), new Date(), 15), [holds]);
  const fmtTime = (iso: string | null) => (iso ? formatDateTime(iso, undefined, i18n.language) : '');

  const patch = (p: Partial<AgentCallerSettings>) => setSettings((s) => ({ ...s, ...p }));

  async function onSave() {
    setSaving(true);
    try {
      const saved = await saveSettings({ ...settings, blockedZips: parseLines(zipText).filter((z) => /^\d{5}$/.test(z)), neverDiscuss: parseLines(topicText) });
      setSettings(saved);
      setZipText(saved.blockedZips.join('\n'));
      setTopicText(saved.neverDiscuss.join('\n'));
      toast(t('settings.saved'), 'success');
    } catch {
      toast(t('settings.saveFailed'), 'error');
    } finally {
      setSaving(false);
    }
  }

  async function onDecide(h: AgentHold, approve: boolean) {
    setBusyHold(h.id);
    try {
      const status = await decideHold(h.id, approve);
      toast(status === 'confirmed' ? t('holds.approved') : status === 'declined' ? t('holds.released') : t('holds.alreadyDone'), status === 'confirmed' || status === 'declined' ? 'success' : 'error');
      await load();
    } catch {
      toast(t('holds.failed'), 'error');
    } finally {
      setBusyHold(null);
    }
  }

  async function onToggleItem(item: AgentQuotableItem, next: boolean) {
    setItems((list) => list.map((x) => (x.id === item.id ? { ...x, agent_quotable: next } : x)));
    try {
      await setItemQuotable(item.id, next);
    } catch {
      setItems((list) => list.map((x) => (x.id === item.id ? { ...x, agent_quotable: !next } : x)));
      toast(t('services.failed'), 'error');
    }
  }

  const stageLabel = { calls: t('overview.calls'), quotes: t('overview.quotes'), holds: t('overview.holds'), confirmed: t('overview.confirmed') } as const;
  const canEdit = isOwner;

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
        <header>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><Bot size={24} className="text-accent" aria-hidden="true" />{t('title')}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t('subtitle')}</p>
          <p className="mt-2 flex items-start gap-2 text-xs text-text-secondary"><ShieldCheck size={14} className="mt-0.5 shrink-0" aria-hidden="true" />{t('honesty')}</p>
        </header>

        {expiring.length > 0 && (
          <div role="alert" className="flex items-start gap-3 rounded-xl border border-warning-500/40 bg-warning-500/10 p-4 text-sm text-text-primary">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />
            <div>
              <p className="font-semibold">{t('holds.expiringTitle')}</p>
              <p className="text-text-secondary">{t('holds.expiringBody', { count: expiring.length })}</p>
            </div>
          </div>
        )}

        <div role="tablist" aria-label={t('title')} className="flex flex-wrap gap-2">
          {TABS.map((k) => (
            <Button key={k} role="tab" id={`tab-${k}`} aria-selected={tab === k} aria-controls={`panel-${k}`} variant={tab === k ? 'primary' : 'secondary'} size="sm" onClick={() => setTab(k)}>
              {t(`tabs.${k}`)}
            </Button>
          ))}
        </div>

        {loading ? (
          <SkeletonCardList count={3} />
        ) : error ? (
          <EmptyStateError icon={AlertTriangle} title={t('loadError')} onRetry={() => void load()} />
        ) : (
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="space-y-6">
            {tab === 'overview' && (
              <>
                {!settings.enabled && <p className="rounded-xl border border-border bg-bg-secondary p-4 text-sm text-text-secondary">{t('overview.disabledBanner')}</p>}
                <section aria-labelledby="funnel-title">
                  <h2 id="funnel-title" className="mb-3 text-sm font-semibold text-text-primary">{t('overview.funnelTitle')}</h2>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    {funnel.stages.map((s) => (
                      <Stat key={s.key} label={stageLabel[s.key]} value={String(s.count)} hint={s.rate != null ? t('overview.ofPrevious', { pct: pct(s.rate) }) : undefined} />
                    ))}
                  </div>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <Stat label={t('overview.winRateAgent')} value={funnel.winRate != null ? `${pct(funnel.winRate)}%` : t('overview.winRateNone')} hint={t('overview.winRateHint')} />
                    <Stat label={t('overview.winRateHuman')} value={human.winRate != null ? `${pct(human.winRate)}%` : t('overview.winRateNone')} hint={`${human.won}/${human.calls}`} />
                  </div>
                </section>
                {funnel.stages[0].count === 0 ? (
                  <EmptyState icon={Bot} title={t('overview.empty')} description={t('overview.emptyHint')} />
                ) : (
                  <>
                    <section aria-labelledby="platform-title">
                      <h2 id="platform-title" className="mb-2 text-sm font-semibold text-text-primary">{t('overview.platforms')}</h2>
                      <ul className="flex flex-wrap gap-2 text-sm">
                        {Object.entries(funnel.platforms).map(([p, n]) => (
                          <li key={p} className="rounded-full bg-bg-tertiary px-3 py-1 text-text-primary">{p === 'unknown' ? t('platformUnknown') : t('platformClaimed', { platform: p })} · {n}</li>
                        ))}
                      </ul>
                    </section>
                    <section aria-labelledby="recent-title">
                      <h2 id="recent-title" className="mb-2 text-sm font-semibold text-text-primary">{t('overview.recent')}</h2>
                      <ul className="divide-y divide-border rounded-xl border border-border">
                        {agentCalls.map((c) => (
                          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                            <span className="text-text-primary">{fmtTime(c.call_datetime)} · <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">{t('badge')}</span></span>
                            <Link className="focus-ring rounded font-medium text-accent hover:underline" to={`/dashboard/calls/${c.id}`}>{t('overview.viewCall')}</Link>
                          </li>
                        ))}
                      </ul>
                    </section>
                  </>
                )}
              </>
            )}

            {tab === 'holds' && (holds.length === 0 ? (
              <EmptyState icon={Clock} title={t('holds.empty')} description={t('holds.emptyHint')} />
            ) : (
              <ul className="space-y-3">
                {holds.map((h) => (
                  <li key={h.id}>
                    <Card interactive={false} className="p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-semibold text-text-primary">{h.service ?? '—'} · {h.zip ?? ''}</p>
                          <p className="text-sm text-text-secondary">{fmtTime(h.window_start)} · {t('holds.ref', { code: h.code })}</p>
                          {h.status === 'held' && h.expires_at && <p className="text-sm text-text-secondary">{t('holds.expiresAt', { time: fmtTime(h.expires_at) })}</p>}
                          <p className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-text-primary"><CheckCircle2 size={14} aria-hidden="true" />{t(`holds.status.${h.status}`)}</p>
                        </div>
                        {h.status === 'held' && (
                          <div className="flex gap-2">
                            <Button size="sm" loading={busyHold === h.id} onClick={() => void onDecide(h, true)}>{t('holds.approve')}</Button>
                            <Button size="sm" variant="secondary" disabled={busyHold === h.id} onClick={() => void onDecide(h, false)}>{t('holds.release')}</Button>
                          </div>
                        )}
                      </div>
                    </Card>
                  </li>
                ))}
              </ul>
            ))}

            {tab === 'settings' && (
              <Card interactive={false} className="space-y-5 p-6">
                {!canEdit && <p className="text-sm text-text-secondary">{t('settings.ownerOnly')}</p>}
                <fieldset disabled={!canEdit} className="space-y-5">
                  <Switch label={t('settings.enabled')} hint={t('settings.enabledHint')} checked={settings.enabled} onChange={(v) => patch({ enabled: v })} />
                  <Select label={t('settings.approvalMode')} value={settings.approvalMode} onChange={(e) => patch({ approvalMode: e.target.value as AgentCallerSettings['approvalMode'] })}>
                    <option value="quote_only">{t('settings.mode_quote_only')}</option>
                    <option value="hold_for_approval">{t('settings.mode_hold_for_approval')}</option>
                    <option value="auto_book">{t('settings.mode_auto_book')}</option>
                  </Select>
                  {settings.approvalMode === 'auto_book' && <p role="note" className="text-sm text-warning-500">{t('settings.autoBookWarn')}</p>}
                  <div className="grid gap-4 md:grid-cols-2">
                    <NumberField label={t('settings.maxHolds')} value={settings.maxHoldsPerDay} {...AGENT_CALLER_LIMITS.maxHoldsPerDay} onChange={(n) => patch({ maxHoldsPerDay: n })} />
                    <NumberField label={t('settings.holdMinutes')} value={settings.holdMinutes} {...AGENT_CALLER_LIMITS.holdMinutes} onChange={(n) => patch({ holdMinutes: n })} />
                    <Select label={t('settings.flatPriceMode')} value={settings.flatPriceMode} onChange={(e) => patch({ flatPriceMode: e.target.value as AgentCallerSettings['flatPriceMode'] })}>
                      <option value="exact">{t('settings.flat_exact')}</option>
                      <option value="starting_at">{t('settings.flat_starting_at')}</option>
                      <option value="range">{t('settings.flat_range')}</option>
                    </Select>
                    {settings.flatPriceMode === 'range' && <NumberField label={t('settings.flatRangePercent')} value={settings.flatRangePercent} {...AGENT_CALLER_LIMITS.flatRangePercent} onChange={(n) => patch({ flatRangePercent: n })} />}
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <label htmlFor="zips" className="mb-1.5 block text-sm font-medium text-text-primary">{t('settings.blockedZips')}</label>
                      <textarea id="zips" aria-describedby="zips-hint" rows={4} value={zipText} onChange={(e) => setZipText(e.target.value)} className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary" />
                      <p id="zips-hint" className="mt-1 text-xs text-text-secondary">{t('settings.blockedZipsHint')}</p>
                    </div>
                    <div>
                      <label htmlFor="topics" className="mb-1.5 block text-sm font-medium text-text-primary">{t('settings.neverDiscuss')}</label>
                      <textarea id="topics" aria-describedby="topics-hint" rows={4} value={topicText} onChange={(e) => setTopicText(e.target.value)} className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary" />
                      <p id="topics-hint" className="mt-1 text-xs text-text-secondary">{t('settings.neverDiscussHint')}</p>
                    </div>
                  </div>
                  <Switch label={t('settings.allowSms')} checked={settings.allowSmsSummary} onChange={(v) => patch({ allowSmsSummary: v })} />
                  <Switch label={t('settings.allowEmail')} checked={settings.allowEmailSummary} onChange={(v) => patch({ allowEmailSummary: v })} />
                  <h2 className="text-sm font-semibold text-text-primary">{t('settings.limitsTitle')}</h2>
                  <div className="grid gap-4 md:grid-cols-2">
                    <NumberField label={t('settings.maxQuotesCaller')} value={settings.maxQuotesPerCallerPerDay} {...AGENT_CALLER_LIMITS.maxQuotesPerCallerPerDay} onChange={(n) => patch({ maxQuotesPerCallerPerDay: n })} />
                    <NumberField label={t('settings.maxServicesCaller')} value={settings.maxDistinctServicesPerCallerPerDay} {...AGENT_CALLER_LIMITS.maxDistinctServicesPerCallerPerDay} onChange={(n) => patch({ maxDistinctServicesPerCallerPerDay: n })} />
                    <NumberField label={t('settings.maxQuotesHour')} value={settings.maxQuotesPerHourTenant} {...AGENT_CALLER_LIMITS.maxQuotesPerHourTenant} onChange={(n) => patch({ maxQuotesPerHourTenant: n })} />
                    <NumberField label={t('settings.maxSummaries')} value={settings.maxSummariesPerDay} {...AGENT_CALLER_LIMITS.maxSummariesPerDay} onChange={(n) => patch({ maxSummariesPerDay: n })} />
                    <NumberField label={t('settings.retention')} value={settings.retentionDays} {...AGENT_CALLER_LIMITS.retentionDays} onChange={(n) => patch({ retentionDays: n })} />
                  </div>
                </fieldset>
                <p className="text-xs text-text-secondary">{t('settings.emergencyNote')}</p>
                {canEdit && <Button loading={saving} onClick={() => void onSave()}>{t('settings.save')}</Button>}
              </Card>
            )}

            {tab === 'services' && (items.length === 0 ? (
              <EmptyState icon={Bot} title={t('services.none')} description={t('services.noneHint')} />
            ) : (
              <>
                <p className="text-sm text-text-secondary">{t('services.intro')} {t('services.summary', { on: items.filter((i) => i.agent_quotable).length, total: items.length })}</p>
                <ul className="space-y-2">
                  {items.map((i) => (
                    <li key={i.id}>
                      <Card interactive={false} className="p-4">
                        <Switch label={i.service_name} hint={i.category ?? undefined} checked={i.agent_quotable} disabled={!canEdit} onChange={(v) => void onToggleItem(i, v)} />
                      </Card>
                    </li>
                  ))}
                </ul>
              </>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
