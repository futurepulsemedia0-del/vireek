import { useCallback, useEffect, useRef, useState } from 'react';
import { Fingerprint, GitMerge, Loader2, Settings2, TriangleAlert } from 'lucide-react';
import { MergeDialog } from '@/components/duplicates/MergeDialog';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { UNMERGE_WINDOW_DAYS, totalMoved, type DuplicatePair, type MergeResult } from '@/lib/duplicates';
import {
  DEFAULT_IDENTITY_SETTINGS,
  candidateToPair,
  confidenceTone,
  describeSignals,
  dismissIdentityCandidate,
  fetchIdentityCandidates,
  fetchIdentitySettings,
  saveIdentitySettings,
  type IdentityCandidate,
  type IdentitySettings,
} from '@/lib/identityResolution';

const PAGE = 10;

const TONE_CLASS = {
  high: 'bg-emerald-500/10 text-emerald-500',
  medium: 'bg-amber-500/10 text-amber-500',
  low: 'bg-slate-500/10 text-text-secondary',
} as const;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.';
}

function Side({ r }: { r: IdentityCandidate['a'] }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-bg-primary p-3 text-sm">
      <p className="truncate font-medium text-text-primary">{r.name}</p>
      {[r.phone, r.email, r.address].map((v, i) =>
        v && v.trim() ? (
          <p key={i} className="truncate text-xs text-text-secondary">
            {v}
          </p>
        ) : null,
      )}
    </div>
  );
}

/** Uncertain identity matches found at ingestion. Rendered inside the Duplicates page (customers → To review). */
export function IdentityReviewQueue() {
  const { toast } = useToast();
  const [items, setItems] = useState<IdentityCandidate[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [target, setTarget] = useState<DuplicatePair | null>(null);
  const [settings, setSettings] = useState<IdentitySettings>(DEFAULT_IDENTITY_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const [page, s] = await Promise.all([fetchIdentityCandidates(PAGE, 0), fetchIdentitySettings()]);
      if (id !== requestRef.current) return;
      setItems(page.items);
      setTotal(page.total);
      setSettings(s);
    } catch (e) {
      if (id !== requestRef.current) return;
      setError(errorText(e));
    } finally {
      if (id === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  const loadMore = async () => {
    const id = requestRef.current;
    setLoadingMore(true);
    try {
      const page = await fetchIdentityCandidates(PAGE, items.length);
      if (id !== requestRef.current) return;
      setItems((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...page.items.filter((p) => !seen.has(p.id))];
      });
      setTotal(page.total);
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  const dismiss = async (c: IdentityCandidate) => {
    setBusyId(c.id);
    try {
      await dismissIdentityCandidate(c.id);
      setItems((prev) => prev.filter((x) => x.id !== c.id));
      setTotal((t) => Math.max(0, t - 1));
      toast('Marked as different people. They won’t be suggested again.', 'success');
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleMerged = (result: MergeResult) => {
    setTarget(null);
    const moved = totalMoved(result.moved);
    toast(`Merged${moved > 0 ? `. ${moved} linked records moved` : ''}. You can undo this for ${UNMERGE_WINDOW_DAYS} days.`, 'success');
    void load();
  };

  const save = async (next: IdentitySettings) => {
    setSavingSettings(true);
    try {
      setSettings(await saveIdentitySettings(next));
      toast('Identity settings saved.', 'success');
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <section aria-labelledby="identity-queue-heading" className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Fingerprint className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 id="identity-queue-heading" className="text-base font-semibold text-text-primary">
              Identity matches to review{total > 0 ? ` (${total})` : ''}
            </h2>
            <p className="mt-0.5 text-sm text-text-secondary">
              Found automatically when calls and leads come in. Clear-cut matches are merged for you (undo for {UNMERGE_WINDOW_DAYS} days); these were not certain enough.
            </p>
          </div>
        </div>
        <Button size="sm" variant="ghost" aria-expanded={showSettings} onClick={() => setShowSettings((v) => !v)}>
          <Settings2 className="h-4 w-4" aria-hidden="true" /> Settings
        </Button>
      </div>

      {showSettings && (
        <div className="mt-4 space-y-3 rounded-xl border border-border bg-bg-primary p-4 text-sm">
          <label className="flex items-center justify-between gap-3">
            <span className="text-text-primary">Merge obvious matches automatically</span>
            <input
              type="checkbox"
              checked={settings.autoEnabled}
              disabled={savingSettings}
              onChange={(e) => void save({ ...settings, autoEnabled: e.target.checked })}
              className="h-4 w-4 accent-accent"
            />
          </label>
          <p className="text-xs text-text-secondary">
            Needs a score of {settings.auto}+ with a matching phone or email plus a second agreeing signal, and no name conflict. Pairs you split apart are never merged again.
          </p>
        </div>
      )}

      {loading ? (
        <div className="mt-5 flex items-center gap-2 text-sm text-text-secondary" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading…
        </div>
      ) : error ? (
        <div className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary p-3 text-sm" role="alert">
          <span className="flex items-center gap-2 text-text-secondary">
            <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" /> {error}
          </span>
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="mt-5 text-sm text-text-secondary">Nothing to review. New matches will show up here.</p>
      ) : (
        <ul className="mt-5 space-y-3">
          {items.map((c) => {
            const tone = confidenceTone(c.score);
            return (
              <li key={c.id} className="rounded-xl border border-border p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className={`rounded-full px-2 py-0.5 font-semibold ${TONE_CLASS[tone]}`}>{c.score}% match</span>
                  <span className="text-text-secondary">{describeSignals(c.signals)}</span>
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <Side r={c.a} />
                  <Side r={c.b} />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setTarget(candidateToPair(c))} disabled={busyId === c.id}>
                    <GitMerge className="h-4 w-4" aria-hidden="true" /> Review &amp; merge
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void dismiss(c)} disabled={busyId === c.id}>
                    Different people
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!loading && !error && items.length < total && (
        <div className="mt-4">
          <Button size="sm" variant="secondary" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : `Show more (${total - items.length})`}
          </Button>
        </div>
      )}

      <MergeDialog pair={target} onClose={() => setTarget(null)} onMerged={handleMerged} />
    </section>
  );
}
