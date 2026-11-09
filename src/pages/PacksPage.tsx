import { useCallback, useEffect, useMemo, useState } from 'react';
import { PackageCheck, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { useFeatureFlags } from '@/hooks/useFeatureFlag';
import { applyPlan, fetchEntitledPackIds, fetchPackAccountView, friendlyPackError, type PackAccountView } from '@/lib/packsApi';
import {
  compareSemver, customizedIds, getPackVersion, latestVersion, listPackIds, planInstall, planReset, planRollback, planUpgrade, previewDiff,
  type Plan,
} from '@/lib/packs';

const ACTION_LABEL: Record<string, string> = {
  add: 'Add', update: 'Update', remove: 'Remove', keep_yours: 'Keep yours', detach: 'Keep (yours now)', retrack: 'Keep yours',
};

function PlanPreview({ plan, onApply, onCancel, busy }: { plan: Plan; onApply: () => void; onCancel: () => void; busy: boolean }) {
  const lines = useMemo(() => previewDiff(plan), [plan]);
  const s = plan.summary;
  const title = plan.kind === 'rollback' ? `Roll back to ${plan.toVersion ?? 'not installed'}` : `${plan.kind === 'install' ? 'Install' : 'Upgrade to'} ${plan.toVersion}`;
  return (
    <Card className="space-y-3 p-5" role="region" aria-label="Change preview">
      <h3 className="font-semibold text-text-primary">{title}</h3>
      <p className="text-sm text-text-secondary" aria-live="polite">
        {s.created} added · {s.updated} updated · {s.removed} removed · {s.preservedCustomized} of your customizations kept
        {s.conflicts ? ` · ${s.conflicts} changed by both you and the pack (yours kept)` : ''}
      </p>
      {lines.length === 0 ? (
        <p className="text-sm text-text-secondary">Nothing to change — you are already up to date.</p>
      ) : (
        <div className="max-h-72 overflow-auto rounded-xl border border-border">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Changes this action will make</caption>
            <thead className="sticky top-0 bg-bg-secondary text-xs text-text-secondary">
              <tr><th scope="col" className="p-2">Item</th><th scope="col" className="p-2">Action</th><th scope="col" className="hidden p-2 md:table-cell">Why</th></tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className="border-t border-border align-top">
                  <td className="break-all p-2 font-mono text-xs">{l.id}</td>
                  <td className="p-2 font-medium">{ACTION_LABEL[l.action]}</td>
                  <td className="hidden p-2 text-text-secondary md:table-cell">{l.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button onClick={onApply} loading={busy} disabled={lines.length === 0 && plan.kind !== 'install'}>Apply</Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </Card>
  );
}

export function PacksPage() {
  const { ready, isEnabled } = useFeatureFlags();
  const { toast } = useToast();
  const [entitled, setEntitled] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>(() => listPackIds()[0]);
  const [view, setView] = useState<PackAccountView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const on = isEnabled('trade_pack_framework');

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [ids, v] = await Promise.all([fetchEntitledPackIds(), fetchPackAccountView(selected)]);
      setEntitled(ids);
      setView(v);
    } catch (e) {
      setError(friendlyPackError(e, 'Could not load your pack. Please try again.'));
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    if (!on) return;
    setLoading(true);
    setPlan(null);
    void reload();
  }, [on, reload]);

  if (!ready) return <div className="mx-auto max-w-5xl p-4 md:p-8"><Skeleton className="h-32 w-full rounded-2xl" /></div>;
  if (!on) {
    return (
      <div className="mx-auto max-w-3xl p-4 md:p-8">
        <Card className="p-6 text-sm text-text-secondary">Trade pack management is not available on your account yet.</Card>
      </div>
    );
  }

  const installed = view?.install?.status === 'installed' ? view.install.version : null;
  const latest = latestVersion(selected);
  const isEntitled = entitled.includes(selected);
  const canUpgrade = Boolean(installed && latest && compareSemver(latest.version, installed) > 0);
  const mine = view ? customizedIds(view.state) : [];

  const preview = (kind: 'install' | 'upgrade' | 'rollback' | 'reset', ids: string[] = []) => {
    if (!view || !latest) return;
    if (kind === 'install') setPlan(planInstall(latest, view.state));
    else if (kind === 'upgrade' && installed) setPlan(planUpgrade(latest, view.state, installed));
    else if (kind === 'rollback' && view.revertible) setPlan(planRollback(selected, view.revertible, view.state));
    else if (kind === 'reset' && installed) {
      const cur = getPackVersion(selected, installed);
      if (cur) setPlan(planReset(cur, view.state, ids));
    }
  };

  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      await applyPlan(plan, plan.kind === 'rollback' ? view?.revertible?.id : undefined);
      toast(plan.kind === 'rollback' ? 'Rolled back.' : 'Done. Your customizations were kept.', 'success');
      setPlan(null);
      await reload();
    } catch (e) {
      toast(friendlyPackError(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-8">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><PackageCheck size={24} aria-hidden="true" /> Trade pack library</h1>
        <p className="text-sm text-text-secondary">Versioned toolkits for your trade. Upgrades never overwrite what you changed, and every change can be rolled back.</p>
      </header>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Choose a pack">
        {listPackIds().map((id) => (
          <Button key={id} size="sm" variant={id === selected ? 'primary' : 'secondary'} selected={id === selected} onClick={() => setSelected(id)}>
            {latestVersion(id)?.name ?? id}{entitled.includes(id) ? '' : ' (not included)'}
          </Button>
        ))}
      </div>

      {error && (
        <Card className="space-y-2 p-4" role="alert">
          <p className="text-sm text-danger">{error}</p>
          <Button size="sm" variant="secondary" onClick={() => { setLoading(true); void reload(); }}>Try again</Button>
        </Card>
      )}

      {loading ? (
        <Skeleton className="h-40 w-full rounded-2xl" />
      ) : !error && latest && view ? (
        <>
          <Card className="space-y-3 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-semibold text-text-primary">{latest.name}</h2>
                <p className="text-sm text-text-secondary">{latest.description}</p>
              </div>
              <p className="text-sm" aria-live="polite">{installed ? `Installed: v${installed}` : 'Not installed'}{canUpgrade ? ` · v${latest.version} available` : ''}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {!installed && <Button onClick={() => preview('install')} disabled={!isEntitled} disabledReason="Your plan does not include this pack">Preview install</Button>}
              {canUpgrade && <Button onClick={() => preview('upgrade')} disabled={!isEntitled} disabledReason="Your plan does not include this pack">Preview upgrade</Button>}
              {view.revertible && <Button variant="secondary" onClick={() => preview('rollback')}><RotateCcw size={16} aria-hidden="true" /> Roll back last change</Button>}
            </div>
          </Card>

          {plan && <PlanPreview plan={plan} onApply={apply} onCancel={() => setPlan(null)} busy={busy} />}

          <Card className="space-y-2 p-5">
            <h2 className="font-semibold text-text-primary">Your customizations</h2>
            {mine.length === 0 ? (
              <p className="text-sm text-text-secondary">You have not changed anything from the pack.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {mine.map((id) => (
                  <li key={id} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="break-all font-mono text-xs">{id}</span>
                    <Button size="xs" variant="ghost" onClick={() => preview('reset', [id])}>Reset to pack</Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="space-y-2 p-5">
            <h2 className="font-semibold text-text-primary">History</h2>
            {view.events.length === 0 ? <p className="text-sm text-text-secondary">No changes yet.</p> : (
              <ol className="space-y-1 text-sm text-text-secondary">
                {view.events.map((e) => (
                  <li key={e.id}>{new Date(e.createdAt).toLocaleString()} — {e.kind}{e.toVersion ? ` → v${e.toVersion}` : ''}{e.kind === 'customize' ? '' : ` (${e.ops.length} changes)`}</li>
                ))}
              </ol>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}
