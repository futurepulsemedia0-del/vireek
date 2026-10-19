// src/pages/WallboardPage.tsx
//
// Public, login-free dispatch TV at /wallboard/:token. Read-only. The token is
// the credential (SHA-256 hashed server-side, revocable). Data = one token-gated
// RPC; realtime = empty broadcast nudges that trigger a refetch.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Expand, Lock, Pause, Play, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { FadeIn, Skeleton } from '@/components/Skeleton';
import { useWallboardFeed } from '@/hooks/useWallboardFeed';
import { CallsPanel, EmergenciesPanel, JobsPanel, KpiStrip, RevenuePanel, TechniciansPanel } from '@/components/wallboard/WallboardPanels';
import {
  PANEL_LABELS,
  activePanels,
  dwellMs,
  formatAge,
  formatClock,
  hasCriticalEmergency,
  isStale,
  stepIndex,
  type WallboardPanelKey,
  type WallboardSnapshot,
} from '@/lib/wallboard';

const TICK_MS = 10_000;
const CURSOR_HIDE_MS = 3_000;
const SOFT_RELOAD_MS = 24 * 60 * 60 * 1000; // a TV runs for weeks: reload daily to shed leaks and pick up new deploys

type WakeLockLike = { release: () => Promise<void> };
type NavWithWakeLock = Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockLike> } };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-slate-100">
      <div className="max-w-md text-center">{children}</div>
    </main>
  );
}

function renderPanel(key: WallboardPanelKey, snapshot: WallboardSnapshot, nowMs: number) {
  switch (key) {
    case 'jobs':
      return <JobsPanel snapshot={snapshot} nowMs={nowMs} />;
    case 'technicians':
      return <TechniciansPanel snapshot={snapshot} nowMs={nowMs} />;
    case 'emergencies':
      return <EmergenciesPanel snapshot={snapshot} nowMs={nowMs} />;
    case 'calls':
      return <CallsPanel snapshot={snapshot} nowMs={nowMs} />;
    case 'revenue':
      return <RevenuePanel snapshot={snapshot} nowMs={nowMs} />;
  }
}

