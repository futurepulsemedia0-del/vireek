// src/lib/native/tracking.ts
// True background GPS for the installed app: keeps recording the technician's trail with
// the screen locked or the app in the background (Android foreground service / iOS
// "location" background mode). Points go to the same IndexedDB buffer the web tracker
// uses, so the existing batch sync + dedup keep working unchanged.

import { recordFix, shouldRecordPing } from '../offline/capture';
import { idb, type PingRecord } from '../offline/db';
import { getCachedIdentity } from '../offline/identity';
import { requestSync } from '../offline/sync';

export type TrackingIssue = 'not_authorized' | 'start_failed';

const SYNC_EVERY_N_POINTS = 10;

export function startNativeTracking(getJobId: () => string | null, onIssue?: (issue: TrackingIssue) => void): () => void {
  let stopRequested = false;
  let running = false;
  let prev: { lat: number; lng: number; at: number } | null = null;
  let sinceSync = 0;

  const stopNative = async () => {
    const { BackgroundGeolocation } = await import('@capgo/background-geolocation');
    await BackgroundGeolocation.stop();
  };

  void import('@capgo/background-geolocation')
    .then(async ({ BackgroundGeolocation }) => {
      if (stopRequested) return;
      await BackgroundGeolocation.start(
        {
          backgroundTitle: 'Vireek is sharing your trip',
          backgroundMessage: 'Dispatch can see your progress while you are on a job.',
          requestPermissions: true,
          stale: false,
          distanceFilter: 20,
          networkFallback: true,
        },
        (location, error) => {
          if (error) {
            if (error.code === 'NOT_AUTHORIZED') onIssue?.('not_authorized');
            return;
          }
          if (!location) return;

          const at = location.time ?? Date.now();
          const next = { lat: location.latitude, lng: location.longitude, at, accuracy: location.accuracy ?? null };
          recordFix({ lat: next.lat, lng: next.lng, accuracy: next.accuracy, at });

          const identity = getCachedIdentity();
          if (!identity || !shouldRecordPing(prev, next)) return;
          prev = next;

          const ping: PingRecord = {
            recorded_at: at,
            user_id: identity.userId,
            lat: next.lat,
            lng: next.lng,
            accuracy: next.accuracy,
            speed: location.speed ?? null,
            job_id: getJobId(),
          };
          void idb.put('pings', ping).catch(() => undefined);

          sinceSync += 1;
          if (sinceSync >= SYNC_EVERY_N_POINTS) {
            sinceSync = 0;
            requestSync(); // best effort: Android may throttle WebView traffic in the background; the outbox retries later
          }
        },
      );
      running = true;
      if (stopRequested) await stopNative();
    })
    .catch(() => onIssue?.('start_failed'));

  return () => {
    stopRequested = true;
    if (running) {
      running = false;
      void stopNative().catch(() => undefined);
    }
  };
}

/** Asks for the location (+ Android notification) permissions up front, so the toggle can fail early and clearly. */
export async function requestTrackingPermission(): Promise<boolean> {
  const { BackgroundGeolocation } = await import('@capgo/background-geolocation');
  const status = await BackgroundGeolocation.requestPermissions({ permissions: ['location', 'notification'] });
  return status.location === 'granted';
}
