import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, TriangleAlert } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { Skeleton } from '@/components/Skeleton';
import { useSEO } from '@/lib/seo';
import { REFERENCE_STRENGTHS, getReferenceRequest, submitReference } from '@/lib/talentNetwork';

export function TalentReferencePage() {
  const { token = '' } = useParams();
  useSEO({ title: 'Share a reference — Vireek', description: 'Provide a short professional reference.', canonical: `https://vireek.com/talent/reference/${token}` });
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex';
    document.head.appendChild(meta);
    return () => { meta.remove(); };
  }, []);

  const [info, setInfo] = useState<{ referee_name: string; relationship: string; worker_first_name: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [rating, setRating] = useState(0);
  const [rehire, setRehire] = useState('');
  const [strengths, setStrengths] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);
    if (!valid) { setLoading(false); return; }
    getReferenceRequest(token).then(setInfo).catch(() => setInfo(null)).finally(() => setLoading(false));
  }, [token]);

  const toggle = (k: string) => setStrengths((s) => (s.includes(k) ? s.filter((x) => x !== k) : s.length < 3 ? [...s, k] : s));

  async function submit() {
    if (rating < 1 || !rehire) { setError('Please give a rating and answer the rehire question.'); return; }
    setBusy(true);
    setError(null);
    try {
      const ok = await submitReference(token, { rating, wouldRehire: rehire, strengths, comment: comment.trim() });
      if (ok) setDone(true); else setError('This link has expired or was already used.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not submit your reference.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Header />
      <main className="min-h-screen bg-bg-primary px-6 pb-24 pt-28">
        <div className="mx-auto max-w-xl">
          {loading && <Skeleton className="h-64 w-full rounded-2xl" />}
          {!loading && !info && !done && (
            <p role="alert" className="rounded-2xl border border-border bg-bg-secondary p-6 text-text-primary">This reference link is invalid, expired, or already used.</p>
          )}
          {done && <p className="flex items-center gap-2 rounded-2xl border border-border bg-bg-secondary p-6 text-text-primary"><CheckCircle2 className="text-accent" size={20} aria-hidden="true" />Thank you. Your reference was submitted.</p>}
          {info && !done && (
            <div className="space-y-6">
              <div>
                <h1 className="text-2xl font-bold text-text-primary">Reference for {info.worker_first_name}</h1>
                <p className="mt-2 text-sm text-text-secondary">Hi {info.referee_name}, this takes about 2 minutes. Your answers are shared with employers considering {info.worker_first_name} and are never shown to {info.worker_first_name} directly.</p>
              </div>
              <fieldset>
                <legend className="mb-2 text-sm font-medium text-text-primary">Overall, how would you rate their work?</legend>
                <div className="flex gap-2">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} type="button" aria-pressed={rating === n} onClick={() => setRating(n)}
                      className={`h-11 w-11 rounded-xl border text-sm font-semibold ${rating === n ? 'border-accent bg-accent text-white' : 'border-border bg-bg-secondary text-text-primary'}`}>{n}</button>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend className="mb-2 text-sm font-medium text-text-primary">Would you work with or hire them again?</legend>
                <div className="flex gap-2">
                  {[['yes', 'Yes'], ['unsure', 'Not sure'], ['no', 'No']].map(([v, l]) => (
                    <button key={v} type="button" aria-pressed={rehire === v} onClick={() => setRehire(v)}
                      className={`rounded-xl border px-4 py-2 text-sm ${rehire === v ? 'border-accent bg-accent text-white' : 'border-border bg-bg-secondary text-text-primary'}`}>{l}</button>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend className="mb-2 text-sm font-medium text-text-primary">Strengths (up to 3)</legend>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(REFERENCE_STRENGTHS).map(([k, l]) => (
                    <button key={k} type="button" aria-pressed={strengths.includes(k)} onClick={() => toggle(k)}
                      className={`rounded-full border px-3 py-1.5 text-sm ${strengths.includes(k) ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}>{l}</button>
                  ))}
                </div>
              </fieldset>
              <Textarea label="Anything else employers should know? (optional)" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={800} rows={4} />
              {error && <p role="alert" className="flex items-center gap-2 text-sm text-red-500"><TriangleAlert size={14} aria-hidden="true" />{error}</p>}
              <Button onClick={() => void submit()} disabled={busy}>{busy ? 'Submitting…' : 'Submit reference'}</Button>
            </div>
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}

export default TalentReferencePage;