export function WallboardPage() {
  const { token } = useParams<{ token: string }>();
  const { state, snapshot, lastOkAt, realtime, refresh } = useWallboardFeed(token);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [paused, setPaused] = useState(false);
  const [panelKey, setPanelKey] = useState<WallboardPanelKey | null>(null);
  const [cursorHidden, setCursorHidden] = useState(false);
  const startedAt = useRef(Date.now());
  const seenCritical = useRef<Set<string>>(new Set());

  // ---- page hygiene: never indexed, never leak the token via Referer ----
  useEffect(() => {
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex, nofollow, noarchive';
    const referrer = document.createElement('meta');
    referrer.name = 'referrer';
    referrer.content = 'no-referrer';
    document.head.append(robots, referrer);
    return () => {
      robots.remove();
      referrer.remove();
    };
  }, []);

  useEffect(() => {
    if (snapshot?.config.name) document.title = `${snapshot.config.name} · Wallboard`;
  }, [snapshot?.config.name]);

  // ---- clock + daily soft reload ----
  useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      if (now - startedAt.current > SOFT_RELOAD_MS) window.location.reload();
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  // ---- keep the screen awake (re-acquired after the tab regains visibility) ----
  useEffect(() => {
    let lock: WakeLockLike | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        const nav = navigator as NavWithWakeLock;
        if (!nav.wakeLock || document.visibilityState !== 'visible') return;
        const l = await nav.wakeLock.request('screen');
        if (cancelled) void l.release().catch(() => undefined);
        else lock = l;
      } catch {
        /* unsupported or denied: the TV's own power settings apply */
      }
    };
    void acquire();
    const onVis = () => void acquire();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release().catch(() => undefined);
    };
  }, []);

  // ---- rotation ----
  const panels = useMemo(() => activePanels(snapshot), [snapshot]);
  const current: WallboardPanelKey = panelKey && panels.includes(panelKey) ? panelKey : panels[0];
  const rotationSeconds = snapshot?.config.rotationSeconds ?? 15;
  const dwell = dwellMs(current, snapshot, rotationSeconds);

  const step = useCallback(
    (direction: 1 | -1) => {
      const idx = panels.indexOf(current);
      setPanelKey(panels[stepIndex(idx < 0 ? 0 : idx, panels.length, direction)]);
    },
    [panels, current],
  );

  // `step` is read through a ref so a data refresh (new snapshot object) never
  // restarts the dwell timer; otherwise frequent realtime updates could stop the rotation.
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    if (paused || panels.length < 2 || state !== 'ready') return;
    const id = window.setTimeout(() => stepRef.current(1), dwell);
    return () => window.clearTimeout(id);
  }, [paused, panels.length, state, dwell, current]);

  // A NEW critical emergency interrupts the rotation immediately.
  useEffect(() => {
    if (!snapshot) return;
    const critical = snapshot.emergencies.filter((e) => e.severity === 'critical' || e.slaBreached).map((e) => e.id);
    const fresh = critical.filter((id) => !seenCritical.current.has(id));
    seenCritical.current = new Set(critical);
    if (fresh.length > 0 && seenCritical.current.size > 0 && snapshot.config.panels.includes('emergencies')) {
      setPanelKey('emergencies');
    }
  }, [snapshot]);

  // ---- controls ----
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === ' ') {
        e.preventDefault();
        setPaused((p) => !p);
      } else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, toggleFullscreen]);

  useEffect(() => {
    let timer: number | null = null;
    const show = () => {
      setCursorHidden(false);
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => setCursorHidden(true), CURSOR_HIDE_MS);
    };
    show();
    window.addEventListener('mousemove', show);
    window.addEventListener('pointerdown', show);
    return () => {
      window.removeEventListener('mousemove', show);
      window.removeEventListener('pointerdown', show);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  // ---- states ----
  if (state === 'loading') {
    return (
      <main className="min-h-screen bg-slate-950 p-8" aria-busy="true" aria-label="Loading wallboard">
        <div className="grid grid-cols-5 gap-4">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-28 !bg-slate-800" />
          ))}
        </div>
        <Skeleton className="mt-6 h-[60vh] !bg-slate-800" />
      </main>
    );
  }

  if (state === 'invalid') {
    return (
      <Shell>
        <Lock className="mx-auto mb-3 text-slate-400" size={36} />
        <h1 className="text-2xl font-bold">This display link is no longer available</h1>
        <p className="mt-2 text-slate-400">It may have been revoked. Ask the account owner for a new link.</p>
      </Shell>
    );
  }

  if (state === 'error' || !snapshot) {
    return (
      <Shell>
        <WifiOff className="mx-auto mb-3 text-slate-400" size={36} />
        <h1 className="text-2xl font-bold">Can&apos;t reach Vireek</h1>
        <p className="mt-2 text-slate-400">Check this screen&apos;s internet connection.</p>
        <Button className="mt-4" onClick={refresh}>
          Try again
        </Button>
      </Shell>
    );
  }

  const stale = isStale(lastOkAt, nowMs);
  const clock = formatClock(nowMs, snapshot.timezone);
  const critical = hasCriticalEmergency(snapshot);
  const showBanner = critical && current !== 'emergencies';
  const liveOk = realtime === 'live' && !stale;

  return (
    <main
      className={`flex min-h-screen flex-col bg-slate-950 text-slate-100 ${cursorHidden ? 'cursor-none' : ''}`}
      style={{ fontSize: 'clamp(15px, 1.15vw, 30px)' }}
      aria-label={`${snapshot.config.name} dispatch wallboard`}
    >
      <header className="flex items-center justify-between gap-[1em] px-[1.5em] pb-[0.6em] pt-[1em]">
        <div className="min-w-0">
          <h1 className="truncate text-[1.9em] font-bold tracking-tight text-white">{snapshot.config.name}</h1>
          <p className="text-[0.95em] text-slate-400">{PANEL_LABELS[current]}</p>
        </div>
        <div className="flex items-center gap-[1.2em]">
          <span
            role="status"
            className={`inline-flex items-center gap-[0.5em] rounded-full px-[0.9em] py-[0.3em] text-[0.8em] font-semibold ring-1 ${
              liveOk ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30' : 'bg-amber-500/15 text-amber-300 ring-amber-400/30'
            }`}
          >
            <span className={`h-[0.6em] w-[0.6em] rounded-full ${liveOk ? 'animate-pulse bg-emerald-400' : 'bg-amber-400'}`} />
            {liveOk ? 'LIVE' : stale ? 'OFFLINE' : 'RECONNECTING'}
          </span>
          <div className="text-right">
            <p className="text-[2.2em] font-bold leading-none tabular-nums text-white">{clock.time}</p>
            <p className="text-[0.85em] text-slate-400">{clock.date}</p>
          </div>
        </div>
      </header>

      {stale && (
        <div role="alert" className="mx-[1.5em] mb-[0.6em] rounded-[0.7em] border border-amber-400/60 bg-amber-500/15 px-[1em] py-[0.5em] text-[1em] font-semibold text-amber-200">
          Connection lost. Showing data from {formatAge(lastOkAt === null ? null : new Date(lastOkAt).toISOString(), nowMs)}.
        </div>
      )}
      {showBanner && (
        <div role="alert" className="mx-[1.5em] mb-[0.6em] animate-pulse rounded-[0.7em] border border-red-400/70 bg-red-600/25 px-[1em] py-[0.5em] text-[1.1em] font-bold text-red-100">
          {snapshot.emergencies.length} open emergenc{snapshot.emergencies.length === 1 ? 'y' : 'ies'} need attention
        </div>
      )}

      <div className="px-[1.5em]">
        <KpiStrip snapshot={snapshot} />
      </div>

      <FadeIn key={current} className="min-h-0 flex-1 px-[1.5em] py-[1em]">
        {renderPanel(current, snapshot, nowMs)}
      </FadeIn>

      <footer className="flex items-center justify-between gap-[1em] px-[1.5em] pb-[0.8em] text-[0.75em] text-slate-500">
        <div className="flex items-center gap-[0.5em]" aria-label="Panels">
          {panels.map((p) => (
            <span key={p} className={`h-[0.5em] rounded-full transition-all ${p === current ? 'w-[2em] bg-sky-400' : 'w-[0.5em] bg-slate-600'}`} aria-current={p === current ? 'true' : undefined} />
          ))}
          {paused && <span className="ml-[0.5em] font-semibold text-amber-300">Paused</span>}
        </div>
        <div className={`flex items-center gap-[0.6em] transition-opacity ${cursorHidden ? 'opacity-0' : 'opacity-100'}`}>
          <span>← → switch · Space pause · F fullscreen</span>
          <button type="button" onClick={() => setPaused((p) => !p)} className="rounded p-[0.3em] hover:bg-slate-800" aria-label={paused ? 'Resume rotation' : 'Pause rotation'}>
            {paused ? <Play className="h-[1.4em] w-[1.4em]" /> : <Pause className="h-[1.4em] w-[1.4em]" />}
          </button>
          <button type="button" onClick={toggleFullscreen} className="rounded p-[0.3em] hover:bg-slate-800" aria-label="Toggle fullscreen">
            <Expand className="h-[1.4em] w-[1.4em]" />
          </button>
        </div>
      </footer>
    </main>
  );
}
