import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { WifiOff, Wifi, RefreshCw, ClipboardList, Camera, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useConnectivity } from '@/contexts/ConnectivityContext';
import { getSyncState, subscribeSync } from '@/lib/offline/sync';
import { describeLastSync, safeReturnPath } from '@/lib/offline/offlinePage';
import { EASE } from '@/lib/motion';

function useNoIndexTitle(title: string) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = title;
    let robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const previousRobots = robots?.getAttribute('content') ?? null;
    if (!robots) {
      robots = document.createElement('meta');
      robots.setAttribute('name', 'robots');
      document.head.appendChild(robots);
    }
    robots.setAttribute('content', 'noindex');
    return () => {
      document.title = previousTitle;
      if (previousRobots === null) robots?.remove();
      else robots?.setAttribute('content', previousRobots);
    };
  }, [title]);
}

/**
 * In-app offline screen (/offline). The static /offline.html is what the service
 * worker serves when the app can't boot at all; this is the same message with
 * live status, pending-sync info and shortcuts once the app is running.
 */
export function OfflinePage() {
  useNoIndexTitle("You're offline | Vireek");
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const returnTo = safeReturnPath(params.get('from'));
  const { isOnline, refresh } = useConnectivity();
  const sync = useSyncExternalStore(subscribeSync, getSyncState, getSyncState);
  const [checking, setChecking] = useState(false);
  const [stillOffline, setStillOffline] = useState(false);

  // Coming back online while on this page → continue where the user was headed.
  useEffect(() => {
    if (!isOnline) return;
    const id = window.setTimeout(() => navigate(returnTo, { replace: true }), 1200);
    return () => window.clearTimeout(id);
  }, [isOnline, navigate, returnTo]);

  const retry = async () => {
    setChecking(true);
    setStillOffline(false);
    await refresh();
    setChecking(false);
    setStillOffline(!navigator.onLine);
  };

  const queued = sync.pending + sync.failed;

  return (
    <main
      className="flex min-h-screen items-center justify-center bg-bg-primary px-5 py-10"
      style={{ paddingBottom: 'max(2.5rem, env(safe-area-inset-bottom))' }}
    >
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: EASE }}
        className="w-full max-w-md text-center"
      >
        <span
          className={`mx-auto flex h-16 w-16 items-center justify-center rounded-2xl ${isOnline ? 'bg-success-500/10 text-success-500' : 'bg-accent/10 text-accent'}`}
          aria-hidden="true"
        >
          {isOnline ? <Wifi size={28} /> : <WifiOff size={28} />}
        </span>

        <h1 className="mt-5 text-3xl font-extrabold tracking-tight text-text-primary">
          {isOnline ? "You're back online" : "You're offline"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-text-secondary" role="status" aria-live="polite">
          {isOnline
            ? 'Taking you back…'
            : 'Vireek can’t reach the internet. This page will continue on its own the moment your connection returns.'}
        </p>

        <Card className="mt-6 !p-5 text-left">
          <h2 className="text-sm font-semibold text-text-primary">
            Your work is safe on this device
          </h2>
          <dl className="mt-3 grid grid-cols-3 gap-3 text-center">
            <div className="rounded-xl bg-bg-primary p-3">
              <dt className="text-[11px] text-text-secondary">Waiting to sync</dt>
              <dd className="mt-1 text-xl font-bold text-text-primary">{queued}</dd>
            </div>
            <div className="rounded-xl bg-bg-primary p-3">
              <dt className="text-[11px] text-text-secondary">Need review</dt>
              <dd
                className={`mt-1 text-xl font-bold ${sync.conflicts > 0 ? 'text-warning-500' : 'text-text-primary'}`}
              >
                {sync.conflicts}
              </dd>
            </div>
            <div className="rounded-xl bg-bg-primary p-3">
              <dt className="text-[11px] text-text-secondary">Status</dt>
              <dd className="mt-1 text-sm font-semibold text-text-primary">
                {sync.syncing ? 'Syncing' : isOnline ? 'Online' : 'Offline'}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-text-secondary">
            {describeLastSync(sync.lastSyncAt)}. Queued changes are sent automatically when you
            reconnect.
          </p>
        </Card>

        <Card className="mt-4 !p-5 text-left">
          <h2 className="text-sm font-semibold text-text-primary">
            Still available without a connection
          </h2>
          <ul className="mt-3 space-y-2">
            <li>
              <Link
                to="/tech/today"
                className="focus-ring flex items-center gap-3 rounded-xl px-2 py-2 text-sm text-text-primary transition-colors hover:bg-bg-tertiary"
              >
                <ClipboardList size={16} className="shrink-0 text-accent" />
                <span className="flex-1">Today’s jobs and briefs you’ve opened</span>
                <ArrowRight size={14} className="shrink-0 text-text-secondary" />
              </Link>
            </li>
            <li className="flex items-center gap-3 px-2 py-2 text-sm text-text-secondary">
              <Camera size={16} className="shrink-0 text-accent" />
              <span>Field photos and forms are saved here, then uploaded automatically</span>
            </li>
          </ul>
        </Card>

        <div className="mt-6 flex flex-col gap-3">
          {isOnline ? (
            <Button onClick={() => navigate(returnTo, { replace: true })}>Continue</Button>
          ) : (
            <Button onClick={() => void retry()} disabled={checking}>
              <RefreshCw size={16} className={checking ? 'animate-spin' : ''} />
              {checking ? 'Checking…' : 'Try again'}
            </Button>
          )}
        </div>
        {stillOffline && !isOnline && (
          <p role="alert" className="mt-3 text-sm font-medium text-warning-500">
            Still offline. We’ll keep checking automatically.
          </p>
        )}
      </motion.div>
    </main>
  );
}
