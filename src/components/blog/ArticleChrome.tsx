import { useEffect, useRef, useState, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronDown, Link2, Linkedin, Mail, ShieldCheck, Twitter } from 'lucide-react';
import { InlineContent } from '@/components/blog/ArticleBody';
import { blogEvents, SCROLL_MILESTONES } from '@/lib/blogAnalytics';
import { formatDate } from '@/lib/blogContent';
import type { BlogAuthor, BlogFaq, BlogPost, TocItem } from '@/lib/blogTypes';

/* ------------------------- progress + scroll depth ------------------------- */

export function ReadingProgress({ target }: { target: RefObject<HTMLElement> }) {
  const [pct, setPct] = useState(0);
  useEffect(() => {
    let raf = 0;
    const update = () => {
      const el = target.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const total = Math.max(r.height - window.innerHeight * 0.6, 1);
      setPct(Math.round((Math.min(Math.max(-r.top, 0), total) / total) * 100));
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [target]);
  return (
    <div aria-hidden="true" className="fixed inset-x-0 top-0 z-[60] h-1">
      <div className="h-full bg-accent motion-reduce:transition-none" style={{ width: `${pct}%`, transition: 'width 100ms linear' }} />
    </div>
  );
}

/** Fires consent-gated scroll-depth events once per milestone (25/50/75/90 % of the article). */
export function useScrollDepth(slug: string, target: RefObject<HTMLElement>) {
  useEffect(() => {
    const fired = new Set<number>();
    let raf = 0;
    const check = () => {
      const el = target.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const read = Math.min(Math.max((window.innerHeight - r.top) / Math.max(r.height, 1), 0), 1) * 100;
      for (const m of SCROLL_MILESTONES) {
        if (read >= m && !fired.has(m)) {
          fired.add(m);
          blogEvents.scrollDepth(slug, m);
        }
      }
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(check);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
    };
  }, [slug, target]);
}

/* ------------------------------ table of contents ------------------------------ */

function useActiveHeading(ids: string[]) {
  const [active, setActive] = useState(ids[0] ?? '');
  useEffect(() => {
    const els = ids.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => Boolean(e));
    if (!els.length || typeof IntersectionObserver === 'undefined') return;
    const visible = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => (e.isIntersecting ? visible.add(e.target.id) : visible.delete(e.target.id)));
        const first = ids.find((id) => visible.has(id));
        if (first) setActive(first);
      },
      { rootMargin: '-96px 0px -65% 0px' },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [ids]);
  return active;
}

