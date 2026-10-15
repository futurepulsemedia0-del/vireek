import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, Check, ChevronsUpDown, Settings2 } from 'lucide-react';
import { useLocations } from '@/lib/locationStore';
import { STATUS_LABELS, type BusinessLocation } from '@/lib/locations';

/**
 * Organization switcher: pick which location the dashboard is "working in".
 * Mounted in DashboardNav (desktop sidebar + mobile drawer). Renders nothing for accounts that have
 * not set up any location yet except a quiet "Set up locations" link, so it never gets in the way.
 */
export function LocationSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const { status, locations, activeLocation, setActive, reload } = useLocations();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const groups = useMemo(() => {
    const usable = locations.filter((l) => l.status !== 'archived');
    const map = new Map<string, BusinessLocation[]>();
    for (const l of usable) {
      const key = l.brand_name ?? '';
      map.set(key, [...(map.get(key) ?? []), l]);
    }
    return Array.from(map.entries()).sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  }, [locations]);

  if (status === 'loading' || status === 'idle') {
    return <div className="mb-3 h-[52px] animate-pulse rounded-xl bg-bg-tertiary" aria-hidden="true" />;
  }

  if (status === 'error' && locations.length === 0) {
    return (
      <button
        type="button"
        onClick={() => void reload()}
        className="focus-ring mb-3 w-full rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-left text-xs font-medium text-danger"
      >
        Locations failed to load — tap to retry
      </button>
    );
  }

  if (locations.filter((l) => l.status !== 'archived').length === 0) {
    return (
      <Link
        to="/dashboard/settings/locations"
        onClick={onNavigate}
        className="focus-ring mb-3 flex items-center gap-2.5 rounded-xl border border-dashed border-border px-3 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-text-primary"
      >
        <Building2 size={16} aria-hidden="true" /> Set up locations
      </Link>
    );
  }

  return (
    <div ref={rootRef} className="relative mb-3">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="focus-ring flex w-full items-center gap-2.5 rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-left transition-colors hover:border-accent/40"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <Building2 size={16} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-text-primary">{activeLocation?.name ?? 'Choose location'}</span>
          <span className="block truncate text-[11px] text-text-secondary">{activeLocation?.brand_name ?? 'Current location'}</span>
        </span>
        <ChevronsUpDown size={14} className="shrink-0 text-text-secondary" aria-hidden="true" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-50 mt-1.5 overflow-hidden rounded-xl border border-border bg-bg-secondary shadow-card-hover dark:shadow-card-hover-dark">
          <ul id={listId} role="listbox" aria-label="Switch location" className="max-h-72 overflow-y-auto p-1.5">
            {groups.map(([brand, items]) => (
              <li key={brand || 'no-brand'} role="presentation">
                {groups.length > 1 && (
                  <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-text-secondary/70">
                    {brand || 'No brand'}
                  </p>
                )}
                <ul role="presentation">
                  {items.map((l) => {
                    const selected = l.id === activeLocation?.id;
                    return (
                      <li key={l.id} role="presentation">
                        <button
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => {
                            void setActive(l.id);
                            setOpen(false);
                            onNavigate?.();
                          }}
                          className={`focus-ring flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                            selected ? 'bg-accent/10 text-accent' : 'text-text-primary hover:bg-bg-tertiary'
                          }`}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{l.name}</span>
                            {(l.status !== 'active' || l.is_primary) && (
                              <span className="block text-[11px] text-text-secondary">
                                {[l.is_primary ? 'Primary' : null, l.status !== 'active' ? STATUS_LABELS[l.status] : null].filter(Boolean).join(' · ')}
                              </span>
                            )}
                          </span>
                          {selected && <Check size={14} aria-hidden="true" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
          <Link
            to="/dashboard/settings/locations"
            onClick={() => {
              setOpen(false);
              onNavigate?.();
            }}
            className="focus-ring flex items-center gap-2 border-t border-border px-3.5 py-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          >
            <Settings2 size={14} aria-hidden="true" /> Manage locations
          </Link>
        </div>
      )}
    </div>
  );
}
