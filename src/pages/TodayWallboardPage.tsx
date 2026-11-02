import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TodayHome } from '@/components/today/TodayHome';

/** Signed-in TV view of Today: big type, no interaction needed, screen kept awake where the browser allows it. */
export function TodayWallboardPage() {
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setClock(new Date()), 30_000);
    let lock: { release: () => Promise<void> } | null = null;
    const wake = async () => {
      try {
        lock = await (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request('screen') ?? null;
      } catch {
        /* best effort: the TV's own sleep settings still apply */
      }
    };
    void wake();
    const onVis = () => !document.hidden && void wake();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release();
    };
  }, []);
  return (
    <main className="min-h-screen bg-bg-primary p-10">
      <h1 className="sr-only">Today on the wallboard</h1>
      <div className="mb-6 flex items-center justify-between text-text-secondary">
        <Link to="/dashboard" className="focus-ring rounded px-2 py-1 text-sm hover:underline">Exit TV view</Link>
        <time className="text-3xl tabular-nums" dateTime={clock.toISOString()}>{clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
      </div>
      <TodayHome variant="tv" />
    </main>
  );
}
