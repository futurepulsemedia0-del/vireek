import { useEffect, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { searchHelpArticles, type HelpArticleRecord } from '@/lib/helpArticles';

/** Suggests help articles while someone writes a support ticket (before they send it). */
export function HelpSuggestions({ text }: { text: string }) {
  const [items, setItems] = useState<HelpArticleRecord[]>([]);
  useEffect(() => {
    if (text.trim().length < 6) { setItems([]); return; }
    const t = window.setTimeout(() => setItems(searchHelpArticles(text, 3)), 400);
    return () => window.clearTimeout(t);
  }, [text]);
  if (items.length === 0) return null;
  return (
    <aside aria-label="Suggested help articles" className="rounded-xl border border-border bg-bg-tertiary/40 p-3">
      <p className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-text-primary"><BookOpen className="h-4 w-4" aria-hidden="true" /> These might answer it faster</p>
      <ul className="space-y-1">
        {items.map((a) => (
          <li key={a.slug}><a href={`/help/${a.slug}`} target="_blank" rel="noopener noreferrer" className="focus-ring rounded text-sm text-accent hover:underline">{a.title}</a></li>
        ))}
      </ul>
    </aside>
  );
}
