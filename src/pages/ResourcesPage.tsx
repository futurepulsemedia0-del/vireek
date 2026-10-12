import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, BookOpen, Calculator, CheckCircle2, FileText, Lock, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, fadeUpItem, staggerContainer, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { readUnlock } from '@/lib/resourceLeads';
import {
  KIND_LABEL,
  KIND_PLURAL,
  filterResources,
  hubJsonLd,
  publishedResources,
  resourcePath,
} from '@/lib/resources';
import type { ResourceKind } from '@/lib/resources';

const KIND_ICON: Record<ResourceKind, LucideIcon> = {
  ebook: BookOpen,
  template: FileText,
  calculator: Calculator,
};

const KIND_ORDER: ResourceKind[] = ['calculator', 'template', 'ebook'];

export function ResourcesPage() {
  const resources = useMemo(() => publishedResources(), []);
  const [kind, setKind] = useState<'all' | ResourceKind>('all');
  const [query, setQuery] = useState('');
  const [unlocked] = useState(() => readUnlock());

  useSEO({
    title: 'Free Resources for Home Service Businesses — Vireek',
    description:
      'Free calculators, ready-to-use templates and guides for home service businesses: recover missed calls, follow up on estimates and book more jobs.',
    canonical: 'https://vireek.com/resources',
    jsonLd: hubJsonLd(resources),
  });

  const counts = useMemo(() => {
    const map = new Map<ResourceKind, number>();
    for (const r of resources) map.set(r.kind, (map.get(r.kind) ?? 0) + 1);
    return map;
  }, [resources]);

  const visible = useMemo(() => filterResources(resources, { kind, query }), [resources, kind, query]);
  const kinds = KIND_ORDER.filter((k) => (counts.get(k) ?? 0) > 0);
  const isFiltering = kind !== 'all' || query.trim().length > 0;

  const chipClass = (active: boolean) =>
    `focus-ring min-h-[40px] shrink-0 rounded-full border px-4 text-sm font-semibold transition-colors ${
      active
        ? 'border-accent bg-accent/10 text-accent'
        : 'border-border bg-bg-secondary text-text-secondary hover:text-text-primary'
    }`;

  return (
    <>
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        <section className="relative bg-gradient-mesh bg-noise px-6 py-16 sm:py-20 lg:py-24">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-4xl">
            <div className="mb-8">
              <BackButton />
            </div>
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>Free Resources</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Tools to Win More of the Jobs You Already Get Calls For
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                Free calculators and ready-to-use templates for home service businesses. One email unlocks the whole
                library.
              </p>
              {unlocked && (
                <p className="mt-5 inline-flex items-center gap-2 rounded-full bg-success/10 px-4 py-1.5 text-sm font-semibold text-success">
                  <CheckCircle2 size={16} aria-hidden="true" /> Library unlocked on this device
                </p>
              )}
            </motion.div>
          </div>
        </section>

        <section className="px-6 py-14 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="-mx-6 overflow-x-auto px-6 lg:mx-0 lg:px-0">
                <div className="flex gap-2" role="group" aria-label="Filter by type">
                  <button type="button" aria-pressed={kind === 'all'} onClick={() => setKind('all')} className={chipClass(kind === 'all')}>
                    All ({resources.length})
                  </button>
                  {kinds.map((k) => (
                    <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className={chipClass(kind === k)}>
                      {KIND_PLURAL[k]} ({counts.get(k)})
                    </button>
                  ))}
                </div>
              </div>
              <div className="w-full lg:max-w-xs">
                <Input
                  type="search"
                  aria-label="Search resources"
                  placeholder="Search resources"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            </div>

            <p className="sr-only" aria-live="polite">
              {visible.length} {visible.length === 1 ? 'resource' : 'resources'} shown
            </p>

            {resources.length === 0 ? (
              <div className="mt-16 text-center">
                <h2 className="text-xl font-semibold text-text-primary">Resources are on the way</h2>
                <p className="mx-auto mt-2 max-w-md text-sm text-text-secondary">
                  We're preparing the first calculators and templates. Check back soon.
                </p>
              </div>
            ) : visible.length === 0 ? (
              <div className="mt-16 text-center">
                <h2 className="text-xl font-semibold text-text-primary">Nothing matches your search</h2>
                <p className="mx-auto mt-2 max-w-md text-sm text-text-secondary">Try a different word or clear the filters.</p>
                {isFiltering && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-5"
                    onClick={() => {
                      setKind('all');
                      setQuery('');
                    }}
                  >
                    <X size={14} aria-hidden="true" /> Clear filters
                  </Button>
                )}
              </div>
            ) : (
              <motion.ul
                variants={staggerContainer}
                initial="initial"
                whileInView="whileInView"
                viewport={viewport}
                className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
              >
                {visible.map((r) => {
                  const Icon = KIND_ICON[r.kind];
                  return (
                    <motion.li key={r.slug} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                      <Link to={resourcePath(r.slug)} className="focus-ring group block h-full rounded-2xl">
                        <Card className="flex h-full flex-col">
                          <div className="flex items-center justify-between">
                            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
                              <Icon size={20} aria-hidden="true" />
                            </span>
                            <span className="rounded-full bg-bg-tertiary px-3 py-1 text-xs font-semibold text-text-secondary">
                              {KIND_LABEL[r.kind]}
                            </span>
                          </div>
                          <h2 className="mt-5 text-lg font-bold text-text-primary">{r.title}</h2>
                          <p className="mt-2 flex-1 text-sm leading-relaxed text-text-secondary">{r.summary}</p>
                          <div className="mt-5 flex items-center justify-between text-sm font-semibold">
                            <span className="inline-flex items-center gap-1.5 text-text-secondary">
                              {unlocked ? (
                                <>
                                  <CheckCircle2 size={14} className="text-success" aria-hidden="true" /> Unlocked
                                </>
                              ) : (
                                <>
                                  <Lock size={14} aria-hidden="true" /> Free · email required
                                </>
                              )}
                            </span>
                            <span className="inline-flex items-center gap-1 text-accent transition-transform group-hover:translate-x-0.5">
                              Open <ArrowRight size={14} aria-hidden="true" />
                            </span>
                          </div>
                        </Card>
                      </Link>
                    </motion.li>
                  );
                })}
              </motion.ul>
            )}
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
