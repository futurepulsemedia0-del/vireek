import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { fetchRegionProfile, friendlyPestOpsError, setRegionProfile } from '@/lib/pestOpsApi';
import { fetchLogEntries } from '@/lib/tradePacksApi';
import {
  RECORD_FIELDS, RECORD_FIELD_LABELS, REGION_COUNSEL_NOTICE, REGION_PRESETS, summarizeCompleteness, validateRegionProfile,
  type RecordFieldKey, type RecordSource,
} from '@/lib/tradePacks/pestOps';
import { Pill } from '@/components/tradePacks/shared';
import { useResource } from './useResource';

export function RegionPanel({ ownerId, canManage }: { ownerId: string; canManage: boolean }) {
  const { toast } = useToast();
  const profile = useResource(() => fetchRegionProfile(ownerId));
  const entries = useResource(() => fetchLogEntries(ownerId, { packKey: 'pest_control', entryType: 'chemical_application', limit: 500 }));
  const [region, setRegion] = useState('US');
  const [fields, setFields] = useState<RecordFieldKey[]>(REGION_PRESETS[0].requiredFields);
  const [years, setYears] = useState('3');
  const [ack, setAck] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (profile.data) {
      setRegion(profile.data.region_code);
      setFields(profile.data.required_fields);
      setYears(String(profile.data.retention_years));
    }
  }, [profile.data]);

  const summary = useMemo(() => {
    const recs: RecordSource[] = (entries.data ?? []).filter((e) => !e.voided_at).map((e) => ({
      performed_at: e.performed_at, site_address: e.site_address, technician_name: e.technician_name, credential_number: e.credential_number,
      product_name: e.product_name, product_epa_reg: e.product_epa_reg, product_exempt: false, customer_name: null, data: e.data,
    }));
    return summarizeCompleteness(recs, fields);
  }, [entries.data, fields]);

  const toggle = (f: RecordFieldKey) => setFields((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]));
  const problems = validateRegionProfile({ regionCode: region, requiredFields: fields, retentionYears: Number(years) });

  const save = async () => {
    setSaving(true);
    try {
      await setRegionProfile({ region: region.trim(), fields, retentionYears: Number(years), acknowledge: ack });
      toast('Record rules saved', 'success');
      setAck(false);
      await profile.reload();
    } catch (e) {
      toast(friendlyPestOpsError(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (profile.loading && !profile.data && !profile.error) return <Skeleton className="h-40 w-full" />;
  if (profile.error) return <EmptyState variant="load-failed" title="Could not load record rules" description={profile.error} onRetry={() => void profile.reload()} />;

  return (
    <div className="space-y-4">
      <p role="note" className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-text-primary">{REGION_COUNSEL_NOTICE}</p>
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold text-text-primary">Required fields on every application record</h3>
          {profile.data?.counsel_acknowledged_at ? <Pill tone="success">reviewed</Pill> : <Pill tone="warning">not yet reviewed</Pill>}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Region code" value={region} onChange={(e) => setRegion(e.target.value)} helperText="e.g. US, US-TX, CA-ON, GB, AU-NSW" />
          <Input label="Keep records (years)" type="number" min={1} max={15} value={years} onChange={(e) => setYears(e.target.value)} />
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            {REGION_PRESETS.map((p) => <Button key={p.key} size="xs" variant="secondary" onClick={() => setFields(p.requiredFields)}>{p.label.split(' (')[0]} preset</Button>)}
          </div>
        )}
        <fieldset disabled={!canManage}>
          <legend className="sr-only">Required fields</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {RECORD_FIELDS.map((f) => (
              <label key={f} className="flex items-center gap-2 text-sm text-text-primary">
                <input type="checkbox" className="focus-ring h-4 w-4" checked={fields.includes(f)} onChange={() => toggle(f)} />
                {RECORD_FIELD_LABELS[f]}
              </label>
            ))}
          </div>
        </fieldset>
        {canManage && (
          <>
            <label className="flex items-start gap-2 text-sm text-text-primary">
              <input type="checkbox" className="focus-ring mt-0.5 h-4 w-4" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              I confirmed this list with my regulator or counsel for the region above.
            </label>
            {problems.length > 0 && <p className="text-sm text-danger" role="alert">{problems[0]}</p>}
            <Button size="sm" loading={saving} disabled={problems.length > 0} onClick={() => void save()}>Save rules</Button>
          </>
        )}
      </Card>

      <Card className="space-y-2 p-4">
        <h3 className="font-semibold text-text-primary">Completeness of recent records</h3>
        {entries.loading && !entries.data ? <Skeleton className="h-12 w-full" /> : entries.error ? (
          <p className="text-sm text-danger" role="alert">{entries.error}</p>
        ) : summary.total === 0 ? (
          <p className="text-sm text-text-secondary">No chemical applications recorded yet.</p>
        ) : (
          <>
            <p className="text-sm text-text-primary">{summary.complete} of {summary.total} records have every required field.</p>
            {summary.topMissing.length > 0 && (
              <ul className="text-sm text-text-secondary">
                {summary.topMissing.slice(0, 5).map((m) => <li key={m.field}>{RECORD_FIELD_LABELS[m.field]} — missing on {m.count}</li>)}
              </ul>
            )}
            <p className="text-xs text-text-secondary">Customer name is not stored on the ledger row, so it can show as missing here.</p>
          </>
        )}
      </Card>
    </div>
  );
}
