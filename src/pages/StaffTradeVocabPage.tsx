/**
 * Staff view — /staff/trade-vocabulary (wrapped in <StaffRoute>)
 * Editor for the versioned trade vocabulary (terms, synonyms, brand/model names, pronunciation hints per trade and dialect),
 * publishing of immutable versions, and the log of measured before/after evaluation runs.
 * Reads go through staff-only RLS; writes go through staff-only RPCs (see 20290312000000_trade_vocabulary.sql).
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useToast } from '@/contexts/ToastContext';
import {
  fetchVocabEntries, fetchVocabEvalRuns, fetchVocabVersions, publishVocab, recordVocabEval, saveVocabEntry,
  type VocabEntryRow, type VocabEvalRow, type VocabVersionRow,
} from '@/lib/tradeVocabAdmin';
import {
  DIALECT_RE, DIALECT_SUGGESTIONS, VOCAB_CATEGORIES, VOCAB_TRADES, formatDelta, parseEvalResult, validateDraft,
  type EntryDraft, type VocabCategory,
} from '@/lib/tradeVocabModel';

const EMPTY: EntryDraft = { term: '', category: 'term', synonymsText: '', pronunciationHint: '', boost: 1 };
const field = 'focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

function errMessage(e: unknown): string {
  const m = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : '';
  if (m.includes('forbidden')) return 'Staff access required.';
  if (m.includes('duplicate key')) return 'That term already exists for this trade and dialect.';
  if (m.includes('invalid_text') || m.includes('term_too_long')) return 'Text rejected: no line breaks or control characters, and at most 6 words per term.';
  return m || 'Request failed.';
}

export function StaffTradeVocabPage() {
  const { toast } = useToast();
  const uid = useId();
  const [trade, setTrade] = useState<string>('general');
  const [dialect, setDialect] = useState('en');
  const [loading, setLoading] = useState(true);
  const [entries, setEntries] = useState<VocabEntryRow[]>([]);
  const [versions, setVersions] = useState<VocabVersionRow[]>([]);
  const [evals, setEvals] = useState<VocabEvalRow[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EntryDraft>(EMPTY);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [evalJson, setEvalJson] = useState('');
  const [evalLabel, setEvalLabel] = useState('');
  const [evalDataset, setEvalDataset] = useState('');
  const [evalVersion, setEvalVersion] = useState('');
  const [evalError, setEvalError] = useState<string | null>(null);

  const dialectOk = DIALECT_RE.test(dialect);

  const load = useCallback(async () => {
    if (!dialectOk) { setLoading(false); return; }
    setLoading(true);
    try {
      const [e, v, r] = await Promise.all([fetchVocabEntries(trade, dialect), fetchVocabVersions(trade, dialect), fetchVocabEvalRuns(trade, dialect)]);
      setEntries(e); setVersions(v); setEvals(r);
    } catch (err) {
      toast(errMessage(err), 'error');
    } finally {
      setLoading(false);
    }
  }, [trade, dialect, dialectOk, toast]);

  useEffect(() => { void load(); }, [load]);

  const reset = () => { setEditingId(null); setDraft(EMPTY); setFormError(null); };

  const edit = (row: VocabEntryRow) => {
    setEditingId(row.id);
    setFormError(null);
    setDraft({
      term: row.term, category: row.category as VocabCategory, synonymsText: row.synonyms.join(', '),
      pronunciationHint: row.pronunciation_hint ?? '', boost: (row.boost === 2 || row.boost === 3 ? row.boost : 1) as 1 | 2 | 3,
    });
  };

  const submit = async (status: 'active' | 'retired') => {
    const problem = validateDraft(draft, dialect);
    if (problem) { setFormError(problem); return; }
    setFormError(null);
    setBusy(true);
    try {
      await saveVocabEntry({ id: editingId, trade, dialect, draft, status });
      toast(status === 'retired' ? 'Entry retired.' : 'Entry saved (draft until published).', 'success');
      reset();
      await load();
    } catch (err) {
      setFormError(errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const retireRow = async (row: VocabEntryRow, status: 'active' | 'retired') => {
    setBusy(true);
    try {
      await saveVocabEntry({
        id: row.id, trade, dialect, status,
        draft: { term: row.term, category: row.category as VocabCategory, synonymsText: row.synonyms.join(', '), pronunciationHint: row.pronunciation_hint ?? '', boost: (row.boost === 2 || row.boost === 3 ? row.boost : 1) as 1 | 2 | 3 },
      });
      await load();
    } catch (err) {
      toast(errMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    setBusy(true);
    try {
      const r = await publishVocab(trade, dialect, note);
      toast(r.created ? `Published version ${r.version_no} (${r.entry_count} entries).` : `No changes since version ${r.version_no}; nothing new published.`, r.created ? 'success' : 'info');
      setNote('');
      await load();
    } catch (err) {
      const m = errMessage(err);
      toast(m.includes('nothing_to_publish') ? 'Add at least one active entry before the first publish.' : m, 'error');
    } finally {
      setBusy(false);
    }
  };

  const record = async () => {
    const parsed = parseEvalResult(evalJson);
    if (!parsed.ok) { setEvalError(parsed.error); return; }
    if (evalLabel.trim() === '') { setEvalError('Give the run a label.'); return; }
    setEvalError(null);
    setBusy(true);
    try {
      await recordVocabEval({ trade, dialect, versionId: evalVersion || null, label: evalLabel.trim(), datasetRef: evalDataset, notes: '', result: parsed.value });
      toast('Evaluation run recorded.', 'success');
      setEvalJson(''); setEvalLabel(''); setEvalDataset(''); setEvalVersion('');
      await load();
    } catch (err) {
      setEvalError(errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const activeCount = entries.filter((e) => e.status === 'active').length;
  const dialectListId = `${uid}-dialects`;

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-8 sm:px-6">
      <header className="space-y-2">
        <Link to="/staff" className="text-sm text-accent hover:underline">← Staff</Link>
        <h1 className="text-2xl font-bold text-text-primary">Trade vocabulary (staff)</h1>
        <p className="max-w-2xl text-sm text-text-secondary">
          Terms, synonyms, brand and model names and pronunciation hints per trade and dialect. Edits are drafts; publishing freezes the active entries as an immutable version
          that the live voice prompt reads. <code>en</code> applies to every English dialect; <code>en-US</code> overrides it. Entries in <code>general</code> apply to every trade.
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label htmlFor={`${uid}-trade`} className="block text-sm text-text-secondary">Trade</label>
            <select id={`${uid}-trade`} value={trade} onChange={(e) => { setTrade(e.target.value); reset(); }} className={field}>
              {VOCAB_TRADES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={`${uid}-dialect`} className="block text-sm text-text-secondary">Dialect</label>
            <input id={`${uid}-dialect`} list={dialectListId} value={dialect} onChange={(e) => { setDialect(e.target.value.trim()); reset(); }}
              aria-invalid={!dialectOk} aria-describedby={dialectOk ? undefined : `${uid}-dialect-err`} className={field} dir="ltr" />
            <datalist id={dialectListId}>{DIALECT_SUGGESTIONS.map((d) => <option key={d} value={d} />)}</datalist>
            {!dialectOk && <p id={`${uid}-dialect-err`} role="alert" className="mt-1 text-xs text-danger">Use a form like en or en-US.</p>}
          </div>
        </div>
      </header>

      {loading ? (
        <div className="flex items-center gap-2 text-text-secondary"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      ) : (
        <>
          <section aria-labelledby={`${uid}-form`}>
            <Card padding="md" interactive={false} className="space-y-4">
              <h2 id={`${uid}-form`} className="text-lg font-semibold text-text-primary">{editingId ? 'Edit entry' : 'Add entry'}</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor={`${uid}-term`} className="block text-sm text-text-secondary">Term</label>
                  <input id={`${uid}-term`} value={draft.term} maxLength={80} onChange={(e) => setDraft({ ...draft, term: e.target.value })} className={field} dir="auto" />
                </div>
                <div>
                  <label htmlFor={`${uid}-cat`} className="block text-sm text-text-secondary">Category</label>
                  <select id={`${uid}-cat`} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as VocabCategory })} className={field}>
                    {VOCAB_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor={`${uid}-syn`} className="block text-sm text-text-secondary">Synonyms and spoken variants (comma separated, at most 12)</label>
                  <input id={`${uid}-syn`} value={draft.synonymsText} onChange={(e) => setDraft({ ...draft, synonymsText: e.target.value })} className={field} dir="auto" />
                </div>
                <div>
                  <label htmlFor={`${uid}-hint`} className="block text-sm text-text-secondary">Pronunciation hint (optional)</label>
                  <input id={`${uid}-hint`} value={draft.pronunciationHint} maxLength={120} onChange={(e) => setDraft({ ...draft, pronunciationHint: e.target.value })} className={field} dir="auto" />
                </div>
                <div>
                  <label htmlFor={`${uid}-boost`} className="block text-sm text-text-secondary">Priority (3 = first when space is tight)</label>
                  <select id={`${uid}-boost`} value={draft.boost} onChange={(e) => setDraft({ ...draft, boost: Number(e.target.value) as 1 | 2 | 3 })} className={field}>
                    <option value={1}>1 — normal</option><option value={2}>2 — high</option><option value={3}>3 — highest</option>
                  </select>
                </div>
              </div>
              {formError && <p role="alert" className="text-sm text-danger">{formError}</p>}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" loading={busy} onClick={() => void submit('active')}>{editingId ? 'Save changes' : 'Add entry'}</Button>
                {editingId && <Button size="sm" variant="secondary" disabled={busy} onClick={reset}>Cancel</Button>}
              </div>
            </Card>
          </section>

          <section className="overflow-x-auto" aria-labelledby={`${uid}-list`}>
            <h2 id={`${uid}-list`} className="mb-2 text-lg font-semibold text-text-primary">Entries ({activeCount} active of {entries.length})</h2>
            {entries.length === 0 ? (
              <p className="text-sm text-text-secondary">No entries for {trade} / {dialect} yet.</p>
            ) : (
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Vocabulary entries for {trade} / {dialect}</caption>
                <thead className="text-xs text-text-secondary">
                  <tr><th scope="col" className="py-2 pe-3">Term</th><th scope="col" className="pe-3">Category</th><th scope="col" className="pe-3">Variants</th><th scope="col" className="pe-3">Hint</th><th scope="col" className="pe-3">Priority</th><th scope="col" className="pe-3">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
                </thead>
                <tbody>
                  {entries.map((r) => (
                    <tr key={r.id} className="border-t border-border/60 align-top">
                      <td className="py-2 pe-3 text-text-primary" dir="auto">{r.term}</td>
                      <td className="pe-3">{r.category}</td>
                      <td className="pe-3" dir="auto">{r.synonyms.join(', ') || '—'}</td>
                      <td className="pe-3" dir="auto">{r.pronunciation_hint ?? '—'}</td>
                      <td className="pe-3">{r.boost}</td>
                      <td className="pe-3">{r.status}</td>
                      <td className="whitespace-nowrap">
                        <Button size="xs" variant="ghost" disabled={busy} onClick={() => edit(r)}>Edit</Button>{' '}
                        <Button size="xs" variant="ghost" disabled={busy} onClick={() => void retireRow(r, r.status === 'active' ? 'retired' : 'active')}>{r.status === 'active' ? 'Retire' : 'Restore'}</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section aria-labelledby={`${uid}-pub`}>
            <Card padding="md" interactive={false} className="space-y-4">
              <h2 id={`${uid}-pub`} className="text-lg font-semibold text-text-primary">Publish</h2>
              <p className="text-sm text-text-secondary">Publishes the {activeCount} active entries as the next immutable version. Publishing an unchanged set creates nothing. The live prompt only changes when the <code>TRADE_VOCAB_ENABLED</code> flag is on.</p>
              <div>
                <label htmlFor={`${uid}-note`} className="block text-sm text-text-secondary">Note (optional, 300 characters)</label>
                <input id={`${uid}-note`} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} className={field} dir="auto" />
              </div>
              <Button size="sm" loading={busy} onClick={() => void publish()}>Publish version</Button>
              {versions.length > 0 && (
                <ul className="space-y-1 text-sm text-text-secondary">
                  {versions.map((v) => (
                    <li key={v.id}><span className="font-medium text-text-primary">v{v.version}</span> · {new Date(v.created_at).toLocaleString()} · <code>{v.content_hash.slice(0, 10)}</code>{v.note ? ` · ${v.note}` : ''}</li>
                  ))}
                </ul>
              )}
            </Card>
          </section>

          <section className="space-y-4" aria-labelledby={`${uid}-eval`}>
            <h2 id={`${uid}-eval`} className="text-lg font-semibold text-text-primary">Evaluation on labeled calls</h2>
            <p className="max-w-2xl text-sm text-text-secondary">
              Run <code>node scripts/voice/trade-vocab-eval.mjs --calls calls.jsonl --vocab vocab.json</code> on real labeled calls, then paste its JSON output here.
              Only numbers produced by that script on real calls belong in this log.
            </p>
            {evals.length === 0 ? (
              <p className="text-sm text-text-secondary">No evaluation runs recorded yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Recorded evaluation runs</caption>
                  <thead className="text-xs text-text-secondary">
                    <tr><th scope="col" className="py-2 pe-3">Run</th><th scope="col" className="pe-3">Calls</th><th scope="col" className="pe-3">Term occurrences</th><th scope="col" className="pe-3">WER before → after</th><th scope="col" className="pe-3">Term recall before → after</th><th scope="col">Date</th></tr>
                  </thead>
                  <tbody>
                    {evals.map((r) => (
                      <tr key={r.id} className="border-t border-border/60 align-top">
                        <td className="py-2 pe-3 text-text-primary" dir="auto">{r.label}{r.dataset_ref ? <span className="block text-xs text-text-secondary">{r.dataset_ref}</span> : null}</td>
                        <td className="pe-3">{r.n_calls}</td>
                        <td className="pe-3">{r.n_term_occurrences}</td>
                        <td className="pe-3">{r.baseline_wer} → {r.biased_wer} ({formatDelta(r.baseline_wer, r.biased_wer)})</td>
                        <td className="pe-3">{r.baseline_term_recall ?? '—'} → {r.biased_term_recall ?? '—'} ({formatDelta(r.baseline_term_recall, r.biased_term_recall)})</td>
                        <td>{new Date(r.created_at).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Card padding="md" interactive={false} className="space-y-4">
              <h3 className="text-base font-semibold text-text-primary">Record a run</h3>
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <label htmlFor={`${uid}-elabel`} className="block text-sm text-text-secondary">Label</label>
                  <input id={`${uid}-elabel`} value={evalLabel} maxLength={120} onChange={(e) => setEvalLabel(e.target.value)} className={field} dir="auto" />
                </div>
                <div>
                  <label htmlFor={`${uid}-eds`} className="block text-sm text-text-secondary">Labeled set (name or path, no content)</label>
                  <input id={`${uid}-eds`} value={evalDataset} maxLength={200} onChange={(e) => setEvalDataset(e.target.value)} className={field} dir="auto" />
                </div>
                <div>
                  <label htmlFor={`${uid}-ever`} className="block text-sm text-text-secondary">Vocabulary version</label>
                  <select id={`${uid}-ever`} value={evalVersion} onChange={(e) => setEvalVersion(e.target.value)} className={field}>
                    <option value="">Not specified</option>
                    {versions.map((v) => <option key={v.id} value={v.id}>v{v.version}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label htmlFor={`${uid}-ejson`} className="block text-sm text-text-secondary">Script output (JSON)</label>
                <textarea id={`${uid}-ejson`} value={evalJson} onChange={(e) => setEvalJson(e.target.value)} rows={6} className={`${field} font-mono`} dir="ltr" spellCheck={false} />
              </div>
              {evalError && <p role="alert" className="text-sm text-danger">{evalError}</p>}
              <Button size="sm" loading={busy} onClick={() => void record()}>Record run</Button>
            </Card>
          </section>
        </>
      )}
    </div>
  );
}
