import { useCallback, useEffect, useRef, useState } from 'react';
import { useRealtimeSubscription } from '@/lib/realtime';
import type { Geofence, GeofenceDraft, ZoneEventRow } from '@/lib/geofences';
import { deleteGeofence, loadGeofenceEvents, loadGeofences, saveGeofence, setGeofenceActive } from '@/lib/geofencesApi';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');
const EVENT_REFRESH_MS = 1500;

/**
 * Zones + their recent activity for the live map. Zones load once and are updated from the
 * server's response after each write (never optimistically guessed). Activity refreshes live
 * when the ingest pipeline records a zone event.
 */
export function useGeofences(ownerId: string | undefined, enabled: boolean) {
  const [zones, setZones] = useState<Geofence[]>([]);
  const [events, setEvents] = useState<ZoneEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const loadEvents = useCallback(async () => {
    if (!ownerId) return;
    try {
      setEvents(await loadGeofenceEvents(ownerId));
      setEventsError(null);
    } catch (e) {
      setEventsError(errMsg(e));
    }
  }, [ownerId]);

  const reload = useCallback(async () => {
    if (!ownerId) return;
    setLoading(true);
    try {
      setZones(await loadGeofences(ownerId));
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
    void loadEvents();
  }, [ownerId, loadEvents]);

  useEffect(() => {
    if (!enabled || !ownerId) {
      setLoading(false);
      return;
    }
    void reload();
  }, [enabled, ownerId, reload]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  useRealtimeSubscription<Record<string, unknown>>({
    channelName: `zone-events-${ownerId ?? 'anon'}`,
    table: 'fleet_geofence_events',
    event: '*',
    filter: ownerId ? `user_id=eq.${ownerId}` : undefined,
    onChange: () => {
      if (timer.current === null) {
        timer.current = window.setTimeout(() => {
          timer.current = null;
          void loadEvents();
        }, EVENT_REFRESH_MS);
      }
    },
    enabled: enabled && !!ownerId,
  });

  const save = useCallback(
    async (draft: GeofenceDraft): Promise<Geofence> => {
      if (!ownerId) throw new Error('Not signed in.');
      const saved = await saveGeofence(ownerId, draft);
      setZones((prev) => (prev.some((z) => z.id === saved.id) ? prev.map((z) => (z.id === saved.id ? saved : z)) : [...prev, saved]).sort((a, b) => a.name.localeCompare(b.name)));
      return saved;
    },
    [ownerId],
  );

  const toggle = useCallback(
    async (id: string, active: boolean) => {
      if (!ownerId) throw new Error('Not signed in.');
      await setGeofenceActive(ownerId, id, active);
      setZones((prev) => prev.map((z) => (z.id === id ? { ...z, active } : z)));
    },
    [ownerId],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!ownerId) throw new Error('Not signed in.');
      await deleteGeofence(ownerId, id);
      setZones((prev) => prev.filter((z) => z.id !== id));
    },
    [ownerId],
  );

  return { zones, events, loading, error, eventsError, reload, save, toggle, remove };
}
