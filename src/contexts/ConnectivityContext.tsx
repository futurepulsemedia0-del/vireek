import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  buildSnapshot,
  fetchRemoteMaintenanceSignal,
  getBrowserOnline,
  getInitialMaintenance,
  type ConnectivitySnapshot,
  type MaintenanceInfo,
} from '@/lib/connectivity';
import { useToast } from '@/contexts/ToastContext';

interface ConnectivityContextValue extends ConnectivitySnapshot {
  /** Force a remote + online re-check */
  refresh: () => Promise<void>;
}

const ConnectivityContext = createContext<ConnectivityContextValue | null>(null);

const REMOTE_POLL_MS = 60_000;

export function ConnectivityProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const wasOffline = useRef(false);

  const [isOnline, setIsOnline] = useState(getBrowserOnline);
  const [maintenance, setMaintenance] = useState<MaintenanceInfo>(getInitialMaintenance);
  const [degraded, setDegraded] = useState(false);

  const applyRemote = useCallback(async () => {
    const envBase = getInitialMaintenance();
    // Env flag always wins if set
    if (envBase.active) {
      setMaintenance(envBase);
      setDegraded(false);
      return;
    }
    const remote = await fetchRemoteMaintenanceSignal();
    if (remote.maintenance?.active) {
      setMaintenance({
        active: true,
        title: remote.maintenance.title ?? envBase.title,
        message: remote.maintenance.message ?? envBase.message,
        eta: remote.maintenance.eta ?? null,
        statusUrl: remote.maintenance.statusUrl ?? '/status',
      });
      setDegraded(false);
      return;
    }
    setMaintenance({ ...envBase, active: false });
    setDegraded(remote.degraded);
  }, []);

  const refresh = useCallback(async () => {
    setIsOnline(getBrowserOnline());
    await applyRemote();
  }, [applyRemote]);

  // Browser online / offline
  useEffect(() => {
    const onOnline = () => {
      setIsOnline(true);
      if (wasOffline.current) {
        toast('You are back online.', 'success');
        wasOffline.current = false;
      }
      void applyRemote();
    };
    const onOffline = () => {
      setIsOnline(false);
      wasOffline.current = true;
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [applyRemote, toast]);

  // Initial + periodic remote check
  useEffect(() => {
    void applyRemote();
    const id = window.setInterval(() => {
      void applyRemote();
    }, REMOTE_POLL_MS);
    return () => window.clearInterval(id);
  }, [applyRemote]);

  // Re-check when tab becomes visible again
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refresh]);

  const snapshot = useMemo(
    () => buildSnapshot({ isOnline, maintenance, degraded }),
    [isOnline, maintenance, degraded],
  );

  const value = useMemo(
    () => ({ ...snapshot, refresh }),
    [snapshot, refresh],
  );

  return (
    <ConnectivityContext.Provider value={value}>
      {children}
    </ConnectivityContext.Provider>
  );
}

export function useConnectivity(): ConnectivityContextValue {
  const ctx = useContext(ConnectivityContext);
  if (!ctx) {
    throw new Error('useConnectivity must be used within ConnectivityProvider');
  }
  return ctx;
}

/** Safe for optional UI that may render outside the provider (returns online defaults). */
export function useConnectivityOptional(): ConnectivityContextValue | null {
  return useContext(ConnectivityContext);
}
