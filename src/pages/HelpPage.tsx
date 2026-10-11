import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, BookOpen, ChevronLeft, Clock, LifeBuoy, Mail, PlayCircle, Search, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { Input } from '@/components/ui/Input';
import {
  HELP_ARTICLES,
  HELP_CATEGORIES,
  HELP_SUPPORT_EMAIL,
  HELP_VIDEOS,
  contextualArticles,
  contextualVideos,
  filterByPermission,
  getRememberedDashboardPath,
  highlightParts,
  isValidContextPath,
  loadRecentSearches,
  pageLabel,
  pushRecent,
  saveRecentSearches,
  searchArticles,
  searchVideos,
  toEmbedSrc,
  tokenize,
  videoEmbedState,
  type HelpArticle,
  type HelpCategoryId,
  type HelpVideo,
} from '@/lib/helpCenter';

// ============================================================
// URL STATE — everything shareable lives in the query string
//   ?q=search  ?tab=articles|videos  ?article=<id>  ?video=<id>  ?page=/dashboard/…
// ============================================================

type Tab = 'articles' | 'videos';
type Patch = Partial<Record<'q' | 'tab' | 'article' | 'video', string | null>>;

const HELP_PATH = '/dashboard/help';

function categoryName(id: HelpCategoryId): string {
  return HELP_CATEGORIES.find((c) => c.id === id)?.name ?? '';
}

