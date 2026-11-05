import { KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { BackupSettingsPanel } from '@/components/voiceResilience/BackupSettingsPanel';
import { CarrierWizardPanel } from '@/components/voiceResilience/CarrierWizardPanel';
import { LadderStatusPanel } from '@/components/voiceResilience/LadderStatusPanel';
import { useAuth } from '@/contexts/AuthContext';
import { useVoiceResilienceT } from '@/i18n/voiceResilienceNamespace';
import {
  buildSavePayload, draftFromSettings, errorKeyFor, forcedLevelActive, normalizePhone, pollDelayMs, pollExpired, validateForcedLevel, validateSettings,
  type CarrierFamily, type CheckKind, type CheckStatus, type ForwardCode, type Level, type SettingsDraft, type VoiceStatus,
} from '@/lib/voiceResilience';
import {
  VoiceApiError, fetchVireekNumbers, fetchVoiceStatus, fetchWizardPlan, fetchWizardStatus, saveOrgSettings, setForcedLevel, startWizardCheck,
} from '@/lib/voiceResilienceApi';

const PAGE = 'Phone Resilience';
type Tab = 'status' | 'settings' | 'wizard';
const TABS: Tab[] = ['status', 'settings', 'wizard'];

const errKey = (e: unknown) => (e instanceof VoiceApiError ? errorKeyFor(e.message, e.status) : errorKeyFor(undefined));

export function VoiceResiliencePage() {
  const { t, language } = useVoiceResilienceT();
  const { profile, teamMember, isOwner, permissions, loading: authLoading, profileLoading } = useAuth();
  const ownerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const canAccess = isOwner || permissions.can_edit_business_profile;

  const [tab, setTab] = useState<Tab>('status');
  const [load, setLoad] = useState<'loading' | 'error' | 'ready'>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const fmt = useCallback((iso: string) => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)), [language]);

  const refresh = useCallback(async (initial = false) => {
    if (initial) setLoad('loading'); else setRefreshing(true);
    try {
      setStatus(await fetchVoiceStatus());
      setNow(Date.now());
      setLoad('ready');
    } catch {
      if (initial || !status) setLoad('error');
    } finally {
      setRefreshing(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (ownerId && canAccess) void refresh(true); }, [ownerId, canAccess, refresh]);
  // The level can change while the page is open: re-read every minute, only while visible.
  useEffect(() => {
    if (!ownerId || !canAccess) return;
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 60_000);
    return () => window.clearInterval(id);
  }, [ownerId, canAccess, refresh]);

  // ---- settings ----
  const [draft, setDraft] = useState<SettingsDraft>(() => draftFromSettings(null));
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const seeded = useRef(false);
  useEffect(() => {
    if (status && !seeded.current) { setDraft(draftFromSettings(status.org)); seeded.current = true; }
  }, [status]);

  const onSave = async () => {
    setShowErrors(true);
    if (Object.keys(validateSettings(draft)).length) return;
    const payload = buildSavePayload(draft, status?.org ?? null);
    if (!payload) { setSaveMsg({ tone: 'ok', text: t('settings.noChanges') }); return; }
    setSaving(true);
    try {
      await saveOrgSettings(payload);
      await refresh();
      setSaveMsg({ tone: 'ok', text: t('settings.saved') });
      setShowErrors(false);
    } catch (e) {
      setSaveMsg({ tone: 'error', text: t(errKey(e)) });
    } finally {
      setSaving(false);
    }
  };

  const [ovLevel, setOvLevel] = useState<Level>(3);
  const [ovMinutes, setOvMinutes] = useState(60);
  const [ovBusy, setOvBusy] = useState(false);
  const [ovMsg, setOvMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const runOverride = async (clear: boolean) => {
    if (!clear && !validateForcedLevel(ovLevel, ovMinutes)) { setOvMsg({ tone: 'error', text: t('settings.override.invalid') }); return; }
    setOvBusy(true);
    try {
      await (clear ? setForcedLevel(null) : setForcedLevel(ovLevel, ovMinutes));
      await refresh();
      setOvMsg({ tone: 'ok', text: t(clear ? 'settings.override.cleared' : 'settings.override.applied') });
    } catch (e) {
      setOvMsg({ tone: 'error', text: t(errKey(e)) });
    } finally {
      setOvBusy(false);
    }
  };

  // ---- wizard ----
  const [numbers, setNumbers] = useState<string[]>([]);
  const [number, setNumber] = useState('');
  const [family, setFamily] = useState<CarrierFamily>('gsm_standard');
  const [business, setBusiness] = useState('');
  const [plan, setPlan] = useState<{ codes: ForwardCode[]; warning: string } | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [check, setCheck] = useState<{ id: string | null; kind: CheckKind; status: CheckStatus | 'starting'; startedAt: number; elapsed: number } | null>(null);
  const [wizErr, setWizErr] = useState<string | null>(null);

  useEffect(() => {
    if (!ownerId || !canAccess) return;
    fetchVireekNumbers(ownerId).then((n) => { setNumbers(n); setNumber((cur) => cur || n[0] || ''); }).catch(() => setNumbers([]));
  }, [ownerId, canAccess]);

  // Changing family or number invalidates the shown codes.
  useEffect(() => { setPlan(null); }, [family, number]);

  const loadPlan = async () => {
    setPlanLoading(true); setWizErr(null);
    try { setPlan(await fetchWizardPlan(family, number)); } catch (e) { setWizErr(errKey(e)); } finally { setPlanLoading(false); }
  };

  const start = async (kind: CheckKind) => {
    const biz = normalizePhone(business);
    if (!biz) { setWizErr('errors.forbidden'); return; }
    setWizErr(null);
    setCheck({ id: null, kind, status: 'starting', startedAt: Date.now(), elapsed: 0 });
    try {
      const r = await startWizardCheck(kind, number, biz);
      setCheck({ id: r.check_id, kind, status: 'pending', startedAt: Date.now(), elapsed: 0 });
    } catch (e) {
      setCheck(null);
      setWizErr(errKey(e));
    }
  };

  const checkId = check?.id;
  const pending = check?.status === 'pending';
  useEffect(() => {
    if (!checkId || !pending) return;
    let cancelled = false;
    let timer: number | undefined;
    const begin = Date.now();
    const tick = async () => {
      const elapsed = Date.now() - begin;
      if (pollExpired(elapsed)) { setCheck((c) => (c && c.id === checkId ? { ...c, status: 'expired' } : c)); return; }
      try {
        const r = await fetchWizardStatus(checkId);
        if (cancelled) return;
        if (r.status !== 'pending') { setCheck((c) => (c && c.id === checkId ? { ...c, status: r.status } : c)); return; }
      } catch { /* transient: keep polling until the deadline */ }
      if (cancelled) return;
      setCheck((c) => (c && c.id === checkId ? { ...c, elapsed: Math.round((Date.now() - begin) / 1000) } : c));
      timer = window.setTimeout(() => void tick(), pollDelayMs(Date.now() - begin));
    };
    timer = window.setTimeout(() => void tick(), pollDelayMs(0));
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [checkId, pending]);

  // ---- tabs (roving tabindex + arrow keys) ----
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.indexOf(tab);
    const dir = document.dir === 'rtl' ? -1 : 1;
    let next = i;
    if (e.key === 'ArrowRight') next = (i + dir + TABS.length) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (i - dir + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    else return;
    e.preventDefault();
    setTab(TABS[next]);
    document.getElementById(`vr-tab-${TABS[next]}`)?.focus();
  };

  if (authLoading || profileLoading) {
    return <DashboardLayout activeLabel={PAGE}><div className="mx-auto w-full max-w-4xl"><SkeletonCardList count={3} rows={2} /></div></DashboardLayout>;
  }
  if (!canAccess || !ownerId) {
    return (
      <DashboardLayout activeLabel={PAGE}>
        <div className="mx-auto w-full max-w-3xl">
          <EmptyState icon={ShieldCheck} variant="no-permission" title={t('page.noAccess.title')} description={t('page.noAccess.description')} />
        </div>
      </DashboardLayout>
    );
  }

  const errors = showErrors ? validateSettings(draft) : {};

  return (
    <DashboardLayout activeLabel={PAGE}>
      <div className="mx-auto w-full max-w-4xl space-y-5">
        <header>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-text-primary"><ShieldCheck size={22} aria-hidden="true" className="text-accent" /> {t('page.title')}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t('page.subtitle')}</p>
        </header>

        <div role="tablist" aria-label={t('page.tabsLabel')} className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1">
          {TABS.map((id) => (
            <button key={id} type="button" role="tab" id={`vr-tab-${id}`} aria-selected={tab === id} aria-controls={`vr-panel-${id}`}
              tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)} onKeyDown={onTabKey}
              className={`focus-ring shrink-0 rounded-lg px-4 py-2 text-sm font-medium ${tab === id ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}>
              {t(`page.tabs.${id}`)}
            </button>
          ))}
        </div>

        {load === 'loading' && <SkeletonCardList count={3} rows={2} />}
        {load === 'error' && <EmptyStateError icon={ShieldCheck} title={t('page.loadError')} onRetry={() => void refresh(true)} />}

        {load === 'ready' && status && (
          <div role="tabpanel" id={`vr-panel-${tab}`} aria-labelledby={`vr-tab-${tab}`} tabIndex={0} className="focus-ring rounded-xl">
            {tab === 'status' && <LadderStatusPanel t={t} status={status} now={now} refreshing={refreshing} onRefresh={() => void refresh()} formatDate={fmt} />}
            {tab === 'settings' && (
              <BackupSettingsPanel t={t} draft={draft} errors={errors} onChange={(p) => setDraft((d) => ({ ...d, ...p }))} onSave={() => void onSave()} saving={saving} message={saveMsg}
                override={{ level: ovLevel, minutes: ovMinutes, active: forcedLevelActive(status.org, now), busy: ovBusy, onLevel: setOvLevel, onMinutes: setOvMinutes, onApply: () => void runOverride(false), onClear: () => void runOverride(true), message: ovMsg }} />
            )}
            {tab === 'wizard' && (
              <CarrierWizardPanel t={t} family={family} onFamily={setFamily} numbers={numbers} number={number} onNumber={setNumber} businessNumber={business} onBusinessNumber={setBusiness}
                plan={plan} planLoading={planLoading} onLoadPlan={() => void loadPlan()}
                check={check ? { kind: check.kind, status: check.status, elapsedSeconds: check.elapsed } : null} onStart={(k) => void start(k)} errorKey={wizErr} />
            )}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

export default VoiceResiliencePage;
