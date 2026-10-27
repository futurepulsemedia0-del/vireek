import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Filter } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { addRecipients } from '@/lib/directMailApi';
import {
  MAX_CAMPAIGN_RECIPIENTS, linkSegment, listSegments, resolveSegmentRecipients, type SegmentOption, type SegmentResolution,
} from '@/lib/directMailAudience';

const selectCls = 'focus-ring mt-1 block w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary';

/** Adds recipients from a saved audience (Dashboard → Audiences). Same rules the Audiences page counts. */
export function SegmentAudienceBox({ campaignId, ownerId, onDone }: { campaignId: string; ownerId: string; onDone: () => void }) {
  const { toast } = useToast();
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [segments, setSegments] = useState<SegmentOption[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<SegmentResolution | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      setSegments(await listSegments(ownerId));
      setState('ready');
    } catch {
      setState('error');
    }
  }, [ownerId]);

  useEffect(() => { void load(); }, [load]);

  const segment = segments.find((s) => s.id === selected) ?? null;

  const check = async () => {
    if (!segment) return;
    setBusy(true);
    try {
      const result = await resolveSegmentRecipients(ownerId, segment.filter);
      setPreview(result);
      if (!result.recipients.length) toast('No customer in this audience has an address that can be mailed.', 'error');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load this audience.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!segment || !preview?.recipients.length) return;
    setBusy(true);
    try {
      const s = await addRecipients(campaignId, preview.recipients);
      let note = '';
      try { await linkSegment(campaignId, segment.id); } catch { note = ' (the audience name could not be saved on the campaign)'; }
      toast(`Added ${s.inserted} recipient${s.inserted === 1 ? '' : 's'} from “${segment.name}”${s.suppressed ? ` · ${s.suppressed} on the do-not-mail list skipped` : ''}${s.duplicates ? ` · ${s.duplicates} already in the campaign` : ''}${note}.`, 'success');
      setPreview(null);
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not add recipients.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const tooMany = (preview?.recipients.length ?? 0) > MAX_CAMPAIGN_RECIPIENTS;

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-label="Add recipients from an audience">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><Filter size={16} className="text-accent" /> Add from a saved audience</h3>
      <p className="mt-1 text-xs text-text-secondary">Use a segment you already built, for example “inactive 12+ months” or “VIP”. Only customers with a mailing address can be mailed.</p>

      {state === 'loading' && <p role="status" className="mt-3 text-xs text-text-secondary">Loading audiences…</p>}
      {state === 'error' && (
        <p role="alert" className="mt-3 text-xs text-danger">Couldn’t load your audiences. <button type="button" className="focus-ring rounded underline" onClick={() => void load()}>Try again</button></p>
      )}
      {state === 'ready' && segments.length === 0 && (
        <p className="mt-3 text-xs text-text-secondary">You have no saved audiences yet. <Link to="/dashboard/audiences" className="focus-ring rounded text-accent underline">Create one in Audiences</Link>.</p>
      )}
      {state === 'ready' && segments.length > 0 && (
        <>
          <label className="mt-3 block text-xs font-medium text-text-secondary">Audience
            <select value={selected} onChange={(e) => { setSelected(e.target.value); setPreview(null); }} className={selectCls}>
              <option value="">Choose an audience…</option>
              {segments.map((s) => <option key={s.id} value={s.id} disabled={!s.mailable}>{s.name}{s.mailable ? '' : ' (leads have no address)'}</option>)}
            </select>
          </label>
          <div className="mt-3">
            <Button size="sm" variant="secondary" disabled={busy || !segment} onClick={() => void check()}>{busy && !preview ? 'Checking…' : 'Check audience'}</Button>
          </div>
        </>
      )}

      {preview && (
        <div className="mt-4 rounded-xl border border-border bg-bg-primary p-3 text-xs" role="status">
          <p className="font-medium text-text-primary">
            {preview.recipients.length.toLocaleString()} ready to mail · {preview.matched.toLocaleString()} in audience · {preview.noAddress.toLocaleString()} without an address · {preview.errors.length.toLocaleString()} unreadable · {preview.duplicates.toLocaleString()} duplicate{preview.duplicates === 1 ? '' : 's'}
          </p>
          {preview.truncated && <p className="mt-2 text-warning-500">This audience is very large, so only the first part was read. Narrow it in Audiences for a complete list.</p>}
          {tooMany && <p className="mt-2 text-danger">A campaign holds at most {MAX_CAMPAIGN_RECIPIENTS.toLocaleString()} recipients. Narrow the audience first.</p>}
          {preview.errors.length > 0 && (
            <ul className="mt-2 max-h-28 space-y-1 overflow-y-auto text-text-secondary">
              {preview.errors.slice(0, 10).map((e) => <li key={`${e.line}-${e.raw}`}>{e.raw}: {e.reason}</li>)}
              {preview.errors.length > 10 && <li>…and {preview.errors.length - 10} more</li>}
            </ul>
          )}
          <Button size="sm" className="mt-3" disabled={busy || tooMany || !preview.recipients.length} onClick={() => void add()}>
            {busy ? 'Adding…' : `Add ${preview.recipients.length.toLocaleString()} recipient${preview.recipients.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      )}
    </section>
  );
}
