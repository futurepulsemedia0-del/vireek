import { ArrowRight, Calendar, Clock, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/Card';
import { formatDate, getCategoryBySlug } from '@/lib/blogContent';
import type { BlogPostMeta } from '@/lib/blogTypes';

export function BlogCard({ post, showDate = true }: { post: BlogPostMeta; showDate?: boolean }) {
  const category = getCategoryBySlug(post.category);
  const Icon = category?.icon ?? Sparkles;
  return (
    <Link to={`/blog/${post.slug}`} className="focus-ring block h-full rounded-2xl">
      <Card className="flex h-full flex-col p-6">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent"><Icon className="h-4 w-4" /></span>
          <span className="text-xs font-semibold uppercase tracking-wider text-accent">{category?.name ?? 'Resources'}</span>
        </div>
        <h3 className="mt-4 text-lg font-bold leading-snug tracking-tight text-text-primary">{post.title}</h3>
        <p className="mt-2.5 flex-1 text-sm leading-relaxed text-text-secondary">{post.description}</p>
        <div className="mt-5 flex items-center justify-between border-t border-border pt-4 text-xs text-text-secondary">
          {showDate ? (
            <span className="flex items-center gap-1.5"><Calendar className="h-3.5 w-3.5" aria-hidden="true" />{formatDate(post.publishedAt)}</span>
          ) : (
            <span className="inline-flex items-center gap-1.5 font-semibold text-accent">Read article <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></span>
          )}
          <span className="flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" aria-hidden="true" />{post.readTimeMinutes} min read</span>
        </div>
      </Card>
    </Link>
  );
}
