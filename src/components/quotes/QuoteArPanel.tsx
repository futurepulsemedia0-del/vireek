/**
 * Technician side of the AR Product Visualizer (rendered on /dashboard/quotes/:id).
 *  - attach equipment models from the account library to this quote (optionally to one tier option)
 *  - upload a new model (GLB, optional USDZ) with its REAL dimensions
 *  - preview a model with an automatic SCALE CHECK (declared size vs. measured model size)
 *  - see whether the customer opened the preview / tried it in AR
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Box, Plus, RefreshCw, ScanLine, Trash2, TriangleAlert, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ArModelViewer, type ArReadyInfo } from '@/components/quotes/ArModelViewer';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { formatBytes } from '@/lib/quoteVideo';
import {
  AR_CATEGORIES,
  AR_CATEGORY_LABELS,
  MAX_PREVIEWS_PER_QUOTE,
  compareScale,
  describeArEngagement,
  formatDimensions,
  modelDimensions,
  modelSubtitle,
  optionLabel,
  optionRefs,
  parseLengthInput,
  type ArCategory,
  type ArModelRow,
  type ArPlacement,
  type ArPreviewRow,
  type ArTone,
  type ArUnit,
} from '@/lib/quoteAr';
import {
  archiveArModel,
  attachArModel,
  detachArPreview,
  listArModels,
  listQuoteArPreviews,
  signArModelPreview,
  uploadArModel,
} from '@/lib/quoteArApi';

const SECTION = 'rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5';
const SELECT =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary focus-visible:border-accent disabled:opacity-50';
const TONE: Record<ArTone, string> = {
  neutral: 'bg-bg-tertiary text-text-secondary',
  warning: 'bg-warning-500/10 text-warning-500',
  success: 'bg-success-500/10 text-success-500',
};

interface Props {
  quoteId: string;
  quoteStatus: string;
  /** `quote.options` - shape-checked inside. */
  rawOptions: unknown;
  customerName: string | null;
}

type ScaleResult = { ok: boolean; delta: number } | 'unavailable';

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong. Please try again.';
}

