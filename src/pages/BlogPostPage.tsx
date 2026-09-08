import { useEffect } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, Calendar, Clock, Lightbulb, Sparkles, User } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { getCategoryBySlug, getPostBySlug, getRelatedPosts, type BlogPost } from '@/lib/blog';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function SEO({ post }: { post: BlogPost }) {
  useSEO({
    title: `${post.title} | Vireek Blog`,
    description: post.excerpt,
    canonical: `https://vireek.com/blog/${post.slug}`,
    type: 'article',
  });

  useEffect(() => {
    const schema = {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: post.title,
      description: post.excerpt,
      datePublished: post.publishedDate,
      author: { '@type': 'Organization', name: post.author },
      publisher: { '@type': 'Organization', name: 'Vireek' },
      mainEntityOfPage: `https://vireek.com/blog/${post.slug}`,
    };
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.text = JSON.stringify(schema);
    document.head.appendChild(script);
    return () => {
      script.remove();
    };
  }, [post]);

  return null;
}

function ArticleBody({ post }: { post: BlogPost }) {
  return (
    <div className="space-y-6 text-base leading-8 text-text-secondary">
      {post.content.map((block, index) => {
        if (block.type === 'h2') {
          return (
            <h2 key={index} className="!mt-12 text-2xl font-bold tracking-tight text-text-primary">
              {block.text}
            </h2>
          );
        }
        if (block.type === 'list') {
          return (
            <ul key={index} className="ml-1 space-y-2.5">
              {block.items.map((item) => (
                <li key={item} className="flex gap-3">
                  <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          );
        }
        if (block.type === 'callout') {
          return (
            <div
              key={index}
              className="flex gap-4 rounded-2xl border-2 border-accent/30 bg-accent/[0.04] p-5 sm:p-6"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
                <Lightbulb className="h-4 w-4" />
              </span>
              <p className="text-base leading-7 text-text-primary">{block.text}</p>
            </div>
          );
        }
        return <p key={index}>{block.text}</p>;
      })}
    </div>
  );
}

export function BlogPostPage() {
  const { slug } = useParams<{ slug: string }>();
  const post = slug ? getPostBySlug(slug) : undefined;

  if (!post) {
    return <Navigate to="/blog" replace />;
  }

  const category = getCategoryBySlug(post.category);
  const CategoryIcon = category?.icon ?? Sparkles;
  const relatedPosts = getRelatedPosts(post);

  return (
    <>
      <SEO post={post} />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        <section className="relative bg-gradient-mesh bg-noise px-6 py-16 sm:py-20">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-3xl">
            <div className="mb-8 flex items-center justify-between gap-4">
              <BackButton fallback="/blog" />
              <Link
                to="/blog"
                className="focus-ring text-sm font-semibold text-text-secondary transition-colors hover:text-accent"
              >
                All articles
              </Link>
            </div>

            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
              <div className="inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-4 py-2 text-sm font-semibold text-accent">
                <CategoryIcon className="h-4 w-4" />
                {category?.name ?? 'Resources'}
              </div>
              <h1 className="mt-6 text-balance text-4xl font-extrabold leading-tight tracking-tight text-text-primary sm:text-5xl">
                {post.title}
              </h1>
              <p className="mt-5 text-xl leading-8 text-text-secondary">{post.excerpt}</p>
              <div className="mt-6 flex flex-wrap items-center gap-5 border-t border-border pt-6 text-sm text-text-secondary">
                <span className="flex items-center gap-1.5">
                  <User className="h-4 w-4" />
                  {post.author}
                </span>
                <span className="flex items-center gap-1.5">
                  <Calendar className="h-4 w-4" />
                  {formatDate(post.publishedDate)}
                </span>
                <span className="flex items-center gap-1.5">
                  <Clock className="h-4 w-4" />
                  {post.readTimeMinutes} min read
                </span>
              </div>
            </motion.div>
          </div>
        </section>

        <section className="px-6 py-14">
          <motion.article
            initial={{ opacity: 0, y: 18 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
            className="mx-auto max-w-3xl"
          >
            <ArticleBody post={post} />
          </motion.article>
        </section>

        {/* CTA */}
        <section className="px-6 pb-16">
          <div className="mx-auto max-w-3xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-10">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">See it in action</p>
            <h2 className="mt-3 text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">
              Ready to stop losing jobs to missed calls?
            </h2>
            <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link to="/login">
                <Button variant="primary" size="lg">
                  Start Free Trial
                </Button>
              </Link>
              <Link
                to="/demo"
                className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
              >
                Book a Demo <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </section>

        {/* Related posts */}
        {relatedPosts.length > 0 && (
          <section className="px-6 pb-24">
            <div className="mx-auto max-w-5xl">
              <h2 className="text-2xl font-bold tracking-tight text-text-primary">Keep reading</h2>
              <div className="mt-6 grid gap-6 sm:grid-cols-2">
                {relatedPosts.map((related) => {
                  const relatedCategory = getCategoryBySlug(related.category);
                  const RelatedIcon = relatedCategory?.icon ?? Sparkles;
                  return (
                    <Link key={related.slug} to={`/blog/${related.slug}`} className="focus-ring block h-full rounded-2xl">
                      <Card className="flex h-full flex-col p-6">
                        <div className="flex items-center gap-2">
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
                            <RelatedIcon className="h-4 w-4" />
                          </span>
                          <span className="text-xs font-semibold uppercase tracking-wider text-accent">
                            {relatedCategory?.name ?? 'Resources'}
                          </span>
                        </div>
                        <h3 className="mt-4 text-lg font-bold leading-snug tracking-tight text-text-primary">
                          {related.title}
                        </h3>
                        <p className="mt-2.5 flex-1 text-sm leading-relaxed text-text-secondary">{related.excerpt}</p>
                        <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-accent">
                          Read article <ArrowRight className="h-3.5 w-3.5" />
                        </span>
                      </Card>
                    </Link>
                  );
                })}
              </div>
            </div>
          </section>
        )}
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
