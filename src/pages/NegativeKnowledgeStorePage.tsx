/**
 * Negative Knowledge Store — /dashboard/negative-knowledge
 *
 * A structured record of strategies and actions that already failed under
 * specific conditions, so agents, workflows, and people stop repeating them.
 * Entries live in `negative_knowledge_entries` (src/lib/negativeKnowledge.ts).
 * Before retrying a strategy, call checkNegativeKnowledge(domain, context) —
 * any active entry whose failure conditions are a subset of the current
 * context means "this was already tried under these conditions and failed".
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { CheckCircle2, History, Repeat2, ShieldAlert, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  fetchNegativeKnowledgeEntries,
  resolveNegativeKnowledgeEntry,
  NEGATIVE_KNOWLEDGE_DOMAINS,
  type NegativeKnowledgeEntry,
  type NegativeKnowledgeSeverity,
  type NegativeKnowledgeStatus,
} from '@/lib/negativeKnowledge';

const SEVERITY_STYLES: Record<NegativeKnowledgeSeverity, string> = {
  critical: 'bg-red-500/10 text-red-600 border-red-500/25',
  high: 'bg-amber-500/10 text-amber-600 border-amber-500/25',
  medium: 'bg-accent/10 text-accent border-accent/25',
  low: 'bg-bg-tertiary text-text-secondary border-border',
};

const SEVERITY_ORDER: Record<NegativeKnowledgeSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function formatDomain(domain: string): string {
  return domain.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function EntryCard({ entry, onResolve }: { entry: NegativeKnowledgeEntry; onResolve: (id: string, reason: string) => void }) {
  const [resolving, setResolving] = useState(false);
  const [reason, setReason] = useState('');
  const conditions = Object.entries(entry.context_conditions ?? {});

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-text-primary">{entry.strategy}</p>
          <p className="mt-0.5 text-xs text-text-secondary">{formatDomain(entry.domain)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {entry.status === 'resolved' ? (
            <span className="flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-600">
              <CheckCircle2 size={12} /> Resolved
            </span>
          ) : (
            <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${SEVERITY_STYLES[entry.severity]}`}>
              {entry.severity}
            </span>
          )}
        </div>
      </div>

      <p className="mt-3 text-sm text-text-primary">{entry.action_description}</p>
      <p className="mt-1 text-xs text-text-secondary">
        <span className="font-medium text-text-primary">Why it failed:</span> {entry.failure_reason}
      </p>

      {conditions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {conditions.map(([key, value]) => (
            <span key={key} className="rounded-lg bg-bg-tertiary px-2 py-1 text-[11px] text-text-secondary">
              {key}: <span className="font-medium text-text-primary">{String(value)}</span>
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3 text-xs text-text-secondary">
        <span className="flex items-center gap-1">
          <Repeat2 size={12} /> Prevented {entry.times_matched} {entry.times_matched === 1 ? 'repeat' : 'repeats'}
        </span>
        {entry.status === 'active' && !resolving && (
          <button type="button" onClick={() => setResolving(true)} className="focus-ring rounded-lg border border-border px-2.5 py-1 font-medium text-text-secondary hover:text-accent">
            Mark resolved
          </button>
        )}
      </div>

      {resolving && (
        <div className="mt-3 flex items-center gap-2 border-t border-border/60 pt-3">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="What changed so this won't happen again?"
            className="focus-ring flex-1 rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary"
          />
          <button
            type="button"
            disabled={!reason.trim()}
            onClick={() => { onResolve(entry.id, reason.trim()); setResolving(false); }}
            className="focus-ring rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
          >
            Save
          </button>
          <button type="button" onClick={() => setResolving(false)} className="focus-ring rounded-xl border border-border p-2 text-text-secondary">
            <X size={13} />
          </button>
        </div>
      )}
    </motion.div>
  );
}

export function NegativeKnowledgeStorePage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [entries, setEntries] = useState<NegativeKnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [domainFilter, setDomainFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<NegativeKnowledgeStatus | 'all'>('active');

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const result = await fetchNegativeKnowledgeEntries({
        domain: domainFilter === 'all' ? undefined : domainFilter,
        status: statusFilter === 'all' ? undefined : statusFilter,
      });
      setEntries(result);
    } catch {
      toast('Could not load the negative knowledge store', 'error');
    }
    setLoading(false);
  }, [user, domainFilter, statusFilter, toast]);

  useEffect(() => { void load(); }, [load]);

  const sorted = useMemo(
    () => [...entries].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.times_matched - a.times_matched),
    [entries],
  );

  const handleResolve = async (id: string, reason: string) => {
    try {
      await resolveNegativeKnowledgeEntry(id, reason);
      setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, status: 'resolved' as const, resolved_reason: reason } : e)));
      toast('Marked resolved', 'success');
    } catch {
      toast('Could not resolve this entry', 'error');
    }
  };

  return (
    <DashboardLayout activeLabel="Negative Knowledge Store">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <History size={22} className="text-accent" /> Negative Knowledge Store
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
              Strategies and actions that already failed under specific conditions — kept on record so agents,
              workflows, and your team don't try them again the same way.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select value={domainFilter} onChange={(e) => setDomainFilter(e.target.value)} className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs text-text-secondary">
              <option value="all">All domains</option>
              {NEGATIVE_KNOWLEDGE_DOMAINS.map((d) => <option key={d} value={d}>{formatDomain(d)}</option>)}
            </select>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as NegativeKnowledgeStatus | 'all')} className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs text-text-secondary">
              <option value="active">Active</option>
              <option value="resolved">Resolved</option>
              <option value="superseded">Superseded</option>
              <option value="all">All statuses</option>
            </select>
          </div>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => <div key={i} className="h-36 animate-pulse rounded-2xl bg-bg-tertiary" />)}
          </div>
        ) : sorted.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-12 text-center">
            <ShieldAlert className="mx-auto mb-2 h-6 w-6 text-text-secondary/50" />
            <p className="mx-auto max-w-sm text-sm text-text-secondary">
              Nothing logged here yet. Once a strategy fails, record it with logNegativeKnowledgeEntry() so it's
              checked before anything tries it again.
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {sorted.map((entry) => <EntryCard key={entry.id} entry={entry} onResolve={handleResolve} />)}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