function UploadForm({ ownerId, onDone, onCancel }: { ownerId: string; onDone: () => void; onCancel: () => void }) {
  const { toast } = useToast();
  const [unit, setUnit] = useState<ArUnit>('in');
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [modelNumber, setModelNumber] = useState('');
  const [category, setCategory] = useState<ArCategory>('furnace');
  const [placement, setPlacement] = useState<ArPlacement>('floor');
  const [width, setWidth] = useState('');
  const [depth, setDepth] = useState('');
  const [height, setHeight] = useState('');
  const [clearance, setClearance] = useState('');
  const [glb, setGlb] = useState<File | null>(null);
  const [usdz, setUsdz] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const w = parseLengthInput(width, unit);
    const d = parseLengthInput(depth, unit);
    const h = parseLengthInput(height, unit);
    if (!name.trim()) return setError('Give the model a name.');
    if (!glb) return setError('Choose the .glb model file.');
    if (w === null || d === null || h === null) return setError('Enter the real width, depth and height of the unit.');
    const c = clearance.trim() ? parseLengthInput(clearance, unit) : 0;
    if (c === null) return setError('Service clearance must be a number (or leave it empty).');
    setSaving(true);
    try {
      await uploadArModel({
        ownerId,
        name,
        brand,
        modelNumber,
        category,
        placement,
        dimensions: { widthMm: w, depthMm: d, heightMm: h },
        clearanceMm: c,
        glb,
        usdz,
      });
      toast('Model added to your library', 'success');
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3 rounded-xl border border-border bg-bg-primary p-3" aria-label="Add AR model">
      <Input id="ar-name" label="Name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} required />
      <div className="grid gap-3 sm:grid-cols-2">
        <Input id="ar-brand" label="Brand (optional)" value={brand} maxLength={80} onChange={(e) => setBrand(e.target.value)} />
        <Input id="ar-modelno" label="Model number (optional)" value={modelNumber} maxLength={80} onChange={(e) => setModelNumber(e.target.value)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="ar-category" className="mb-1.5 block text-sm font-medium text-text-primary">Equipment type</label>
          <select id="ar-category" className={SELECT} value={category} onChange={(e) => setCategory(e.target.value as ArCategory)}>
            {AR_CATEGORIES.map((c) => (
              <option key={c} value={c}>{AR_CATEGORY_LABELS[c]}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ar-placement" className="mb-1.5 block text-sm font-medium text-text-primary">Placed on</label>
          <select id="ar-placement" className={SELECT} value={placement} onChange={(e) => setPlacement(e.target.value as ArPlacement)}>
            <option value="floor">Floor</option>
            <option value="wall">Wall</option>
          </select>
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-1 flex w-full items-center justify-between text-sm font-medium text-text-primary">
          <span>Real-world size</span>
          <span role="group" aria-label="Units" className="flex overflow-hidden rounded-lg border border-border">
            {(['in', 'cm'] as const).map((u) => (
              <button
                key={u}
                type="button"
                aria-pressed={unit === u}
                onClick={() => setUnit(u)}
                className={`focus-ring min-h-[36px] px-3 text-xs font-medium ${unit === u ? 'bg-accent text-white' : 'text-text-secondary'}`}
              >
                {u === 'in' ? 'in' : 'cm'}
              </button>
            ))}
          </span>
        </legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Input id="ar-w" label="Width" inputMode="decimal" value={width} onChange={(e) => setWidth(e.target.value)} required />
          <Input id="ar-d" label="Depth" inputMode="decimal" value={depth} onChange={(e) => setDepth(e.target.value)} required />
          <Input id="ar-h" label="Height" inputMode="decimal" value={height} onChange={(e) => setHeight(e.target.value)} required />
          <Input id="ar-clear" label="Service clearance" inputMode="decimal" value={clearance} onChange={(e) => setClearance(e.target.value)} />
        </div>
        <p className="text-xs text-text-secondary">
          Use the manufacturer’s spec sheet. This is what customers see, and what the scale check compares the 3D model against.
        </p>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="ar-glb" className="mb-1.5 block text-sm font-medium text-text-primary">3D model (.glb, required)</label>
          <input id="ar-glb" type="file" accept=".glb,model/gltf-binary" className="block w-full text-sm text-text-secondary" onChange={(e) => setGlb(e.target.files?.[0] ?? null)} />
        </div>
        <div>
          <label htmlFor="ar-usdz" className="mb-1.5 block text-sm font-medium text-text-primary">iPhone file (.usdz, optional)</label>
          <input id="ar-usdz" type="file" accept=".usdz,model/vnd.usdz+zip" className="block w-full text-sm text-text-secondary" onChange={(e) => setUsdz(e.target.files?.[0] ?? null)} />
        </div>
      </div>
      <p className="text-xs text-text-secondary">
        Export in metres (the glTF standard), up to 40 MB, and without Draco / KTX2 compression. Without a .usdz, iPhones build one from the .glb automatically.
      </p>

      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={saving}>{saving ? 'Uploading…' : 'Add to library'}</Button>
        <Button type="button" size="sm" variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </form>
  );
}

export function QuoteArPanel({ quoteId, quoteStatus, rawOptions, customerName }: Props) {
  const { accountOwnerId } = useAuth();
  const { toast } = useToast();
  const refs = optionRefs(rawOptions);

  const [previews, setPreviews] = useState<ArPreviewRow[] | null>(null);
  const [models, setModels] = useState<ArModelRow[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pickModel, setPickModel] = useState('');
  const [pickOption, setPickOption] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ modelId: string; glbUrl: string; usdzUrl: string | null } | null>(null);
  const [scale, setScale] = useState<Record<string, ScaleResult>>({});
  const [showLibrary, setShowLibrary] = useState(false);
  const requestRef = useRef(0);

  const open = quoteStatus === 'draft' || quoteStatus === 'sent';
  const atLimit = (previews?.length ?? 0) >= MAX_PREVIEWS_PER_QUOTE;

  const load = useCallback(async () => {
    if (!accountOwnerId) return;
    const id = ++requestRef.current;
    try {
      const [p, m] = await Promise.all([listQuoteArPreviews(quoteId), listArModels(accountOwnerId)]);
      if (id === requestRef.current) {
        setPreviews(p);
        setModels(m);
        setLoadError(false);
      }
    } catch {
      if (id === requestRef.current) setLoadError(true);
    }
  }, [quoteId, accountOwnerId]);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current++;
    };
  }, [load]);

  const handleAttach = async () => {
    if (!pickModel) return;
    setBusy(true);
    try {
      await attachArModel(quoteId, pickModel, pickOption || null);
      toast('AR preview added to this quote', 'success');
      setPickModel('');
      setPickOption('');
      await load();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDetach = async (p: ArPreviewRow) => {
    if (confirmId !== p.id) {
      setConfirmId(p.id);
      window.setTimeout(() => setConfirmId((c) => (c === p.id ? null : c)), 4000);
      return;
    }
    setBusyId(p.id);
    setConfirmId(null);
    try {
      await detachArPreview(p.id);
      toast('Removed from this quote', 'success');
      await load();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleArchive = async (m: ArModelRow) => {
    if (confirmId !== m.id) {
      setConfirmId(m.id);
      window.setTimeout(() => setConfirmId((c) => (c === m.id ? null : c)), 4000);
      return;
    }
    setBusyId(m.id);
    setConfirmId(null);
    try {
      await archiveArModel(m.id);
      toast('Model archived and removed from every quote', 'success');
      if (viewing?.modelId === m.id) setViewing(null);
      await load();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const openPreview = async (m: ArModelRow) => {
    setBusyId(m.id);
    try {
      const glbUrl = await signArModelPreview(m.glb_path);
      const usdzUrl = m.usdz_path ? await signArModelPreview(m.usdz_path) : null;
      setViewing({ modelId: m.id, glbUrl, usdzUrl });
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handlePreview = async (m: ArModelRow) => {
    if (viewing?.modelId === m.id) {
      setViewing(null);
      return;
    }
    await openPreview(m);
  };

  const handleReady = (m: ArModelRow, info: ArReadyInfo) => {
    if (!info.measured) {
      setScale((s) => ({ ...s, [m.id]: 'unavailable' }));
      return;
    }
    const result = compareScale(modelDimensions(m), info.measured);
    setScale((s) => ({ ...s, [m.id]: { ok: result.ok, delta: result.worstDelta } }));
  };

  const viewedModel = viewing ? models.find((m) => m.id === viewing.modelId) ?? null : null;
  const viewedScale = viewedModel ? scale[viewedModel.id] : undefined;

  return (
    <section className={SECTION} aria-labelledby="qd-ar">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="qd-ar" className="flex items-center gap-2 text-base font-semibold text-text-primary">
          <ScanLine size={16} aria-hidden="true" /> AR preview
        </h2>
        <Button size="sm" variant="ghost" onClick={() => void load()} aria-label="Refresh AR previews">
          <RefreshCw size={14} aria-hidden="true" />
        </Button>
      </div>

      <p className="mb-4 text-sm text-text-secondary">
        Let{customerName ? ` ${customerName}` : ' the customer'} see the proposed equipment at true size in their own space, straight from the quote link.
        Models you attach appear on the customer’s quote page once the quote is sent.
      </p>

      {/* ---------- attach ---------- */}
      {!open ? (
        <p className="mb-4 rounded-xl border border-border bg-bg-primary p-3 text-sm text-text-secondary">
          This quote has been answered, so previews can no longer be changed.
        </p>
      ) : adding ? (
        <div className="mb-4">
          {accountOwnerId ? (
            <UploadForm
              ownerId={accountOwnerId}
              onCancel={() => setAdding(false)}
              onDone={() => {
                setAdding(false);
                void load();
              }}
            />
          ) : null}
        </div>
      ) : atLimit ? (
        <p className="mb-4 rounded-xl border border-border bg-bg-primary p-3 text-sm text-text-secondary">
          This quote has {MAX_PREVIEWS_PER_QUOTE} AR previews, the maximum. Remove one to add another.
        </p>
      ) : (
        <div className="mb-4 space-y-3 rounded-xl border border-border bg-bg-primary p-3">
          {models.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="ar-pick-model" className="mb-1.5 block text-sm font-medium text-text-primary">Equipment</label>
                <select id="ar-pick-model" className={SELECT} value={pickModel} onChange={(e) => setPickModel(e.target.value)} disabled={busy}>
                  <option value="">Choose from your library…</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {modelSubtitle(m) ? ` — ${modelSubtitle(m)}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="ar-pick-option" className="mb-1.5 block text-sm font-medium text-text-primary">Show with</label>
                <select id="ar-pick-option" className={SELECT} value={pickOption} onChange={(e) => setPickOption(e.target.value)} disabled={busy}>
                  <option value="">All options</option>
                  {refs.map((o) => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </select>
              </div>
            </div>
          ) : (
            <p className="text-sm text-text-secondary">Your library is empty. Upload a 3D model to get started.</p>
          )}
          <div className="flex flex-wrap gap-2">
            {models.length > 0 ? (
              <Button size="sm" onClick={() => void handleAttach()} disabled={!pickModel || busy}>
                {busy ? 'Adding…' : 'Add to this quote'}
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" onClick={() => setAdding(true)} disabled={busy || !accountOwnerId}>
              <Plus size={14} aria-hidden="true" /> Upload new model
            </Button>
          </div>
        </div>
      )}

      {/* ---------- attached list ---------- */}
      {loadError ? (
        <p role="alert" className="text-sm text-danger">
          Could not load AR previews. <button className="underline" onClick={() => void load()}>Try again</button>
        </p>
      ) : previews === null ? (
        <p role="status" className="text-sm text-text-secondary">Loading AR previews…</p>
      ) : previews.length === 0 ? (
        <p className="text-sm text-text-secondary">Nothing attached to this quote yet.</p>
      ) : (
        <ul className="space-y-3">
          {previews.map((p) => {
            const eng = describeArEngagement(p);
            return (
              <li key={p.id} className="rounded-xl border border-border bg-bg-primary p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-semibold text-text-primary">{p.model?.name ?? 'Model unavailable'}</p>
                    <p className="text-xs text-text-secondary">
                      {p.model ? `${formatDimensions(modelDimensions(p.model), 'in')} · ` : ''}
                      {optionLabel(p.option_id, refs)}
                    </p>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${TONE[eng.tone]}`}>{eng.label}</span>
                </div>
                {open ? (
                  <div className="mt-3">
                    <Button size="sm" variant="ghost" onClick={() => void handleDetach(p)} disabled={busyId === p.id}>
                      <Trash2 size={14} aria-hidden="true" /> {confirmId === p.id ? 'Click again to confirm' : 'Remove from quote'}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {/* ---------- library ---------- */}
      <div className="mt-5 border-t border-border pt-4">
        <button
          type="button"
          className="focus-ring flex items-center gap-2 rounded-lg text-sm font-semibold text-text-primary"
          aria-expanded={showLibrary}
          onClick={() => setShowLibrary((v) => !v)}
        >
          <Box size={14} aria-hidden="true" /> Model library ({models.length})
        </button>

        {showLibrary ? (
          <div className="mt-3 space-y-3">
            {models.length === 0 ? (
              <p className="text-sm text-text-secondary">Models you upload are saved here and can be reused on any quote.</p>
            ) : (
              <ul className="space-y-3">
                {models.map((m) => {
                  const result = scale[m.id];
                  return (
                    <li key={m.id} className="rounded-xl border border-border bg-bg-primary p-3">
                      <p className="break-words text-sm font-semibold text-text-primary">{m.name}</p>
                      <p className="text-xs text-text-secondary">
                        {AR_CATEGORY_LABELS[m.category]}
                        {modelSubtitle(m) ? ` · ${modelSubtitle(m)}` : ''} · {formatBytes(m.glb_size_bytes)}
                        {m.usdz_path ? ' · iPhone file' : ''}
                      </p>
                      <p className="text-xs text-text-secondary">{formatDimensions(modelDimensions(m), 'in')}</p>
                      {result && result !== 'unavailable' ? (
                        <p
                          className={`mt-1 flex items-center gap-1.5 text-xs font-medium ${result.ok ? 'text-success-500' : 'text-warning-500'}`}
                        >
                          {result.ok ? <CheckCircle2 size={12} aria-hidden="true" /> : <TriangleAlert size={12} aria-hidden="true" />}
                          {result.ok
                            ? 'Scale check passed — the 3D model matches the entered size.'
                            : `Scale mismatch — the 3D model differs from the entered size by ${Math.round(result.delta * 100)}%. AR would show the wrong size; re-export in metres or correct the dimensions.`}
                        </p>
                      ) : null}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" onClick={() => void handlePreview(m)} disabled={busyId === m.id}>
                          {viewing?.modelId === m.id ? 'Hide preview' : 'Preview + scale check'}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void handleArchive(m)} disabled={busyId === m.id}>
                          <Trash2 size={14} aria-hidden="true" /> {confirmId === m.id ? 'Click again to confirm' : 'Archive'}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {viewing && viewedModel ? (
              <div className="rounded-xl border border-border bg-bg-primary p-3">
                <ArModelViewer
                  name={viewedModel.name}
                  glbUrl={viewing.glbUrl}
                  usdzUrl={viewing.usdzUrl}
                  placement={viewedModel.placement}
                  onReady={(info) => handleReady(viewedModel, info)}
                  onRetry={() => void openPreview(viewedModel)}
                />
                {viewedScale === 'unavailable' ? (
                  <p className="mt-2 text-xs text-text-secondary">Scale check isn’t available in this browser.</p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
