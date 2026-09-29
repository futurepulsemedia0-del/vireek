import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BadgeCheck,
  Bot,
  CornerDownRight,
  FileDown,
  Link2,
  Loader2,
  MapPin,
  Paperclip,
  Pencil,
  Plus,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  User,
  X,
} from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import type { Job } from '@/lib/supabase';
import {
  EVIDENCE_STAGES,
  GAP_LABELS,
  KIND_LABELS,
  LEVEL_META,
  MAX_MEDIA_PER_ENTRY,
  STAGE_KINDS,
  STAGE_META,
  addChainEntry,
  buildMeasurementPayload,
  fetchChainEntries,
  fetchChainReport,
  getChainMediaUrl,
  shortHash,
  uploadChainMedia,
  validateMediaFile,
  type ChainReport,
  type EvidenceEntry,
  type EvidenceKind,
  type EvidenceMedia,
  type EvidenceStage,
  type MeasurementPhase,
} from '@/lib/jobEvidenceChain';

// ============================================================
// SMALL HELPERS
// ============================================================

const TONE_BOX = {
  success: 'border-success-500/30 bg-success-500/5',
  warning: 'border-warning-500/30 bg-warning-500/5',
  danger: 'border-danger/30 bg-danger/5',
  neutral: 'border-border bg-bg-primary',
} as const;

const TONE_TEXT = {
  success: 'text-success-500',
  warning: 'text-warning-500',
  danger: 'text-danger',
  neutral: 'text-text-secondary',
} as const;

const INPUT_CLS = 'w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';
const LABEL_CLS = 'mb-1 block text-xs font-medium text-text-secondary';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function parseOptionalNumber(value: string): number | null {
  const v = value.trim();
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function getPosition(): Promise<{ latitude: number; longitude: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          latitude: Number(p.coords.latitude.toFixed(5)),
          longitude: Number(p.coords.longitude.toFixed(5)),
        }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 30000 },
    );
  });
}

/** Human-readable chips describing the structured payload of an entry. */
function payloadChips(e: EvidenceEntry): string[] {
  const p = e.payload ?? {};
  const chips: string[] = [];
  if (e.kind === 'measurement' && p.label != null) {
    chips.push(`${String(p.label)}: ${String(p.value ?? '')} ${String(p.unit ?? '')}`.trim());
    if (p.phase) chips.push(String(p.phase));
    if (p.in_range === true) chips.push('in range');
    if (p.in_range === false) chips.push('out of range');
  }
  if (e.kind === 'test') chips.push(`${String(p.name ?? 'Test')}: ${p.passed === true ? 'passed' : 'failed'}`);
  if (e.kind === 'part') {
    if (p.part_name) chips.push(String(p.part_name));
    if (p.quantity) chips.push(`qty ${String(p.quantity)}`);
    if (p.serial_number) chips.push(`S/N ${String(p.serial_number)}`);
  }
  if (e.kind === 'media' && p.phase) chips.push(String(p.phase));
  if (e.kind === 'approval' && p.method) chips.push(String(p.method).replace(/_/g, ' '));
  if (e.stage === 'result' && p.outcome) chips.push(String(p.outcome).replace(/_/g, ' '));
  if (p.replaces_part === true) chips.push('replaces a part');
  if (p.emergency === true) chips.push('emergency');
  return chips;
}

/** Stages reachable by following `refs` transitively (mirrors the server-side linkage rule). */
function ancestorStages(refIds: string[], byId: Map<string, EvidenceEntry>): Set<EvidenceStage> {
  const seen = new Set<string>();
  const stages = new Set<EvidenceStage>();
  const queue = [...refIds];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) continue;
    stages.add(entry.stage);
    queue.push(...entry.refs);
  }
  return stages;
}

// ============================================================
// MEDIA THUMBNAIL (signed URL fetched lazily)
// ============================================================

