import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Link2, Loader2, Plug, RefreshCw, Settings2, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useRun, type RunFn } from '@/components/listings/useRun';
import {
  LISTING_PLATFORM_LABEL,
  MODE_LABEL,
  connectYelpListing,
  disconnectListingSource,
  saveListingSettings,
  startListingsOAuth,
  syncListings,
  timeAgo,
  type ListingConnection,
  type ListingsOverview,
  type PlatformInfo,
} from '@/lib/listings';

const CONNECTION_STATUS: Record<ListingConnection['status'], { label: string; cls: string }> = {
  active: { label: 'Connected', cls: 'bg-success/10 text-success' },
  needs_reauth: { label: 'Reconnect needed', cls: 'bg-warning-500/10 text-warning-500' },
  error: { label: 'Sync error', cls: 'bg-danger/10 text-danger' },
};

function PlatformCard({ info, data, isOwner, busy, run }: { info: PlatformInfo; data: ListingsOverview; isOwner: boolean; busy: string | null; run: RunFn }) {
  const [yelpId, setYelpId] = useState('');
  const [confirm, setConfirm] = useState<ListingConnection | null>(null);
  const label = LISTING_PLATFORM_LABEL[info.platform];
  const connections = data.connections.filter((c) => c.platform === info.platform);
  const linkCount = data.links.filter((l) => l.platform === info.platform).length;
  const usesConnections = info.credentials !== 'location_id';

  const connect = () =>
    run(`connect-${info.platform}`, async () => {
      if (info.platform === 'yelp') {
        const out = await connectYelpListing(yelpId);
        setYelpId('');
        return out;
      }
      const { url } = await startListingsOAuth();
      window.location.assign(url);
    }, info.platform === 'yelp' ? 'Yelp business connected.' : undefined);

  return (
    <Card className="space-y-4 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-text-primary">{label}</h3>
          <p className="mt-1 max-w-xl text-sm text-text-secondary">{info.note}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-xs font-semibold text-text-secondary">{MODE_LABEL[info.mode]}</span>
          {!info.configured && <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-xs font-semibold text-text-secondary">Not enabled yet</span>}
        </div>
      </div>

      {!info.configured && (
        <p className="rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-secondary">
          {label} syncing isn't enabled on this workspace yet. You can still link locations on the Locations tab and keep a copy-ready record. Contact support to enable it.
        </p>
      )}

      {info.configured && info.credentials === 'location_id' && (
        <p className="text-sm text-text-secondary">
          {linkCount === 0 ? `No locations linked yet — open the Locations tab and link one using its ${info.externalLabel}.` : `${linkCount} location${linkCount === 1 ? '' : 's'} linked.`}
          {!info.pushEnabled && ' Automatic updates are switched off for now, so these listings are checked and you copy changes across by hand.'}
        </p>
      )}

      {info.configured && usesConnections && (
        <>
          {connections.length > 0 && (
            <ul className="space-y-2">
              {connections.map((c) => (
                <li key={c.id} className="rounded-xl border border-border bg-bg-primary p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 break-words text-sm font-medium text-text-primary">{c.display_name}</span>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${CONNECTION_STATUS[c.status].cls}`}>{CONNECTION_STATUS[c.status].label}</span>
                  </div>
                  <p className="mt-1 text-xs text-text-secondary">Last synced {timeAgo(c.last_synced_at)}</p>
                  {c.last_error && (
                    <p className="mt-1 flex items-start gap-1.5 text-xs text-danger">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" /> {c.last_error}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {c.status === 'needs_reauth' && isOwner && info.credentials === 'oauth' && (
                      <Button type="button" size="sm" onClick={connect} disabled={busy !== null}>
                        <Link2 size={16} aria-hidden="true" /> Reconnect
                      </Button>
                    )}
                    {isOwner && (
                      <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirm(c)}>
                        <Unplug size={16} aria-hidden="true" /> Disconnect
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {isOwner ? (
            info.credentials === 'yelp_url' ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <Input label="Yelp business page or alias" value={yelpId} placeholder="https://www.yelp.com/biz/your-business" onChange={(e) => setYelpId(e.target.value)} />
                </div>
                <Button type="button" size="sm" onClick={connect} disabled={busy !== null || !yelpId.trim()}>
                  {busy === 'connect-yelp' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Plug size={16} aria-hidden="true" />}
                  {connections.length ? 'Add another' : 'Connect Yelp'}
                </Button>
              </div>
            ) : (
              <Button type="button" size="sm" variant={connections.length ? 'secondary' : 'primary'} onClick={connect} disabled={busy !== null}>
                {busy === `connect-${info.platform}` ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Plug size={16} aria-hidden="true" />}
                {connections.length ? `Add more ${label} Pages` : `Connect ${label}`}
              </Button>
            )
          ) : (
            connections.length === 0 && <p className="text-sm text-text-secondary">Only the account owner can connect {label}.</p>
          )}
        </>
      )}

      <ConfirmDialog
        open={!!confirm}
        title={`Disconnect ${confirm?.display_name ?? label}?`}
        description="Every location linked to it stops syncing and is unlinked. Nothing on the directory itself changes."
        confirmLabel="Disconnect"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const c = confirm;
          setConfirm(null);
          if (c) await run(`disc-${c.id}`, () => disconnectListingSource(c.id), 'Disconnected.');
        }}
      />
    </Card>
  );
}

export function ChannelsPanel({ data, isOwner, onChange }: { data: ListingsOverview; isOwner: boolean; onChange: (o: ListingsOverview) => void }) {
  const { busy, run } = useRun(onChange);
  const [auto, setAuto] = useState(data.settings.auto_sync);
  const [website, setWebsite] = useState(data.settings.website_url ?? '');
  const [description, setDescription] = useState(data.settings.description ?? '');

  useEffect(() => {
    setAuto(data.settings.auto_sync);
    setWebsite(data.settings.website_url ?? '');
    setDescription(data.settings.description ?? '');
  }, [data.settings]);

  const dirty = auto !== data.settings.auto_sync || website.trim() !== (data.settings.website_url ?? '') || description.trim() !== (data.settings.description ?? '');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-text-primary">Directories</h2>
        {data.links.length > 0 && (
          <Button type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={() => run('sync-all', () => syncListings())}>
            {busy === 'sync-all' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />} Sync all
          </Button>
        )}
      </div>

      <div className="space-y-4">
        {data.platforms.map((p) => <PlatformCard key={p.platform} info={p} data={data} isOwner={isOwner} busy={busy} run={run} />)}
      </div>

      <Card className="space-y-4 p-5 sm:p-6">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-text-primary"><Settings2 size={18} aria-hidden="true" /> Listing details &amp; automation</h2>
          <p className="mt-1 text-sm text-text-secondary">Name, address, phone and hours come from each location. These apply to every listing.</p>
        </div>

        <label className="flex cursor-pointer items-start gap-3">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="focus-ring mt-1 h-4 w-4 rounded border-border" />
          <span>
            <span className="block text-sm font-medium text-text-primary">Keep listings in sync automatically</span>
            <span className="block text-xs text-text-secondary">Checks every listing hourly, updates what directories allow, and alerts you in the notification bell when one drifts. Turn off to sync only when you press the button.</span>
          </span>
        </label>

        <Input label="Website" value={website} maxLength={300} placeholder="https://www.example.com" helperText="Shown on every listing. Leave empty to use your brand's website." onChange={(e) => setWebsite(e.target.value)} />
        <Textarea label="Business description" rows={4} maxLength={750} value={description} placeholder="Family-owned heating and cooling company serving Austin since 1998." helperText={`${description.length}/750`} onChange={(e) => setDescription(e.target.value)} />

        <Button type="button" size="sm" disabled={!dirty || busy !== null} onClick={() => run('settings', () => saveListingSettings({ autoSync: auto, websiteUrl: website, description }), 'Settings saved.')}>
          {busy === 'settings' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />} Save settings
        </Button>
      </Card>
    </div>
  );
}
