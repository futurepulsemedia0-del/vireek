import { useEffect, useState } from 'react';
import { PackageCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { friendlyPackError, publishPackVersion, publishedVersions, setPackEntitlement } from '@/lib/packsApi';
import { PACK_VERSIONS, formatIssues, listPackIds, validatePack } from '@/lib/packs';

export function StaffPacksPage() {
  const { toast } = useToast();
  const [published, setPublished] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tenant, setTenant] = useState('');
  const [pack, setPack] = useState(listPackIds()[0]);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const load = async () => {
    try {
      setPublished(new Set((await publishedVersions()).map((v) => `${v.pack_id}@${v.version}`)));
      setError(null);
    } catch (e) {
      setError(friendlyPackError(e));
    }
  };
  useEffect(() => { void load(); }, []);

  const publish = async (id: string, version: string) => {
    const manifest = PACK_VERSIONS.find((p) => p.id === id && p.version === version);
    if (!manifest) return;
    const check = validatePack(manifest);
    if (!check.ok) return toast(formatIssues(check.issues).slice(0, 300), 'error');
    setBusy(`${id}@${version}`);
    try {
      await publishPackVersion(manifest);
      toast(`Published ${id}@${version}`, 'success');
      await load();
    } catch (e) {
      toast(friendlyPackError(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const entitle = async (granted: boolean) => {
    setBusy('ent');
    try {
      await setPackEntitlement(tenant.trim(), pack, granted);
      toast(granted ? 'Entitlement granted' : 'Entitlement revoked', 'success');
    } catch (e) {
      toast(friendlyPackError(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-8">
      <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><PackageCheck size={24} aria-hidden="true" /> Trade pack publishing</h1>
      {error && <Card className="p-4 text-sm text-danger" role="alert">{error}</Card>}
      <Card className="space-y-2 p-5">
        <h2 className="font-semibold text-text-primary">Versions in this build</h2>
        {!published ? <Skeleton className="h-20 w-full" /> : (
          <ul className="space-y-2 text-sm">
            {PACK_VERSIONS.map((p) => {
              const tag = `${p.id}@${p.version}`;
              const done = published.has(tag);
              return (
                <li key={tag} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-xs">{tag}</span>
                  {done ? <span className="text-text-secondary">Published</span> : <Button size="xs" loading={busy === tag} onClick={() => publish(p.id, p.version)}>Publish</Button>}
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-xs text-text-secondary">Publish in ascending version order. Published versions can never be changed.</p>
      </Card>
      <Card className="space-y-3 p-5">
        <h2 className="font-semibold text-text-primary">Account entitlement (packs:&lt;id&gt;)</h2>
        <label className="block text-sm">Account owner id (UUID)
          <input className="mt-1 w-full rounded-xl border border-border bg-bg-primary p-2 font-mono text-xs" value={tenant} onChange={(e) => setTenant(e.target.value)} inputMode="text" autoComplete="off" />
        </label>
        <label className="block text-sm">Pack
          <select className="mt-1 w-full rounded-xl border border-border bg-bg-primary p-2" value={pack} onChange={(e) => setPack(e.target.value)}>
            {listPackIds().map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        <div className="flex gap-2">
          <Button disabled={!UUID.test(tenant.trim())} disabledReason="Enter a valid UUID" loading={busy === 'ent'} onClick={() => entitle(true)}>Grant</Button>
          <Button variant="secondary" disabled={!UUID.test(tenant.trim())} disabledReason="Enter a valid UUID" onClick={() => entitle(false)}>Revoke</Button>
        </div>
      </Card>
    </div>
  );
}