function MediaThumb({ media }: { media: EvidenceMedia }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getChainMediaUrl(media.path).then((u) => {
      if (!cancelled) setUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [media.path]);

  const label = media.name ?? media.path.split('/').pop() ?? 'file';
  const isImage = media.mime.startsWith('image/') && media.mime !== 'image/heic';

  return (
    <a
      href={url ?? undefined}
      target="_blank"
      rel="noreferrer"
      title={`${label} · SHA-256 ${media.sha256.slice(0, 16)}…`}
      className="focus-ring flex h-14 w-14 items-center justify-center overflow-hidden rounded-lg border border-border bg-bg-secondary text-[10px] text-text-secondary"
    >
      {url && isImage ? (
        <img src={url} alt={label} className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <span className="px-1 text-center leading-tight">{media.mime.split('/')[1]?.toUpperCase() ?? 'FILE'}</span>
      )}
    </a>
  );
}

// ============================================================
// ONE TIMELINE ENTRY
// ============================================================

function EntryCard({
  entry,
  byId,
  superseded,
  onCorrect,
}: {
  entry: EvidenceEntry;
  byId: Map<string, EvidenceEntry>;
  superseded: boolean;
  onCorrect: (e: EvidenceEntry) => void;
}) {
  const automatic = entry.actor_type === 'system' || entry.actor_type === 'customer' || entry.actor_type === 'ai';
  const ActorIcon = entry.actor_type === 'ai' ? Bot : automatic ? BadgeCheck : User;
  const chips = payloadChips(entry);
  const because = entry.refs.map((id) => byId.get(id)).filter((r): r is EvidenceEntry => !!r);
  const corrected = entry.supersedes_id ? byId.get(entry.supersedes_id) : undefined;

  return (
    <li className={`rounded-lg border border-border/70 bg-bg-primary p-3 ${superseded ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-secondary">
        <span className="font-semibold text-accent">#{entry.seq}</span>
        <span className="rounded-full border border-border px-2 py-0.5">{STAGE_META[entry.stage].label}</span>
        <span>{KIND_LABELS[entry.kind]}</span>
        <span className="flex items-center gap-1">
          <ActorIcon size={11} className={automatic ? 'text-success-500' : ''} />
          {entry.actor_name ?? entry.actor_type}
        </span>
        <span className="ml-auto">{formatTime(entry.recorded_at)}</span>
      </div>

      <p className={`mt-1.5 text-sm font-medium text-text-primary ${superseded ? 'line-through' : ''}`}>{entry.title}</p>
      {entry.detail && <p className="mt-0.5 whitespace-pre-line text-xs text-text-secondary">{entry.detail}</p>}

      {chips.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {chips.map((c, i) => (
            <span key={`${c}-${i}`} className="rounded-md bg-bg-secondary px-1.5 py-0.5 text-[11px] text-text-primary">
              {c}
            </span>
          ))}
        </div>
      )}

      {because.length > 0 && (
        <p className="mt-1.5 flex items-start gap-1 text-[11px] text-text-secondary">
          <CornerDownRight size={11} className="mt-0.5 shrink-0" />
          <span>
            Because of: {because.map((b) => `#${b.seq} ${b.title}`).join(' · ')}
          </span>
        </p>
      )}

      {entry.media.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {entry.media.map((m) => (
            <MediaThumb key={m.path} media={m} />
          ))}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-text-secondary">
        <span title={entry.entry_hash} className="font-mono">
          hash {shortHash(entry.entry_hash)}
        </span>
        {entry.latitude != null && entry.longitude != null && (
          <span className="flex items-center gap-0.5">
            <MapPin size={10} /> GPS
          </span>
        )}
        {corrected && <span className="text-warning-500">Corrects #{corrected.seq}</span>}
        {superseded && <span className="text-warning-500">Superseded</span>}
        {!superseded && entry.actor_type !== 'system' && entry.actor_type !== 'customer' && entry.actor_type !== 'ai' && (
          <button
            type="button"
            onClick={() => onCorrect(entry)}
            className="focus-ring ml-auto flex items-center gap-1 text-text-secondary hover:text-accent"
          >
            <Pencil size={10} /> Correct
          </button>
        )}
      </div>
    </li>
  );
}

// ============================================================
// ADD / CORRECT ENTRY FORM
// ============================================================

function EntryForm({
  jobId,
  entries,
  correcting,
  onDone,
  onCancel,
}: {
  jobId: string;
  entries: EvidenceEntry[];
  correcting: EvidenceEntry | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [stage, setStage] = useState<EvidenceStage>(correcting?.stage ?? 'diagnosis');
  const [kind, setKind] = useState<Exclude<EvidenceKind, 'system'>>(
    correcting && correcting.kind !== 'system' ? correcting.kind : 'statement',
  );
  const [title, setTitle] = useState(correcting?.title ?? '');
  const [detail, setDetail] = useState(correcting?.detail ?? '');
  const [refs, setRefs] = useState<Set<string>>(new Set(correcting?.refs ?? []));
  const [files, setFiles] = useState<File[]>([]);
  const [attachLocation, setAttachLocation] = useState(false);

  // measurement
  const [mLabel, setMLabel] = useState('');
  const [mValue, setMValue] = useState('');
  const [mUnit, setMUnit] = useState('');
  const [mPhase, setMPhase] = useState<MeasurementPhase>('before');
  const [mMin, setMMin] = useState('');
  const [mMax, setMMax] = useState('');
  // test
  const [tName, setTName] = useState('');
  const [tPassed, setTPassed] = useState<'pass' | 'fail'>('pass');
  // part
  const [pName, setPName] = useState('');
  const [pQty, setPQty] = useState('1');
  const [pSerial, setPSerial] = useState('');
  // approval / media / work / result
  const [aMethod, setAMethod] = useState('verbal_on_site');
  const [mediaPhase, setMediaPhase] = useState<MeasurementPhase>('before');
  const [replacesPart, setReplacesPart] = useState(false);
  const [emergency, setEmergency] = useState(false);
  const [outcome, setOutcome] = useState('resolved');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const stageIdx = EVIDENCE_STAGES.indexOf(stage);
  const candidates = useMemo(() => {
    const superseded = new Set(entries.map((e) => e.supersedes_id).filter((v): v is string => !!v));
    return entries.filter(
      (e) => !superseded.has(e.id) && e.payload?.snapshot !== true && EVIDENCE_STAGES.indexOf(e.stage) < stageIdx,
    );
  }, [entries, stageIdx]);

  const linkedStages = useMemo(() => ancestorStages([...refs], byId), [refs, byId]);
  const needsDiagnosis = (stage === 'work' || stage === 'part' || stage === 'recommendation') && !linkedStages.has('diagnosis');
  const needsEvidence = (stage === 'work' || stage === 'part') && !linkedStages.has('evidence');

  const changeStage = (next: EvidenceStage) => {
    setStage(next);
    const allowed = STAGE_KINDS[next];
    if (!allowed.includes(kind)) setKind(allowed[0]);
    setRefs(new Set());
  };

  const toggleRef = (id: string) =>
    setRefs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onFiles = (list: FileList | null) => {
    if (!list) return;
    const picked = Array.from(list);
    for (const f of picked) {
      const problem = validateMediaFile(f);
      if (problem) {
        setError(problem);
        return;
      }
    }
    setError(null);
    setFiles((prev) => [...prev, ...picked].slice(0, MAX_MEDIA_PER_ENTRY));
    if (fileRef.current) fileRef.current.value = '';
  };

  const submit = async () => {
    setError(null);
    const titleTrim = title.trim();
    if (titleTrim.length < 3) {
      setError('Add a short, specific title (at least 3 characters).');
      return;
    }

    let payload: Record<string, unknown> = {};
    if (kind === 'measurement') {
      const value = Number(mValue);
      if (!mLabel.trim() || mValue.trim() === '' || !Number.isFinite(value)) {
        setError('A measurement needs a label and a numeric value.');
        return;
      }
      payload = buildMeasurementPayload({
        label: mLabel,
        value,
        unit: mUnit,
        phase: mPhase,
        expectedMin: parseOptionalNumber(mMin),
        expectedMax: parseOptionalNumber(mMax),
      });
    } else if (kind === 'test') {
      if (!tName.trim()) {
        setError('Name the test that was performed (e.g. "Amp draw under load").');
        return;
      }
      payload = { name: tName.trim(), passed: tPassed === 'pass' };
    } else if (kind === 'part') {
      if (!pName.trim()) {
        setError('Enter the part name.');
        return;
      }
      const qty = Math.max(1, Math.floor(Number(pQty) || 1));
      payload = {
        part_name: pName.trim(),
        quantity: qty,
        ...(pSerial.trim() ? { serial_number: pSerial.trim() } : {}),
      };
    } else if (kind === 'approval') {
      payload = { method: aMethod };
    } else if (kind === 'media') {
      if (files.length === 0) {
        setError('Attach at least one photo or video.');
        return;
      }
      payload = { phase: mediaPhase };
    }

    if (stage === 'work') payload = { ...payload, replaces_part: replacesPart, ...(emergency ? { emergency: true } : {}) };
    if (stage === 'result') payload = { ...payload, outcome };

    setSubmitting(true);
    try {
      const [uploaded, position] = await Promise.all([
        Promise.all(files.map((f) => uploadChainMedia(jobId, f))),
        attachLocation ? getPosition() : Promise.resolve(null),
      ]);
      if (attachLocation && !position) toast('Could not read your location — saved without it.', 'info');

      await addChainEntry({
        jobId,
        stage,
        kind,
        title: titleTrim,
        detail,
        payload,
        media: uploaded,
        refs: [...refs],
        supersedesId: correcting?.id ?? null,
        latitude: position?.latitude ?? null,
        longitude: position?.longitude ?? null,
      });
      toast(correcting ? 'Correction sealed into the chain.' : 'Evidence sealed into the chain.', 'success');
      onDone();
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      setError(message.includes('JOB_EVIDENCE_CHAIN_INVALID') ? message.split(':').slice(1).join(':').trim() : 'Could not save this entry. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-accent/30 bg-accent/5 p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-text-primary">
          {correcting ? `Correct entry #${correcting.seq}` : 'Add evidence'}
        </p>
        <button type="button" onClick={onCancel} aria-label="Close form" className="focus-ring text-text-secondary hover:text-text-primary">
          <X size={16} />
        </button>
      </div>

      {correcting && (
        <p className="text-xs text-text-secondary">
          The original stays in the chain (marked superseded). This creates a new sealed entry that replaces it.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={LABEL_CLS}>Stage</label>
          <select value={stage} onChange={(e) => changeStage(e.target.value as EvidenceStage)} disabled={!!correcting} className={INPUT_CLS}>
            {EVIDENCE_STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_META[s].label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={LABEL_CLS}>Type</label>
          <select value={kind} onChange={(e) => setKind(e.target.value as Exclude<EvidenceKind, 'system'>)} className={INPUT_CLS}>
            {STAGE_KINDS[stage].map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="-mt-1 text-[11px] text-text-secondary">{STAGE_META[stage].question}</p>

      <div>
        <label className={LABEL_CLS}>Title</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          placeholder={stage === 'work' ? 'e.g. Replaced compressor and recharged R410A' : 'Short, specific title'}
          className={INPUT_CLS}
        />
      </div>
      <div>
        <label className={LABEL_CLS}>Details (optional)</label>
        <textarea value={detail} onChange={(e) => setDetail(e.target.value)} rows={2} maxLength={4000} className={INPUT_CLS} />
      </div>

      {kind === 'measurement' && (
        <div className="grid grid-cols-2 gap-2 rounded-lg border border-border/70 p-2">
          <div className="col-span-2">
            <label className={LABEL_CLS}>What was measured</label>
            <input value={mLabel} onChange={(e) => setMLabel(e.target.value)} placeholder="e.g. Compressor amp draw" className={INPUT_CLS} />
          </div>
          <div>
            <label className={LABEL_CLS}>Value</label>
            <input value={mValue} onChange={(e) => setMValue(e.target.value)} inputMode="decimal" className={INPUT_CLS} />
          </div>
          <div>
            <label className={LABEL_CLS}>Unit</label>
            <input value={mUnit} onChange={(e) => setMUnit(e.target.value)} placeholder="A, psi, °F…" className={INPUT_CLS} />
          </div>
          <div>
            <label className={LABEL_CLS}>Phase</label>
            <select value={mPhase} onChange={(e) => setMPhase(e.target.value as MeasurementPhase)} className={INPUT_CLS}>
              <option value="before">Before repair</option>
              <option value="during">During</option>
              <option value="after">After repair</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={LABEL_CLS}>Expected min</label>
              <input value={mMin} onChange={(e) => setMMin(e.target.value)} inputMode="decimal" className={INPUT_CLS} />
            </div>
            <div>
              <label className={LABEL_CLS}>Expected max</label>
              <input value={mMax} onChange={(e) => setMMax(e.target.value)} inputMode="decimal" className={INPUT_CLS} />
            </div>
          </div>
        </div>
      )}

      {kind === 'test' && (
        <div className="grid grid-cols-2 gap-2 rounded-lg border border-border/70 p-2">
          <div>
            <label className={LABEL_CLS}>Test performed</label>
            <input value={tName} onChange={(e) => setTName(e.target.value)} placeholder="e.g. Amp draw under load" className={INPUT_CLS} />
          </div>
          <div>
            <label className={LABEL_CLS}>Result</label>
            <select value={tPassed} onChange={(e) => setTPassed(e.target.value as 'pass' | 'fail')} className={INPUT_CLS}>
              <option value="pass">Passed</option>
              <option value="fail">Failed</option>
            </select>
          </div>
        </div>
      )}

      {kind === 'part' && (
        <div className="grid grid-cols-3 gap-2 rounded-lg border border-border/70 p-2">
          <div className="col-span-2">
            <label className={LABEL_CLS}>Part</label>
            <input value={pName} onChange={(e) => setPName(e.target.value)} placeholder="Part name / number" className={INPUT_CLS} />
          </div>
          <div>
            <label className={LABEL_CLS}>Qty</label>
            <input value={pQty} onChange={(e) => setPQty(e.target.value)} inputMode="numeric" className={INPUT_CLS} />
          </div>
          <div className="col-span-3">
            <label className={LABEL_CLS}>Serial number (optional)</label>
            <input value={pSerial} onChange={(e) => setPSerial(e.target.value)} className={INPUT_CLS} />
          </div>
        </div>
      )}

      {kind === 'approval' && (
        <div>
          <label className={LABEL_CLS}>How was approval given?</label>
          <select value={aMethod} onChange={(e) => setAMethod(e.target.value)} className={INPUT_CLS}>
            <option value="verbal_on_site">Verbal, on site</option>
            <option value="phone">By phone</option>
            <option value="text_or_email">Text / email</option>
            <option value="signed_document">Signed document</option>
          </select>
        </div>
      )}

      {kind === 'media' && (
        <div>
          <label className={LABEL_CLS}>Phase</label>
          <select value={mediaPhase} onChange={(e) => setMediaPhase(e.target.value as MeasurementPhase)} className={INPUT_CLS}>
            <option value="before">Before repair</option>
            <option value="during">During</option>
            <option value="after">After repair</option>
          </select>
        </div>
      )}

      {stage === 'work' && (
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-xs text-text-primary">
            <input type="checkbox" checked={replacesPart} onChange={(e) => setReplacesPart(e.target.checked)} className="h-4 w-4 rounded border-border" />
            This work replaces a part (a Part entry will be required)
          </label>
          <label className="flex items-center gap-2 text-xs text-text-primary">
            <input type="checkbox" checked={emergency} onChange={(e) => setEmergency(e.target.checked)} className="h-4 w-4 rounded border-border" />
            Emergency work (started before approval for safety)
          </label>
        </div>
      )}

      {stage === 'result' && (
        <div>
          <label className={LABEL_CLS}>Outcome</label>
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)} className={INPUT_CLS}>
            <option value="resolved">Resolved</option>
            <option value="partially_resolved">Partially resolved</option>
            <option value="deferred">Deferred (parts / customer decision)</option>
            <option value="unresolved">Unresolved</option>
          </select>
        </div>
      )}

      {candidates.length > 0 && stage !== 'problem' && (
        <details className="rounded-lg border border-border/70 p-2" open={stage === 'work' || stage === 'part'}>
          <summary className="cursor-pointer text-xs font-medium text-text-secondary">
            Because of… (link the entries that justify this — {refs.size} selected)
          </summary>
          <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
            {candidates.map((c) => (
              <label key={c.id} className="flex items-start gap-2 text-xs text-text-primary">
                <input type="checkbox" checked={refs.has(c.id)} onChange={() => toggleRef(c.id)} className="mt-0.5 h-3.5 w-3.5 rounded border-border" />
                <span>
                  <span className="text-text-secondary">
                    #{c.seq} {STAGE_META[c.stage].label} ·{' '}
                  </span>
                  {c.title}
                </span>
              </label>
            ))}
          </div>
        </details>
      )}

      {(needsDiagnosis || needsEvidence) && (
        <p className="flex items-start gap-1.5 rounded-lg bg-warning-500/10 px-2.5 py-1.5 text-[11px] text-warning-500">
          <ShieldAlert size={12} className="mt-0.5 shrink-0" />
          Not yet linked to {needsDiagnosis && needsEvidence ? 'a diagnosis and evidence' : needsDiagnosis ? 'a diagnosis' : 'evidence'} — the chain will flag this as unsupported.
        </p>
      )}

      <div>
        <div className="flex items-center justify-between">
          <label className={LABEL_CLS}>Photos / video (optional{kind === 'media' ? ' — required' : ''})</label>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={files.length >= MAX_MEDIA_PER_ENTRY}
            className="focus-ring mb-1 flex items-center gap-1 text-xs font-medium text-accent disabled:opacity-50"
          >
            <Paperclip size={12} /> Attach
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/mp4,video/quicktime,video/webm,application/pdf"
          capture="environment"
          multiple
          hidden
          onChange={(e) => onFiles(e.target.files)}
        />
        {files.length > 0 && (
          <ul className="space-y-1">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center justify-between rounded-md bg-bg-secondary px-2 py-1 text-xs text-text-primary">
                <span className="truncate">{f.name}</span>
                <button
                  type="button"
                  onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                  aria-label={`Remove ${f.name}`}
                  className="focus-ring ml-2 text-text-secondary hover:text-danger"
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-[10px] text-text-secondary">Each file is fingerprinted (SHA-256) on this device before upload and sealed into the chain.</p>
      </div>

      <label className="flex items-center gap-2 text-xs text-text-primary">
        <input type="checkbox" checked={attachLocation} onChange={(e) => setAttachLocation(e.target.checked)} className="h-4 w-4 rounded border-border" />
        <MapPin size={12} /> Attach my current location
      </label>

      {error && <p className="rounded-lg bg-danger/10 px-2.5 py-1.5 text-xs text-danger">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          className="focus-ring flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {submitting && <Loader2 size={12} className="animate-spin" />}
          {submitting ? 'Sealing…' : correcting ? 'Seal correction' : 'Seal into chain'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="focus-ring rounded-lg border border-border px-3 py-2 text-xs text-text-secondary hover:text-text-primary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ============================================================
// PANEL
// ============================================================

export function JobEvidenceChainPanel({ job, defaultExpanded = false }: { job: Job; defaultExpanded?: boolean }) {
  const { toast } = useToast();
  const [report, setReport] = useState<ChainReport | null>(null);
  const [entries, setEntries] = useState<EvidenceEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [formOpen, setFormOpen] = useState(false);
  const [correcting, setCorrecting] = useState<EvidenceEntry | null>(null);
  const [exporting, setExporting] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const [r, list] = await Promise.all([fetchChainReport(job.id), fetchChainEntries(job.id)]);
      if (!alive.current) return;
      setReport(r);
      setEntries(list);
    } catch {
      // panel keeps its last known state (also covers "migration not applied yet")
    } finally {
      if (alive.current) setLoaded(true);
    }
  }, [job.id]);

  useEffect(() => {
    void load();
  }, [load, job.job_status]);

  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const supersededIds = useMemo(() => new Set(entries.map((e) => e.supersedes_id).filter((v): v is string => !!v)), [entries]);
  const visibleEntries = useMemo(() => entries.filter((e) => e.payload?.snapshot !== true), [entries]);

  const handleExport = async () => {
    if (!report) return;
    setExporting(true);
    try {
      const { exportEvidenceChainPdf } = await import('@/lib/jobEvidenceChainPdf');
      await exportEvidenceChainPdf({
        job: { id: job.id, customer_name: job.customer_name, service_type: job.service_type, address: job.address },
        entries,
        report,
      });
    } catch {
      toast('Could not export the evidence report.', 'error');
    } finally {
      setExporting(false);
    }
  };

  const openForm = (entry: EvidenceEntry | null) => {
    setCorrecting(entry);
    setFormOpen(true);
    setExpanded(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setCorrecting(null);
  };

  if (!loaded || !report) return null;

  const level = LEVEL_META[report.level];
  const blocking = report.gaps.filter((g) => g.severity === 'blocking');
  const advisory = report.gaps.filter((g) => g.severity === 'advisory');
  const LevelIcon = report.level === 'compromised' || report.level === 'weak' ? ShieldX : report.level === 'partial' ? ShieldAlert : report.level === 'not_started' ? Link2 : ShieldCheck;

  return (
    <div className={`rounded-xl border p-4 ${TONE_BOX[level.tone]}`}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="focus-ring flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <LevelIcon size={16} className={TONE_TEXT[level.tone]} />
          Evidence Chain —{' '}
          {report.level === 'not_started' ? 'not started' : `${report.score}/100 · ${level.label}`}
        </span>
        <span className="text-xs text-text-secondary">{expanded ? 'Hide' : 'Details'}</span>
      </button>

      {!report.integrity.valid && (
        <p className="mt-1.5 text-xs font-medium text-danger">
          Integrity check failed at entry #{report.integrity.broken_seq} ({report.integrity.reason?.replace(/_/g, ' ')}). Do not rely on this chain.
        </p>
      )}
      {report.integrity.valid && blocking.length > 0 && (
        <p className="mt-1.5 text-xs text-text-secondary">
          Missing: {blocking.map((g) => GAP_LABELS[g.key] ?? g.key).join(' · ')}
        </p>
      )}

      {expanded && (
        <div className="mt-3 space-y-4 border-t border-border/60 pt-3">
          {/* Stage rail */}
          <ol className="flex flex-wrap gap-1" aria-label="Chain stages">
            {report.stages.map((s) => (
              <li
                key={s.stage}
                title={STAGE_META[s.stage].question}
                className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                  s.status === 'complete'
                    ? 'border-success-500/40 bg-success-500/10 text-success-500'
                    : s.status === 'missing'
                      ? 'border-warning-500/40 bg-warning-500/10 text-warning-500'
                      : 'border-border text-text-secondary line-through opacity-60'
                }`}
              >
                {STAGE_META[s.stage].label}
                {s.status !== 'not_applicable' && s.count > 0 ? ` · ${s.count}` : ''}
              </li>
            ))}
          </ol>

          {(blocking.length > 0 || advisory.length > 0) && (
            <ul className="space-y-1 text-xs">
              {blocking.map((g) => (
                <li key={g.key} className="flex items-center gap-2 font-medium text-text-primary">
                  <span className="h-1.5 w-1.5 rounded-full bg-warning-500" />
                  {GAP_LABELS[g.key] ?? g.key}
                </li>
              ))}
              {advisory.map((g) => (
                <li key={g.key} className="flex items-center gap-2 text-text-secondary">
                  <span className="h-1.5 w-1.5 rounded-full bg-border" />
                  {GAP_LABELS[g.key] ?? g.key} <span className="text-[10px]">(advisory)</span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-text-secondary">
            <span>{report.stats.system_verified} system-verified</span>
            <span>{report.stats.human_recorded} recorded by staff</span>
            <span>{report.stats.media_files} files</span>
            {report.integrity.head_hash && (
              <span className="font-mono" title={report.integrity.head_hash}>
                head {shortHash(report.integrity.head_hash, 12)}
              </span>
            )}
          </div>

          {/* Actions */}
          {!formOpen && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => openForm(null)}
                className="focus-ring flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
              >
                <Plus size={13} /> Add evidence
              </button>
              <button
                type="button"
                onClick={handleExport}
                disabled={exporting || entries.length === 0}
                className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-primary hover:border-accent/40 disabled:opacity-50"
              >
                {exporting ? <Loader2 size={13} className="animate-spin" /> : <FileDown size={13} />}
                Export report (PDF)
              </button>
            </div>
          )}

          {formOpen && (
            <EntryForm
              key={correcting?.id ?? 'new'}
              jobId={job.id}
              entries={entries}
              correcting={correcting}
              onCancel={closeForm}
              onDone={() => {
                closeForm();
                void load();
              }}
            />
          )}

          {/* Timeline */}
          {visibleEntries.length > 0 ? (
            <ul className="space-y-2">
              {visibleEntries.map((e) => (
                <EntryCard key={e.id} entry={e} byId={byId} superseded={supersededIds.has(e.id)} onCorrect={openForm} />
              ))}
            </ul>
          ) : (
            <p className="text-xs text-text-secondary">
              No evidence recorded yet. Start with the diagnosis and what proves it — measurements and photos, before the repair.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
