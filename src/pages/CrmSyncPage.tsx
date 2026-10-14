import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  Clock,
  Link2,
  Loader2,
  Lock,
  Plug,
  RefreshCw,
  Save,
  Unplug,
  Workflow,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LiveIndicator } from '@/components/LiveIndicator';
import { useToast } from '@/contexts/ToastContext';
import { useRealtimeSubscription } from '@/lib/realtime';
import {
  CONFLICT_RULES,
  CONFLICT_RULE_META,
  CRM_CATALOG,
  CRM_ENTITIES,
  CRM_PROVIDERS,
  CUSTOM_CRM_KEY,
  DIRECTION_META,
  ENTITY_META,
  LOG_PAGE_SIZE,
  PROVIDER_META,
  SYNC_DIRECTIONS,
  VIREEK_FIELDS,
  defaultSettings,
  disconnectCrm,
  listConflicts,
  listConnections,
  listDeals,
  listLog,
  listRuns,
  readSettings,
  resolveConflict,
  saveSettings,
  startOAuth,
  syncNow,
  timeAgo,
  useCanManageCrm,
  useCrmOwnerId,
  validateSettings,
  vireekFieldLabel,
  type ConflictRule,
  type CrmConflict,
  type CrmConnection,
  type CrmDeal,
  type CrmEntity,
  type CrmLogRow,
  type CrmProvider,
  type CrmRun,
  type CrmSettings,
  type LogAction,
  type RunStatus,
  type SyncDirection,
} from '@/lib/crmSync';

const INPUT =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 disabled:opacity-60';

type Tab = 'overview' | 'mapping' | 'log';

const RUN_STYLE: Record<RunStatus, { label: string; cls: string }> = {
  running: { label: 'Syncing', cls: 'bg-accent/10 text-accent' },
  success: { label: 'Up to date', cls: 'bg-success-500/10 text-success-500' },
  partial: { label: 'Partially synced', cls: 'bg-warning-500/10 text-warning-500' },
  failed: { label: 'Failed', cls: 'bg-danger/10 text-danger' },
};

const ACTION_STYLE: Record<LogAction, string> = {
  created: 'bg-success-500/10 text-success-500',
  updated: 'bg-accent/10 text-accent',
  linked: 'bg-bg-tertiary text-text-secondary',
  conflict: 'bg-warning-500/10 text-warning-500',
  skipped: 'bg-bg-tertiary text-text-secondary',
  error: 'bg-danger/10 text-danger',
};

function Badge({ cls, children }: { cls: string; children: React.ReactNode }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}>{children}</span>;
}

