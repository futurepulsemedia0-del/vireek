import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Download,
  Filter,
  Lock,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  TriangleAlert,
  Users,
  UserRound,
  X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { supabase } from '@/lib/supabase';
import { exportToCsv } from '@/lib/csvExport';
import type { MarketingSegment } from '@/lib/marketing';
import {
  audienceFilename,
  createRule,
  describeFilter,
  fetchAllMembers,
  fetchLeadStages,
  fieldsForEntity,
  filterToRules,
  getFieldConfig,
  memberCsvColumns,
  previewAudience,
  rulesToFilter,
  sanitizeValue,
  validateRules,
  type AudienceEntity,
  type AudienceResult,
  type AudienceRule,
} from '@/lib/audiences';

const COUNT_DEBOUNCE_MS = 400;

export default function AudiencesPage() {
  const { profile, teamMember, isOwner, permissions, loading: authLoading, profileLoading } = useAuth();
  const { toast } = useToast();

  // Rows in every marketing table are keyed by the ACCOUNT OWNER's id. For a
  // team member that differs from their own user id, so never use user.id here.
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canAccess = isOwner || permissions.can_view_billing;

  const [segments, setSegments] = useState<MarketingSegment[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [entity, setEntity] = useState<AudienceEntity>('customer');
  const [rules, setRules] = useState<AudienceRule[]>([]);
  const [leadStages, setLeadStages] = useState<string[]>([]);

  const [result, setResult] = useState<AudienceResult | null>(null);
  const [counting, setCounting] = useState(false);
  const [countError, setCountError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<MarketingSegment | null>(null);

  const filter = useMemo(() => rulesToFilter(entity, rules), [entity, rules]);
  const filterKey = JSON.stringify(filter);
  const validationError = useMemo(() => validateRules(entity, rules), [entity, rules]);
  const active = segments.find((s) => s.id === activeId) ?? null;

  const isDirty = useMemo(() => {
    if (!active) return name.trim() !== '' || rules.length > 0;
    return (
      active.name !== name.trim() ||
      (active.description ?? '') !== description.trim() ||
      JSON.stringify(rulesToFilter(filterToRules(active.filter).entity, filterToRules(active.filter).rules)) !== filterKey
    );
  }, [active, name, description, rules.length, filterKey]);

  // ---------- load saved audiences ----------
  const loadSegments = useCallback(async () => {
    if (!ownerId) return;
    setListLoading(true);
    setListError(null);
    const { data, error } = await supabase
      .from('marketing_segments')
      .select('*')
      .eq('user_id', ownerId)
      .order('created_at', { ascending: false });
    if (error) setListError(error.message);
    else setSegments((data ?? []) as MarketingSegment[]);
    setListLoading(false);
  }, [ownerId]);

  useEffect(() => {
    if (canAccess) void loadSegments();
  }, [canAccess, loadSegments]);

  useEffect(() => {
    if (!ownerId || !canAccess) return;
    void fetchLeadStages(ownerId).then(setLeadStages).catch(() => undefined);
  }, [ownerId, canAccess]);

  // ---------- live count (debounced, stale responses discarded) ----------
  const requestSeq = useRef(0);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!ownerId || !canAccess) return;
    if (validationError) {
      setResult(null);
      setCountError(null);
      setCounting(false);
      return;
    }
    const seq = ++requestSeq.current;
    setCounting(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await previewAudience(ownerId, JSON.parse(filterKey));
        if (seq !== requestSeq.current) return;
        setResult(res);
        setCountError(null);
      } catch (e) {
        if (seq !== requestSeq.current) return;
        setResult(null);
        setCountError(e instanceof Error ? e.message : 'Could not count this audience.');
      } finally {
        if (seq === requestSeq.current) setCounting(false);
      }
    }, COUNT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [ownerId, canAccess, filterKey, validationError, refreshTick]);

  // ---------- builder actions ----------
  const startNew = () => {
    setActiveId(null);
    setName('');
    setDescription('');
    setEntity('customer');
    setRules([]);
  };

  const openSegment = (s: MarketingSegment) => {
    const parsed = filterToRules(s.filter);
    setActiveId(s.id);
    setName(s.name);
    setDescription(s.description ?? '');
    setEntity(parsed.entity);
    setRules(parsed.rules);
  };

  const changeEntity = (next: AudienceEntity) => {
    if (next === entity) return;
    setEntity(next);
    // keep only rules that still apply to the new entity
    setRules((r) => r.filter((x) => getFieldConfig(x.field).entities.includes(next)));
  };

  const usedFields = new Set(rules.map((r) => r.field));
  const availableFields = fieldsForEntity(entity).filter((f) => !usedFields.has(f.field));

  const updateRule = (id: string, patch: Partial<AudienceRule>) =>
    setRules((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const save = async () => {
    if (!ownerId || saving) return;
    if (!name.trim()) return toast('Give this audience a name first.', 'error');
    if (validationError) return toast(validationError, 'error');
    setSaving(true);
    const payload = {
      name: name.trim(),
      description: description.trim() || null,
      filter,
      is_dynamic: true,
      member_count: result?.total ?? 0,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = activeId
      ? await supabase.from('marketing_segments').update(payload).eq('id', activeId).eq('user_id', ownerId).select().single()
      : await supabase.from('marketing_segments').insert({ ...payload, user_id: ownerId }).select().single();
    setSaving(false);
    if (error || !data) return toast(error?.message ?? 'Could not save this audience.', 'error');
    toast(activeId ? 'Audience updated.' : 'Audience saved.', 'success');
    setActiveId((data as MarketingSegment).id);
    void loadSegments();
  };

  const confirmDelete = async () => {
    if (!pendingDelete || !ownerId) return;
    const { error } = await supabase.from('marketing_segments').delete().eq('id', pendingDelete.id).eq('user_id', ownerId);
    if (error) return toast(error.message, 'error');
    toast('Audience deleted.', 'success');
    if (pendingDelete.id === activeId) startNew();
    setPendingDelete(null);
    void loadSegments();
  };

  const exportCsv = async () => {
    if (!ownerId || exporting || validationError) return;
    setExporting(true);
    try {
      const all = await fetchAllMembers(ownerId, filter);
      if (all.members.length === 0) return toast('Nobody matches these rules, so there is nothing to export.', 'info');
      exportToCsv(all.members, memberCsvColumns(entity), audienceFilename(name || 'audience'));
      toast(
        all.truncated
          ? `Exported the first ${all.members.length.toLocaleString()} contacts (export limit reached).`
          : `Exported ${all.members.length.toLocaleString()} contacts.`,
        all.truncated ? 'info' : 'success',
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Export failed.', 'error');
    } finally {
      setExporting(false);
    }
  };

  // ---------- gates ----------
  if (authLoading || profileLoading) {
    return (
      <DashboardLayout>
        <div className="mx-auto max-w-6xl space-y-4 px-4 py-8" aria-busy="true">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-64 w-full" />
        </div>
      </DashboardLayout>
    );
  }

  if (!canAccess) {
    return (
      <DashboardLayout>
        <div className="mx-auto max-w-2xl px-4 py-16">
          <EmptyState
            icon={Lock}
            title="You don't have access to Audiences"
            description="Audiences contain customer contact details, so they're limited to the account owner and roles with billing access. Ask your account owner to grant access."
          />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl px-4 py-6 sm:py-8">
        <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <Filter className="h-7 w-7 text-accent" aria-hidden />
              <h1 className="text-2xl font-bold text-text-primary">Audiences</h1>
            </div>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">
              Build dynamic segments from your customers and leads. Counts are live, and a saved audience is
              re-evaluated every time a{' '}
              <Link to="/dashboard/marketing" className="text-accent underline-offset-2 hover:underline">
                campaign
              </Link>{' '}
              runs.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={startNew}>
            <Plus className="h-4 w-4" aria-hidden /> New audience
          </Button>
        </header>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[18rem_1fr]">
          {/* ---------- saved audiences ---------- */}
          <aside aria-label="Saved audiences" className="order-2 lg:order-1">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-text-secondary">Saved audiences</h2>
            {listLoading ? (
              <div className="space-y-3" aria-busy="true">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : listError ? (
              <Card className="p-4">
                <p className="flex items-start gap-2 text-sm text-danger">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {listError}
                </p>
                <Button variant="secondary" size="sm" className="mt-3" onClick={() => void loadSegments()}>
                  <RefreshCw className="h-4 w-4" aria-hidden /> Retry
                </Button>
              </Card>
            ) : segments.length === 0 ? (
              <EmptyState
                icon={Users}
                title="No saved audiences"
                description="Add a rule or two, name it, and save it to reuse it in campaigns."
              />
            ) : (
              <ul className="space-y-3">
                {segments.map((s) => (
                  <li key={s.id}>
                    <motion.div
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={`rounded-xl border p-4 transition-colors ${
                        s.id === activeId ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary hover:border-accent/40'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => openSegment(s)}
                          className="focus-ring min-w-0 flex-1 rounded text-left"
                          aria-current={s.id === activeId ? 'true' : undefined}
                        >
                          <span className="block truncate font-semibold text-text-primary">{s.name}</span>
                          <span className="mt-0.5 block text-xs text-text-secondary">
                            {s.member_count.toLocaleString()} members · {describeFilter(s.filter)}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setPendingDelete(s)}
                          aria-label={`Delete ${s.name}`}
                          className="focus-ring -m-1 rounded p-2 text-text-secondary hover:text-danger"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </motion.div>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          {/* ---------- builder ---------- */}
          <section aria-label="Audience builder" className="order-1 min-w-0 space-y-4 lg:order-2">
            <Card className="space-y-4 p-5 hover:translate-y-0 sm:p-6">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Input
                  label="Name"
                  value={name}
                  maxLength={80}
                  placeholder="e.g. VIPs quiet for 90 days"
                  onChange={(e) => setName(e.target.value)}
                />
                <div>
                  <span className="mb-1.5 block text-sm font-medium text-text-primary">Who</span>
                  <div role="radiogroup" aria-label="Audience type" className="grid grid-cols-2 gap-2">
                    {(['customer', 'lead'] as AudienceEntity[]).map((e) => (
                      <button
                        key={e}
                        type="button"
                        role="radio"
                        aria-checked={entity === e}
                        onClick={() => changeEntity(e)}
                        className={`focus-ring flex min-h-[48px] items-center justify-center gap-2 rounded-xl border px-3 text-sm font-medium transition-colors ${
                          entity === e ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'
                        }`}
                      >
                        {e === 'customer' ? <UserRound className="h-4 w-4" aria-hidden /> : <Users className="h-4 w-4" aria-hidden />}
                        {e === 'customer' ? 'Customers' : 'Leads'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <Textarea
                label="Description (optional)"
                rows={2}
                value={description}
                maxLength={300}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Card>

            <Card className="space-y-3 p-5 hover:translate-y-0 sm:p-6">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold text-text-primary">Rules</h2>
                <span className="text-xs text-text-secondary">
                  {rules.length > 1 ? 'Members must match ALL rules' : 'No rules = everyone'}
                </span>
              </div>

              {rules.length === 0 && (
                <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-text-secondary">
                  This audience currently includes every {entity}. Add a rule to narrow it down.
                </p>
              )}

              {rules.map((rule, i) => (
                <RuleRow
                  key={rule.id}
                  rule={rule}
                  index={i}
                  leadStages={leadStages}
                  onChange={(patch) => updateRule(rule.id, patch)}
                  onRemove={() => setRules((rs) => rs.filter((r) => r.id !== rule.id))}
                />
              ))}

              {availableFields.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {availableFields.map((f) => (
                    <button
                      key={f.field}
                      type="button"
                      onClick={() => setRules((rs) => [...rs, createRule(f.field)])}
                      className="focus-ring inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-border bg-bg-secondary px-3 text-sm text-text-primary hover:border-accent"
                    >
                      <Plus className="h-3.5 w-3.5" aria-hidden /> {f.label}
                    </button>
                  ))}
                </div>
              )}
              {validationError && (
                <p role="alert" className="flex items-start gap-2 text-sm text-danger">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {validationError}
                </p>
              )}
            </Card>

            <Card className="space-y-4 p-5 hover:translate-y-0 sm:p-6" aria-live="polite">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">Matching {entity === 'lead' ? 'leads' : 'customers'}</p>
                  <div className="mt-1 flex items-baseline gap-2">
                    {counting && !result ? (
                      <Skeleton className="h-9 w-24" />
                    ) : (
                      <span className="text-3xl font-bold text-text-primary tabular-nums">
                        {result ? result.total.toLocaleString() : '—'}
                        {result?.truncated ? '+' : ''}
                      </span>
                    )}
                    {counting && result && <RefreshCw className="h-4 w-4 animate-spin text-text-secondary" aria-label="Updating count" />}
                  </div>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button variant="secondary" size="sm" onClick={() => void exportCsv()} disabled={exporting || !!validationError || result?.total === 0}>
                    <Download className="h-4 w-4" aria-hidden /> {exporting ? 'Exporting…' : 'Export CSV'}
                  </Button>
                  <Button size="sm" onClick={() => void save()} disabled={saving || !!validationError || !isDirty}>
                    <Save className="h-4 w-4" aria-hidden /> {saving ? 'Saving…' : activeId ? 'Save changes' : 'Save audience'}
                  </Button>
                </div>
              </div>

              {result?.truncated && (
                <p className="text-xs text-text-secondary">
                  Large audience — the count shows the first {result.total.toLocaleString()} matches scanned. Tighten the rules for an exact number.
                </p>
              )}

              {countError ? (
                <div className="rounded-xl border border-danger/30 bg-danger/5 p-4">
                  <p className="flex items-start gap-2 text-sm text-danger">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {countError}
                  </p>
                  <Button variant="secondary" size="sm" className="mt-3" onClick={() => setRefreshTick((t) => t + 1)}>
                    <RefreshCw className="h-4 w-4" aria-hidden /> Try again
                  </Button>
                </div>
              ) : result && result.total === 0 ? (
                <EmptyState icon={Users} title="Nobody matches yet" description="Loosen a rule — for example remove a tag or lower the minimum score." />
              ) : result ? (
                <PreviewList members={result.members} entity={entity} total={result.total} />
              ) : counting ? (
                <div className="space-y-2" aria-busy="true">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : null}
            </Card>
          </section>
        </div>
      </div>

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete this audience?"
        description={`"${pendingDelete?.name ?? ''}" will be removed. Campaigns using it will keep running but stop finding new members.`}
        confirmLabel="Delete audience"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </DashboardLayout>
  );
}

// ============================================================
// Pieces
// ============================================================

function PreviewList({
  members,
  entity,
  total,
}: {
  members: AudienceResult['members'];
  entity: AudienceEntity;
  total: number;
}) {
  return (
    <div>
      <ul className="divide-y divide-border rounded-xl border border-border">
        {members.map((m) => (
          <li key={m.id} className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-text-primary">{m.name || 'Unnamed'}</p>
              <p className="truncate text-xs text-text-secondary">{m.email ?? m.phone ?? 'No contact details'}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
              {m.stage && <span className="rounded-full bg-bg-tertiary px-2 py-0.5 capitalize">{m.stage}</span>}
              {entity === 'customer' && m.tags.slice(0, 2).map((t) => (
                <span key={t} className="rounded-full bg-accent/10 px-2 py-0.5 text-accent">{t}</span>
              ))}
              {m.score !== null && <span className="tabular-nums">Score {m.score}</span>}
            </div>
          </li>
        ))}
      </ul>
      {total > members.length && (
        <p className="mt-2 text-xs text-text-secondary">
          Showing {members.length} of {total.toLocaleString()} — export the CSV for the full list.
        </p>
      )}
    </div>
  );
}

function RuleRow({
  rule,
  index,
  leadStages,
  onChange,
  onRemove,
}: {
  rule: AudienceRule;
  index: number;
  leadStages: string[];
  onChange: (patch: Partial<AudienceRule>) => void;
  onRemove: () => void;
}) {
  const cfg = getFieldConfig(rule.field);
  const options = rule.field === 'stage' ? leadStages : cfg.options ?? [];
  const inputId = `rule-${rule.id}`;

  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <label htmlFor={inputId} className="text-sm font-medium text-text-primary">
          {index > 0 && <span className="mr-2 text-xs font-semibold uppercase text-text-secondary">and</span>}
          {cfg.label} <span className="font-normal text-text-secondary">· {cfg.hint}</span>
        </label>
        <button type="button" onClick={onRemove} aria-label={`Remove ${cfg.label} rule`} className="focus-ring -m-2 rounded p-2 text-text-secondary hover:text-danger">
          <X className="h-4 w-4" />
        </button>
      </div>

      {cfg.kind === 'number' ? (
        <Input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={cfg.min}
          max={cfg.max}
          value={rule.number ?? ''}
          onChange={(e) => onChange({ number: e.target.value === '' ? null : Number(e.target.value) })}
          className="max-w-[10rem]"
        />
      ) : (
        <ChipPicker
          id={inputId}
          options={options}
          values={rule.values}
          allowCustom={cfg.kind === 'tags' || rule.field === 'stage'}
          onChange={(values) => onChange({ values })}
        />
      )}
    </div>
  );
}

function ChipPicker({
  id,
  options,
  values,
  allowCustom,
  onChange,
}: {
  id: string;
  options: string[];
  values: string[];
  allowCustom: boolean;
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const selected = new Set(values);
  const toggle = (v: string) => onChange(selected.has(v) ? values.filter((x) => x !== v) : [...values, v]);

  const commitDraft = () => {
    const v = sanitizeValue(draft);
    if (v && !selected.has(v)) onChange([...values, v]);
    setDraft('');
  };

  const extra = values.filter((v) => !options.includes(v));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Values">
        {[...options, ...extra].map((o) => (
          <button
            key={o}
            type="button"
            aria-pressed={selected.has(o)}
            onClick={() => toggle(o)}
            className={`focus-ring min-h-[36px] rounded-full border px-3 text-sm capitalize transition-colors ${
              selected.has(o) ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'
            }`}
          >
            {o}
          </button>
        ))}
      </div>
      {allowCustom && (
        <input
          id={id}
          value={draft}
          maxLength={60}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commitDraft();
            }
          }}
          onBlur={commitDraft}
          placeholder="Type a value and press Enter"
          className="focus-ring w-full rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60 focus-visible:border-accent"
        />
      )}
      {!allowCustom && <span id={id} tabIndex={-1} className="sr-only">Select one or more values</span>}
    </div>
  );
}