function Highlight({ text, query }: { text: string; query: string }) {
  const parts = useMemo(() => highlightParts(text, query), [text, query]);
  return (
    <>
      {parts.map((p, i) =>
        p.match ? (
          <mark key={i} className="rounded bg-accent/20 px-0.5 text-text-primary">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

function Pill({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'warn' }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
        tone === 'warn' ? 'bg-warning/10 text-warning' : 'bg-bg-tertiary text-text-secondary'
      }`}
    >
      {children}
    </span>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`focus-ring min-h-[40px] rounded-full px-4 py-2 text-sm font-medium transition-colors ${
        active ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  );
}

// ============================================================
// PAGE
// ============================================================

export function HelpPage() {
  const { isOwner, permissions } = useAuth();
  const [params, setParams] = useSearchParams();

  const urlQuery = params.get('q') ?? '';
  const tab: Tab = params.get('tab') === 'videos' ? 'videos' : 'articles';
  const articleId = params.get('article');
  const videoId = params.get('video');

  const [input, setInput] = useState(urlQuery);
  const [recent, setRecent] = useState<string[]>(() => loadRecentSearches());
  const lastWritten = useRef(urlQuery);

  useEffect(() => {
    const previous = document.title;
    document.title = 'Help — Vireek';
    return () => {
      document.title = previous;
    };
  }, []);

  // Which dashboard page did the person come from? ?page= wins, else the page remembered by the nav.
  const contextPath = useMemo(() => {
    const fromUrl = params.get('page');
    return isValidContextPath(fromUrl) ? fromUrl : getRememberedDashboardPath();
  }, [params]);

  const articles = useMemo(() => filterByPermission(HELP_ARTICLES, { isOwner, permissions }), [isOwner, permissions]);

  const update = useCallback(
    (patch: Patch, replace = false) => {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === '') next.delete(k);
        else next.set(k, v);
      }
      setParams(next, { replace });
    },
    [params, setParams],
  );

  /** A normal <Link> target that keeps q/tab/page and applies the patch. */
  const hrefFor = useCallback(
    (patch: Patch): string => {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === '') next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      return qs ? `${HELP_PATH}?${qs}` : HELP_PATH;
    },
    [params],
  );

  // Typing -> URL (debounced); URL -> typing (back/forward, shared links).
  useEffect(() => {
    const t = window.setTimeout(() => {
      const value = input.trim();
      if (value !== (params.get('q') ?? '')) {
        lastWritten.current = value;
        update({ q: value || null, article: null, video: null }, true);
      }
    }, 250);
    return () => window.clearTimeout(t);
  }, [input, params, update]);

  useEffect(() => {
    if (urlQuery !== lastWritten.current) {
      lastWritten.current = urlQuery;
      setInput(urlQuery);
    }
  }, [urlQuery]);

  const rememberQuery = useCallback(() => {
    if (!input.trim()) return;
    setRecent((prev) => {
      const next = pushRecent(prev, input);
      saveRecentSearches(next);
      return next;
    });
  }, [input]);

  const clearSearch = () => {
    setInput('');
    lastWritten.current = '';
    update({ q: null, article: null, video: null }, true);
  };

  const query = urlQuery.trim();
  const article = articleId ? articles.find((a) => a.id === articleId) ?? null : null;
  const video = videoId ? HELP_VIDEOS.find((v) => v.id === videoId) ?? null : null;

  let body: React.ReactNode;
  if (articleId) {
    body = article ? (
      <ArticleView
        article={article}
        articles={articles}
        backHref={hrefFor({ article: null })}
        hrefFor={hrefFor}
        hasQuery={!!query}
      />
    ) : (
      <EmptyState
        icon={BookOpen}
        title="That article isn't available"
        description="It may have moved, or it's only available to people with different permissions."
        action={{ label: 'Back to help', onClick: () => update({ article: null }) }}
      />
    );
  } else if (videoId) {
    body = video ? (
      <VideoView video={video} backHref={hrefFor({ video: null })} hrefFor={hrefFor} articles={articles} hasQuery={!!query} />
    ) : (
      <EmptyState
        icon={PlayCircle}
        title="That video isn't available"
        description="It may have been renamed or removed from the library."
        action={{ label: 'Back to videos', onClick: () => update({ video: null, tab: 'videos' }) }}
      />
    );
  } else if (query) {
    body = (
      <SearchResults
        query={query}
        tab={tab}
        articles={articles}
        recent={recent}
        hrefFor={hrefFor}
        onTab={(t) => update({ tab: t === 'articles' ? null : t }, true)}
        onClear={clearSearch}
        onOpen={rememberQuery}
      />
    );
  } else {
    body = (
      <HelpHome
        tab={tab}
        articles={articles}
        contextPath={contextPath}
        recent={recent}
        hrefFor={hrefFor}
        onTab={(t) => update({ tab: t === 'articles' ? null : t }, true)}
        onPickRecent={(q) => setInput(q)}
        onClearRecent={() => {
          setRecent([]);
          saveRecentSearches([]);
        }}
      />
    );
  }

  const showSearchChrome = !articleId && !videoId;

  return (
    <DashboardLayout activeLabel="Help">
      <div className="mx-auto max-w-5xl space-y-6 px-0 py-2 sm:px-2">
        <header className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <LifeBuoy size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Help Center</h1>
            <p className="mt-1 text-sm text-text-secondary">Search guides, get help for the page you're on, or watch a short video.</p>
          </div>
        </header>

        {showSearchChrome && (
          <form
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              rememberQuery();
            }}
          >
            <div className="relative">
              <Input
                icon={Search}
                aria-label="Search the help center"
                placeholder="Search — e.g. forward calls, cycle count, permissions"
                value={input}
                inputMode="search"
                enterKeyHint="search"
                autoComplete="off"
                autoFocus={typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: fine)').matches}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') clearSearch();
                }}
                className="pr-11"
              />
              {input && (
                <button
                  type="button"
                  onClick={clearSearch}
                  aria-label="Clear search"
                  className="focus-ring absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-text-secondary hover:text-text-primary"
                >
                  <X size={16} />
                </button>
              )}
            </div>
          </form>
        )}

        {body}

        <footer className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-bg-secondary p-4">
          <div>
            <p className="text-sm font-semibold text-text-primary">Still stuck?</p>
            <p className="text-xs text-text-secondary">Tell us the page you were on and what you expected to happen.</p>
          </div>
          <a
            href={`mailto:${HELP_SUPPORT_EMAIL}?subject=${encodeURIComponent('Vireek dashboard help')}`}
            className="focus-ring inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-border bg-bg-primary px-4 text-sm font-medium text-text-primary hover:border-accent/40"
          >
            <Mail size={16} /> Email support
          </a>
        </footer>
      </div>
    </DashboardLayout>
  );
}

