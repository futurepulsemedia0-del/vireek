/**
 * Connectivity + maintenance detection.
 * - Offline: browser navigator.onLine + online/offline events
 * - Maintenance: VITE_MAINTENANCE_MODE or remote status summary
 * - Degraded: optional signal from the same status feed
 */

export type AppConnectivityMode = 'online' | 'offline' | 'maintenance' | 'degraded';

export interface MaintenanceInfo {
  active: boolean;
  title: string;
  message: string;
  /** ISO timestamp if known */
  eta: string | null;
  /** Public status page path or absolute URL */
  statusUrl: string;
}

export interface ConnectivitySnapshot {
  mode: AppConnectivityMode;
  isOnline: boolean;
  maintenance: MaintenanceInfo;
  /** Last time we confirmed network (client clock) */
  checkedAt: string;
}

const DEFAULT_MAINTENANCE: MaintenanceInfo = {
  active: false,
  title: 'Scheduled maintenance',
  message:
    'Vireek is briefly unavailable while we finish a planned update. Voice answering for live calls is designed to keep running — the dashboard will be back shortly.',
  eta: null,
  statusUrl: '/status',
};

/** Paths always reachable during maintenance (status + legal). */
export const MAINTENANCE_ALLOWLIST: string[] = [
  '/status',
  '/status/unsubscribe',
  '/privacy',
  '/terms',
  '/security',
];

export function isMaintenanceAllowlisted(pathname: string): boolean {
  return MAINTENANCE_ALLOWLIST.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

function readEnvMaintenance(): MaintenanceInfo {
  const flag = String(import.meta.env.VITE_MAINTENANCE_MODE ?? '')
    .trim()
    .toLowerCase();
  const active = flag === '1' || flag === 'true' || flag === 'yes';
  const title =
    (import.meta.env.VITE_MAINTENANCE_TITLE as string | undefined)?.trim() ||
    DEFAULT_MAINTENANCE.title;
  const message =
    (import.meta.env.VITE_MAINTENANCE_MESSAGE as string | undefined)?.trim() ||
    DEFAULT_MAINTENANCE.message;
  const eta =
    (import.meta.env.VITE_MAINTENANCE_ETA as string | undefined)?.trim() || null;
  return {
    active,
    title,
    message,
    eta,
    statusUrl: '/status',
  };
}

/**
 * Optional remote override. Expects a small JSON blob, e.g.:
 * { "maintenance": true, "title": "...", "message": "...", "eta": "2026-09-16T18:00:00Z", "degraded": false }
 * If VITE_STATUS_API_URL points at Instatus summary.json, we only treat
 * "maintenance" loosely — failures never force maintenance on.
 */
export async function fetchRemoteMaintenanceSignal(): Promise<{
  maintenance: Partial<MaintenanceInfo> | null;
  degraded: boolean;
}> {
  const url = (import.meta.env.VITE_MAINTENANCE_STATUS_URL as string | undefined)?.trim();
  if (!url) return { maintenance: null, degraded: false };

  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return { maintenance: null, degraded: false };
    const data = (await res.json()) as Record<string, unknown>;

    const maintenanceFlag =
      data.maintenance === true ||
      data.mode === 'maintenance' ||
      data.status === 'maintenance';

    if (maintenanceFlag) {
      return {
        maintenance: {
          active: true,
          title: typeof data.title === 'string' ? data.title : DEFAULT_MAINTENANCE.title,
          message:
            typeof data.message === 'string' ? data.message : DEFAULT_MAINTENANCE.message,
          eta: typeof data.eta === 'string' ? data.eta : null,
          statusUrl:
            typeof data.statusUrl === 'string' ? data.statusUrl : '/status',
        },
        degraded: false,
      };
    }

    const degraded =
      data.degraded === true ||
      data.status === 'degraded' ||
      data.mode === 'degraded';

    return { maintenance: null, degraded };
  } catch {
    return { maintenance: null, degraded: false };
  }
}

export function buildSnapshot(opts: {
  isOnline: boolean;
  maintenance: MaintenanceInfo;
  degraded: boolean;
}): ConnectivitySnapshot {
  let mode: AppConnectivityMode = 'online';
  if (!opts.isOnline) mode = 'offline';
  else if (opts.maintenance.active) mode = 'maintenance';
  else if (opts.degraded) mode = 'degraded';

  return {
    mode,
    isOnline: opts.isOnline,
    maintenance: opts.maintenance,
    checkedAt: new Date().toISOString(),
  };
}

export function getInitialMaintenance(): MaintenanceInfo {
  return readEnvMaintenance();
}

export function getBrowserOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine !== false;
}
