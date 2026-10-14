import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search, X } from 'lucide-react';
import { searchHelpArticles } from '@/lib/helpArticles';

export function HelpSearch({ className = '' }: { className?: string }) {
  const navigate = useNavigate();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const trimmed = query.trim();
  const results = useMemo(() => searchHelpArticles(trimmed, 6), [trimmed]);
  const expanded = open && trimmed.length >= 2;

  const go = (slug: string) => {
    setQuery('');
    setOpen(false);
    setActive(-1);
    navigate(`/help/${slug}`);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (results.length === 0 ? -1 : (i + 1) % results.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (results.length === 0 ? -1 : i <= 0 ? results.length - 1 : i - 1));
    } else if (e.key === 'Enter') {
      if (expanded && results.length > 0) {
        e.preventDefault();
        go(results[active >= 0 ? active : 0].slug);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActive(-1);
    }
  };

  return (
    <div
      role="search"
      className={`relative ${className}`}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <Search aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-text-secondary" />
      <input
        type="search"
        role="combobox"
        aria-label="Search help articles"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={expanded && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        placeholder="Search help articles…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(-1);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="focus-ring h-12 w-full rounded-2xl border border-border bg-bg-secondary pl-12 pr-12 text-base text-text-primary placeholder:text-text-secondary"
      />
      {query && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setQuery('');
            setActive(-1);
          }}
          className="focus-ring absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-xl text-text-secondary"
        >
          <X className="h-4 w-4" />
        </button>
      )}

      {expanded && (
        <div className="absolute z-20 mt-2 w-full overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark">
          <p role="status" className="sr-only">
            {results.length === 0 ? 'No results' : `${results.length} result${results.length === 1 ? '' : 's'}`}
          </p>
          {results.length > 0 ? (
            <ul id={listId} role="listbox" aria-label="Search results">
              {results.map((r, i) => (
                <li
                  key={r.slug}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => go(r.slug)}
                  className={`cursor-pointer border-b border-border px-4 py-3 last:border-b-0 ${i === active ? 'bg-bg-tertiary' : ''}`}
                >
                  <span className="block text-sm font-semibold text-text-primary">{r.title}</span>
                  <span className="block text-xs text-text-secondary">{r.categoryName}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-4 py-4 text-sm text-text-secondary">
              No articles match “{trimmed}”.{' '}
              <Link to="/contact" className="font-semibold text-accent hover:underline">
                Contact support
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
