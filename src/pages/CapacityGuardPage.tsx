import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck, Hourglass, History, Settings2, AlertTriangle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { MiniLoader } from '@/components/ui/MiniLoader';
import { formatCurrency, formatDateTime, formatNumber, formatPercent } from '@/lib/format';
import {
  fetchGaps, fetchHolds, fetchOffers, fetchSettings, saveSettings,
  type GapRow, type GuardSettings, type HoldRow, type OfferRow, type TradeRule,
} from '@/lib/capacityGuard/api';
import { buildHeatmap, summarizeGaps, summarizeOutcomes } from '@/lib/capacityGuard/heatmap';
import { replayLastWeek, type ReplayOutput } from '@/lib/capacityGuard/preview';
import { CAPACITY_GUARD_NS } from '@/lib/capacityGuard/i18n';

type Tab = 'overview' | 'gaps' | 'history' | 'settings';
const DAY_MS = 86_400_000;
const localDayKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function CapacityGuardPage() {
  const { t } = useTranslation(CAPACITY_GUARD_NS);
  const { user } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('overview');
  const [settings, setSettings] = useState<GuardSettings | null>(null);
  const [holds, setHolds] = useState<HoldRow[]>([]);
  const [gaps, setGaps] = useState<GapRow[]>([]);
  const [offers, setOffers] = useState<OfferRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setFailed(false);
    try {
      const now = Date.now();
      const [s, h, g] = await Promise.all([fetchSettings(), fetchHolds(new Date(now - 7 * DAY_MS).toISOString(), new Date(now + 8 * DAY_MS).toISOString()), fetchGaps(new Date(now - 30 * DAY_MS).toISOString())]);
      setSettings(s); setHolds(h); setGaps(g);
      setOffers(await fetchOffers(g.map((x) => x.id)));
    } catch { setFailed(true); } finally { setLoading(false); }
  }, []);
  useEffect(() => { if (user) void load(); }, [user, load]);

  // The browser refreshes the board by polling every 30 s while the page is visible (no extra realtime channel needed).
  useEffect(() => {
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 30_000);
    return () => window.clearInterval(id);
  }, [load]);

  const isOwner = !!user && !!settings && user.id === settings.user_id;
  const tabs: { id: Tab; label: string; icon: typeof ShieldCheck }[] = [
    { id: 'overview', label: t('tabs.overview'), icon: ShieldCheck }, { id: 'gaps', label: t('tabs.gaps'), icon: Hourglass },
    { id: 'history', label: t('tabs.history'), icon: History }, { id: 'settings', label: t('tabs.settings'), icon: Settings2 },
  ];

  return (
    <DashboardLayout>
      <div className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold text-text-primary">{t('title')}</h1>
            <p className="text-sm text-text-secondary">{t('subtitle')}</p>
          </div>
          {settings && (
            <span className="rounded-full bg-bg-tertiary px-3 py-1 text-xs font-semibold text-text-primary" role="status">
              {!settings.enabled ? t('status.off') : settings.mode === 'shadow' ? t('status.shadow') : t('status.live')}
            </span>
          )}
        </header>

        <div role="tablist" aria-label={t('title')} className="flex gap-2 overflow-x-auto pb-1">
          {tabs.map((x) => (
            <Button key={x.id} role="tab" id={`cg-tab-${x.id}`} aria-selected={tab === x.id} aria-controls={`cg-panel-${x.id}`} variant={tab === x.id ? 'primary' : 'secondary'} size="sm" onClick={() => setTab(x.id)}>
              <x.icon className="h-4 w-4" aria-hidden="true" /> {x.label}
            </Button>
          ))}
        </div>

        {loading && !settings ? (
          <div className="flex justify-center py-16" role="status" aria-live="polite"><MiniLoader size={24} /></div>
        ) : failed || !settings ? (
          <EmptyState variant="load-failed" icon={AlertTriangle} title={t('errors.load')} onRetry={() => void load()} />
        ) : (
          <div role="tabpanel" id={`cg-panel-${tab}`} aria-labelledby={`cg-tab-${tab}`}>
            {tab === 'overview' && <Overview holds={holds} />}
            {tab === 'gaps' && <Gaps gaps={gaps.filter((g) => g.status === 'open' || g.status === 'offered')} offers={offers} />}
            {tab === 'history' && <HistoryTab gaps={gaps} />}
            {tab === 'settings' && <SettingsTab settings={settings} isOwner={isOwner} onSaved={(s) => { setSettings(s); toast(t('settings.saved'), 'success'); }} onError={() => toast(t('settings.saveFailed'), 'error')} />}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

function Overview({ holds }: { holds: HoldRow[] }) {
  const { t } = useTranslation(CAPACITY_GUARD_NS);
  const o = useMemo(() => summarizeOutcomes(holds), [holds]);
  const hm = useMemo(() => buildHeatmap(holds, localDayKey, (ms) => new Date(ms).getHours()), [holds]);
  const hours = useMemo(() => { const s = new Set<number>(); hm.cells.forEach((c) => s.add(c.hour)); return [...s].sort((a, b) => a - b); }, [hm]);
  const stat = (label: string, v: number) => (
    <Card interactive={false} className="p-4"><div className="text-xs text-text-secondary">{label}</div><div className="text-2xl font-semibold text-text-primary">{formatNumber(v)}</div></Card>
  );
  return (
    <div className="space-y-6">
      <section aria-labelledby="cg-outcomes">
        <h2 id="cg-outcomes" className="mb-2 text-lg font-semibold text-text-primary">{t('outcomes.title')}</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {stat(t('outcomes.held'), o.held)}{stat(t('outcomes.active'), o.active)}{stat(t('outcomes.consumed'), o.consumed)}{stat(t('outcomes.released'), o.released)}{stat(t('outcomes.shadow'), o.shadowActive)}
        </div>
      </section>
      <section aria-labelledby="cg-heat">
        <h2 id="cg-heat" className="text-lg font-semibold text-text-primary">{t('heatmap.title')}</h2>
        <p className="mb-2 text-xs text-text-secondary">{t('heatmap.desc')} {t('heatmap.legend')}</p>
        {hm.days.length === 0 ? (
          <EmptyState icon={ShieldCheck} title={t('heatmap.none')} />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[560px] border-collapse text-xs">
              <caption className="sr-only">{t('heatmap.title')}</caption>
              <thead><tr><th scope="col" className="p-2 text-start text-text-secondary" />{hours.map((h) => <th key={h} scope="col" className="p-2 text-center text-text-secondary">{formatNumber(h)}</th>)}</tr></thead>
              <tbody>
                {hm.days.map((d) => (
                  <tr key={d}>
                    <th scope="row" className="whitespace-nowrap p-2 text-start font-medium text-text-primary">{formatDateTime(`${d}T12:00:00`, { month: 'short', day: 'numeric', weekday: 'short' })}</th>
                    {hours.map((h) => {
                      const c = hm.cells.get(`${d}|${h}`);
                      const total = c ? c.value + c.campaign : 0;
                      return (
                        <td key={h} className={`p-1 text-center ${total >= 2 ? 'bg-accent/30' : total === 1 ? 'bg-accent/15' : c?.released ? 'bg-bg-tertiary' : ''}`}
                          aria-label={c ? `${t('heatmap.value')} ${c.value}, ${t('heatmap.campaign')} ${c.campaign}, ${t('heatmap.released')} ${c.released}` : undefined}>
                          {c ? `${c.value}/${c.campaign}/${c.released}` : ''}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Gaps({ gaps, offers }: { gaps: GapRow[]; offers: OfferRow[] }) {
  const { t } = useTranslation(CAPACITY_GUARD_NS);
  if (gaps.length === 0) return <EmptyState icon={Hourglass} title={t('gaps.empty')} description={t('gaps.emptyDesc')} />;
  return (
    <ul className="space-y-3" aria-label={t('gaps.title')}>
      {gaps.map((g) => {
        const mine = offers.filter((o) => o.gap_id === g.id);
        const sent = mine.filter((o) => o.status === 'sent').length;
        const blocked = mine.filter((o) => o.status === 'blocked').length;
        return (
          <li key={g.id}>
            <Card interactive={false} className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-text-primary">{formatDateTime(g.slot_start)} · {formatNumber(g.duration_minutes)}′</div>
                  <div className="text-xs text-text-secondary">{g.service_type ?? '—'} · {t(`gaps.reason.${g.source_reason}`)}</div>
                </div>
                <span className="rounded-full bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">{t(`gaps.status.${g.status}`)}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
                <span>{t('gaps.value')}: {formatCurrency(g.est_value_cents / 100)}</span>
                <span>{t('gaps.offers')}: {formatNumber(sent)} · {t('gaps.blocked')}: {formatNumber(blocked)}</span>
              </div>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}

function HistoryTab({ gaps }: { gaps: GapRow[] }) {
  const { t } = useTranslation(CAPACITY_GUARD_NS);
  const s = useMemo(() => summarizeGaps(gaps), [gaps]);
  const closed = gaps.filter((g) => g.status === 'filled' || g.status === 'expired' || g.status === 'abandoned');
  if (closed.length === 0) return <EmptyState icon={History} title={t('history.empty')} description={t('history.emptyDesc')} />;
  const stat = (label: string, v: string) => (<Card interactive={false} className="p-4"><div className="text-xs text-text-secondary">{label}</div><div className="text-2xl font-semibold text-text-primary">{v}</div></Card>);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stat(t('history.winRate'), formatPercent(s.winRate))}{stat(t('history.filled'), `${formatNumber(s.filled)} / ${formatNumber(s.total)}`)}
        {stat(t('history.recoveredEst'), formatCurrency(s.estimateCents / 100))}{stat(t('history.recoveredReal'), formatCurrency(s.realizedCents / 100))}
      </div>
      <p className="text-xs text-text-secondary">{t('history.note')}</p>
      <ul className="space-y-2">
        {closed.map((g) => (
          <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3 text-sm">
            <span className="text-text-primary">{formatDateTime(g.slot_start)} · {g.service_type ?? '—'}</span>
            <span className="text-text-secondary">{t(`gaps.status.${g.status}`)}{g.status === 'filled' && g.recovered_estimate_cents != null ? ` · ${formatCurrency(g.recovered_estimate_cents / 100)}` : ''}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SettingsTab({ settings, isOwner, onSaved, onError }: { settings: GuardSettings; isOwner: boolean; onSaved: (s: GuardSettings) => void; onError: () => void }) {
  const { t } = useTranslation(CAPACITY_GUARD_NS);
  const [form, setForm] = useState<GuardSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<ReplayOutput | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const set = <K extends keyof GuardSettings>(k: K, v: GuardSettings[K]) => setForm((f) => ({ ...f, [k]: v }));
  const num = (k: keyof GuardSettings, label: string, min: number, max: number, step = 1) => (
    <Input id={`cg-${String(k)}`} type="number" inputMode="decimal" label={label} min={min} max={max} step={step} disabled={!isOwner}
      value={String(form[k] as number)} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) set(k, Math.min(max, Math.max(min, n)) as never); }} />
  );
  const rules = form.trade_rules;
  const setRule = (i: number, patch: Partial<TradeRule>) => set('trade_rules', rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = async () => {
    setSaving(true);
    try {
      const { user_id: _u, ...patch } = form; void _u;
      onSaved(await saveSettings({ ...patch, trade_rules: rules.filter((r) => r.trade.trim()) }));
    } catch { onError(); } finally { setSaving(false); }
  };

  const runPreview = async () => {
    setPreviewing(true);
    try {
      const since = new Date(Date.now() - 7 * DAY_MS).toISOString();
      const [jobs, techs, wl] = await Promise.all([
        supabase.from('jobs').select('service_type, created_at, scheduled_datetime, job_status, invoice_amount').gte('created_at', since).limit(3000),
        supabase.from('team_members').select('max_jobs_per_day').eq('role', 'technician').eq('invite_status', 'active').eq('dispatch_enabled', true).limit(200),
        supabase.from('capacity_waitlist_entries').select('id', { count: 'exact', head: true }).eq('status', 'waiting'),
      ]);
      const t0 = (techs.data ?? []) as { max_jobs_per_day: number | null }[];
      setPreview(replayLastWeek({
        jobs: (jobs.data ?? []) as never, technicians: t0.length, maxJobsPerDay: t0.length ? Math.round(t0.reduce((a, x) => a + (x.max_jobs_per_day && x.max_jobs_per_day > 0 ? x.max_jobs_per_day : 6), 0) / t0.length) : 6,
        settings: form, waitlistSize: wl.count ?? 0, dayKeyOf: localDayKey,
      }));
    } catch { onError(); } finally { setPreviewing(false); }
  };

  return (
    <div className="space-y-6">
      {!isOwner && <p className="text-sm text-text-secondary" role="note">{t('settings.ownerOnly')}</p>}
      <Card interactive={false} className="space-y-4 p-4 sm:p-6">
        <Switch id="cg-enabled" label={t('settings.enabled')} hint={t('settings.enabledHint')} checked={form.enabled} disabled={!isOwner} onChange={(v) => set('enabled', v)} />
        <div role="group" aria-label={t('settings.mode')} className="flex gap-2">
          {(['shadow', 'live'] as const).map((m) => (
            <Button key={m} variant={form.mode === m ? 'primary' : 'secondary'} size="sm" aria-pressed={form.mode === m} disabled={!isOwner} onClick={() => set('mode', m)}>{t(`mode.${m}`)}</Button>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {num('hold_share_pct', t('settings.holdShare'), 0, 50)}{num('hold_horizon_days', t('settings.horizon'), 1, 14)}{num('min_release_probability', t('settings.minProb'), 0.01, 0.99, 0.01)}
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-text-primary">{t('settings.tradeRules')}</legend>
          {rules.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_7rem_auto] items-end gap-2">
              <Input id={`cg-rule-${i}`} label={t('settings.tradeName')} maxLength={60} disabled={!isOwner} value={r.trade} onChange={(e) => setRule(i, { trade: e.target.value })} />
              <Input id={`cg-rule-share-${i}`} type="number" label={t('settings.tradeShare')} min={0} max={50} disabled={!isOwner} value={String(r.hold_share_pct)} onChange={(e) => setRule(i, { hold_share_pct: Math.min(50, Math.max(0, Number(e.target.value) || 0)) })} />
              <Button variant="secondary" size="sm" disabled={!isOwner} onClick={() => set('trade_rules', rules.filter((_, j) => j !== i))}>{t('settings.removeRule')}</Button>
            </div>
          ))}
          <Button variant="secondary" size="sm" disabled={!isOwner || rules.length >= 20} onClick={() => set('trade_rules', [...rules, { trade: '', hold_share_pct: form.hold_share_pct }])}>{t('settings.addRule')}</Button>
        </fieldset>
        <h3 className="text-sm font-semibold text-text-primary">{t('settings.campaignHolds')}</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <Switch id="cg-camp" label={t('settings.campaignHolds')} checked={form.campaign_holds_enabled} disabled={!isOwner} onChange={(v) => set('campaign_holds_enabled', v)} />
          {num('campaign_max_hold_share_pct', t('settings.campaignMax'), 0, 60)}{num('campaign_default_response_rate', t('settings.campaignRate'), 0, 0.5, 0.001)}
        </div>
        <h3 className="text-sm font-semibold text-text-primary">{t('settings.backfill')}</h3>
        <Switch id="cg-bf" label={t('settings.backfill')} checked={form.backfill_enabled} disabled={!isOwner} onChange={(v) => set('backfill_enabled', v)} />
        <div className="grid gap-4 sm:grid-cols-3">
          {num('backfill_offer_ttl_minutes', t('settings.ttl'), 5, 240)}{num('backfill_batch_size', t('settings.batch'), 1, 10)}{num('backfill_min_lead_minutes', t('settings.lead'), 15, 1440)}
          {num('backfill_max_offers_per_customer_24h', t('settings.cap24'), 1, 5)}{num('backfill_max_offers_per_customer_7d', t('settings.cap7'), 1, 10)}
        </div>
        <Button onClick={() => void save()} loading={saving} disabled={!isOwner}>{t('settings.save')}</Button>
      </Card>

      <Card interactive={false} className="space-y-3 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-text-primary">{t('preview.title')}</h2>
          <span className="rounded-full bg-warning-500/10 px-2 py-0.5 text-xs font-semibold text-warning-500">{t('preview.simulated')}</span>
        </div>
        <p className="text-sm text-text-secondary">{t('preview.desc')}</p>
        <Button variant="secondary" onClick={() => void runPreview()} loading={previewing} loadingLabel={t('preview.loading')}>{t('preview.run')}</Button>
        {preview && (
          <div className="space-y-2" aria-live="polite">
            <dl className="grid grid-cols-2 gap-3 md:grid-cols-4 text-sm">
              {[[t('preview.holds'), formatNumber(preview.holds.held)], [t('preview.used'), formatNumber(preview.holds.used)], [t('preview.unused'), formatNumber(preview.holds.releasedUnused)], [t('preview.protected'), formatCurrency(preview.holds.protectedCents / 100)]].map(([k, v]) => (
                <div key={k}><dt className="text-xs text-text-secondary">{k}</dt><dd className="text-lg font-semibold text-text-primary">{v}</dd></div>
              ))}
            </dl>
            <p className="text-sm text-text-primary">{t('preview.backfill')}: {formatNumber(preview.cancellations)} → {formatNumber(preview.backfill.filled)} ({formatPercent(preview.backfill.winRate)})</p>
            <p className="text-xs text-text-secondary">{t('preview.waitlistOnly')} {t('preview.assumptions')}</p>
          </div>
        )}
      </Card>
    </div>
  );
}