// ============================================================
// HOME (no search)
// ============================================================

function HelpHome({
  tab,
  articles,
  contextPath,
  recent,
  hrefFor,
  onTab,
  onPickRecent,
  onClearRecent,
}: {
  tab: Tab;
  articles: HelpArticle[];
  contextPath: string | null;
  recent: string[];
  hrefFor: (patch: Patch) => string;
  onTab: (t: Tab) => void;
  onPickRecent: (q: string) => void;
  onClearRecent: () => void;
}) {
  const ctxArticles = useMemo(() => (contextPath ? contextualArticles(contextPath, articles).slice(0, 4) : []), [contextPath, articles]);
  const ctxVideos = useMemo(() => (contextPath ? contextualVideos(contextPath, HELP_VIDEOS).slice(0, 2) : []), [contextPath]);
  const label = contextPath ? pageLabel(contextPath) : null;

  return (
    <div className="space-y-6">
      {recent.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1 text-xs font-medium text-text-secondary">
            <Clock size={13} /> Recent
          </span>
          {recent.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onPickRecent(r)}
              className="focus-ring rounded-full bg-bg-tertiary px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
            >
              {r}
            </button>
          ))}
          <button type="button" onClick={onClearRecent} className="focus-ring rounded-lg px-2 py-1 text-xs text-text-secondary hover:text-text-primary">
            Clear
          </button>
        </div>
      )}

      {(ctxArticles.length > 0 || ctxVideos.length > 0) && (
        <section aria-label="Help for this page" className="rounded-2xl border border-accent/30 bg-accent/5 p-4">
          <h2 className="text-sm font-semibold text-text-primary">Help for {label ?? 'the page you were on'}</h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {ctxArticles.map((a) => (
              <li key={a.id}>
                <ArticleRow article={a} href={hrefFor({ article: a.id })} />
              </li>
            ))}
            {ctxVideos.map((v) => (
              <li key={v.id}>
                <VideoRow video={v} href={hrefFor({ video: v.id })} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <div role="tablist" aria-label="Help content" className="flex gap-2">
        <Chip active={tab === 'articles'} onClick={() => onTab('articles')}>
          Articles
        </Chip>
        <Chip active={tab === 'videos'} onClick={() => onTab('videos')}>
          Video library ({HELP_VIDEOS.length})
        </Chip>
      </div>

      {tab === 'articles' ? (
        <div className="space-y-8">
          {HELP_CATEGORIES.map((cat) => {
            const list = articles.filter((a) => a.category === cat.id);
            if (list.length === 0) return null;
            return (
              <section key={cat.id} aria-labelledby={`cat-${cat.id}`}>
                <h2 id={`cat-${cat.id}`} className="text-base font-semibold text-text-primary">
                  {cat.name}
                </h2>
                <p className="mb-3 mt-0.5 text-sm text-text-secondary">{cat.description}</p>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {list.map((a) => (
                    <motion.li key={a.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
                      <ArticleRow article={a} href={hrefFor({ article: a.id })} />
                    </motion.li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      ) : (
        <VideoGrid videos={HELP_VIDEOS} hrefFor={hrefFor} />
      )}
    </div>
  );
}

// ============================================================
// SEARCH RESULTS
// ============================================================

function SearchResults({
  query,
  tab,
  articles,
  recent,
  hrefFor,
  onTab,
  onClear,
  onOpen,
}: {
  query: string;
  tab: Tab;
  articles: HelpArticle[];
  recent: string[];
  hrefFor: (patch: Patch) => string;
  onTab: (t: Tab) => void;
  onClear: () => void;
  onOpen: () => void;
}) {
  const articleHits = useMemo(() => searchArticles(query, articles), [query, articles]);
  const videoHits = useMemo(() => searchVideos(query, HELP_VIDEOS), [query]);
  const tooShort = tokenize(query).length === 0;
  const total = articleHits.length + videoHits.length;

  if (tooShort) {
    return (
      <EmptyState
        icon={Search}
        title="Keep typing…"
        description="Use at least two letters so we can find the right guide."
        action={{ label: 'Clear search', onClick: onClear }}
      />
    );
  }

  if (total === 0) {
    return (
      <div className="space-y-4">
        <EmptyState
          icon={Search}
          title={`Nothing matches "${query}"`}
          description="Try fewer or different words — for example “count” instead of “inventory audit”."
          action={{ label: 'Clear search', onClick: onClear }}
          secondaryAction={{ label: 'Email support', onClick: () => window.location.assign(`mailto:${HELP_SUPPORT_EMAIL}?subject=${encodeURIComponent(`Help: ${query}`)}`) }}
        />
        {recent.length > 0 && <p className="text-center text-xs text-text-secondary">Your recent searches are on the Help home page.</p>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Result type" className="flex gap-2">
        <Chip active={tab === 'articles'} onClick={() => onTab('articles')}>
          Articles ({articleHits.length})
        </Chip>
        <Chip active={tab === 'videos'} onClick={() => onTab('videos')}>
          Videos ({videoHits.length})
        </Chip>
      </div>

      <p className="text-xs text-text-secondary" aria-live="polite">
        {total} result{total === 1 ? '' : 's'} for “{query}”
      </p>

      {tab === 'articles' ? (
        articleHits.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title="No articles for that search"
            description={videoHits.length > 0 ? `There ${videoHits.length === 1 ? 'is 1 video' : `are ${videoHits.length} videos`} that match.` : 'Try different words.'}
            action={videoHits.length > 0 ? { label: 'Show videos', onClick: () => onTab('videos') } : undefined}
          />
        ) : (
          <ul className="space-y-2">
            {articleHits.map(({ article }) => (
              <li key={article.id}>
                <ArticleRow article={article} href={hrefFor({ article: article.id })} query={query} onOpen={onOpen} showCategory />
              </li>
            ))}
          </ul>
        )
      ) : videoHits.length === 0 ? (
        <EmptyState
          icon={PlayCircle}
          title="No videos for that search"
          description={articleHits.length > 0 ? `${articleHits.length} article${articleHits.length === 1 ? '' : 's'} match instead.` : 'Try different words.'}
          action={articleHits.length > 0 ? { label: 'Show articles', onClick: () => onTab('articles') } : undefined}
        />
      ) : (
        <VideoGrid videos={videoHits} hrefFor={hrefFor} query={query} onOpen={onOpen} />
      )}
    </div>
  );
}

// ============================================================
// ROWS & GRID
// ============================================================

function ArticleRow({
  article,
  href,
  query = '',
  onOpen,
  showCategory = false,
}: {
  article: HelpArticle;
  href: string;
  query?: string;
  onOpen?: () => void;
  showCategory?: boolean;
}) {
  return (
    <Link
      to={href}
      onClick={onOpen}
      className="focus-ring group flex min-h-[64px] items-start justify-between gap-3 rounded-2xl border border-border bg-bg-secondary p-3.5 transition-colors hover:border-accent/40"
    >
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-text-primary">
          <Highlight text={article.title} query={query} />
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-text-secondary">
          <Highlight text={article.summary} query={query} />
        </span>
        {showCategory && (
          <span className="mt-1.5 block">
            <Pill>{categoryName(article.category)}</Pill>
          </span>
        )}
      </span>
      <ArrowRight size={16} className="mt-0.5 shrink-0 text-text-secondary transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

function VideoRow({ video, href, query = '', onOpen }: { video: HelpVideo; href: string; query?: string; onOpen?: () => void }) {
  const state = videoEmbedState(video.url);
  return (
    <Link
      to={href}
      onClick={onOpen}
      className="focus-ring group flex min-h-[64px] items-start gap-3 rounded-2xl border border-border bg-bg-secondary p-3.5 transition-colors hover:border-accent/40"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
        <PlayCircle size={20} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-text-primary">
          <Highlight text={video.title} query={query} />
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-text-secondary">
          {video.minutes} min
          {state === 'placeholder' && <Pill tone="warn">Coming soon</Pill>}
        </span>
      </span>
    </Link>
  );
}

function VideoGrid({
  videos,
  hrefFor,
  query = '',
  onOpen,
}: {
  videos: HelpVideo[];
  hrefFor: (patch: Patch) => string;
  query?: string;
  onOpen?: () => void;
}) {
  const courses = useMemo(() => {
    const map = new Map<string, { title: string; items: HelpVideo[] }>();
    for (const v of videos) {
      const entry = map.get(v.courseSlug) ?? { title: v.courseTitle, items: [] };
      entry.items.push(v);
      map.set(v.courseSlug, entry);
    }
    return Array.from(map.entries());
  }, [videos]);

  if (videos.length === 0) {
    return <EmptyState icon={PlayCircle} title="The video library is empty" description="Videos will appear here as soon as they are published." />;
  }

  return (
    <div className="space-y-6">
      {courses.map(([slug, course]) => (
        <section key={slug} aria-label={course.title}>
          <h2 className="mb-3 text-base font-semibold text-text-primary">{course.title}</h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {course.items.map((v) => (
              <li key={v.id}>
                <VideoCard video={v} href={hrefFor({ video: v.id, tab: 'videos' })} query={query} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function VideoCard({ video, href, query, onOpen }: { video: HelpVideo; href: string; query: string; onOpen?: () => void }) {
  const state = videoEmbedState(video.url);
  return (
    <Link
      to={href}
      onClick={onOpen}
      className="focus-ring group block overflow-hidden rounded-2xl border border-border bg-bg-secondary transition-colors hover:border-accent/40"
    >
      <div className="relative flex aspect-video items-center justify-center bg-gradient-to-br from-accent/20 to-bg-tertiary">
        <PlayCircle size={40} className="text-accent transition-transform group-hover:scale-110" />
        <span className="absolute bottom-2 right-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-white">{video.minutes} min</span>
        {state === 'placeholder' && (
          <span className="absolute left-2 top-2">
            <Pill tone="warn">Coming soon</Pill>
          </span>
        )}
      </div>
      <div className="p-3.5">
        <p className="text-sm font-semibold text-text-primary">
          <Highlight text={video.title} query={query} />
        </p>
        <p className="mt-1 text-xs leading-relaxed text-text-secondary">
          <Highlight text={video.description} query={query} />
        </p>
      </div>
    </Link>
  );
}

// ============================================================
// ARTICLE VIEW
// ============================================================

function ArticleView({
  article,
  articles,
  backHref,
  hrefFor,
  hasQuery,
}: {
  article: HelpArticle;
  articles: HelpArticle[];
  backHref: string;
  hrefFor: (patch: Patch) => string;
  hasQuery: boolean;
}) {
  const videos = (article.videoIds ?? []).map((id) => HELP_VIDEOS.find((v) => v.id === id)).filter((v): v is HelpVideo => !!v);
  const related = articles.filter((a) => a.category === article.category && a.id !== article.id).slice(0, 3);
  const target = article.routes[0];
  const targetLabel = target ? pageLabel(target) : null;

  return (
    <article className="space-y-6">
      <Link to={backHref} className="focus-ring -ml-1 inline-flex items-center gap-1 rounded-lg px-1 py-1 text-sm font-medium text-text-secondary hover:text-text-primary">
        <ChevronLeft size={16} /> {hasQuery ? 'Back to results' : 'All help'}
      </Link>

      <div className="space-y-3">
        <Pill>{categoryName(article.category)}</Pill>
        <h2 className="text-2xl font-bold text-text-primary">{article.title}</h2>
        <p className="text-sm text-text-secondary">{article.summary}</p>
      </div>

      <div className="space-y-4 text-[15px] leading-relaxed text-text-primary">
        {article.body.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>

      {article.steps && article.steps.length > 0 && (
        <ol className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-4">
          {article.steps.map((s, i) => (
            <li key={i} className="flex gap-3 text-sm text-text-primary">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-semibold text-accent">{i + 1}</span>
              <span className="pt-0.5">{s}</span>
            </li>
          ))}
        </ol>
      )}

      {target && targetLabel && (
        <Link
          to={target}
          className="focus-ring inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 text-sm font-medium text-text-primary hover:border-accent/40"
        >
          Open {targetLabel} <ArrowRight size={16} />
        </Link>
      )}

      {videos.length > 0 && (
        <section aria-label="Related videos" className="space-y-3">
          <h3 className="text-sm font-semibold text-text-primary">Watch</h3>
          <ul className="grid gap-3 sm:grid-cols-2">
            {videos.map((v) => (
              <li key={v.id}>
                <VideoRow video={v} href={hrefFor({ article: null, video: v.id, tab: 'videos' })} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {related.length > 0 && (
        <section aria-label="Related articles" className="space-y-3">
          <h3 className="text-sm font-semibold text-text-primary">Related</h3>
          <ul className="grid gap-2 sm:grid-cols-2">
            {related.map((a) => (
              <li key={a.id}>
                <ArticleRow article={a} href={hrefFor({ article: a.id })} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

// ============================================================
// VIDEO VIEW
// ============================================================

function VideoView({
  video,
  backHref,
  hrefFor,
  articles,
  hasQuery,
}: {
  video: HelpVideo;
  backHref: string;
  hrefFor: (patch: Patch) => string;
  articles: HelpArticle[];
  hasQuery: boolean;
}) {
  const state = videoEmbedState(video.url);
  const articlesForVideo = articles.filter((a) => a.videoIds?.includes(video.id));

  return (
    <section className="space-y-5">
      <Link to={backHref} className="focus-ring -ml-1 inline-flex items-center gap-1 rounded-lg px-1 py-1 text-sm font-medium text-text-secondary hover:text-text-primary">
        <ChevronLeft size={16} /> {hasQuery ? 'Back to results' : 'Video library'}
      </Link>

      <div className="aspect-video w-full overflow-hidden rounded-2xl border border-border bg-black">
        {state === 'ok' ? (
          <iframe
            key={video.id}
            src={toEmbedSrc(video.url)}
            title={video.title}
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            allow="accelerometer; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            className="h-full w-full"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <PlayCircle size={36} className="text-white/70" />
            <p className="text-sm font-semibold text-white">{state === 'placeholder' ? 'This video is being recorded' : "This video can't be played here"}</p>
            <p className="max-w-sm text-xs text-white/70">
              {state === 'placeholder'
                ? 'It will appear here as soon as it is published. The written guide below covers the same steps.'
                : 'Its link is not from a supported video host. Please contact support so we can fix it.'}
            </p>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <h2 className="text-xl font-bold text-text-primary">{video.title}</h2>
        <p className="text-xs text-text-secondary">
          {video.minutes} min · {video.courseTitle}
        </p>
        <p className="pt-1 text-sm leading-relaxed text-text-secondary">{video.description}</p>
      </div>

      {articlesForVideo.length > 0 && (
        <section aria-label="Written guide" className="space-y-3">
          <h3 className="text-sm font-semibold text-text-primary">Prefer to read?</h3>
          <ul className="grid gap-2 sm:grid-cols-2">
            {articlesForVideo.map((a) => (
              <li key={a.id}>
                <ArticleRow article={a} href={hrefFor({ video: null, article: a.id, tab: null })} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
