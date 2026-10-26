/**
 * Enterprise Value & Exit-Readiness — /dashboard/exit-readiness  (OWNER ONLY)
 *
 * Estimates business value from the account's own data using transparent, editable methods
 * (SDE / adjusted EBITDA with documented add-backs, configurable multiples), shows value drivers with
 * trends, a sell-readiness score, a ranked action plan, a what-if simulator and a buyer data room
 * (expiring links + access logs). Every output is an ESTIMATE, not a valuation or advice.
 * Logic: src/lib/exitReadiness.ts · Data: src/lib/exitReadinessApi.ts · DB: 20271121000000_exit_readiness.sql
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Gauge, RefreshCw, Rocket } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList } from '@/components/Skeleton';
import { captureError } from '@/lib/sentry';
import {
  GRADE_LABELS,
  buildActionPlan,
  buildValuationSummary,
  evaluate,
  fmtMoney,
  previousSnapshot,
  type ActionStatus,
  type AddBack,
  type AddBackKind,
  type ExitMetrics,
  type ExitSettings,
  type ModelInput,
  type PlanAction,
  type Scenario,
  type SnapshotLite,
} from '@/lib/exitReadiness';
import {
  createAddBack,
  createDataRoom,
  deleteAddBack,
  fetchAccessLogs,
  fetchActionStates,
  fetchAddBacks,
  fetchDataQualityScore,
  fetchLinks,
  fetchMetrics,
  fetchSettings,
  fetchSnapshots,
  revokeLink,
  saveSettings,
  saveSnapshot,
  setActionState,
  setAddBackActive,
  type AccessLogEntry,
  type DataRoomLink,
} from '@/lib/exitReadinessApi';
import { EstimateBanner } from '@/components/exit-readiness/shared';
import { ValuationPanel } from '@/components/exit-readiness/ValuationPanel';
import { DriversPanel } from '@/components/exit-readiness/DriversPanel';
import { ActionPlanPanel } from '@/components/exit-readiness/ActionPlanPanel';
import { WhatIfPanel } from '@/components/exit-readiness/WhatIfPanel';
import { DataRoomPanel } from '@/components/exit-readiness/DataRoomPanel';

type Tab = 'overview' | 'drivers' | 'plan' | 'whatif' | 'dataroom';
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Estimate' },
  { key: 'drivers', label: 'Value drivers' },
  { key: 'plan', label: 'Action plan' },
  { key: 'whatif', label: 'What-if' },
  { key: 'dataroom', label: 'Data room' },
];

interface Loaded {
  metrics: ExitMetrics;
  settings: ExitSettings;
  addBacks: AddBack[];
  snapshots: SnapshotLite[];
  actionStates: Record<string, ActionStatus>;
  dataQuality: number | null;
  links: DataRoomLink[];
  logs: AccessLogEntry[];
}

export function ExitReadinessPage() {
  const { profile, isOwner, profileLoading } = useAuth();
  const { toast } = useToast();
  const ownerId = isOwner ? profile?.id ?? null : null;

  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  const [scenario, setScenario] = useState<Scenario>({});
  const [savingSettings, setSavingSettings] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<DataRoomLink | null>(null);
  const autoSnapshotted = useRef(false);

  const load = useCallback(async () => {
    if (!ownerId) return;
    setLoading(true);
    setLoadError(false);
    try {
      const [metrics, settings, addBacks, snapshots, actionStates, dataQuality, links, logs] = await Promise.all([
        fetchMetrics(), fetchSettings(ownerId), fetchAddBacks(ownerId), fetchSnapshots(ownerId),
        fetchActionStates(ownerId), fetchDataQualityScore(), fetchLinks(ownerId), fetchAccessLogs(ownerId),
      ]);
      setData({ metrics, settings, addBacks, snapshots, actionStates, dataQuality, links, logs });
    } catch (e) {
      captureError(e, { page: 'exit-readiness' });
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [ownerId]);

  useEffect(() => {
    if (ownerId) void load();
  }, [ownerId, load]);

  const model: ModelInput | null = useMemo(
    () => (data ? { metrics: data.metrics, settings: data.settings, addBacks: data.addBacks, dataQuality: data.dataQuality } : null),
    [data],
  );
  const base = useMemo(() => (model ? evaluate(model) : null), [model]);
  const result = useMemo(() => (model ? evaluate(model, scenario) : null), [model, scenario]);
  const plan = useMemo(() => (model ? buildActionPlan(model) : []), [model]);
  const previous = useMemo(() => (data ? previousSnapshot(data.snapshots) : null), [data]);

  // Save this month's snapshot silently once per visit so KPI history and trends build up on their own.
  useEffect(() => {
    if (!data || !base || autoSnapshotted.current || base.readiness.score === null) return;
    autoSnapshotted.current = true;
    const driverScores = Object.fromEntries(base.drivers.map((d) => [d.key, d.score]));
    void saveSnapshot({
      score: base.readiness.score, lowCents: base.valuation.lowCents, pointCents: base.valuation.pointCents,
      highCents: base.valuation.highCents, driverScores, metrics: data.metrics,
    })
      .then(() => ownerId && fetchSnapshots(ownerId))
      .then((snaps) => snaps && setData((d) => (d ? { ...d, snapshots: snaps } : d)))
      .catch((e) => captureError(e, { page: 'exit-readiness', step: 'auto-snapshot' }));
  }, [data, base, ownerId]);

  const run = async (fn: () => Promise<void>, ok: string, fail: string) => {
    try {
      await fn();
      toast(ok, 'success');
    } catch (e) {
      captureError(e, { page: 'exit-readiness' });
      toast(e instanceof Error ? e.message : fail, 'error');
    }
  };

  const onSaveSettings = async (s: ExitSettings) => {
    if (!ownerId) return;
    setSavingSettings(true);
    await run(async () => {
      await saveSettings(ownerId, s);
      setData((d) => (d ? { ...d, settings: s } : d));
    }, 'Assumptions saved', 'Could not save your assumptions');
    setSavingSettings(false);
  };

  const reloadAddBacks = async () => {
    if (!ownerId) return;
    const addBacks = await fetchAddBacks(ownerId);
    setData((d) => (d ? { ...d, addBacks } : d));
  };

  const onCreateAddBack = async (input: { kind: AddBackKind; label: string; amountCents: number; justification: string; evidenceRef: string }) => {
    if (!ownerId) return;
    await run(async () => {
      await createAddBack(ownerId, input);
      await reloadAddBacks();
    }, 'Adjustment added', 'Could not add the adjustment');
  };

  const onToggleAddBack = async (id: string, active: boolean) => {
    await run(async () => {
      await setAddBackActive(id, active);
      await reloadAddBacks();
    }, active ? 'Included in earnings' : 'Excluded from earnings', 'Could not update the adjustment');
  };

  const confirmDelete = async () => {
    const id = deleteTarget;
    setDeleteTarget(null);
    if (!id) return;
    await run(async () => {
      await deleteAddBack(id);
      await reloadAddBacks();
    }, 'Adjustment deleted', 'Could not delete the adjustment');
  };

  const onActionState = async (key: string, status: ActionStatus) => {
    if (!ownerId) return;
    setBusyAction(key);
    await run(async () => {
      await setActionState(ownerId, key, status);
      setData((d) => (d ? { ...d, actionStates: { ...d.actionStates, [key]: status } } : d));
    }, 'Action updated', 'Could not update the action');
    setBusyAction(null);
  };

  const onSimulate = (a: PlanAction) => {
    setScenario(a.scenario);
    setTab('whatif');
  };

  const onCreateRoom = async (input: { label: string; sections: string[]; recipient: string; expiresHours: number; maxViews: number; includeNames: boolean }) => {
    if (!ownerId || !model || !base) return;
    setCreatingRoom(true);
    await run(async () => {
      const created = await createDataRoom({
        ...input,
        valuation: input.sections.includes('valuation') ? buildValuationSummary(model, base) : null,
      });
      setCreatedUrl(created.url);
      const [links, logs] = await Promise.all([fetchLinks(ownerId), fetchAccessLogs(ownerId)]);
      setData((d) => (d ? { ...d, links, logs } : d));
    }, 'Data room created', 'Could not create the data room');
    setCreatingRoom(false);
  };

  const confirmRevoke = async () => {
    const link = revokeTarget;
    setRevokeTarget(null);
    if (!link || !ownerId) return;
    await run(async () => {
      await revokeLink(link.id);
      const links = await fetchLinks(ownerId);
      setData((d) => (d ? { ...d, links } : d));
    }, 'Link revoked', 'Could not revoke the link');
  };

  const header = (
    <div className="mb-6 flex flex-wrap items-center gap-3">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
        <Rocket size={22} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl font-bold text-text-primary">Enterprise Value & Exit Readiness</h1>
        <p className="text-sm text-text-secondary">Estimate what your business could be worth, see what moves it, and prepare a buyer data room. Estimates only.</p>
      </div>
      {data && <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}><RefreshCw size={14} aria-hidden="true" /> Refresh</Button>}
    </div>
  );

  if (profileLoading) {
    return <DashboardLayout><div className="mx-auto max-w-6xl px-4 py-8 sm:px-6"><SkeletonCardList count={2} /></div></DashboardLayout>;
  }
  if (!isOwner) {
    return (
      <DashboardLayout>
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          {header}
          <EmptyState icon={Gauge} title="Owner access only" description="Exit readiness contains company-wide financials and sale preparation. Ask the account owner to open it." />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {header}

        {loading && !data ? (
          <SkeletonCardList count={3} />
        ) : loadError || !data || !model || !base || !result ? (
          <EmptyState icon={Gauge} title="Couldn’t load exit readiness" description="Check your connection and try again. Your data has not changed." action={{ label: 'Retry', onClick: () => void load() }} />
        ) : (
          <div className="space-y-6">
            <Card className="!p-5">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <p className="text-xs text-text-secondary">Sell-readiness score</p>
                  <p className="text-3xl font-bold text-text-primary">{base.readiness.score === null ? '—' : Math.round(base.readiness.score)}<span className="text-sm font-normal text-text-secondary"> / 100</span></p>
                  <p className="text-xs text-text-secondary">{GRADE_LABELS[base.readiness.grade]}</p>
                </div>
                <div>
                  <p className="text-xs text-text-secondary">Estimated value (readiness-adjusted)</p>
                  <p className="text-3xl font-bold text-text-primary">{base.valuation.reason ? '—' : fmtMoney(base.valuation.pointCents)}</p>
                  <p className="text-xs text-text-secondary">{base.valuation.reason ? 'Needs positive earnings' : `${fmtMoney(base.valuation.lowCents)} – ${fmtMoney(base.valuation.highCents)}`}</p>
                </div>
                <div>
                  <p className="text-xs text-text-secondary">{base.valuation.method === 'sde' ? 'SDE' : 'Adjusted EBITDA'}</p>
                  <p className="text-3xl font-bold text-text-primary">{fmtMoney(base.valuation.earningsCents)}</p>
                  <p className="text-xs text-text-secondary">trailing 12 months</p>
                </div>
                <div>
                  <p className="text-xs text-text-secondary">Top action</p>
                  <p className="text-sm font-semibold text-text-primary">{plan.find((a) => !['done', 'dismissed'].includes(data.actionStates[a.key] ?? 'open'))?.title ?? 'Nothing urgent'}</p>
                </div>
              </div>
              <div className="mt-3"><EstimateBanner compact /></div>
            </Card>

            <div role="tablist" aria-label="Exit readiness sections" className="flex flex-wrap gap-1 border-b border-border">
              {TABS.map((t) => (
                <button key={t.key} type="button" role="tab" id={`exit-tab-${t.key}`} aria-selected={tab === t.key} aria-controls={`exit-panel-${t.key}`}
                  onClick={() => setTab(t.key)}
                  className={`focus-ring -mb-px border-b-2 px-4 py-2.5 text-sm font-medium ${tab === t.key ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
                  {t.label}
                </button>
              ))}
            </div>

            <div role="tabpanel" id={`exit-panel-${tab}`} aria-labelledby={`exit-tab-${tab}`}>
              {tab === 'overview' && (
                <ValuationPanel evaluation={base} settings={data.settings} addBacks={data.addBacks} saving={savingSettings}
                  onSaveSettings={onSaveSettings} onCreateAddBack={onCreateAddBack} onToggleAddBack={onToggleAddBack} onDeleteAddBack={setDeleteTarget} />
              )}
              {tab === 'drivers' && <DriversPanel drivers={base.drivers} metrics={data.metrics} previous={previous} snapshots={data.snapshots} />}
              {tab === 'plan' && <ActionPlanPanel actions={plan} states={data.actionStates} busyKey={busyAction} onState={(k, s) => void onActionState(k, s)} onSimulate={onSimulate} />}
              {tab === 'whatif' && (
                <WhatIfPanel base={base} result={result} metrics={data.metrics} baseDataQuality={data.dataQuality} baseOwnerHours={data.settings.ownerWeeklyHours} scenario={scenario} onChange={setScenario} />
              )}
              {tab === 'dataroom' && (
                <DataRoomPanel links={data.links} logs={data.logs} creating={creatingRoom} createdUrl={createdUrl} onCreate={onCreateRoom} onRevoke={setRevokeTarget} onDismissUrl={() => setCreatedUrl(null)} />
              )}
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog open={deleteTarget !== null} title="Delete this adjustment?" description="It will no longer count toward earnings. You can add it again later."
        confirmLabel="Yes, delete it" onConfirm={() => void confirmDelete()} onCancel={() => setDeleteTarget(null)} />
      <ConfirmDialog open={revokeTarget !== null} title="Revoke this link?" description="The buyer will lose access immediately. This cannot be undone, but you can create a new link."
        confirmLabel="Yes, revoke it" onConfirm={() => void confirmRevoke()} onCancel={() => setRevokeTarget(null)} />
    </DashboardLayout>
  );
}
