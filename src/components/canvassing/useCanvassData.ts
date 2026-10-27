import { useCallback, useEffect, useRef, useState } from 'react';
import type { Door, Rep, Territory } from '@/lib/canvassing';
import { listDoors, listReps, listTerritories } from '@/lib/canvassingApi';

export interface CanvassData {
  status: 'loading' | 'error' | 'ready';
  territories: Territory[];
  doors: Door[];
  reps: Rep[];
  /** True when the account has more doors than the page loads (10,000). */
  truncated: boolean;
  /** `silent` keeps the current content on screen while refreshing. Resolves once the new data is in state. */
  reload: (silent?: boolean) => Promise<void>;
  /** Replaces (or adds) one door after a visit / follow-up change, without a round trip. */
  patchDoor: (door: Door) => void;
}

export function useCanvassData(ownerId: string | null, isManager: boolean): CanvassData {
  const [status, setStatus] = useState<CanvassData['status']>('loading');
  const [territories, setTerritories] = useState<Territory[]>([]);
  const [doors, setDoors] = useState<Door[]>([]);
  const [reps, setReps] = useState<Rep[]>([]);
  const [truncated, setTruncated] = useState(false);
  const request = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const reload = useCallback(async (silent = false) => {
    if (!ownerId) return;
    const id = ++request.current;
    if (!silent) setStatus('loading');
    try {
      const [t, d, r] = await Promise.all([listTerritories(ownerId), listDoors(ownerId), isManager ? listReps() : Promise.resolve([] as Rep[])]);
      if (!mounted.current || id !== request.current) return;
      setTerritories(t);
      setDoors(d.doors);
      setTruncated(d.truncated);
      setReps(r);
      setStatus('ready');
    } catch {
      if (!mounted.current || id !== request.current) return;
      // A failed silent refresh keeps the data already on screen.
      if (!silent) setStatus('error');
    }
  }, [ownerId, isManager]);

  useEffect(() => { void reload(); }, [reload]);

  const patchDoor = useCallback((door: Door) => {
    setDoors((prev) => (prev.some((d) => d.id === door.id) ? prev.map((d) => (d.id === door.id ? { ...d, ...door } : d)) : [...prev, door]));
  }, []);

  return { status, territories, doors, reps, truncated, reload, patchDoor };
}