function TocList({ items, active }: { items: TocItem[]; active: string }) {
  return (
    <ol className="space-y-1 text-sm">
      {items.map((t) => (
        <li key={t.id} className={t.level === 3 ? 'ml-4' : ''}>
          <a
            href={`#${t.id}`}
            aria-current={active === t.id ? 'location' : undefined}
            className={`focus-ring block rounded-md border-l-2 py-1.5 pl-3 transition-colors ${
              active === t.id ? 'border-accent font-semibold text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {t.text}
          </a>
        </li>
      ))}
    </ol>
  );
}

export function TableOfContents({ items, variant }: { items: TocItem[]; variant: 'mobile' | 'desktop' }) {
  const ids = items.map((i) => i.id);
  const active = useActiveHeading(ids);
  if (items.length < 2) return null;
  if (variant === 'mobile') {
    return (
      <nav aria-label="On this page (mobile)" className="mb-8 rounded-2xl border border-border bg-bg-secondary">
        <details className="group">
          <summary className="focus-ring flex cursor-pointer list-none items-center justify-between rounded-2xl px-5 py-4 text-sm font-semibold text-text-primary">
            On this page
            <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="px-5 pb-4"><TocList items={items} active={active} /></div>
        </details>
      </nav>
    );
  }
  return (
    <nav aria-label="On this page" className="sticky top-28 max-h-[calc(100vh-8rem)] overflow-y-auto">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-secondary">On this page</p>
      <TocList items={items} active={active} />
    </nav>
  );
}

/* ---------------------------------- share ---------------------------------- */

export function ShareBar({ url, title, slug }: { url: string; title: string; slug: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const enc = encodeURIComponent;
  const item = 'focus-ring inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-bg-secondary px-3.5 text-sm font-semibold text-text-secondary transition-colors hover:border-accent/40 hover:text-text-primary';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } finally { ta.remove(); }
    }
    setCopied(true);
    blogEvents.share(slug, 'copy');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <span className="text-sm font-semibold text-text-primary">Share</span>
      <button type="button" onClick={copy} className={item}>
        {copied ? <Check className="h-4 w-4 text-accent" aria-hidden="true" /> : <Link2 className="h-4 w-4" aria-hidden="true" />}
        {copied ? 'Link copied' : 'Copy link'}
      </button>
      <span role="status" aria-live="polite" className="sr-only">{copied ? 'Link copied to clipboard' : ''}</span>
      <a className={item} target="_blank" rel="noopener noreferrer" onClick={() => blogEvents.share(slug, 'linkedin')} href={`https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}`}>
        <Linkedin className="h-4 w-4" aria-hidden="true" /> LinkedIn<span className="sr-only"> (opens in a new tab)</span>
      </a>
      <a className={item} target="_blank" rel="noopener noreferrer" onClick={() => blogEvents.share(slug, 'x')} href={`https://twitter.com/intent/tweet?text=${enc(title)}&url=${enc(url)}`}>
        <Twitter className="h-4 w-4" aria-hidden="true" /> X<span className="sr-only"> (opens in a new tab)</span>
      </a>
      <a className={item} onClick={() => blogEvents.share(slug, 'email')} href={`mailto:?subject=${enc(title)}&body=${enc(`${title}\n${url}`)}`}>
        <Mail className="h-4 w-4" aria-hidden="true" /> Email
      </a>
    </div>
  );
}

/* ------------------------------ author / E-E-A-T ------------------------------ */

export function AuthorCard({ author, post }: { author?: BlogAuthor; post: Pick<BlogPost, 'updatedAt' | 'reviewedBy' | 'legalReview'> }) {
  const placeholder = !author || /^TODO/i.test(author.name);
  return (
    <section aria-label="About the author" className="rounded-2xl border border-border bg-bg-secondary p-6">
      <div className="flex gap-4">
        <span aria-hidden="true" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent/15 text-lg font-bold text-accent">
          {(author?.name ?? 'V').replace(/^TODO:?\s*/i, '').charAt(0).toUpperCase() || 'V'}
        </span>
        <div className="min-w-0">
          <p className="text-base font-bold text-text-primary">
            {author && !placeholder ? (author.url.startsWith('/') ? <Link to={author.url} className="focus-ring rounded-sm hover:text-accent">{author.name}</Link> : author.name) : 'The Vireek Team'}
          </p>
          {author && !placeholder && <p className="text-sm text-text-secondary">{author.role}</p>}
          {author && !placeholder && <p className="mt-2 text-sm leading-6 text-text-secondary">{author.bio}</p>}
          {author && !placeholder && author.credentials.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-2">
              {author.credentials.map((c) => <li key={c} className="rounded-full border border-border px-2.5 py-0.5 text-xs text-text-secondary">{c}</li>)}
            </ul>
          )}
        </div>
      </div>
      <div className="mt-4 space-y-1.5 border-t border-border pt-4 text-sm text-text-secondary">
        {post.reviewedBy && (
          <p className="flex items-start gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />Reviewed by {post.reviewedBy.name}, {post.reviewedBy.role}, on {formatDate(post.reviewedBy.date)}.</p>
        )}
        {post.legalReview && <p>General information only. This is not legal advice; check requirements for your state with a qualified attorney.</p>}
        <p>Last updated {formatDate(post.updatedAt)}.</p>
      </div>
    </section>
  );
}

export function SourcesList({ sources }: { sources: { title: string; url: string }[] }) {
  if (!sources.length) return null;
  return (
    <section aria-labelledby="sources-heading">
      <h2 id="sources-heading" className="text-xl font-bold tracking-tight text-text-primary">Sources</h2>
      <ol className="mt-4 list-decimal space-y-2 pl-6 text-sm leading-6 text-text-secondary">
        {sources.map((s) => (
          <li key={s.url}>
            <a href={s.url} target="_blank" rel="noopener noreferrer" className="focus-ring rounded-sm break-words font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent">
              {s.title}<span className="sr-only"> (opens in a new tab)</span>
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ----------------------------------- FAQ ----------------------------------- */

export function FaqAccordion({ faq }: { faq: BlogFaq[] }) {
  if (!faq.length) return null;
  return (
    <section aria-labelledby="faq">
      <h2 id="faq" className="scroll-mt-28 text-2xl font-bold tracking-tight text-text-primary">Frequently asked questions</h2>
      <div className="mt-5 divide-y divide-border rounded-2xl border border-border bg-bg-secondary">
        {faq.map((f) => (
          <details key={f.q} className="group px-5">
            <summary className="focus-ring flex cursor-pointer list-none items-center justify-between gap-4 rounded-lg py-4 text-left text-base font-semibold text-text-primary">
              {f.q}
              <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <p className="pb-5 text-base leading-7 text-text-secondary"><InlineContent nodes={f.a} /></p>
          </details>
        ))}
      </div>
    </section>
  );
}
