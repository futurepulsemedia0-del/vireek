import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Landmark, Loader2, Plus, ChevronDown, BadgeCheck, Undo2, Pencil } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { useToast } from '@/contexts/ToastContext';
import { RegulationEntryCard } from '@/components/regulation/RegulationEntryCard';
import { RegulationTimeline } from '@/components/regulation/RegulationTimeline';
import {
  addEdge,
  addJurisdiction,
  addNode,
  addVersion,
  fetchEdges,
  fetchJurisdictions,
  fetchNodes,
  fetchVersions,
  resolveRegulations,
  retractEdge,
  retractVersion,
  verifyVersion,
} from '@/lib/temporalRegulationApi';
import {
  EDGE_TYPE_LABELS,
  KIND_LABELS,
  KIND_ORDER,
  LEVEL_LABELS,
  LEVEL_RANK,
  SOURCE_TYPE_LABELS,
  WORK_TYPE_OPTIONS,
  formatIsoDate,
  formatRequirementLines,
  formatTimestamp,
  groupByKind,
  isValidIsoDate,
  linksFor,
  parseRequirementLines,
  shortHash,
  slugifyKey,
  todayIso,
  validateVersionDraft,
  workTypeLabel,
  type EdgeType,
  type Jurisdiction,
  type JurisdictionLevel,
  type RegulationEdge,
  type RegulationKind,
  type RegulationNode,
  type RegulationVersion,
  type ResolveResult,
  type SourceType,
  type VersionDraft,
} from '@/lib/temporalRegulation';

type TabKey = 'travel' | 'registry' | 'graph';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'travel', label: 'Time Travel' },
  { key: 'registry', label: 'Registry' },
  { key: 'graph', label: 'Graph' },
];

const inputCls =
  'focus-ring w-full rounded-lg border border-border bg-bg-secondary px-2.5 py-1.5 text-sm text-text-primary placeholder:text-text-secondary/60';
const btnPrimary =
  'focus-ring inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50';
const btnGhost =
  'focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-tertiary disabled:opacity-50';
const card = 'rounded-2xl border border-border bg-bg-secondary p-4';

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="block text-xs font-medium text-text-secondary">
      {label}
      <div className="mt-1 font-normal">{children}</div>
      {error && <span className="mt-1 block text-[11px] text-danger">{error}</span>}
    </label>
  );
}

// ------------------------------------------------------------------ jurisdiction picker

