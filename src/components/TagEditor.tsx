import { useState, useRef, useEffect } from 'react';
import { X, Plus } from 'lucide-react';

interface TagEditorProps {
  tags: string[];
  suggestions?: string[];
  onChange: (tags: string[]) => void;
}

export function TagEditor({ tags, suggestions = [], onChange }: TagEditorProps) {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const addTag = (raw: string) => {
    const value = raw.trim().toLowerCase().replace(/\s+/g, '-');
    if (!value || tags.includes(value)) return;
    onChange([...tags, value]);
    setDraft('');
    setOpen(false);
  };

  const removeTag = (value: string) => onChange(tags.filter((t) => t !== value));

  const filteredSuggestions = suggestions.filter(
    (s) => !tags.includes(s) && s.includes(draft.trim().toLowerCase())
  );

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent"
          >
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              className="rounded-full p-0.5 hover:bg-accent/20"
              aria-label={`Remove ${tag} tag`}
            >
              <X size={10} />
            </button>
          </span>
        ))}
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addTag(draft);
            }
          }}
          placeholder={tags.length ? 'Add tag…' : 'Add tag… (e.g. urgent)'}
          className="focus-ring min-w-[110px] flex-1 rounded-full border border-dashed border-border bg-transparent px-2.5 py-1 text-xs text-text-primary placeholder:text-text-secondary/60"
        />
      </div>

      {open && (draft.trim() || filteredSuggestions.length > 0) && (
        <div className="absolute left-0 top-full z-20 mt-1.5 w-48 overflow-hidden rounded-xl border border-border bg-bg-secondary shadow-card-hover dark:shadow-card-hover-dark">
          {draft.trim() && !suggestions.includes(draft.trim().toLowerCase()) && (
            <button
              type="button"
              onClick={() => addTag(draft)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-accent hover:bg-bg-tertiary"
            >
              <Plus size={12} /> Create "{draft.trim().toLowerCase()}"
            </button>
          )}
          {filteredSuggestions.slice(0, 6).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => addTag(s)}
              className="block w-full truncate px-3 py-2 text-left text-xs text-text-primary hover:bg-bg-tertiary"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
