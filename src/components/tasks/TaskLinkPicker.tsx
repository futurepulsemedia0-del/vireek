import { useEffect, useId, useRef, useState } from 'react';
import { BookUser, Search, Users, Wrench, X } from 'lucide-react';
import { searchLinkTargets, type LinkKind, type LinkOption } from '@/lib/tasksApi';

const KIND_META: Record<LinkKind, { label: string; icon: typeof Users; placeholder: string }> = {
  customer: { label: 'Customer', icon: BookUser, placeholder: 'Search customers…' },
  job: { label: 'Job', icon: Wrench, placeholder: 'Search jobs by customer…' },
  lead: { label: 'Lead', icon: Users, placeholder: 'Search leads…' },
};

interface Props {
  kind: LinkKind;
  value: { id: string; label: string } | null;
  onChange: (next: { id: string; label: string } | null) => void;
  disabled?: boolean;
}

/** Type-ahead picker for one linked record (customer / job / lead). */
export function TaskLinkPicker({ kind, value, onChange, disabled }: Props) {
  const meta = KIND_META[kind];
  const Icon = meta.icon;
  const listId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<LinkOption[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || value) return;
    let cancelled = false;
    setStatus('loading');
    const t = setTimeout(() => {
      searchLinkTargets(kind, query)
        .then((rows) => {
          if (cancelled) return;
          setOptions(rows);
          setStatus('idle');
        })
        .catch(() => {
          if (!cancelled) setStatus('error');
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, query, kind, value]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-bg-primary px-3 py-2.5">
        <span className="flex min-w-0 items-center gap-2 text-sm text-text-primary">
          <Icon size={15} className="shrink-0 text-accent" aria-hidden="true" />
          <span className="truncate">{value.label}</span>
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(null)}
          className="focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
          aria-label={`Remove linked ${meta.label.toLowerCase()}`}
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="relative">
      <Search
        size={15}
        className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-text-secondary"
        aria-hidden="true"
      />
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`Link a ${meta.label.toLowerCase()}`}
        autoComplete="off"
        disabled={disabled}
        value={query}
        placeholder={meta.placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className="focus-ring w-full rounded-xl border border-border bg-bg-primary py-2.5 pl-10 pr-3 text-sm text-text-primary placeholder:text-text-secondary/60 focus-visible:border-accent disabled:opacity-50"
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-xl border border-border bg-bg-secondary p-1 shadow-card-hover dark:shadow-card-hover-dark"
        >
          {status === 'loading' && <li className="px-3 py-2 text-xs text-text-secondary">Searching…</li>}
          {status === 'error' && <li className="px-3 py-2 text-xs text-danger">Could not search right now.</li>}
          {status === 'idle' && options.length === 0 && (
            <li className="px-3 py-2 text-xs text-text-secondary">Nothing matches.</li>
          )}
          {status === 'idle' &&
            options.map((o) => (
              <li key={o.id} role="option" aria-selected={false}>
                <button
                  type="button"
                  onClick={() => {
                    onChange({ id: o.id, label: o.label });
                    setQuery('');
                    setOpen(false);
                  }}
                  className="focus-ring flex w-full flex-col rounded-lg px-3 py-2 text-left hover:bg-bg-tertiary"
                >
                  <span className="truncate text-sm text-text-primary">{o.label}</span>
                  {o.sublabel && <span className="truncate text-xs text-text-secondary">{o.sublabel}</span>}
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