function pathTo(id: string | null, byId: Map<string, Jurisdiction>): string[] {
  const out: string[] = [];
  let cur = id ? byId.get(id) : undefined;
  while (cur) {
    out.unshift(cur.id);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return out;
}

function JurisdictionPicker({
  jurisdictions,
  value,
  onChange,
}: {
  jurisdictions: Jurisdiction[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const byId = useMemo(() => new Map(jurisdictions.map((j) => [j.id, j])), [jurisdictions]);
  const children = useMemo(() => {
    const m = new Map<string | null, Jurisdiction[]>();
    for (const j of jurisdictions) {
      const arr = m.get(j.parent_id) ?? [];
      arr.push(j);
      m.set(j.parent_id, arr);
    }
    return m;
  }, [jurisdictions]);
  const path = useMemo(() => pathTo(value, byId), [value, byId]);

  const selects = [null, ...path]
    .map((parentId, i) => ({ parentId, options: children.get(parentId) ?? [], selected: path[i] ?? '' }))
    .filter((s) => s.options.length > 0);

  return (
    <div className="flex flex-wrap gap-2">
      {selects.map((s) => (
        <select
          key={s.parentId ?? 'root'}
          value={s.selected}
          onChange={(e) => onChange(e.target.value || s.parentId)}
          aria-label={LEVEL_LABELS[s.options[0].level]}
          className="focus-ring rounded-lg border border-border bg-bg-secondary px-2.5 py-1.5 text-sm text-text-primary"
        >
          <option value="">
            {s.parentId ? `Entire ${byId.get(s.parentId)?.name ?? ''}` : `Choose ${LEVEL_LABELS[s.options[0].level].toLowerCase()}…`}
          </option>
          {s.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
              {o.owner_id ? ' (yours)' : ''}
            </option>
          ))}
        </select>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ inline retract

function RetractControl({ label, onConfirm }: { label: string; onConfirm: (reason: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={btnGhost}>
        <Undo2 size={12} /> {label}
      </button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={500}
        placeholder="Reason (min 8 characters)"
        aria-label="Reason"
        className="focus-ring w-56 rounded-lg border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary"
      />
      <button
        type="button"
        disabled={busy || reason.trim().length < 8}
        onClick={async () => {
          setBusy(true);
          try {
            await onConfirm(reason.trim());
            setOpen(false);
            setReason('');
          } finally {
            setBusy(false);
          }
        }}
        className={btnPrimary}
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : null} Confirm
      </button>
      <button type="button" onClick={() => setOpen(false)} className={btnGhost}>
        Cancel
      </button>
    </span>
  );
}

// ------------------------------------------------------------------ version form

const EMPTY_DRAFT: VersionDraft = {
  effectiveFrom: '',
  expiresOn: '',
  isRepeal: false,
  title: '',
  summary: '',
  citation: '',
  sourceUrl: '',
  requirementsText: '',
};

function VersionForm({
  node,
  initial,
  correctsId,
  onDone,
  onCancel,
}: {
  node: RegulationNode;
  initial?: Partial<VersionDraft> & { sourceType?: SourceType };
  correctsId?: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<VersionDraft>({ ...EMPTY_DRAFT, title: node.title, ...initial });
  const [sourceType, setSourceType] = useState<SourceType>(initial?.sourceType ?? 'statute');
  const [label, setLabel] = useState('');
  const [retrievedOn, setRetrievedOn] = useState(todayIso());
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);
  const { ok, errors } = validateVersionDraft(draft);
  const set = <K extends keyof VersionDraft>(k: K, v: VersionDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const show = (k: keyof VersionDraft) => (touched ? errors[k] : undefined);

  const submit = async () => {
    setTouched(true);
    if (!ok) return;
    setSaving(true);
    try {
      await addVersion({
        nodeId: node.id,
        effectiveFrom: draft.effectiveFrom,
        isRepeal: draft.isRepeal,
        expiresOn: draft.expiresOn || undefined,
        title: draft.title,
        summary: draft.summary,
        requirements: parseRequirementLines(draft.requirementsText),
        citation: draft.citation,
        sourceUrl: draft.sourceUrl,
        sourceType,
        retrievedOn: isValidIsoDate(retrievedOn) ? retrievedOn : undefined,
        label,
        correctsId: correctsId ?? null,
      });
      toast(correctsId ? 'Correction recorded. The original stays on file.' : 'Version recorded.', 'success');
      onDone();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not record this version.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-accent/30 bg-accent/5 p-3">
      <p className="text-xs font-semibold text-text-primary">
        {correctsId ? 'Record a correction' : 'Record a new version'} — {node.title}
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Effective from" error={show('effectiveFrom')}>
          <input type="date" value={draft.effectiveFrom} onChange={(e) => set('effectiveFrom', e.target.value)} className={inputCls} />
        </Field>
        <Field label="Expires on (optional)" error={show('expiresOn')}>
          <input type="date" value={draft.expiresOn} onChange={(e) => set('expiresOn', e.target.value)} className={inputCls} />
        </Field>
        <Field label="Label (optional)">
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} placeholder="e.g. 2023 edition adopted" className={inputCls} />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-xs text-text-primary">
        <input type="checkbox" checked={draft.isRepeal} onChange={(e) => set('isRepeal', e.target.checked)} />
        This is a repeal — the regulation stops applying on the effective date
      </label>
      {!draft.isRepeal && (
        <>
          <Field label="Title" error={show('title')}>
            <input value={draft.title} onChange={(e) => set('title', e.target.value)} maxLength={200} className={inputCls} />
          </Field>
          <Field label="What this version requires" error={show('summary')}>
            <textarea value={draft.summary} onChange={(e) => set('summary', e.target.value)} rows={3} maxLength={4000} className={inputCls} />
          </Field>
          <Field label="Requirements — one per line: [blocker|warning|info] Title | detail">
            <textarea
              value={draft.requirementsText}
              onChange={(e) => set('requirementsText', e.target.value)}
              rows={3}
              placeholder="[blocker] Pull an electrical permit | before work starts"
              className={`${inputCls} font-mono text-xs`}
            />
          </Field>
        </>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Source type">
          <select value={sourceType} onChange={(e) => setSourceType(e.target.value as SourceType)} className={inputCls}>
            {(Object.keys(SOURCE_TYPE_LABELS) as SourceType[]).map((s) => (
              <option key={s} value={s}>
                {SOURCE_TYPE_LABELS[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Retrieved on">
          <input type="date" value={retrievedOn} onChange={(e) => setRetrievedOn(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Legal citation" error={show('citation')}>
          <input value={draft.citation} onChange={(e) => set('citation', e.target.value)} maxLength={500} placeholder="e.g. City Code §12.3.4" className={inputCls} />
        </Field>
        <Field label="Source link (optional)" error={show('sourceUrl')}>
          <input value={draft.sourceUrl} onChange={(e) => set('sourceUrl', e.target.value)} placeholder="https://…" className={inputCls} />
        </Field>
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={() => void submit()} disabled={saving} className={btnPrimary}>
          {saving && <Loader2 size={12} className="animate-spin" />} Record
        </button>
        <button type="button" onClick={onCancel} className={btnGhost}>
          Cancel
        </button>
      </div>
      <p className="text-[11px] text-text-secondary">
        Versions are append-only and fingerprinted. To fix a mistake, record a correction — earlier knowledge stays reproducible.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ registry node row

function NodeRow({
  node,
  jurisdictionName,
  asOf,
  onChanged,
}: {
  node: RegulationNode;
  jurisdictionName: string;
  asOf: string;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<RegulationVersion[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<{ initial?: Partial<VersionDraft> & { sourceType?: SourceType }; correctsId?: string } | null>(null);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const editable = node.owner_id !== null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setVersions(await fetchVersions(node.id));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not load versions.', 'error');
    } finally {
      setLoading(false);
    }
  }, [node.id, toast]);

  useEffect(() => {
    if (open && versions === null) void load();
  }, [open, versions, load]);

  const refresh = async () => {
    await load();
    onChanged();
  };

  return (
    <li className="rounded-xl border border-border bg-bg-secondary">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="focus-ring flex w-full items-center justify-between gap-3 p-3 text-left">
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-medium text-text-secondary">{KIND_LABELS[node.kind]}</span>
            <span className="text-sm font-semibold text-text-primary">{node.title}</span>
            <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">{editable ? 'Yours' : 'Platform'}</span>
          </span>
          <span className="mt-0.5 block truncate text-xs text-text-secondary">
            {node.key} · {jurisdictionName}
            {node.authority ? ` · ${node.authority}` : ''}
          </span>
        </span>
        <ChevronDown size={16} className={`shrink-0 text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="space-y-3 border-t border-border/60 p-3">
          {loading && !versions ? (
            <div className="h-12 animate-pulse rounded-lg bg-bg-tertiary" />
          ) : (
            versions && (
              <>
                <RegulationTimeline versions={versions} asOf={asOf} />
                <ul className="space-y-2">
                  {versions.map((v) => (
                    <li key={v.id} className={`rounded-lg border border-border/70 bg-bg-primary p-2.5 text-xs ${v.retracted_at ? 'opacity-60' : ''}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-text-primary">v{v.version_no}</span>
                        <span className="text-text-secondary">effective {formatIsoDate(v.effective_from)}</span>
                        {v.is_repeal && <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger">Repeal</span>}
                        {v.corrects_id && <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">Correction</span>}
                        {v.retracted_at ? (
                          <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger">Retracted</span>
                        ) : v.verification_status === 'verified' ? (
                          <span className="flex items-center gap-1 rounded-full bg-success-500/10 px-2 py-0.5 text-[11px] font-medium text-success-500">
                            <BadgeCheck size={11} /> Verified
                          </span>
                        ) : (
                          <span className="rounded-full bg-warning-500/10 px-2 py-0.5 text-[11px] font-medium text-warning-500">Unverified</span>
                        )}
                        <span className="font-mono text-[11px] text-text-secondary" title="Content fingerprint (SHA-256)">
                          #{shortHash(v.content_hash, 8)}
                        </span>
                      </div>
                      {v.title && <p className="mt-1 text-text-primary">{v.title}</p>}
                      <p className="mt-0.5 text-text-secondary">
                        Recorded {formatTimestamp(v.recorded_at)} · {SOURCE_TYPE_LABELS[v.source_type]}
                        {v.citation ? ` · ${v.citation}` : ''}
                      </p>
                      {v.retracted_reason && <p className="mt-0.5 text-danger">Retracted: {v.retracted_reason}</p>}
                      {editable && !v.retracted_at && (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {v.verification_status !== 'verified' && (
                            <button
                              type="button"
                              disabled={verifyingId === v.id}
                              onClick={async () => {
                                setVerifyingId(v.id);
                                try {
                                  await verifyVersion(v.id);
                                  toast('Version verified.', 'success');
                                  await refresh();
                                } catch (err) {
                                  toast(err instanceof Error ? err.message : 'Could not verify this version.', 'error');
                                } finally {
                                  setVerifyingId(null);
                                }
                              }}
                              className={btnGhost}
                            >
                              <BadgeCheck size={12} /> Mark verified
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              setForm({
                                correctsId: v.id,
                                initial: {
                                  effectiveFrom: v.effective_from,
                                  expiresOn: v.expires_on ?? '',
                                  isRepeal: v.is_repeal,
                                  title: v.title ?? node.title,
                                  summary: v.summary ?? '',
                                  citation: v.citation ?? '',
                                  sourceUrl: v.source_url ?? '',
                                  requirementsText: formatRequirementLines(v.requirements),
                                  sourceType: v.source_type,
                                },
                              })
                            }
                            className={btnGhost}
                          >
                            <Pencil size={12} /> Correct
                          </button>
                          <RetractControl
                            label="Retract"
                            onConfirm={async (reason) => {
                              try {
                                await retractVersion(v.id, reason);
                                toast('Version retracted.', 'success');
                                await refresh();
                              } catch (err) {
                                toast(err instanceof Error ? err.message : 'Could not retract this version.', 'error');
                                throw err;
                              }
                            }}
                          />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )
          )}

          {editable &&
            (form ? (
              <VersionForm
                node={node}
                initial={form.initial}
                correctsId={form.correctsId}
                onCancel={() => setForm(null)}
                onDone={() => {
                  setForm(null);
                  void refresh();
                }}
              />
            ) : (
              <button type="button" onClick={() => setForm({})} className={btnPrimary}>
                <Plus size={12} /> Record a new version
              </button>
            ))}
        </div>
      )}
    </li>
  );
}

// ------------------------------------------------------------------ add jurisdiction / node

function AddJurisdictionForm({ parent, onCreated }: { parent: Jurisdiction; onCreated: (j: Jurisdiction) => void }) {
  const { toast } = useToast();
  const levels = (Object.keys(LEVEL_LABELS) as JurisdictionLevel[]).filter((l) => LEVEL_RANK[l] > LEVEL_RANK[parent.level]);
  const [level, setLevel] = useState<JurisdictionLevel>(levels[0] ?? 'city');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  if (levels.length === 0) return null;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label={`New area inside ${parent.name}`}>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. Austin" className={`${inputCls} w-48`} />
      </Field>
      <Field label="Level">
        <select value={level} onChange={(e) => setLevel(e.target.value as JurisdictionLevel)} className={inputCls}>
          {levels.map((l) => (
            <option key={l} value={l}>
              {LEVEL_LABELS[l]}
            </option>
          ))}
        </select>
      </Field>
      <button
        type="button"
        disabled={busy || !name.trim()}
        onClick={async () => {
          setBusy(true);
          try {
            const j = await addJurisdiction({ parentId: parent.id, level, name });
            setName('');
            onCreated(j);
            toast(`${j.name} added.`, 'success');
          } catch (err) {
            toast(err instanceof Error ? err.message : 'Could not add the jurisdiction.', 'error');
          } finally {
            setBusy(false);
          }
        }}
        className={btnPrimary}
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Add area
      </button>
    </div>
  );
}

function AddNodeForm({ jurisdiction, onCreated }: { jurisdiction: Jurisdiction; onCreated: () => void }) {
  const { toast } = useToast();
  const [kind, setKind] = useState<RegulationKind>('permit');
  const [title, setTitle] = useState('');
  const [key, setKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [authority, setAuthority] = useState('');
  const [workTypes, setWorkTypes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const effectiveKey = keyEdited ? key : slugifyKey(`${jurisdiction.code}-${title}`);

  return (
    <div className="space-y-3 rounded-xl border border-border bg-bg-secondary p-3">
      <p className="text-xs font-semibold text-text-primary">New regulation in {jurisdiction.name}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kind">
          <select value={kind} onChange={(e) => setKind(e.target.value as RegulationKind)} className={inputCls}>
            {KIND_ORDER.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Title">
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className={inputCls} />
        </Field>
        <Field label="Key (stable id — same key in a nearer area overrides its parent)">
          <input
            value={effectiveKey}
            onChange={(e) => {
              setKey(slugifyKey(e.target.value));
              setKeyEdited(true);
            }}
            maxLength={80}
            className={`${inputCls} font-mono text-xs`}
          />
        </Field>
        <Field label="Authority (optional)">
          <input value={authority} onChange={(e) => setAuthority(e.target.value)} maxLength={200} placeholder="e.g. City building department" className={inputCls} />
        </Field>
      </div>
      <details className="text-xs text-text-secondary">
        <summary className="focus-ring cursor-pointer">Applies to specific work types ({workTypes.length || 'all'})</summary>
        <div className="mt-2 grid grid-cols-2 gap-1 sm:grid-cols-4">
          {WORK_TYPE_OPTIONS.map((w) => (
            <label key={w} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={workTypes.includes(w)}
                onChange={(e) => setWorkTypes((cur) => (e.target.checked ? [...cur, w] : cur.filter((x) => x !== w)))}
              />
              {workTypeLabel(w)}
            </label>
          ))}
        </div>
      </details>
      <button
        type="button"
        disabled={busy || !title.trim() || effectiveKey.length < 2}
        onClick={async () => {
          setBusy(true);
          try {
            await addNode({ jurisdictionId: jurisdiction.id, kind, key: effectiveKey, title, authority, workTypes });
            setTitle('');
            setKey('');
            setKeyEdited(false);
            toast('Regulation added. Record its first version to bring it into force.', 'success');
            onCreated();
          } catch (err) {
            toast(err instanceof Error ? err.message : 'Could not add the regulation.', 'error');
          } finally {
            setBusy(false);
          }
        }}
        className={btnPrimary}
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Add regulation
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ graph tab

const EDGE_TYPES = Object.keys(EDGE_TYPE_LABELS) as EdgeType[];

function GraphTab({
  result,
  nodes,
  edges,
  asOf,
  onChanged,
}: {
  result: ResolveResult | null;
  nodes: RegulationNode[];
  edges: RegulationEdge[];
  asOf: string;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [type, setType] = useState<EdgeType>('requires');
  const [validFrom, setValidFrom] = useState(asOf);
  const [validTo, setValidTo] = useState('');
  const [busy, setBusy] = useState(false);

  const chainIds = useMemo(() => new Set(result?.entries.map((e) => e.node_id) ?? []), [result]);
  const titleOf = useMemo(() => new Map(nodes.map((n) => [n.id, n.title])), [nodes]);
  const myEdges = useMemo(
    () => edges.filter((e) => e.owner_id !== null && (chainIds.has(e.from_node_id) || chainIds.has(e.to_node_id))),
    [edges, chainIds],
  );

  if (!result) return <p className="text-sm text-text-secondary">Choose a jurisdiction and date on the Time Travel tab first.</p>;
  const groups = groupByKind(result.entries);

  return (
    <div className="space-y-4">
      <div className={card}>
        <p className="mb-3 text-xs text-text-secondary">
          How regulations connect on {formatIsoDate(result.as_of)} in {result.jurisdiction.name}. Links are time-bound, so the graph itself changes
          with the date.
        </p>
        {groups.length === 0 ? (
          <p className="text-sm text-text-secondary">Nothing in force to connect on this date.</p>
        ) : (
          <div className="space-y-4">
            {groups.map((g) => (
              <div key={g.kind}>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{KIND_LABELS[g.kind]}</p>
                <ul className="space-y-1.5">
                  {g.items.map((e) => {
                    const links = linksFor(e.node_id, result.entries, result.edges);
                    return (
                      <li key={e.node_id} className="rounded-lg border border-border/70 bg-bg-primary px-3 py-2 text-xs">
                        <span className="font-medium text-text-primary">{e.title}</span>
                        {links.map(({ edge, target }) => (
                          <span key={edge.id} className="mt-1 block pl-3 text-text-secondary">
                            → {EDGE_TYPE_LABELS[edge.edge_type]} <span className="text-text-primary">{target.title}</span>
                            {edge.valid_to ? ` (until ${formatIsoDate(edge.valid_to)})` : ''}
                          </span>
                        ))}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      {result.entries.length >= 2 && (
        <div className={`${card} space-y-3`}>
          <p className="text-xs font-semibold text-text-primary">Link two regulations</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="From">
              <select value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls}>
                <option value="">Choose…</option>
                {result.entries.map((e) => (
                  <option key={e.node_id} value={e.node_id}>
                    {e.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Relationship">
              <select value={type} onChange={(e) => setType(e.target.value as EdgeType)} className={inputCls}>
                {EDGE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {EDGE_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="To">
              <select value={to} onChange={(e) => setTo(e.target.value)} className={inputCls}>
                <option value="">Choose…</option>
                {result.entries
                  .filter((e) => e.node_id !== from)
                  .map((e) => (
                    <option key={e.node_id} value={e.node_id}>
                      {e.title}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Valid from">
              <input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Valid until (optional)">
              <input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} className={inputCls} />
            </Field>
          </div>
          <button
            type="button"
            disabled={busy || !from || !to || !isValidIsoDate(validFrom) || (!!validTo && validTo <= validFrom)}
            onClick={async () => {
              setBusy(true);
              try {
                await addEdge({ fromNodeId: from, toNodeId: to, edgeType: type, validFrom, validTo: validTo || undefined });
                toast('Link added.', 'success');
                setFrom('');
                setTo('');
                setValidTo('');
                onChanged();
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Could not add the link.', 'error');
              } finally {
                setBusy(false);
              }
            }}
            className={btnPrimary}
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Add link
          </button>
        </div>
      )}

      {myEdges.length > 0 && (
        <div className={card}>
          <p className="mb-2 text-xs font-semibold text-text-primary">Your links</p>
          <ul className="space-y-2">
            {myEdges.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-primary">
                <span>
                  {titleOf.get(e.from_node_id) ?? 'Regulation'} {EDGE_TYPE_LABELS[e.edge_type]} {titleOf.get(e.to_node_id) ?? 'Regulation'}
                  <span className="text-text-secondary">
                    {' '}
                    · {formatIsoDate(e.valid_from)} → {e.valid_to ? formatIsoDate(e.valid_to) : 'open'}
                  </span>
                </span>
                <RetractControl
                  label="Retract"
                  onConfirm={async (reason) => {
                    try {
                      await retractEdge(e.id, reason);
                      toast('Link retracted.', 'success');
                      onChanged();
                    } catch (err) {
                      toast(err instanceof Error ? err.message : 'Could not retract this link.', 'error');
                      throw err;
                    }
                  }}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ page

export function TemporalRegulationPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState<TabKey>('travel');
  const [jurisdictions, setJurisdictions] = useState<Jurisdiction[]>([]);
  const [nodes, setNodes] = useState<RegulationNode[]>([]);
  const [edges, setEdges] = useState<RegulationEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [jurisdictionId, setJurisdictionId] = useState<string | null>(null);
  const [asOf, setAsOf] = useState(todayIso());
  const [knownMode, setKnownMode] = useState<'now' | 'custom'>('now');
  const [knownLocal, setKnownLocal] = useState('');
  const [workTypes, setWorkTypes] = useState<string[]>([]);
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const loadAll = useCallback(async () => {
    try {
      const [j, n, e] = await Promise.all([fetchJurisdictions(), fetchNodes(), fetchEdges()]);
      setJurisdictions(j);
      setNodes(n);
      setEdges(e);
      setJurisdictionId((prev) => prev ?? j.find((x) => x.code === 'US')?.id ?? j.find((x) => x.parent_id === null)?.id ?? null);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not load the regulation graph.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const knownIso = useMemo(() => {
    if (knownMode !== 'custom' || !knownLocal) return null;
    const d = new Date(knownLocal);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }, [knownMode, knownLocal]);

  const workKey = workTypes.join(',');
  useEffect(() => {
    if (!jurisdictionId || !isValidIsoDate(asOf)) {
      setResult(null);
      return;
    }
    let cancelled = false;
    setResolving(true);
    resolveRegulations({ jurisdictionId, asOf, knownAt: knownIso, workTypes: workKey ? workKey.split(',') : [] })
      .then((r) => {
        if (cancelled) return;
        setResult(r);
        setResolveError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setResult(null);
        setResolveError(err instanceof Error ? err.message : 'Could not resolve regulations.');
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });
    return () => {
      cancelled = true;
    };
  }, [jurisdictionId, asOf, knownIso, workKey, refreshTick]);

  const byId = useMemo(() => new Map(jurisdictions.map((j) => [j.id, j])), [jurisdictions]);
  const selected = jurisdictionId ? (byId.get(jurisdictionId) ?? null) : null;
  const chainIds = useMemo(() => new Set(pathTo(jurisdictionId, byId)), [jurisdictionId, byId]);
  const visibleNodes = useMemo(() => nodes.filter((n) => chainIds.has(n.jurisdiction_id)), [nodes, chainIds]);
  const grouped = useMemo(() => (result ? groupByKind(result.entries) : []), [result]);

  const changed = () => {
    setRefreshTick((t) => t + 1);
    void loadAll();
  };

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Landmark size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Temporal Regulation Graph</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Jurisdiction → code → permit → license → inspection → environmental rule, versioned by effective date. Ask what was in force on any day —
              and what we knew at the time. Every job can seal that answer as proof.
            </p>
          </div>
        </div>

        {loading ? (
          <div className="space-y-4">
            {[0, 1].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : (
          <>
            <div className={`${card} mb-4 space-y-3`}>
              <JurisdictionPicker jurisdictions={jurisdictions} value={jurisdictionId} onChange={setJurisdictionId} />
              <div className="flex flex-wrap items-end gap-3">
                <Field label="In force on">
                  <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className={inputCls} />
                </Field>
                <Field label="Knowledge as of">
                  <select value={knownMode} onChange={(e) => setKnownMode(e.target.value as 'now' | 'custom')} className={inputCls}>
                    <option value="now">Today (everything we know)</option>
                    <option value="custom">A past moment…</option>
                  </select>
                </Field>
                {knownMode === 'custom' && (
                  <Field label="Date & time">
                    <input type="datetime-local" value={knownLocal} onChange={(e) => setKnownLocal(e.target.value)} className={inputCls} />
                  </Field>
                )}
                <details className="text-xs text-text-secondary">
                  <summary className="focus-ring cursor-pointer rounded-lg border border-border px-3 py-1.5">Work types ({workTypes.length || 'all'})</summary>
                  <div className="absolute z-10 mt-1 grid grid-cols-2 gap-1 rounded-xl border border-border bg-bg-secondary p-3 shadow-lg sm:grid-cols-3">
                    {WORK_TYPE_OPTIONS.map((w) => (
                      <label key={w} className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={workTypes.includes(w)}
                          onChange={(e) => setWorkTypes((cur) => (e.target.checked ? [...cur, w] : cur.filter((x) => x !== w)))}
                        />
                        {workTypeLabel(w)}
                      </label>
                    ))}
                  </div>
                </details>
                {resolving && <Loader2 size={16} className="mb-2 animate-spin text-text-secondary" />}
              </div>
            </div>

            <div className="mb-4 flex gap-1 rounded-xl bg-bg-tertiary p-1" role="tablist">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => setTab(t.key)}
                  className={`focus-ring flex-1 rounded-lg px-3 py-1.5 text-sm font-medium ${tab === t.key ? 'bg-bg-secondary text-text-primary shadow-sm' : 'text-text-secondary'}`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {tab === 'travel' && (
              <div className="space-y-4">
                {resolveError && <p className="rounded-lg bg-danger/10 p-3 text-sm text-danger">{resolveError}</p>}
                {result && (
                  <>
                    <div className="grid grid-cols-3 gap-3">
                      <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                        <p className="text-xl font-bold text-success-500">{result.counts.in_force}</p>
                        <p className="text-xs text-text-secondary">In force</p>
                      </div>
                      <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                        <p className="text-xl font-bold text-text-primary">{result.counts.ended}</p>
                        <p className="text-xs text-text-secondary">Repealed / expired</p>
                      </div>
                      <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                        <p className="text-xl font-bold text-warning-500">{result.counts.unverified}</p>
                        <p className="text-xs text-text-secondary">In force, unverified</p>
                      </div>
                    </div>
                    <p className="text-xs text-text-secondary">
                      {result.jurisdiction_path.map((p) => p.name).join(' › ')} · {formatIsoDate(result.as_of)} · knowledge as of {formatTimestamp(result.known_at)}
                    </p>
                    {grouped.length === 0 ? (
                      <div className={`${card} text-sm text-text-secondary`}>
                        No regulations are recorded for this place on this date. Add them in the Registry tab — each needs a citation.
                      </div>
                    ) : (
                      grouped.map((g) => (
                        <div key={g.kind}>
                          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{KIND_LABELS[g.kind]}</p>
                          <ul className="space-y-2">
                            {g.items.map((e) => (
                              <RegulationEntryCard key={e.version_id} entry={e} />
                            ))}
                          </ul>
                        </div>
                      ))
                    )}
                  </>
                )}
              </div>
            )}

            {tab === 'registry' && (
              <div className="space-y-4">
                {selected ? (
                  <>
                    <div className={card}>
                      <AddJurisdictionForm
                        parent={selected}
                        onCreated={(j) => {
                          setJurisdictionId(j.id);
                          void loadAll();
                        }}
                      />
                    </div>
                    <AddNodeForm jurisdiction={selected} onCreated={changed} />
                    <ul className="space-y-2">
                      {visibleNodes.length === 0 ? (
                        <li className={`${card} text-sm text-text-secondary`}>No regulations recorded for {selected.name} or the areas above it yet.</li>
                      ) : (
                        visibleNodes.map((n) => (
                          <NodeRow key={n.id} node={n} jurisdictionName={byId.get(n.jurisdiction_id)?.name ?? ''} asOf={asOf} onChanged={changed} />
                        ))
                      )}
                    </ul>
                  </>
                ) : (
                  <p className="text-sm text-text-secondary">Choose a jurisdiction above to manage its regulations.</p>
                )}
              </div>
            )}

            {tab === 'graph' && <GraphTab result={result} nodes={nodes} edges={edges} asOf={asOf} onChanged={changed} />}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
