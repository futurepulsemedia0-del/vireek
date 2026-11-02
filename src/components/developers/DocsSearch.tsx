import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { buildDocsIndex, searchDocs, type DocEntry } from '@/lib/docsIndex';

/** Persistent docs search. Open with the button or Cmd/Ctrl+K. Arrow keys move, Enter opens, Esc closes. */
export function DocsSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const index = useMemo(() => buildDocsIndex(), []);
  const results = useMemo(() => searchDocs(index, query), [index, query]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery('');
    setActive(0);
    opener.current?.focus();
  };

  const go = (entry: DocEntry) => {
    close();
    const [path, hash] = entry.href.split('#');
    navigate(path);
    if (hash)
      setTimeout(() => document.getElementById(hash)?.scrollIntoView({ block: 'start' }), 120);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown' && results.length) {
      e.preventDefault();
      setActive((a) => (a + 1) % results.length);
    } else if (e.key === 'ArrowUp' && results.length) {
      e.preventDefault();
      setActive((a) => (a - 1 + results.length) % results.length);
    } else if (e.key === 'Enter' && results[active]) {
      e.preventDefault();
      go(results[active]);
    }
  };

  return (
    <>
      <button
        ref={opener}
        type="button"
        onClick={() => setOpen(true)}
        className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-secondary transition hover:text-text-primary"
      >
        <Search size={14} aria-hidden="true" />
        Search docs
        <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
      </button>
      {open && (
        <div
          className="fixed inset-0 z-[80] flex items-start justify-center p-4 pt-[12vh]"
          onKeyDown={onKeyDown}
        >
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={close}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Search the developer docs"
            className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card-hover"
          >
            <div className="flex items-center gap-2 border-b border-border px-4">
              <Search size={16} className="text-text-secondary" aria-hidden="true" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                role="combobox"
                aria-expanded={results.length > 0}
                aria-controls={listId}
                aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
                aria-label="Search"
                placeholder="Search endpoints, errors, webhooks, guides…"
                className="w-full bg-transparent py-3.5 text-sm text-text-primary outline-none placeholder:text-text-secondary"
              />
            </div>
            <ul
              id={listId}
              role="listbox"
              aria-label="Results"
              className="max-h-80 overflow-y-auto p-2"
            >
              {results.map((r, i) => (
                <li
                  key={r.id}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(r)}
                  className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm ${i === active ? 'bg-accent/10 text-text-primary' : 'text-text-secondary'}`}
                >
                  <span className="min-w-0 truncate">{r.title}</span>
                  <span className="shrink-0 rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                    {r.section}
                  </span>
                </li>
              ))}
              {query.trim() && results.length === 0 && (
                <li className="px-3 py-6 text-center text-sm text-text-secondary">
                  No results for “{query}”.
                </li>
              )}
              {!query.trim() && (
                <li className="px-3 py-6 text-center text-sm text-text-secondary">
                  Type to search. Try “429”, “webhook”, “allowlist” or “/calls”.
                </li>
              )}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
