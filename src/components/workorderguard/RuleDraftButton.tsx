import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import type { RuleCandidate } from '@/lib/fmCheck';
import { useFmcheckT } from '@/i18n/fmcheckNamespace';

/** Saves one rejection-learning candidate as an account DRAFT. A draft is never a rule and is never enforced. */
export function RuleDraftButton({ candidate }: { candidate: RuleCandidate }) {
  const { t } = useFmcheckT();
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error' | 'limit'>('idle');
  const save = async () => {
    if (state === 'saving') return;
    setState('saving');
    try {
      const api = await import('@/lib/fmIngestApi'); // lazy: keeps this panel's first paint free of the Supabase client
      await api.saveRuleDraft(candidate);
      setState('saved');
    } catch (e) {
      setState((e as { code?: string })?.code === 'suggestion_limit' ? 'limit' : 'error');
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button variant="secondary" size="sm" onClick={() => void save()} disabled={state === 'saving' || state === 'saved'}>
        {state === 'saved' ? t('candidates.draftSaved') : t('candidates.saveDraft')}
      </Button>
      <span role="status" className="text-xs text-text-secondary">
        {state === 'error' && t('candidates.draftError')}
        {state === 'limit' && t('candidates.draftLimit')}
      </span>
    </span>
  );
}
