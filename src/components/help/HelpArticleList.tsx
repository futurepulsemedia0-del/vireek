import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';

export interface HelpArticleListItem {
  slug: string;
  title: string;
  eyebrow?: string;
}

interface HelpArticleListProps {
  items: HelpArticleListItem[];
  label?: string;
  className?: string;
}

export function HelpArticleList({ items, label, className = '' }: HelpArticleListProps) {
  if (items.length === 0) return null;
  return (
    <nav aria-label={label} className={className}>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.slug}>
            <Link
              to={`/help/${item.slug}`}
              className="focus-ring flex min-h-11 items-center justify-between gap-3 rounded-xl border border-border bg-bg-secondary px-4 py-3 hover:border-accent"
            >
              <span className="min-w-0">
                {item.eyebrow && (
                  <span className="block text-xs font-semibold uppercase tracking-wide text-text-secondary">
                    {item.eyebrow}
                  </span>
                )}
                <span className="block text-sm font-medium text-text-primary">{item.title}</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
