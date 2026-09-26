/**
 * Organizational Memory — /dashboard/org-memory
 * Long-term institutional memory: decisions and why they were made,
 * exceptions granted, failure patterns, winning playbooks, best practices
 * and tribal knowledge — attributed to the person who logged it, so it
 * survives after they leave. Auto-mined entries (warranty distributors,
 * contract renewals) land here too via the mine-organizational-memory
 * edge function; this page is where the business browses, searches,
 * endorses and manually adds to that memory.
 */

import { useCallback, useEffect, useState } from 'react';
import { Library, Loader2, Plus, Search, ThumbsUp, Trash2, User } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  createOrgMemoryEntry,
  deleteOrgMemoryEntry,
  endorseOrgMemoryEntry,
  fetchContributorOptions,
  fetchOrgMemorySummary,
  searchOrgMemory,
  updateOrgMemoryStatus,
  ENTRY_TYPE_LABELS,
  ENTRY_TYPE_COLORS,
  ENTRY_TYPE_OPTIONS,
  STATUS_LABELS,
  STATUS_COLORS,
  STATUS_OPTIONS,
  confidenceLabel,
  confidenceColor,
  parseTags,
  type MemoryEntryType,
  type MemoryStatus,
  type OrgMemoryEntry,
  type OrgMemorySummaryRow,
} from '@/lib/orgMemory';

const EMPTY_FORM = { entry_type: 'tribal_knowledge' as MemoryEntryType, title: '', situation: '', action_taken: '', rationale: '', outcome_summary: '', contributor_id: '', tags: '' };

