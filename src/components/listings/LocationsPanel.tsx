import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ClipboardCopy, Link2, Loader2, MapPin, RefreshCw, Unlink } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import { useRun, type RunFn } from '@/components/listings/useRun';
import {
  DRIFT_FIELD_LABEL,
  LISTING_PLATFORMS,
  LISTING_PLATFORM_LABEL,
  MODE_LABEL,
  STATE_CLASS,
  STATE_LABEL,
  buildLocationRows,
  confirmManualUpdate,
  copyRecord,
  linkLocation,
  singleLineAddress,
  syncListings,
  timeAgo,
  unlinkLocation,
  type ListingLink,
  type ListingsOverview,
  type LocationRowModel,
  type PlatformInfo,
} from '@/lib/listings';

function LinkRowView({ link, info, location, busy, run }: { link: ListingLink; info: PlatformInfo; location: LocationRowModel['location']; busy: string | null; run: RunFn }) {
  const { toast } = useToast();
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const label = LISTING_PLATFORM_LABEL[link.platform];
  const manual = link.mode === 'manual';
  const idle = busy === null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyRecord(location.canonical));
      toast(`Copied your ${label} record. Paste it into ${label}, then confirm.`, 'success');
    } catch {
      toast('Copying was blocked by your browser. Select the details manually instead.', 'error');
    }
  };

  return (
    <li className="rounded-xl border border-border bg-bg-primary p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-text-primary">{label}</span>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATE_CLASS[link.state]}`}>{STATE_LABEL[link.state]}</span>
      </div>
      <p className="mt-1 text-xs text-text-secondary">
        {MODE_LABEL[link.mode]}
        {link.mode !== 'manual' && ` · Checked ${timeAgo(link.last_checked_at)}`}
        {manual && link.state === 'synced' && ` · Confirmed ${timeAgo(link.last_pushed_at)}`}
        {link.external_location_id !== 'manual' && ` · ID ${link.external_location_id}`}
      </p>

      {link.state === 'drift' && link.drift_fields.length > 0 && (
        <p className="mt-1 text-xs text-warning-500">Doesn't match: {link.drift_fields.map((f) => DRIFT_FIELD_LABEL[f]).join(', ')}</p>
      )}
      {link.state === 'blocked' && link.blocked_reason && <p className="mt-1 text-xs text-text-secondary">{link.blocked_reason}</p>}
      {link.last_error && (link.state === 'error' || link.state === 'needs_reauth') && (
        <p className="mt-1 flex items-start gap-1.5 text-xs text-danger">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" /> {link.last_error}
        </p>
      )}
      {link.mode === 'monitor' && link.state === 'drift' && (
        <p className="mt-1 text-xs text-text-secondary">{label} can't be updated automatically. Copy the record, fix it on {label}, and the next daily check clears this.</p>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        {(manual || (link.mode === 'monitor' && link.state === 'drift')) && (
          <Button type="button" size="sm" variant="secondary" disabled={!idle} onClick={copy}>
            <ClipboardCopy size={16} aria-hidden="true" /> Copy record
          </Button>
        )}
        {manual && link.state !== 'synced' && link.state !== 'blocked' && (
          <Button type="button" size="sm" disabled={!idle} onClick={() => run(`confirm-${link.id}`, () => confirmManualUpdate(link.id), `Marked ${label} as up to date.`)}>
            {busy === `confirm-${link.id}` ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />} I've updated it
          </Button>
        )}
        {!manual && (
          <Button type="button" size="sm" variant="secondary" disabled={!idle} onClick={() => run(`sync-${link.id}`, () => syncListings({ linkId: link.id }))}>
            {busy === `sync-${link.id}` ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
            {info.mode === 'push' ? 'Sync now' : 'Check now'}
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" disabled={!idle} onClick={() => setConfirmUnlink(true)}>
          <Unlink size={16} aria-hidden="true" /> Unlink
        </Button>
      </div>

      <ConfirmDialog
        open={confirmUnlink}
        title={`Unlink ${label} from ${location.name}?`}
        description={`Vireek stops updating and checking this ${label} listing. The listing itself on ${label} stays exactly as it is.`}
        confirmLabel="Unlink"
        onCancel={() => setConfirmUnlink(false)}
        onConfirm={async () => {
          setConfirmUnlink(false);
          await run(`unlink-${link.id}`, () => unlinkLocation(link.id), 'Unlinked.');
        }}
      />
    </li>
  );
}

function LinkForm({ info, locationId, data, busy, run, onClose }: { info: PlatformInfo; locationId: string; data: ListingsOverview; busy: string | null; run: RunFn; onClose: () => void }) {
  const label = LISTING_PLATFORM_LABEL[info.platform];
  const connections = data.connections.filter((c) => c.platform === info.platform && c.status !== 'needs_reauth');
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? '');
  const [externalId, setExternalId] = useState('');
  const key = `link-${locationId}-${info.platform}`;
  const needsId = info.credentials === 'location_id';
  const needsConnection = info.credentials !== 'location_id' && info.configured;
  const canSubmit = (!needsConnection || !!connectionId) && (!needsId || !info.configured || externalId.trim().length > 0);

  const submit = () =>
    run(
      key,
      async () => {
        const out = await linkLocation({
          locationId,
          platform: info.platform,
          ...(needsConnection ? { connectionId } : {}),
          ...(needsId && externalId.trim() ? { externalLocationId: externalId.trim() } : {}),
        });
        onClose();
        return out;
      },
      `Linked ${label}.`,
    );

  return (
    <div className="space-y-3 rounded-xl border border-border bg-bg-primary p-3">
      {!info.configured && (
        <p className="text-xs text-text-secondary">
          {label} syncing isn't enabled on this workspace yet. You can still track it here: Vireek keeps a copy-ready record and reminds you when your details change.
        </p>
      )}
      {needsConnection &&
        (connections.length > 0 ? (
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-text-primary">{info.externalLabel}</span>
            <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)} className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary">
              {connections.map((c) => (
                <option key={c.id} value={c.id}>{c.display_name}</option>
              ))}
            </select>
          </label>
        ) : (
          <p className="text-xs text-text-secondary">Connect a {label} listing on the "Directories &amp; settings" tab first.</p>
        ))}
      {needsId && (
        <Input
          label={`${info.externalLabel}${info.configured ? '' : ' (optional)'}`}
          value={externalId}
          maxLength={100}
          placeholder="e.g. 4821937"
          helperText="Letters, numbers, dots, dashes and underscores."
          onChange={(e) => setExternalId(e.target.value)}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy !== null || !canSubmit} onClick={submit}>
          {busy === key ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Link2 size={16} aria-hidden="true" />}
          {info.configured ? 'Link & sync' : 'Track manually'}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}

function LocationCard({ row, data, busy, run }: { row: LocationRowModel; data: ListingsOverview; busy: string | null; run: RunFn }) {
  const navigate = useNavigate();
  const [linking, setLinking] = useState<string | null>(null);
  const { location } = row;
  const hasLinks = row.links.length > 0;

  return (
    <Card className="space-y-4 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 break-words text-base font-semibold text-text-primary">
            {location.name}
            {location.is_primary && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">Primary</span>}
            {location.status !== 'active' && <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs font-semibold text-text-secondary">Paused</span>}
          </h3>
          <p className="mt-1 break-words text-sm text-text-secondary">
            {singleLineAddress(location.canonical.address) || 'No address yet'} · {location.canonical.phone ?? 'No phone'}
          </p>
        </div>
        {hasLinks && (
          <Button type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={() => run(`sync-loc-${location.id}`, () => syncListings({ locationId: location.id }))}>
            {busy === `sync-loc-${location.id}` ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />} Sync location
          </Button>
        )}
      </div>

      {row.blocking.length > 0 && (
        <div className="rounded-xl bg-warning-500/10 p-3" role="alert">
          <p className="text-sm font-medium text-text-primary">Finish these details before this location can sync:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-text-secondary">
            {row.blocking.map((i) => <li key={i.code}>{i.message}</li>)}
          </ul>
          <Button type="button" size="sm" variant="secondary" className="mt-2" onClick={() => navigate('/dashboard/settings/locations')}>
            <MapPin size={16} aria-hidden="true" /> Edit location details
          </Button>
        </div>
      )}
      {row.blocking.length === 0 && row.warnings.some((w) => w.code !== 'location_inactive') && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-text-secondary">
          {row.warnings.filter((w) => w.code !== 'location_inactive').map((w) => <li key={w.code}>{w.message}</li>)}
        </ul>
      )}

      <ul className="space-y-2">
        {LISTING_PLATFORMS.map((p) => {
          const info = data.platforms.find((x) => x.platform === p);
          if (!info) return null;
          const link = row.links.find((l) => l.platform === p);
          if (link) return <LinkRowView key={p} link={link} info={info} location={location} busy={busy} run={run} />;
          return (
            <li key={p} className="rounded-xl border border-dashed border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-text-primary">{LISTING_PLATFORM_LABEL[p]}</span>
                {linking !== p && (
                  <Button type="button" size="sm" variant="secondary" disabled={busy !== null || location.status !== 'active'} onClick={() => setLinking(p)}>
                    <Link2 size={16} aria-hidden="true" /> Link
                  </Button>
                )}
              </div>
              {linking === p && <div className="mt-2"><LinkForm info={info} locationId={location.id} data={data} busy={busy} run={run} onClose={() => setLinking(null)} /></div>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function LocationsPanel({ data, onChange, onOpenChannels }: { data: ListingsOverview; isOwner: boolean; onChange: (o: ListingsOverview) => void; onOpenChannels: () => void }) {
  const navigate = useNavigate();
  const { busy, run } = useRun(onChange);
  const rows = buildLocationRows(data);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={MapPin}
        title="Add a business location first"
        description="Listings are built from your business locations — name, address, phone and hours. Add one, then come back to link it to Apple Maps, Bing, Yelp and Facebook."
        action={{ label: 'Add a location', onClick: () => navigate('/dashboard/settings/locations') }}
      />
    );
  }

  const anyLinks = data.links.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-text-primary">Your locations</h2>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onOpenChannels}>Directories &amp; settings</Button>
          {anyLinks && (
            <Button type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={() => run('sync-all', () => syncListings())}>
              {busy === 'sync-all' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />} Sync all
            </Button>
          )}
        </div>
      </div>
      {!anyLinks && (
        <p className="rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-secondary">
          Pick a directory under any location to link it. Linked listings are checked daily and updated automatically wherever the directory allows it.
        </p>
      )}
      <div className="space-y-4">
        {rows.map((r) => <LocationCard key={r.location.id} row={r} data={data} busy={busy} run={run} />)}
      </div>
    </div>
  );
}
