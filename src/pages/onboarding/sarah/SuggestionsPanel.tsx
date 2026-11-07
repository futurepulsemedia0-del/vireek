import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { decideSuggestion, loadSuggestions, refreshSuggestions, type Suggestion } from './sarahLearnApi';

/** "Sarah learned" — unanswered caller questions, approvable with one answer. */
export function SuggestionsPanel() {
  const { t } = useTranslation('sarahLearn');
  const [items, setItems] = useState<Suggestion[] | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      await refreshSuggestions();
      setItems(await loadSuggestions());
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (s: Suggestion, decision: 'approve' | 'dismiss') => {
    setBusy(s.id);
    setError('');
    try {
      await decideSuggestion(s.id, decision, answers[s.id]);
      setItems((prev) => (prev ?? []).filter((x) => x.id !== s.id));
    } catch (e) {
      void e;
      setError(t('suggestions.error'));
    } finally {
      setBusy(null);
    }
  };

  if (items === null) return null;

  return (
    <section aria-labelledby="sl-suggest" className="space-y-3 border-t border-border pt-6">
      <h3 id="sl-suggest" className="text-base font-semibold text-text-primary">
        {t('suggestions.heading')}
      </h3>
      {items.length === 0 ? (
        <p className="text-sm text-text-secondary">{t('suggestions.empty')}</p>
      ) : (
        <>
          <p className="text-sm text-text-secondary">{t('suggestions.intro')}</p>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <ul className="space-y-4">
            {items.map((s) => (
              <li key={s.id} className="space-y-2 rounded-xl border border-border p-3">
                <p className="text-sm font-medium text-text-primary">{s.payload.question}</p>
                <p className="text-xs text-text-secondary">{t('suggestions.asked', { count: s.payload.asked_count ?? 1 })}</p>
                <Textarea label={t('suggestions.answerLabel')} rows={2} value={answers[s.id] ?? ''} onChange={(e) => setAnswers((a) => ({ ...a, [s.id]: e.target.value.slice(0, 600) }))} />
                <div className="flex gap-2">
                  <Button size="sm" disabled={(answers[s.id] ?? '').trim().length < 3} loading={busy === s.id} onClick={() => decide(s, 'approve')}>
                    {t('suggestions.approve')}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy === s.id} onClick={() => decide(s, 'dismiss')}>
                    {t('suggestions.dismiss')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