export function OrganizationalMemoryPage() {
  const { toast } = useToast();
  const [entries, setEntries] = useState<OrgMemoryEntry[]>([]);
  const [summary, setSummary] = useState<OrgMemorySummaryRow[]>([]);
  const [contributors, setContributors] = useState<{ id: string; member_name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<MemoryEntryType | ''>('');
  const [statusFilter, setStatusFilter] = useState<MemoryStatus | ''>('active');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [e, s, c] = await Promise.all([
        searchOrgMemory(query || undefined, typeFilter || undefined, statusFilter || undefined),
        fetchOrgMemorySummary(),
        fetchContributorOptions(),
      ]);
      setEntries(e);
      setSummary(s);
      setContributors(c);
    } catch {
      toast('Could not load organizational memory.', 'error');
    } finally {
      setLoading(false);
    }
  }, [query, typeFilter, statusFilter, toast]);

  useEffect(() => { void load(); }, [load]);

  const submitEntry = async () => {
    if (!form.title.trim()) { toast('A title is required.', 'error'); return; }
    setSaving(true);
    try {
      await createOrgMemoryEntry({
        entry_type: form.entry_type,
        title: form.title.trim(),
        situation: form.situation.trim() || undefined,
        action_taken: form.action_taken.trim() || undefined,
        rationale: form.rationale.trim() || undefined,
        outcome_summary: form.outcome_summary.trim() || undefined,
        contributor_id: form.contributor_id || null,
        tags: parseTags(form.tags),
      });
      toast('Added to organizational memory.', 'success');
      setForm(EMPTY_FORM);
      setShowForm(false);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save entry.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const endorse = async (id: string) => {
    setBusyId(id);
    try {
      await endorseOrgMemoryEntry(id);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not endorse.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const changeStatus = async (id: string, status: MemoryStatus) => {
    setBusyId(id);
    try {
      await updateOrgMemoryStatus(id, status);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update status.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    setBusyId(id);
    try {
      await deleteOrgMemoryEntry(id);
      toast('Entry removed.', 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not remove entry.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <DashboardLayout activeLabel="Organizational Memory">
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Library className="text-cta" size={20} />
            <p className="text-sm font-semibold text-text-primary">Organizational Memory</p>
          </div>
          <button
            onClick={() => setShowForm((v) => !v)}
            className="focus-ring flex items-center gap-1 rounded-lg bg-cta/15 px-3 py-1.5 text-xs font-medium text-cta"
          >
            <Plus size={12} /> Log entry
          </button>
        </div>
        <p className="-mt-4 max-w-2xl text-xs text-text-secondary">
          Decisions and why they were made, exceptions granted, failure patterns, winning playbooks, best practices
          and tribal knowledge — attributed to whoever logged it, so it survives after they leave.
        </p>

        {summary.length > 0 && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {ENTRY_TYPE_OPTIONS.map((t) => {
              const row = summary.find((s) => s.entry_type === t);
              return (
                <div key={t} className="rounded-2xl border border-border bg-bg-secondary p-3">
                  <p className={`mb-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${ENTRY_TYPE_COLORS[t]}`}>{ENTRY_TYPE_LABELS[t]}</p>
                  <p className="text-lg font-bold text-text-primary">{row?.active_count ?? 0}</p>
                  <p className="text-[10px] text-text-secondary">{row?.distinct_contributors ?? 0} contributor{row?.distinct_contributors === 1 ? '' : 's'} · {row?.total_endorsements ?? 0} endorsements</p>
                </div>
              );
            })}
          </div>
        )}

        {showForm && (
          <div className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-5">
            <p className="text-sm font-semibold text-text-primary">Log a new entry</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <select value={form.entry_type} onChange={(e) => setForm({ ...form, entry_type: e.target.value as MemoryEntryType })}
                className="focus-ring rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary">
                {ENTRY_TYPE_OPTIONS.map((t) => <option key={t} value={t}>{ENTRY_TYPE_LABELS[t]}</option>)}
              </select>
              <select value={form.contributor_id} onChange={(e) => setForm({ ...form, contributor_id: e.target.value })}
                className="focus-ring rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary">
                <option value="">Attribute to (optional)</option>
                {contributors.map((c) => <option key={c.id} value={c.id}>{c.member_name}</option>)}
              </select>
            </div>
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Title"
              className="focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
            <textarea value={form.situation} onChange={(e) => setForm({ ...form, situation: e.target.value })} placeholder="Situation — what came up"
              rows={2} className="focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
            <textarea value={form.action_taken} onChange={(e) => setForm({ ...form, action_taken: e.target.value })} placeholder="Action taken / decision made"
              rows={2} className="focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
            <textarea value={form.rationale} onChange={(e) => setForm({ ...form, rationale: e.target.value })} placeholder="Rationale — why this was the right call"
              rows={2} className="focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
            <textarea value={form.outcome_summary} onChange={(e) => setForm({ ...form, outcome_summary: e.target.value })} placeholder="Outcome — what happened as a result"
              rows={2} className="focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
            <input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="Tags, comma separated"
              className="focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowForm(false)} className="focus-ring rounded-lg px-3 py-1.5 text-xs font-medium text-text-secondary">Cancel</button>
              <button disabled={saving} onClick={submitEntry} className="focus-ring flex items-center gap-1 rounded-lg bg-cta px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                {saving && <Loader2 size={12} className="animate-spin" />} Save
              </button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search organizational memory…"
              className="focus-ring w-full rounded-lg border border-border bg-bg-secondary py-2 pl-9 pr-3 text-sm text-text-primary" />
          </div>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as MemoryEntryType | '')}
            className="focus-ring rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary">
            <option value="">All types</option>
            {ENTRY_TYPE_OPTIONS.map((t) => <option key={t} value={t}>{ENTRY_TYPE_LABELS[t]}</option>)}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as MemoryStatus | '')}
            className="focus-ring rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary">
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
        </div>

        {loading ? (
          <div className="flex h-48 items-center justify-center"><Loader2 className="animate-spin" /></div>
        ) : (
          <div className="space-y-3">
            {entries.length === 0 && (
              <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center text-sm text-text-secondary">
                Nothing here yet. Log a decision, exception, or lesson above.
              </div>
            )}
            {entries.map((item) => (
              <div key={item.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${ENTRY_TYPE_COLORS[item.entry_type]}`}>{ENTRY_TYPE_LABELS[item.entry_type]}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_COLORS[item.status]}`}>{STATUS_LABELS[item.status]}</span>
                  </div>
                  <span className={`text-[11px] font-semibold ${confidenceColor(item.confidence_score)}`}>{confidenceLabel(item.confidence_score)}</span>
                </div>
                <p className="mt-2 text-sm font-semibold text-text-primary">{item.title}</p>
                <div className="mt-2 space-y-1 text-xs text-text-secondary">
                  {item.situation && <p><span className="font-medium text-text-primary">Situation: </span>{item.situation}</p>}
                  {item.action_taken && <p><span className="font-medium text-text-primary">Action: </span>{item.action_taken}</p>}
                  {item.rationale && <p><span className="font-medium text-text-primary">Why: </span>{item.rationale}</p>}
                  {item.outcome_summary && <p><span className="font-medium text-text-primary">Outcome: </span>{item.outcome_summary}</p>}
                </div>
                {item.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {item.tags.map((tag) => <span key={tag} className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] text-text-secondary">{tag}</span>)}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                  <div className="flex items-center gap-3 text-[11px] text-text-secondary">
                    {item.contributor_name && <span className="flex items-center gap-1"><User size={12} />{item.contributor_name}</span>}
                    <span>{new Date(item.created_at).toLocaleDateString()}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button disabled={busyId === item.id} onClick={() => endorse(item.id)}
                      className="focus-ring flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-text-secondary hover:text-cta disabled:opacity-50">
                      <ThumbsUp size={12} /> {item.endorsement_count}
                    </button>
                    <select value={item.status} disabled={busyId === item.id} onChange={(e) => changeStatus(item.id, e.target.value as MemoryStatus)}
                      className="focus-ring rounded-lg border border-border bg-bg-primary px-2 py-1 text-[11px] text-text-secondary">
                      {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
                    </select>
                    <button disabled={busyId === item.id} onClick={() => remove(item.id)}
                      className="focus-ring rounded-lg p-1 text-text-secondary hover:text-danger-500 disabled:opacity-50">
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