function Skeleton({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-bg-tertiary ${className}`} />;
}

function NoAccess() {
  return (
    <DashboardLayout activeLabel="CRM Sync">
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
          <Lock size={26} />
        </span>
        <h3 className="mt-4 text-lg font-semibold text-text-primary">Permission required</h3>
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
          CRM sync shares customer data with another system, so it's limited to people who can edit the business profile. Ask
          your account owner for access.
        </p>
      </div>
    </DashboardLayout>
  );
}

// ============================================================
// MAPPING EDITOR
// ============================================================

interface DraftRow {
  vireek: string;
  crm: string;
  custom: boolean;
  direction: SyncDirection;
}
type Draft = Record<CrmEntity, { enabled: boolean; conflict_rule: ConflictRule; rows: DraftRow[] }>;

function toDraft(provider: CrmProvider, settings: CrmSettings): Draft {
  const out = {} as Draft;
  for (const e of CRM_ENTITIES) {
    const es = settings.entities[e];
    const catalog = CRM_CATALOG[provider][e];
    out[e] = {
      enabled: es.enabled,
      conflict_rule: es.conflict_rule,
      rows: VIREEK_FIELDS[e].map((f) => {
        const m = es.mapping.find((x) => x.vireek === f.key);
        return {
          vireek: f.key,
          crm: m?.crm ?? '',
          custom: !!m && !catalog.some((c) => c.key === m.crm),
          direction: m?.direction ?? 'both',
        };
      }),
    };
  }
  return out;
}

function fromDraft(draft: Draft): CrmSettings {
  const entities = {} as CrmSettings['entities'];
  for (const e of CRM_ENTITIES) {
    entities[e] = {
      enabled: draft[e].enabled,
      conflict_rule: draft[e].conflict_rule,
      mapping: draft[e].rows.filter((r) => r.crm.trim() !== '').map((r) => ({ vireek: r.vireek, crm: r.crm.trim(), direction: r.direction })),
    };
  }
  return { entities };
}

/** Order-insensitive fingerprint so row order never looks like an edit. */
function settingsSignature(s: CrmSettings): string {
  return JSON.stringify(
    CRM_ENTITIES.map((e) => ({
      e,
      on: s.entities[e].enabled,
      rule: s.entities[e].conflict_rule,
      map: [...s.entities[e].mapping].sort((a, b) => a.vireek.localeCompare(b.vireek)).map((m) => [m.vireek, m.crm, m.direction]),
    })),
  );
}

function MappingTab({ conn, onSaved }: { conn: CrmConnection; onSaved: () => void }) {
  const { toast } = useToast();
  const provider = conn.provider;
  // Keyed by CONTENT, not identity: background refreshes (live sync progress) hand us a new
  // connection object every few seconds and must never wipe unsaved edits.
  const settingsKey = JSON.stringify(conn.settings);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const saved = useMemo(() => readSettings(provider, conn.settings), [provider, settingsKey]);
  const [draft, setDraft] = useState<Draft>(() => toDraft(provider, saved));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(toDraft(provider, saved));
    setError(null);
  }, [provider, saved]);

  const dirty = settingsSignature(fromDraft(draft)) !== settingsSignature(saved);

  const patchEntity = (e: CrmEntity, p: Partial<Draft[CrmEntity]>) => setDraft((d) => ({ ...d, [e]: { ...d[e], ...p } }));
  const patchRow = (e: CrmEntity, vireek: string, p: Partial<DraftRow>) =>
    setDraft((d) => ({ ...d, [e]: { ...d[e], rows: d[e].rows.map((r) => (r.vireek === vireek ? { ...r, ...p } : r)) } }));

  const handleSave = async () => {
    const settings = fromDraft(draft);
    const v = validateSettings(provider, settings);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await saveSettings(conn.id, v.settings);
      toast('Field mapping saved. Changed entities will be re-read on the next sync.', 'success');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {CRM_ENTITIES.map((e) => {
        const d = draft[e];
        const catalog = CRM_CATALOG[provider][e];
        return (
          <section key={e} className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-text-primary">
                  {ENTITY_META[e].vireekLabel} <span className="text-text-secondary">⇄</span> {PROVIDER_META[provider].label} {ENTITY_META[e].crmLabel[provider]}
                </h3>
                {e === 'deal' && (
                  <p className="mt-0.5 text-xs text-text-secondary">Deals are stored in Vireek as a separate record type and shown under Overview.</p>
                )}
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-text-primary">
                <input type="checkbox" checked={d.enabled} onChange={(ev) => patchEntity(e, { enabled: ev.target.checked })} className="h-4 w-4 accent-accent" />
                Sync {ENTITY_META[e].label.toLowerCase()}
              </label>
            </div>

            <div className={d.enabled ? 'mt-4' : 'mt-4 opacity-50'}>
              <label className="block max-w-sm">
                <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">When both sides changed the same field</span>
                <select value={d.conflict_rule} disabled={!d.enabled} onChange={(ev) => patchEntity(e, { conflict_rule: ev.target.value as ConflictRule })} className={`${INPUT} mt-1.5`}>
                  {CONFLICT_RULES.map((r) => (
                    <option key={r} value={r}>
                      {CONFLICT_RULE_META[r].label}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-[11px] text-text-secondary">{CONFLICT_RULE_META[d.conflict_rule].hint}</span>
              </label>

              <div className="mt-4 space-y-3">
                <div className="hidden grid-cols-[10rem_9rem_1fr] gap-3 px-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary md:grid">
                  <span>Vireek field</span>
                  <span>Direction</span>
                  <span>{PROVIDER_META[provider].label} field</span>
                </div>
                {d.rows.map((r) => {
                  const f = VIREEK_FIELDS[e].find((x) => x.key === r.vireek)!;
                  const selectValue = r.custom ? '__custom__' : r.crm;
                  return (
                    <div key={r.vireek} className="grid gap-2 rounded-xl border border-border/70 p-3 md:grid-cols-[10rem_9rem_1fr] md:items-start md:border-0 md:p-0">
                      <p className="text-sm font-medium text-text-primary md:pt-2.5">
                        {f.label}
                        {f.required && <span className="ml-0.5 text-danger" aria-hidden="true">*</span>}
                      </p>
                      <select
                        aria-label={`${f.label} direction`}
                        value={r.direction}
                        disabled={!d.enabled || r.crm === ''}
                        onChange={(ev) => patchRow(e, r.vireek, { direction: ev.target.value as SyncDirection })}
                        className={INPUT}
                      >
                        {SYNC_DIRECTIONS.map((s) => (
                          <option key={s} value={s}>
                            {DIRECTION_META[s].label}
                          </option>
                        ))}
                      </select>
                      <div className="space-y-2">
                        <select
                          aria-label={`${f.label} ${PROVIDER_META[provider].label} field`}
                          value={selectValue}
                          disabled={!d.enabled}
                          onChange={(ev) => {
                            const v = ev.target.value;
                            if (v === '__custom__') patchRow(e, r.vireek, { custom: true, crm: r.custom ? r.crm : '' });
                            else patchRow(e, r.vireek, { custom: false, crm: v });
                          }}
                          className={INPUT}
                        >
                          <option value="">— Not synced —</option>
                          {catalog.map((c) => (
                            <option key={c.key} value={c.key}>
                              {c.label}
                            </option>
                          ))}
                          <option value="__custom__">Custom field (API name)…</option>
                        </select>
                        {r.custom && (
                          <input
                            aria-label={`${f.label} custom field API name`}
                            value={r.crm}
                            maxLength={80}
                            placeholder={provider === 'salesforce' ? 'e.g. Service_Interested__c' : provider === 'zoho' ? 'e.g. Service_Interested' : 'Field key from Pipedrive'}
                            onChange={(ev) => patchRow(e, r.vireek, { crm: ev.target.value })}
                            className={`${INPUT} ${r.crm && !CUSTOM_CRM_KEY.test(r.crm) ? 'border-danger' : ''}`}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        );
      })}

      {error && (
        <p role="alert" className="flex items-start gap-2 text-sm font-medium text-danger">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={() => {
            setDraft(toDraft(provider, defaultSettings(provider)));
            setError(null);
          }}
          className="focus-ring rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary"
        >
          Reset to defaults
        </button>
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={handleSave}
          className="focus-ring flex items-center justify-center gap-2 rounded-xl bg-cta px-5 py-2.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50"
        >
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
          {saving ? 'Saving…' : 'Save mapping'}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// SYNC LOG
// ============================================================

function LogTab({ conn, refreshKey }: { conn: CrmConnection; refreshKey: number }) {
  const [rows, setRows] = useState<CrmLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [more, setMore] = useState(false);
  const [action, setAction] = useState<LogAction | 'all'>('all');
  const [entity, setEntity] = useState<CrmEntity | 'all'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await listLog(conn.id, { action, entity });
      setRows(page);
      setMore(page.length === LOG_PAGE_SIZE);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [conn.id, action, entity]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const loadMore = async () => {
    const last = rows[rows.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const page = await listLog(conn.id, { action, entity, before: last.created_at });
      setRows((r) => [...r, ...page]);
      setMore(page.length === LOG_PAGE_SIZE);
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <label className="block">
          <span className="sr-only">Result</span>
          <select value={action} onChange={(e) => setAction(e.target.value as LogAction | 'all')} className={INPUT}>
            <option value="all">All results</option>
            {(['created', 'updated', 'linked', 'conflict', 'skipped', 'error'] as LogAction[]).map((a) => (
              <option key={a} value={a}>
                {a[0].toUpperCase() + a.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="sr-only">Record type</span>
          <select value={entity} onChange={(e) => setEntity(e.target.value as CrmEntity | 'all')} className={INPUT}>
            <option value="all">All records</option>
            {CRM_ENTITIES.map((e) => (
              <option key={e} value={e}>
                {ENTITY_META[e].label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loading ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading sync log">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : error ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load the sync log" description="Check your connection and try again." action={{ label: 'Try again', onClick: () => void load() }} />
      ) : rows.length === 0 ? (
        <EmptyState icon={Clock} title="Nothing in the log yet" description="Changes, links, conflicts and errors show up here after a sync runs. Entries are kept for 30 days." />
      ) : (
        <>
          <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-bg-secondary">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-col gap-1.5 p-3.5 sm:flex-row sm:items-start sm:gap-4">
                <div className="flex shrink-0 items-center gap-2 sm:w-44">
                  <Badge cls={ACTION_STYLE[r.action]}>{r.action}</Badge>
                  <span className="text-xs text-text-secondary">{ENTITY_META[r.entity].label}</span>
                </div>
                <p className="min-w-0 flex-1 break-words text-sm text-text-primary">{r.message}</p>
                <span className="shrink-0 text-xs text-text-secondary" title={new Date(r.created_at).toLocaleString()}>
                  {timeAgo(r.created_at)}
                </span>
              </li>
            ))}
          </ul>
          {more && (
            <div className="flex justify-center">
              <button type="button" disabled={loadingMore} onClick={loadMore} className="focus-ring flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary disabled:opacity-60">
                {loadingMore && <Loader2 size={14} className="animate-spin" />} Show more
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ============================================================
// OVERVIEW
// ============================================================

const STAT_LABELS: [keyof NonNullable<CrmRun['stats']>, string][] = [
  ['created_vireek', 'Imported'],
  ['updated_vireek', 'Updated in Vireek'],
  ['created_crm', 'Created in CRM'],
  ['updated_crm', 'Updated in CRM'],
  ['conflicts', 'Conflicts'],
  ['errors', 'Errors'],
];

function OverviewTab({
  conn,
  runs,
  runsLoading,
  ownerId,
  onChanged,
}: {
  conn: CrmConnection;
  runs: CrmRun[];
  runsLoading: boolean;
  ownerId: string | undefined;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [conflicts, setConflicts] = useState<CrmConflict[] | null>(null);
  const [conflictsError, setConflictsError] = useState(false);
  const [deals, setDeals] = useState<CrmDeal[] | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const latest = runs[0];

  const loadConflicts = useCallback(async () => {
    try {
      setConflicts(await listConflicts(conn.id));
      setConflictsError(false);
    } catch {
      setConflictsError(true);
    }
  }, [conn.id]);

  useEffect(() => {
    void loadConflicts();
  }, [loadConflicts, latest?.id, latest?.status]);

  useEffect(() => {
    if (!ownerId) return;
    listDeals(ownerId).then(setDeals, () => setDeals([]));
  }, [ownerId, latest?.id, latest?.status]);

  const resolve = async (c: CrmConflict, winner: 'vireek' | 'crm') => {
    setResolving(`${c.link_id}:${winner}`);
    try {
      await resolveConflict(c.link_id, winner);
      toast(`Kept the ${winner === 'vireek' ? 'Vireek' : PROVIDER_META[conn.provider].label} value.`, 'success');
      await loadConflicts();
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not resolve this conflict.', 'error');
    } finally {
      setResolving(null);
    }
  };

  const fmt = (v: unknown) => (v === null || v === undefined || v === '' ? '(empty)' : String(v));

  return (
    <div className="space-y-6">
      {/* Latest run */}
      <section className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
        <h3 className="text-sm font-semibold text-text-primary">Latest sync</h3>
        {runsLoading ? (
          <Skeleton className="mt-3 h-12 w-full" />
        ) : !latest ? (
          <p className="mt-2 text-sm text-text-secondary">No sync has run yet. Press “Sync now”, or wait for the automatic sync (every 15 minutes).</p>
        ) : (
          <div className="mt-3 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <Badge cls={RUN_STYLE[latest.status].cls}>
                {latest.status === 'running' && <Loader2 size={12} className="animate-spin" />}
                {latest.status === 'success' && <CheckCircle2 size={12} />}
                {(latest.status === 'failed' || latest.status === 'partial') && <AlertTriangle size={12} />}
                {RUN_STYLE[latest.status].label}
              </Badge>
              <span className="text-xs text-text-secondary">
                {latest.trigger === 'manual' ? 'Started manually' : 'Scheduled'} · {timeAgo(latest.started_at)}
              </span>
            </div>
            {latest.error && <p className="text-sm text-text-secondary">{latest.error}</p>}
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {STAT_LABELS.map(([k, label]) => (
                <div key={k} className="rounded-xl bg-bg-tertiary/60 px-3 py-2">
                  <dt className="text-[11px] text-text-secondary">{label}</dt>
                  <dd className={`text-lg font-semibold ${k === 'errors' && (latest.stats[k] ?? 0) > 0 ? 'text-danger' : 'text-text-primary'}`}>{latest.stats[k] ?? 0}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </section>

      {/* Conflicts */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-text-primary">Needs your decision</h3>
        {conflicts === null && !conflictsError ? (
          <Skeleton className="h-16 w-full" />
        ) : conflictsError ? (
          <p className="text-sm text-text-secondary">Couldn't load conflicts. They will appear here after the next refresh.</p>
        ) : conflicts!.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border px-4 py-5 text-sm text-text-secondary">
            No conflicts. They only appear for entities set to “Review manually”.
          </p>
        ) : (
          <ul className="space-y-3">
            {conflicts!.map((c) => (
              <li key={c.link_id} className="rounded-2xl border border-warning-500/40 bg-bg-secondary p-4">
                <p className="text-sm font-semibold text-text-primary">
                  {ENTITY_META[c.entity].label.replace(/s$/, '')} edited on both sides {c.at ? `· ${timeAgo(c.at)}` : ''}
                </p>
                <div className="mt-2 space-y-1.5">
                  {c.fields.map((f) => (
                    <p key={f.field} className="grid gap-1 text-xs sm:grid-cols-[9rem_1fr_1fr] sm:gap-3">
                      <span className="font-medium text-text-secondary">{vireekFieldLabel(c.entity, f.field)}</span>
                      <span className="break-words text-text-primary">Vireek: {fmt(f.vireek)}</span>
                      <span className="break-words text-text-primary">{PROVIDER_META[conn.provider].label}: {fmt(f.crm)}</span>
                    </p>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(['vireek', 'crm'] as const).map((w) => (
                    <button
                      key={w}
                      type="button"
                      disabled={resolving !== null}
                      onClick={() => resolve(c, w)}
                      className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-tertiary disabled:opacity-60"
                    >
                      {resolving === `${c.link_id}:${w}` && <Loader2 size={12} className="animate-spin" />}
                      Keep {w === 'vireek' ? 'Vireek' : PROVIDER_META[conn.provider].label}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Deals */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-text-primary">Synced deals</h3>
        {deals === null ? (
          <Skeleton className="h-16 w-full" />
        ) : deals.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border px-4 py-5 text-sm text-text-secondary">
            No deals yet. Turn on “Sync deals” in Field mapping to import your {PROVIDER_META[conn.provider].label} {ENTITY_META.deal.crmLabel[conn.provider].toLowerCase()}.
          </p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-bg-secondary">
            {deals.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 p-3.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-primary">{d.title}</p>
                  <p className="text-xs text-text-secondary">
                    {d.stage ?? '—'}
                    {d.close_date ? ` · closes ${d.close_date}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold text-text-primary">
                    {d.amount === null ? '—' : `${d.currency ?? ''} ${Number(d.amount).toLocaleString('en-US')}`.trim()}
                  </span>
                  <Badge cls={d.status === 'won' ? 'bg-success-500/10 text-success-500' : d.status === 'lost' ? 'bg-danger/10 text-danger' : 'bg-bg-tertiary text-text-secondary'}>{d.status}</Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function CrmSyncPage() {
  const canManage = useCanManageCrm();
  const ownerId = useCrmOwnerId();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [conns, setConns] = useState<CrmConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<CrmProvider | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [runs, setRuns] = useState<CrmRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<CrmConnection | null>(null);
  const [logKey, setLogKey] = useState(0);

  const conn = conns.find((c) => c.provider === selected && c.status !== 'disconnected') ?? null;

  const loadConns = useCallback(
    async (silent = false) => {
      if (!ownerId) return;
      if (!silent) setLoading(true);
      try {
        const rows = await listConnections(ownerId);
        setConns(rows);
        setLoadError(false);
        setSelected((cur) => cur ?? rows.find((r) => r.status !== 'disconnected')?.provider ?? null);
      } catch {
        if (!silent) setLoadError(true);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [ownerId],
  );

  const loadRuns = useCallback(
    async (silent = false) => {
      if (!conn) return;
      if (!silent) setRunsLoading(true);
      try {
        setRuns(await listRuns(conn.id));
      } catch {
        /* keep previous */
      } finally {
        if (!silent) setRunsLoading(false);
      }
    },
    [conn?.id], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    if (canManage) void loadConns();
  }, [canManage, loadConns]);

  useEffect(() => {
    setRuns([]);
    void loadRuns();
  }, [loadRuns]);

  // Return from the OAuth redirect.
  useEffect(() => {
    const status = searchParams.get('crm');
    if (!status) return;
    const provider = searchParams.get('provider') as CrmProvider | null;
    const name = provider && PROVIDER_META[provider] ? PROVIDER_META[provider].label : 'CRM';
    const reason = searchParams.get('reason');
    const REASONS: Record<string, string> = {
      access_denied: 'Access was denied.',
      no_refresh_token: 'The CRM did not grant offline access. Check the app scopes and try again.',
      not_configured: 'This CRM is not configured on the server yet.',
      invalid_state: 'The connection link expired. Please try again.',
    };
    if (status === 'connected') {
      toast(`${name} connected. Review the field mapping, then run your first sync.`, 'success');
      if (provider) setSelected(provider);
    } else {
      toast(`Could not connect ${name}. ${(reason && REASONS[reason]) || 'Please try again.'}`, 'error');
    }
    searchParams.delete('crm');
    searchParams.delete('provider');
    searchParams.delete('reason');
    setSearchParams(searchParams, { replace: true });
    void loadConns(true);
  }, [searchParams, setSearchParams, toast, loadConns]);

  // Live progress (+ a poll while a run is active, in case the socket drops).
  const liveStatus = useRealtimeSubscription<CrmRun>({
    channelName: `crm-runs-${ownerId ?? 'anon'}`,
    table: 'crm_sync_runs',
    event: '*',
    filter: ownerId ? `user_id=eq.${ownerId}` : undefined,
    enabled: canManage && !!ownerId,
    onChange: () => {
      void loadRuns(true);
      void loadConns(true);
      setLogKey((k) => k + 1);
    },
  });
  const running = runs[0]?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      void loadRuns(true);
      void loadConns(true);
    }, 4000);
    return () => clearInterval(t);
  }, [running, loadRuns, loadConns]);

  const connect = async (provider: CrmProvider) => {
    setBusy(`connect:${provider}`);
    try {
      window.location.href = await startOAuth(provider);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not connect.', 'error');
      setBusy(null);
    }
  };

  const runSync = async (c: CrmConnection) => {
    setBusy(`sync:${c.id}`);
    try {
      await syncNow(c.id);
      toast('Sync started.', 'success');
      await loadRuns(true);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not start the sync.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    const c = confirmDisconnect;
    if (!c) return;
    setConfirmDisconnect(null);
    setBusy(`disc:${c.id}`);
    try {
      await disconnectCrm(c.id);
      toast(`${PROVIDER_META[c.provider].label} disconnected.`, 'info');
      setSelected(null);
      await loadConns(true);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not disconnect.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const toggleAuto = async (c: CrmConnection) => {
    setBusy(`auto:${c.id}`);
    try {
      await saveSettings(c.id, readSettings(c.provider, c.settings), !c.auto_sync);
      await loadConns(true);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update automatic sync.', 'error');
    } finally {
      setBusy(null);
    }
  };

  if (!canManage) return <NoAccess />;

  return (
    <DashboardLayout activeLabel="CRM Sync">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Workflow size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-xl font-bold text-text-primary sm:text-2xl">CRM sync</h1>
              <LiveIndicator status={liveStatus} />
            </div>
            <p className="text-sm text-text-secondary">Two-way sync of contacts, leads and deals with Salesforce, Pipedrive and Zoho CRM.</p>
          </div>
        </div>

        {loading ? (
          <div className="grid gap-4 md:grid-cols-3" aria-busy="true" aria-label="Loading CRM connections">
            {[0, 1, 2].map((i) => (
              <div key={i} className="rounded-2xl border border-border bg-bg-secondary p-5">
                <Skeleton className="h-5 w-1/2" />
                <Skeleton className="mt-3 h-3 w-full" />
                <Skeleton className="mt-5 h-9 w-28" />
              </div>
            ))}
          </div>
        ) : loadError ? (
          <EmptyState icon={AlertTriangle} title="Couldn't load your CRM connections" description="Check your connection and try again." action={{ label: 'Try again', onClick: () => void loadConns() }} />
        ) : (
          <div className="grid gap-4 md:grid-cols-3">
            {CRM_PROVIDERS.map((p) => {
              const c = conns.find((x) => x.provider === p);
              const connected = !!c && c.status !== 'disconnected';
              const needsReconnect = c?.status === 'error';
              const isSel = selected === p && connected;
              return (
                <section
                  key={p}
                  className={`flex flex-col rounded-2xl border bg-bg-secondary p-5 transition-colors ${isSel ? 'border-accent' : 'border-border'}`}
                  aria-label={PROVIDER_META[p].label}
                >
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="text-base font-semibold text-text-primary">{PROVIDER_META[p].label}</h2>
                    {connected ? (
                      <Badge cls={needsReconnect ? 'bg-danger/10 text-danger' : 'bg-success-500/10 text-success-500'}>{needsReconnect ? 'Reconnect needed' : 'Connected'}</Badge>
                    ) : (
                      <Badge cls="bg-bg-tertiary text-text-secondary">Not connected</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-text-secondary">{PROVIDER_META[p].tagline}</p>

                  {connected && c ? (
                    <>
                      <p className="mt-3 truncate text-xs text-text-secondary">
                        {c.account_label} · last sync {timeAgo(c.last_synced_at)}
                      </p>
                      {c.last_error && <p className="mt-1 text-xs text-danger">{c.last_error}</p>}
                      <div className="mt-4 flex flex-wrap gap-2">
                        {needsReconnect ? (
                          <button type="button" disabled={busy !== null} onClick={() => connect(p)} className="focus-ring flex items-center gap-2 rounded-xl bg-cta px-3.5 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60">
                            {busy === `connect:${p}` ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />} Reconnect
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              disabled={busy !== null || (isSel && running)}
                              onClick={() => {
                                setSelected(p);
                                void runSync(c);
                              }}
                              className="focus-ring flex items-center gap-2 rounded-xl bg-cta px-3.5 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
                            >
                              {busy === `sync:${c.id}` || (isSel && running) ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                              {isSel && running ? 'Syncing…' : 'Sync now'}
                            </button>
                            <button type="button" onClick={() => { setSelected(p); setTab('overview'); }} className="focus-ring rounded-xl border border-border px-3.5 py-2 text-sm font-medium text-text-primary hover:bg-bg-tertiary">
                              Manage
                            </button>
                          </>
                        )}
                        <button type="button" disabled={busy !== null} onClick={() => setConfirmDisconnect(c)} aria-label={`Disconnect ${PROVIDER_META[p].label}`} className="focus-ring rounded-xl border border-border px-2.5 py-2 text-text-secondary hover:text-danger disabled:opacity-60">
                          <Unplug size={15} />
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="mt-auto pt-4">
                      <button type="button" disabled={busy !== null} onClick={() => connect(p)} className="focus-ring flex w-full items-center justify-center gap-2 rounded-xl bg-cta px-4 py-2.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60 sm:w-auto">
                        {busy === `connect:${p}` ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />} Connect {PROVIDER_META[p].label}
                      </button>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}

        {!loading && !loadError && !conn && (
          <EmptyState
            icon={Link2}
            title="Connect a CRM to get started"
            description="Sign in with Salesforce, Pipedrive or Zoho CRM. You choose which fields sync, in which direction, and who wins when both sides change."
          />
        )}

        {conn && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div role="tablist" aria-label="CRM sync sections" className="inline-flex rounded-xl border border-border bg-bg-secondary p-1">
                {([['overview', 'Overview'], ['mapping', 'Field mapping'], ['log', 'Sync log']] as [Tab, string][]).map(([t, label]) => (
                  <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)} className={`focus-ring rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${tab === t ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}>
                    {label}
                  </button>
                ))}
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
                <input type="checkbox" checked={conn.auto_sync} disabled={busy !== null} onChange={() => toggleAuto(conn)} className="h-4 w-4 accent-accent" />
                <ArrowLeftRight size={14} className="text-text-secondary" /> Automatic sync (every 15 min)
              </label>
            </div>

            {tab === 'overview' && <OverviewTab conn={conn} runs={runs} runsLoading={runsLoading} ownerId={ownerId} onChanged={() => { void loadRuns(true); setLogKey((k) => k + 1); }} />}
            {tab === 'mapping' && <MappingTab conn={conn} onSaved={() => void loadConns(true)} />}
            {tab === 'log' && <LogTab conn={conn} refreshKey={logKey} />}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!confirmDisconnect}
        title={`Disconnect ${confirmDisconnect ? PROVIDER_META[confirmDisconnect.provider].label : ''}?`}
        description="Syncing stops and the stored credentials are deleted. Records already synced stay in both systems untouched. Reconnecting later re-matches records by email or phone."
        confirmLabel="Disconnect"
        onConfirm={disconnect}
        onCancel={() => setConfirmDisconnect(null)}
      />
    </DashboardLayout>
  );
}
