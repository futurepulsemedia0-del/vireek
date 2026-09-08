import { useEffect, useRef, useState } from 'react';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

export type RealtimeStatus = 'connecting' | 'live' | 'reconnecting';

interface SubscriptionConfig<T extends { [key: string]: unknown }> {
  /** Unique channel name, e.g. `calls-inserts-${userId}` */
  channelName: string;
  table: string;
  event: 'INSERT' | 'UPDATE' | 'DELETE' | '*';
  /** Postgres filter string, e.g. `user_id=eq.<uuid>` */
  filter?: string;
  onChange: (payload: RealtimePostgresChangesPayload<T>) => void;
  /** Set to false to skip subscribing (e.g. while the user id isn't known yet) */
  enabled?: boolean;
}

/**
 * Subscribes to Postgres changes for one table via Supabase Realtime and
 * reports connection health so the UI can show "Live" / "Reconnecting...".
 *
 * Handles the two things every ad-hoc `supabase.channel(...)` call in this
 * app would otherwise have to duplicate: cleaning up the channel on unmount
 * (see the performance pass in step 14 — leaked channels are a real memory/
 * connection leak across a session) and surfacing dropped-connection state
 * instead of failing silently.
 */
export function useRealtimeSubscription<T extends { [key: string]: unknown } = Record<string, unknown>>(
  config: SubscriptionConfig<T>
): RealtimeStatus {
  const [status, setStatus] = useState<RealtimeStatus>('connecting');
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    if (config.enabled === false) return;

    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    channel = supabase
      .channel(config.channelName)
      .on(
        'postgres_changes' as never,
        {
          event: config.event,
          schema: 'public',
          table: config.table,
          filter: config.filter,
        },
        (payload: RealtimePostgresChangesPayload<T>) => {
          if (!cancelled) configRef.current.onChange(payload);
        }
      )
      .subscribe((subStatus) => {
        if (cancelled) return;
        if (subStatus === 'SUBSCRIBED') setStatus('live');
        else if (subStatus === 'CHANNEL_ERROR' || subStatus === 'TIMED_OUT') setStatus('reconnecting');
        else if (subStatus === 'CLOSED') setStatus('reconnecting');
      });

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [config.channelName, config.table, config.event, config.filter, config.enabled]);

  return status;
}
