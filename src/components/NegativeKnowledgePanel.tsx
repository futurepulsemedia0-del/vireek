import { useCallback, useEffect, useState } from 'react';
import { dismissNegativeRule, fetchActiveNegativeRules, refreshNegativeRules } from '@/lib/negativeKnowledgeApi';
import type { NegativeRule } from '@/lib/negativeKnowledge';

const BADGE: Record<NegativeRule['severity'], string> = {
  avoid: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
  caution: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
};

const BADGE_LABEL: Record<NegativeRule['severity'], string> = {
  avoid: 'Avoid',
  caution: 'Caution',
};

interface Props {
  ownerId: string;
}

export default function NegativeKnowledgePanel({ ownerId }: Props) {
  const [rules, setRules] = useState<NegativeRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await refreshNegativeRules(ownerId);
      setRules(await fetchActiveNegativeRules(ownerId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load learned rules.');
    } finally {
      setLoading(false);
    }
  }, [ownerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const dismiss = async (id?: string) => {
    if (!id) return;
    try {
      await dismissNegativeRule(id);
      setRules((current) => current.filter((r) => r.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not dismiss this rule.');
    }
  };

  return (
    <section aria-labelledby="negative-knowledge-title" className="rounded-xl border border-slate-200 p-5 dark:border-slate-700">
      <h2 id="negative-knowledge-title" className="text-lg font-semibold">
        What Vireek learned not to repeat
      </h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        Rules come from actions that ended badly. Dismiss any rule you disagree with; it stays hidden.
      </p>

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {loading ? (
        <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">Loading…</p>
      ) : rules.length === 0 ? (
        <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">No failure patterns detected yet.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {rules.map((rule) => (
            <li key={rule.id ?? rule.facet} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{rule.title}</p>
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{rule.rationale}</p>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[rule.severity]}`}>
                  {BADGE_LABEL[rule.severity]}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void dismiss(rule.id)}
                className="mt-2 text-sm text-slate-600 underline underline-offset-2 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
              >
                Dismiss
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
