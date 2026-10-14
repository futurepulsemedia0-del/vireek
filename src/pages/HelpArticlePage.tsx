import { useEffect, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowRight, BookOpen, ChevronRight, FileQuestion, MessageCircle } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { BackButton } from '@/components/ui/BackButton';
import { HelpSearch } from '@/components/HelpSearch';
import { HelpFeedback } from '@/components/HelpFeedback';
import { useSEO } from '@/lib/seo';
import { HELP_CATEGORIES } from '@/lib/helpContent';
import {
  HELP_ARTICLES, getHelpArticle, getHelpCategory, getRelatedHelpArticles, type HelpArticleRecord,
} from '@/lib/helpArticles';

const SITE = 'https://vireek.com';

function ArticleSEO({ article }: { article: HelpArticleRecord }) {
  const url = `${SITE}/help/${article.slug}`;
  const jsonLd = useMemo(
    () => [
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: [
          {
            '@type': 'Question',
            name: article.title,
            acceptedAnswer: { '@type': 'Answer', text: article.body },
          },
        ],
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: 'Help Center', item: `${SITE}/help` },
          { '@type': 'ListItem', position: 3, name: article.categoryName, item: `${SITE}/help#${article.categoryId}` },
          { '@type': 'ListItem', position: 4, name: article.title, item: url },
        ],
      },
    ],
    [article, url],
  );

  useSEO({
    title: `${article.title} | Vireek Help Center`,
    description: article.excerpt,
    canonical: url,
    type: 'article',
    jsonLd,
  });
  return null;
}

/** SPA hosting returns 200 for unknown URLs, so keep soft-404s out of the index. */
function NoIndex({ title }: { title: string }) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = title;
    let el = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const created = !el;
    const previous = el?.getAttribute('content') ?? null;
    if (!el) {
      el = document.createElement('meta');
      el.setAttribute('name', 'robots');
      document.head.appendChild(el);
    }
    el.setAttribute('content', 'noindex, follow');
    return () => {
      document.title = previousTitle;
      if (created) el?.remove();
      else if (previous !== null) el?.setAttribute('content', previous);
    };
  }, [title]);
  return null;
}

function ArticleNotFound() {
  return (
    <>
      <NoIndex title="Article not found | Vireek Help Center" />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        <section className="mx-auto max-w-3xl px-6 py-14 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <FileQuestion className="h-7 w-7" />
          </span>
          <h1 className="mt-6 text-3xl font-extrabold tracking-tight text-text-primary">We couldn’t find that article</h1>
          <p className="mt-3 text-base leading-7 text-text-secondary">
            It may have been renamed or removed. Search the Help Center or browse a category below.
          </p>
          <HelpSearch className="mx-auto mt-8 max-w-xl text-left" />
          <ul className="mt-8 flex flex-wrap justify-center gap-2">
            {HELP_CATEGORIES.map((c) => (
              <li key={c.id}>
                <Link
                  to={`/help#${c.id}`}
                  className="focus-ring inline-flex min-h-11 items-center rounded-full border border-border bg-bg-secondary px-4 text-sm font-medium text-text-primary"
                >
                  {c.name}
                </Link>
              </li>
            ))}
          </ul>
          <Link to="/help" className="focus-ring mt-8 inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-accent hover:underline">
            Go to Help Center <ArrowRight className="h-4 w-4" />
          </Link>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

function ArticleView({ article }: { article: HelpArticleRecord }) {
  const category = getHelpCategory(article.categoryId);
  const CategoryIcon = category?.icon ?? BookOpen;
  const related = useMemo(() => getRelatedHelpArticles(article, 3), [article]);
  const siblings = useMemo(() => HELP_ARTICLES.filter((a) => a.categoryId === article.categoryId), [article.categoryId]);
  const paragraphs = article.body.split(/\n{2,}/);

  return (
    <>
      <ArticleSEO article={article} />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        <div className="mx-auto max-w-6xl px-6 py-10">
          <div className="mb-6 flex items-center justify-between gap-4">
            <BackButton fallback="/help" />
            <Link to="/help" className="focus-ring text-sm font-semibold text-text-secondary transition-colors hover:text-accent">
              All articles
            </Link>
          </div>

          <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="min-w-0">
              <nav aria-label="Breadcrumb" className="mb-5">
                <ol className="flex flex-wrap items-center gap-1 text-sm text-text-secondary">
                  <li>
                    <Link to="/help" className="hover:text-accent">Help Center</Link>
                  </li>
                  <li aria-hidden="true"><ChevronRight className="h-4 w-4" /></li>
                  <li>
                    <Link to={`/help#${article.categoryId}`} className="hover:text-accent">{article.categoryName}</Link>
                  </li>
                </ol>
              </nav>

              <HelpSearch className="mb-8" />

              <article>
                <div className="inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-4 py-2 text-sm font-semibold text-accent">
                  <CategoryIcon className="h-4 w-4" aria-hidden="true" />
                  {article.categoryName}
                </div>
                <h1 className="mt-5 text-balance text-3xl font-extrabold leading-tight tracking-tight text-text-primary sm:text-4xl">
                  {article.title}
                </h1>
                <div className="mt-6 space-y-5 text-base leading-8 text-text-secondary sm:text-lg">
                  {paragraphs.map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </div>
              </article>

              <div className="mt-10">
                <HelpFeedback key={article.slug} slug={article.slug} />
              </div>

              {related.length > 0 && (
                <section aria-labelledby="related-title" className="mt-12">
                  <h2 id="related-title" className="text-xl font-bold tracking-tight text-text-primary">
                    Related articles
                  </h2>
                  <ul className="mt-4 grid gap-3 sm:grid-cols-2">
                    {related.map((r) => (
                      <li key={r.slug}>
                        <Link
                          to={`/help/${r.slug}`}
                          className="focus-ring flex h-full min-h-11 flex-col rounded-2xl border border-border bg-bg-secondary p-4 transition-colors hover:border-accent/40"
                        >
                          <span className="text-xs font-semibold text-accent">{r.categoryName}</span>
                          <span className="mt-1 text-base font-semibold text-text-primary">{r.title}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>

            <aside className="space-y-6">
              <section aria-labelledby="category-title" className="rounded-2xl border border-border bg-bg-secondary p-5">
                <h2 id="category-title" className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
                  In {article.categoryName}
                </h2>
                <ul className="mt-3 space-y-1">
                  {siblings.map((s) => (
                    <li key={s.slug}>
                      <Link
                        to={`/help/${s.slug}`}
                        aria-current={s.slug === article.slug ? 'page' : undefined}
                        className={`focus-ring block min-h-11 rounded-lg px-3 py-2 text-sm ${
                          s.slug === article.slug ? 'bg-accent/10 font-semibold text-accent' : 'text-text-primary hover:bg-bg-tertiary'
                        }`}
                      >
                        {s.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="rounded-2xl border border-border bg-bg-secondary p-5">
                <h2 className="text-base font-semibold text-text-primary">Still need help?</h2>
                <p className="mt-1 text-sm text-text-secondary">Our team replies to every message.</p>
                <Link
                  to="/contact"
                  className="focus-ring mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-white"
                >
                  <MessageCircle className="h-4 w-4" aria-hidden="true" /> Contact support
                </Link>
              </section>
            </aside>
          </div>
        </div>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

export function HelpArticlePage() {
  const { slug } = useParams<{ slug: string }>();
  const article = slug ? getHelpArticle(slug) : undefined;
  return article ? <ArticleView article={article} /> : <ArticleNotFound />;
}
