import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleCheck, GitMerge, History, Pencil, ScanEye, ShieldAlert, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/Skeleton';
import { EmptyStateInline } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import {
  CONDITION_STYLES, SEVERITY_STYLES, ageLabel, confirmAsset, correctAsset, dismissDuplicateHint, fetchAssetDetail,
  formatWhen, humanize, mergeAssets, promoteAssetToEquipment, remainingLabel, reviewFinding, setAssetStatus, severityRank,
  signedPhotoUrls, type PvAsset, type PvCapture, type PvEvent, type PvFinding,
} from '@/lib/propertyVision';

interface Props {
  asset: PvAsset;
  duplicateOf: PvAsset | null;
  onChanged: () => void;
  onRescan: (asset: PvAsset) => void;
}

function Badge({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${className}`}>{children}</span>;
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-text-secondary">{label}</dt>
      <dd className="truncate text-sm font-medium text-text-primary">{value}</dd>
    </div>
  );
}

const EVENT_DOT: Record<string, string> = {
  finding_new: 'bg-danger-500', finding_worsened: 'bg-danger-500', finding_reopened: 'bg-warning-500',
  condition_changed: 'bg-warning-500', finding_not_reobserved: 'bg-warning-500', identity_conflict: 'bg-warning-500',
};

function FindingRow({ f, busy, act }: { f: PvFinding; busy: boolean; act: (fn: () => Promise<void>, ok: string) => Promise<void> }) {
  const done = f.status === 'resolved' || f.status === 'dismissed';
  return (
    <li className={`rounded-xl border border-border p-3 ${done ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge className={SEVERITY_STYLES[f.severity]}>{humanize(f.severity)}</Badge>
        <span className="text-sm font-medium text-text-primary">{f.title}</span>
        {f.status === 'not_reobserved' && <Badge className="bg-warning-500/10 text-warning-500">No longer visible — confirm</Badge>}
        {done && <Badge className="bg-bg-tertiary text-text-secondary">{humanize(f.status)}</Badge>}
      </div>
      {f.description && <p className="mt-1 text-xs text-text-secondary">{f.description}</p>}
      {f.standard_hint && (
        <p className="mt-1 text-xs text-text-secondary">
          Possible deviation: {f.standard_hint}. <span className="font-medium">Verify against the code your jurisdiction enforces.</span>
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-text-secondary">First seen {formatWhen(f.first_seen_at)} · seen {f.times_observed}×</span>
        <span className="flex gap-1">
          {!done ? (
            <>
              <Button variant="ghost" size="sm" className="!min-h-0 !px-2 !py-1 !text-xs" disabled={busy} onClick={() => act(() => reviewFinding(f.id, 'resolve'), 'Marked resolved')}>Resolved</Button>
              <Button variant="ghost" size="sm" className="!min-h-0 !px-2 !py-1 !text-xs" disabled={busy} onClick={() => act(() => reviewFinding(f.id, 'dismiss'), 'Dismissed')}>Not an issue</Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" className="!min-h-0 !px-2 !py-1 !text-xs" disabled={busy} onClick={() => act(() => reviewFinding(f.id, 'reopen'), 'Reopened')}>Reopen</Button>
          )}
        </span>
      </div>
    </li>
  );
}

function FindingSection({ title, icon: Icon, items, busy, act }: {
  title: string; icon: typeof ShieldAlert; items: PvFinding[]; busy: boolean; act: (fn: () => Promise<void>, ok: string) => Promise<void>;
}) {
  if (items.length === 0) return null;
  return (
    <section className="mt-5">
      <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary"><Icon size={13} /> {title}</h4>
      <ul className="space-y-2">{items.map((f) => <FindingRow key={f.id} f={f} busy={busy} act={act} />)}</ul>
    </section>
  );
}

export function AssetDetailPanel({ asset, duplicateOf, onChanged, onRescan }: Props) {
  const { toast } = useToast();
  const [findings, setFindings] = useState<PvFinding[]>([]);
  const [events, setEvents] = useState<PvEvent[]>([]);
  const [captures, setCaptures] = useState<PvCapture[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ make: '', model: '', serial_number: '', install_year: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetchAssetDetail(asset.id);
      setFindings(d.findings); setEvents(d.events); setCaptures(d.captures);
      setUrls(await signedPhotoUrls(d.captures.slice(0, 8).map((c) => c.storage_path)));
    } catch {
      toast('Could not load this asset', 'error');
    } finally {
      setLoading(false);
    }
  }, [asset.id, toast]);

  useEffect(() => { void load(); }, [load, asset.last_seen_at, asset.open_findings_count, asset.status]);

  useEffect(() => {
    setEditing(false);
    setDraft({ make: asset.make ?? '', model: asset.model ?? '', serial_number: asset.serial_number ?? '', install_year: asset.install_year ? String(asset.install_year) : '' });
  }, [asset.id, asset.make, asset.model, asset.serial_number, asset.install_year]);

  const act = async (fn: () => Promise<void>, ok: string) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); toast(ok, 'success'); onChanged(); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Something went wrong', 'error'); }
    finally { setBusy(false); }
  };

  const grouped = useMemo(() => {
    const by = (t: PvFinding['finding_type'], activeOnly: boolean) =>
      findings.filter((f) => f.finding_type === t && (activeOnly ? f.status === 'open' || f.status === 'not_reobserved' : true))
        .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
    return {
      hazards: by('hazard', false), installs: by('installation_issue', false),
      conditions: by('condition_indicator', true), components: by('component', false),
    };
  }, [findings]);

  const saveEdit = () => {
    const yr = draft.install_year.trim();
    if (yr && !/^\d{4}$/.test(yr)) return toast('Install year must be a 4-digit year', 'error');
    void act(async () => {
      await correctAsset(asset.id, {
        make: draft.make, model: draft.model, serial_number: draft.serial_number,
        ...(yr ? { install_year: Number(yr) } : {}),
      });
      setEditing(false);
    }, 'Saved');
  };

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-text-primary">{asset.label}</h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge className={CONDITION_STYLES[asset.condition]}>Condition: {asset.condition}</Badge>
            {asset.installation_quality !== 'unknown' && (
              <Badge className={asset.installation_quality === 'unsafe' || asset.installation_quality === 'deficient' ? 'bg-warning-500/10 text-warning-500' : 'bg-bg-tertiary text-text-secondary'}>
                Install: {asset.installation_quality}
              </Badge>
            )}
            <Badge className={asset.human_confirmed ? 'bg-success-500/10 text-success-500' : 'bg-bg-tertiary text-text-secondary'}>
              {asset.human_confirmed ? 'Confirmed by staff' : 'AI draft — unconfirmed'}
            </Badge>
            {asset.equipment_id && <Badge className="bg-accent/10 text-accent">In equipment records</Badge>}
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => onRescan(asset)}><ScanEye size={16} /> Re-scan</Button>
      </div>

      {duplicateOf && (
        <div role="alert" className="mt-4 rounded-xl border border-warning-500/30 bg-warning-500/5 p-3 text-xs text-text-primary">
          <p className="font-medium">This may be the same unit as “{duplicateOf.label}”.</p>
          <p className="mt-0.5 text-text-secondary">Merge to keep one history, or keep them separate if these are different units.</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" className="!min-h-0 !px-3 !py-1.5 !text-xs" disabled={busy} onClick={() => act(() => mergeAssets(duplicateOf.id, asset.id), 'Merged into one history')}>
              <GitMerge size={14} /> Merge into “{duplicateOf.label.slice(0, 24)}”
            </Button>
            <Button variant="secondary" size="sm" className="!min-h-0 !px-3 !py-1.5 !text-xs" disabled={busy} onClick={() => act(() => dismissDuplicateHint(asset.id), 'Kept separate')}>Different unit</Button>
          </div>
        </div>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <Fact label="Make" value={asset.make ?? '—'} />
        <Fact label="Model" value={asset.model ?? '—'} />
        <Fact label="Serial" value={asset.serial_number ? `${asset.serial_number}${asset.serial_verified ? '' : ' (unverified)'}` : '—'} />
        <Fact label="Age" value={ageLabel(asset)} />
        <Fact label="Life outlook" value={remainingLabel(asset)} />
        <Fact label="Last seen" value={formatWhen(asset.last_seen_at)} />
      </dl>
      {asset.specs && <p className="mt-2 text-xs text-text-secondary">{asset.specs}</p>}
      <p className="mt-2 text-[11px] text-text-secondary">
        Life outlook uses typical industry service life for this equipment type — not manufacturer data.
      </p>

      {editing ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Input label="Make" value={draft.make} maxLength={60} onChange={(e) => setDraft({ ...draft, make: e.target.value })} />
          <Input label="Model" value={draft.model} maxLength={80} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
          <Input label="Serial number" value={draft.serial_number} maxLength={40} onChange={(e) => setDraft({ ...draft, serial_number: e.target.value })} />
          <Input label="Install year" inputMode="numeric" value={draft.install_year} maxLength={4} onChange={(e) => setDraft({ ...draft, install_year: e.target.value })} />
          <div className="flex gap-2 sm:col-span-2">
            <Button size="sm" disabled={busy} onClick={saveEdit}>Save</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          {!asset.human_confirmed && <Button variant="secondary" size="sm" disabled={busy} onClick={() => act(() => confirmAsset(asset.id), 'Confirmed')}><CircleCheck size={16} /> Confirm identity</Button>}
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setEditing(true)}><Pencil size={16} /> Correct details</Button>
          {!asset.equipment_id && asset.customer_id && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => act(() => promoteAssetToEquipment(asset.id), 'Saved to equipment records')}><Wrench size={16} /> Save as equipment</Button>
          )}
          {asset.status === 'active' && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => act(() => setAssetStatus(asset.id, 'replaced'), 'Marked replaced')}>Mark replaced</Button>
          )}
          {asset.status !== 'active' && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => act(() => setAssetStatus(asset.id, 'active'), 'Marked active')}>Mark active</Button>
          )}
        </div>
      )}

      {loading ? (
        <div className="mt-5 space-y-2"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
      ) : (
        <>
          <FindingSection title="Hazards" icon={ShieldAlert} items={grouped.hazards} busy={busy} act={act} />
          <FindingSection title="Installation quality" icon={Wrench} items={grouped.installs} busy={busy} act={act} />
          <FindingSection title="Condition indicators" icon={History} items={grouped.conditions} busy={busy} act={act} />
          {grouped.components.length > 0 && (
            <section className="mt-5">
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Components</h4>
              <ul className="flex flex-wrap gap-1.5">
                {grouped.components.map((c) => (
                  <li key={c.id} className="rounded-lg border border-border px-2 py-1 text-xs text-text-primary" title={c.description ?? undefined}>
                    {c.title}{c.attrs?.origin === 'appears_replaced' ? ' · appears replaced' : ''}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {captures.length > 0 && (
            <section className="mt-5">
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Photos ({asset.capture_count})</h4>
              <ul className="grid grid-cols-4 gap-2">
                {captures.slice(0, 8).map((c) => (
                  <li key={c.id} className="aspect-square overflow-hidden rounded-xl border border-border bg-bg-tertiary">
                    {urls[c.storage_path] && <img src={urls[c.storage_path]} alt={`Taken ${formatWhen(c.captured_at)}`} loading="lazy" className="h-full w-full object-cover" />}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="mt-5">
            <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary"><History size={13} /> Memory timeline</h4>
            {events.length === 0 ? (
              <EmptyStateInline text="Nothing recorded yet beyond the first scan." />
            ) : (
              <ol className="space-y-2.5 border-l border-border pl-4">
                {events.slice(0, 40).map((e) => (
                  <li key={e.id} className="relative text-xs">
                    <span className={`absolute -left-[21px] top-1 h-2 w-2 rounded-full ${EVENT_DOT[e.event_type] ?? 'bg-border'}`} aria-hidden />
                    <p className="text-text-primary">{e.summary}</p>
                    <p className="text-[11px] text-text-secondary">{formatWhen(e.occurred_at)} · {e.actor_type === 'ai' ? 'AI' : e.actor_type === 'staff' ? 'Staff' : 'System'}</p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </div>
  );
}
