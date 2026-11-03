import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface MaintenanceRow {
  id: string;
  title: string;
  summary: string;
  component_id: string | null;
  region: string | null;
  starts_at: string;
  ends_at: string;
  status: 'scheduled' | 'in_progress' | 'completed';
}

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Scheduled maintenance from public_status_maintenance(). Renders nothing when there is none (never invented). */
export function MaintenanceWindows() {
  const [rows, setRows] = useState<MaintenanceRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.rpc('public_status_maintenance');
        if (!cancelled && !error && Array.isArray(data)) setRows(data as MaintenanceRow[]);
      } catch {
        /* status page must never break because maintenance data is unavailable */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const upcoming = rows.filter((r) => r.status !== 'completed');
  if (upcoming.length === 0) return null;

  return (
    <section className="px-6 py-6" aria-label="Scheduled maintenance">
      <div className="mx-auto max-w-3xl rounded-2xl border border-border bg-bg-secondary p-6">
        <h2 className="text-lg font-semibold text-text-primary">Scheduled maintenance</h2>
        <ul className="mt-3 space-y-3 text-sm text-text-secondary">
          {upcoming.map((m) => (
            <li key={m.id}>
              <p className="font-semibold text-text-primary">
                {m.title} <span className="font-normal text-text-secondary">({m.status === 'in_progress' ? 'in progress' : 'scheduled'})</span>
              </p>
              <p>{fmt(m.starts_at)} to {fmt(m.ends_at)}{m.region ? ` · ${m.region}` : ''}{m.component_id ? ` · ${m.component_id}` : ''}</p>
              <p>{m.summary}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
