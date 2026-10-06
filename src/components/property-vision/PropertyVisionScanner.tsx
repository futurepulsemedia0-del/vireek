import { useEffect, useRef, useState } from 'react';
import { Camera, Loader2, ScanEye, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import {
  MAX_PV_PHOTOS, analyzePropertyPhotos, tryGetLocation, uploadPropertyPhoto,
  type PvAnalyzeResult, type PvScope,
} from '@/lib/propertyVision';

interface Props {
  scope: PvScope;
  /** Re-photograph a known unit: the AI compares against its memory + last photo. */
  assetId?: string | null;
  assetLabel?: string | null;
  onDone: (result: PvAnalyzeResult) => void;
  onCancel?: () => void;
}

interface Picked { id: string; file: File; url: string }

/** Pick/capture 1–4 photos, upload them privately, run the vision analysis, report back what changed. */
export function PropertyVisionScanner({ scope, assetId = null, assetLabel = null, onDone, onCancel }: Props) {
  const { toast } = useToast();
  const [picked, setPicked] = useState<Picked[]>([]);
  const [locationLabel, setLocationLabel] = useState('');
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'analyzing'>('idle');
  const inputRef = useRef<HTMLInputElement>(null);
  const urlsRef = useRef<string[]>([]);

  useEffect(() => () => { urlsRef.current.forEach((u) => URL.revokeObjectURL(u)); }, []);

  const busy = phase !== 'idle';

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const room = MAX_PV_PHOTOS - picked.length;
    const next = Array.from(list).filter((f) => f.type.startsWith('image/')).slice(0, room).map((file) => {
      const url = URL.createObjectURL(file);
      urlsRef.current.push(url);
      return { id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 7)}`, file, url };
    });
    if (list.length > room) toast(`You can analyze up to ${MAX_PV_PHOTOS} photos at a time.`, 'info');
    setPicked((p) => [...p, ...next]);
    if (inputRef.current) inputRef.current.value = '';
  };

  const remove = (id: string) => setPicked((p) => p.filter((x) => x.id !== id));

  const run = async () => {
    if (!picked.length || busy) return;
    try {
      setPhase('uploading');
      const geo = await tryGetLocation();
      const uploaded = await Promise.all(picked.map((p) => uploadPropertyPhoto(p.file, geo)));
      setPhase('analyzing');
      const result = await analyzePropertyPhotos(scope, uploaded, { locationLabel: locationLabel.trim(), assetId });
      onDone(result);
      setPicked([]);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not analyze these photos.', 'error');
    } finally {
      setPhase('idle');
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent/10 text-accent"><ScanEye size={16} /></span>
          <div>
            <h3 className="text-sm font-semibold text-text-primary">{assetId ? 'Re-scan this unit' : 'Scan equipment photos'}</h3>
            <p className="text-xs text-text-secondary">
              {assetId && assetLabel ? `Compared with what we remember about ${assetLabel}.` : 'Vireek identifies equipment, reads plates, flags hazards and remembers it all.'}
            </p>
          </div>
        </div>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={busy} aria-label="Close scanner" className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary">
            <X size={16} />
          </button>
        )}
      </div>

      <input ref={inputRef} type="file" accept="image/*" multiple capture="environment" className="sr-only" id="pv-file" onChange={(e) => addFiles(e.target.files)} disabled={busy} />

      {picked.length > 0 && (
        <ul className="mb-3 grid grid-cols-4 gap-2" aria-label="Selected photos">
          {picked.map((p) => (
            <li key={p.id} className="relative aspect-square overflow-hidden rounded-xl border border-border bg-bg-tertiary">
              <img src={p.url} alt="Selected equipment" className="h-full w-full object-cover" />
              {!busy && (
                <button type="button" onClick={() => remove(p.id)} aria-label="Remove photo" className="focus-ring absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white">
                  <X size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mb-3">
        <Input
          label="Where is this? (optional)"
          placeholder="e.g. Garage, basement mechanical room"
          maxLength={120}
          value={locationLabel}
          onChange={(e) => setLocationLabel(e.target.value)}
          disabled={busy}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" type="button" disabled={busy || picked.length >= MAX_PV_PHOTOS} onClick={() => inputRef.current?.click()}>
          <Camera size={16} /> {picked.length ? 'Add photo' : 'Take / choose photos'}
        </Button>
        <Button size="sm" type="button" disabled={!picked.length || busy} onClick={run}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <ScanEye size={16} />}
          {phase === 'uploading' ? 'Uploading…' : phase === 'analyzing' ? 'Analyzing…' : `Analyze ${picked.length || ''} photo${picked.length === 1 ? '' : 's'}`.replace('  ', ' ')}
        </Button>
      </div>
      <p className="mt-2 text-[11px] text-text-secondary">
        Photos stay private to your account. AI results are drafts — review before relying on them.
      </p>
    </div>
  );
}
