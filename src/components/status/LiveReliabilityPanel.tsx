import { useEffect, useState } from 'react';

interface FeedIncident { id: string; title: string; impact: string; status: string; summary: string; started_at: string; resolved_at: string | null }
interface Feed { voice_availability_30d: number | null; probe_samples_30d: number; incidents: FeedIncident[] }

const FEED_URL = `${(import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? ''}/functions/v1/status-feed`;

/** Live data from automated test calls. Renders nothing until real data arrives (never fabricated). */
export function LiveReliabilityPanel() {
  const [feed, setFeed] = useState<Feed | null>(null);

  useEffect(() => {
    if (!import.meta.env.VITE_SUPABASE_URL) return;
    let cancelled = false;
    const controller = new AbortController();
    const pull = () =>
      fetch(FEED_URL, { signal: controller.signal })
        .then((r) => (r.ok ? (r.json() as Promise<Feed>) : null))
        .then((d) => { if (!cancelled && d) setFeed(d); })
        .catch(() => undefined);
    void pull();
    const id = window.setInterval(() => void pull(), 60_000);
    return () => { cancelled = true; controller.abort(); window.clearInterval(id); };
  }, []);

  if (!feed || (feed.voice_availability_30d === null && feed.incidents.length === 0)) return null;
  const active = feed.incidents.filter((i) => i.status !== 'resolved');

  return (
    <section className="px-6 py-10" aria-label="Live reliability from automated test calls">
      <div className="mx-auto max-w-3xl rounded-2xl border border-border bg-bg-secondary p-6">
        <h2 className="text-lg font-semibold text-text-primary">Measured by automated test calls</h2>
        {feed.voice_availability_30d !== null && (
          <p className="mt-2 text-sm text-text-secondary">
            AI receptionist answered <strong className="text-text-primary">{feed.voice_availability_30d}%</strong> of test calls over the last 30 days ({feed.probe_samples_30d} calls).
          </p>
        )}
        {active.length > 0 ? (
          <ul className="mt-3 space-y-2 text-sm">
            {active.map((i) => (<li key={i.id} className="text-text-primary"><strong>{i.title}</strong> — {i.summary}</li>))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-success-500">No active incidents detected by automated monitoring.</p>
        )}
        <p className="mt-3 text-xs text-text-secondary"><a className="underline" href={`${FEED_URL}?format=atom`}>Subscribe to the incident feed (Atom)</a></p>
      </div>
    </section>
  );
}
