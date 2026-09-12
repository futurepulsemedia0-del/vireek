import { useEffect, useState } from 'react';

// ============================================================
// LIVE STATUS PROVIDER HOOK
// ============================================================
//
// Fetches real uptime/incident data from a public status-page provider
// (Instatus by default — its public `summary.json` endpoint needs no API
// key). If you use Better Stack / Better Uptime instead, see the note
// at the bottom of this file for the one line to change.
//
// Configure the endpoint via an env var so no URL is hardcoded:
//   VITE_STATUS_API_URL=https://your-page.instatus.com/summary.json
//
// If the env var is missing or the fetch fails, `isLive` stays false and
// the caller should keep showing its own static fallback data — never a
// fabricated "live" number. This matches the existing honesty philosophy
// already written into StatusPage.tsx.

export type LiveSystemStatus = 'operational' | 'degraded' | 'outage' | 'maintenance';

export interface LiveIncident {
  date: string;
  title: string;
  impact: 'minor' | 'major';
  status: 'investigating' | 'monitoring' | 'resolved';
  summary: string;
}

export interface LiveStatusResult {
  isLive: boolean;
  loading: boolean;
  error: string | null;
  /** Maps a component name (as configured on the provider) to its live status. */
  componentStatus: Record<string, LiveSystemStatus>;
  uptimePercent: number | null;
  incidents: LiveIncident[];
  lastUpdated: string | null;
}

const FETCH_TIMEOUT_MS = 10_000;
const REFRESH_INTERVAL_MS = 60_000;

// Instatus component status strings -> our internal union
function mapInstatusStatus(raw: string): LiveSystemStatus {
  switch (raw) {
    case 'UNDERMAINTENANCE':
      return 'maintenance';
    case 'MAJOROUTAGE':
      return 'outage';
    case 'PARTIALOUTAGE':
    case 'DEGRADEDPERFORMANCE':
      return 'degraded';
    default:
      return 'operational';
  }
}

function mapInstatusImpact(raw: string): 'minor' | 'major' {
  return raw === 'CRITICAL' || raw === 'MAJOR' ? 'major' : 'minor';
}

export function useLiveStatus(): LiveStatusResult {
  const [result, setResult] = useState<LiveStatusResult>({
    isLive: false,
    loading: true,
    error: null,
    componentStatus: {},
    uptimePercent: null,
    incidents: [],
    lastUpdated: null,
  });

  useEffect(() => {
    const endpoint = import.meta.env.VITE_STATUS_API_URL as string | undefined;

    if (!endpoint) {
      setResult((prev) => ({ ...prev, loading: false, isLive: false }));
      return;
    }

    let cancelled = false;
    // Tracks whether we've ever successfully loaded live data in this
    // mount. A later refresh failure (network blip, provider hiccup)
    // should not discard a previously-good live snapshot and flicker the
    // page back to the static fallback — that snapshot is still real
    // data, just briefly stale. Only the very first failed load falls
    // back to static data, per the file's own honesty rule above.
    let hasLoadedOnce = false;

    async function load() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const res = await fetch(endpoint, { cache: 'no-store', signal: controller.signal });
        if (!res.ok) throw new Error(`Status provider returned ${res.status}`);
        const data = await res.json();

        const componentStatus: Record<string, LiveSystemStatus> = {};
        for (const c of data.components ?? []) {
          if (c?.name) componentStatus[c.name] = mapInstatusStatus(c.status);
        }

        const incidents: LiveIncident[] = (data.activeIncidents ?? []).map((inc: any) => ({
          date: inc.createdAt
            ? new Date(inc.createdAt).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })
            : '',
          title: inc.name ?? 'Incident',
          impact: mapInstatusImpact(inc.impact),
          status: inc.status === 'RESOLVED' ? 'resolved' : inc.status === 'MONITORING' ? 'monitoring' : 'investigating',
          summary: inc.latestUpdateMessage ?? '',
        }));

        // Instatus summary.json doesn't always include a rolled-up uptime
        // percent; if present, use it, otherwise leave null (page keeps
        // its own static uptime history in that case).
        const uptimePercent = typeof data.uptime === 'number' ? data.uptime : null;

        if (!cancelled) {
          hasLoadedOnce = true;
          setResult({
            isLive: true,
            loading: false,
            error: null,
            componentStatus,
            uptimePercent,
            incidents,
            lastUpdated: new Date().toLocaleDateString('en-US', {
              month: 'long',
              day: 'numeric',
              year: 'numeric',
            }),
          });
        }
      } catch (err) {
        if (!cancelled) {
          const isTimeout = err instanceof DOMException && err.name === 'AbortError';
          setResult((prev) => ({
            ...prev,
            loading: false,
            // Keep the last good live snapshot alive through a transient
            // refresh failure; only drop to the static fallback if we
            // never successfully loaded live data at all.
            isLive: hasLoadedOnce ? prev.isLive : false,
            error: isTimeout
              ? `Status provider timed out after ${FETCH_TIMEOUT_MS}ms.`
              : err instanceof Error
                ? err.message
                : 'Failed to load live status',
          }));
        }
      } finally {
        clearTimeout(timer);
      }
    }

    load();
    const interval = setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return result;
}

// ------------------------------------------------------------
// USING BETTER STACK / BETTER UPTIME INSTEAD OF INSTATUS
// ------------------------------------------------------------
// Better Stack's public status-page JSON has a different shape
// (component statuses come back as e.g. "up" / "degraded" / "down").
// If you switch providers, only `mapInstatusStatus` and the two
// `data.components ?? []` / `data.activeIncidents ?? []` lines above
// need to change to match their field names — nothing else in this
// file or in StatusPage.tsx depends on Instatus specifically.
