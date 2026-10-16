import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowRight,
  Briefcase,
  CheckCircle2,
  Clock,
  Loader2,
  MapPin,
  RefreshCw,
  TriangleAlert,
  Wallet,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useSEO } from '@/lib/seo';
import {
  EMPTY_APPLICATION,
  EMPLOYMENT_TYPE_LABELS,
  LIMITS,
  LOCATION_TYPE_LABELS,
  REFERRAL_SOURCES,
  buildJobPostingJsonLd,
  formatSalary,
  postedAgo,
  validateApplication,
  type ApplicationErrors,
  type ApplicationFormValues,
  type JobPosting,
} from '@/lib/careers';
import { fetchOpenPostingBySlug, submitApplication } from '@/lib/careersApi';

type LoadState = 'loading' | 'ready' | 'missing' | 'error';

function PostingSEO({ posting }: { posting: JobPosting }) {
  const jsonLd = useMemo(() => buildJobPostingJsonLd(posting), [posting]);
  useSEO({
    title: `${posting.title} — Careers at Vireek`,
    description: posting.summary,
    canonical: `https://vireek.com/careers/${posting.slug}`,
    jsonLd,
  });
  return null;
}

function MissingSEO() {
  useSEO({
    title: 'Position not available — Vireek Careers',
    description: 'This role is no longer open. See the current openings at Vireek.',
    canonical: 'https://vireek.com/careers',
  });
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
  return null;
}

function Fact({ icon: Icon, children }: { icon: typeof MapPin; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <Icon size={14} className="shrink-0" aria-hidden="true" />
      {children}
    </span>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item} className="flex gap-3">
          <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

// ============================================================
// APPLICATION FORM
// ============================================================

function ApplicationForm({ slug, roleTitle }: { slug: string; roleTitle: string }) {
  const [values, setValues] = useState<ApplicationFormValues>(EMPTY_APPLICATION);
  const [errors, setErrors] = useState<ApplicationErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const set = <K extends keyof ApplicationFormValues>(key: K, value: ApplicationFormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next: Record<string, unknown> = { ...prev };
      delete next[key];
      return next as ApplicationErrors;
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const found = validateApplication(values);
    setErrors(found);
    const first = Object.keys(found)[0];
    if (first) {
      document.getElementById(`apply-${first}`)?.focus();
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await submitApplication(slug, values);
      setDone(true);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div role="status" className="rounded-2xl border border-success-500/30 bg-success-500/5 p-8 text-center">
        <CheckCircle2 size={32} className="mx-auto text-success-500" aria-hidden="true" />
        <h3 className="mt-4 text-xl font-bold text-text-primary">Application received</h3>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-text-secondary">
          Thanks for applying for {roleTitle}. We read every application ourselves and will reply by email.
        </p>
        <Link to="/careers" className="mt-6 inline-block">
          <Button variant="secondary" size="sm">
            See other roles
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Input
          id="apply-fullName"
          label="Full name"
          required
          autoComplete="name"
          maxLength={LIMITS.name}
          value={values.fullName}
          onChange={(e) => set('fullName', e.target.value)}
          error={errors.fullName}
        />
        <Input
          id="apply-email"
          label="Email"
          type="email"
          required
          autoComplete="email"
          inputMode="email"
          value={values.email}
          onChange={(e) => set('email', e.target.value)}
          error={errors.email}
        />
        <Input
          id="apply-phone"
          label="Phone (optional)"
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          maxLength={LIMITS.phone}
          value={values.phone}
          onChange={(e) => set('phone', e.target.value)}
          error={errors.phone}
        />
        <Input
          id="apply-location"
          label="Where are you based? (optional)"
          autoComplete="address-level2"
          maxLength={LIMITS.location}
          value={values.location}
          onChange={(e) => set('location', e.target.value)}
          placeholder="City, country"
        />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Input
          id="apply-linkedinUrl"
          label="LinkedIn (optional)"
          type="url"
          inputMode="url"
          value={values.linkedinUrl}
          onChange={(e) => set('linkedinUrl', e.target.value)}
          error={errors.linkedinUrl}
          placeholder="https://linkedin.com/in/…"
        />
        <Input
          id="apply-portfolioUrl"
          label="Portfolio or website (optional)"
          type="url"
          inputMode="url"
          value={values.portfolioUrl}
          onChange={(e) => set('portfolioUrl', e.target.value)}
          error={errors.portfolioUrl}
          placeholder="https://"
        />
      </div>

      <Input
        id="apply-resumeUrl"
        label="Résumé link (optional)"
        type="url"
        inputMode="url"
        value={values.resumeUrl}
        onChange={(e) => set('resumeUrl', e.target.value)}
        error={errors.resumeUrl}
        placeholder="https://"
        helperText="Share a Google Drive, Dropbox or similar link that anyone with the link can view."
      />

      <div>
        <Textarea
          id="apply-coverNote"
          label="Why this role? (optional)"
          rows={5}
          maxLength={LIMITS.coverNote}
          value={values.coverNote}
          onChange={(e) => set('coverNote', e.target.value)}
          error={errors.coverNote}
          placeholder="What would you want to build or improve at Vireek?"
        />
        <p className="mt-1 text-right text-xs text-text-secondary" aria-live="off">
          {values.coverNote.length}/{LIMITS.coverNote}
        </p>
      </div>

      <div>
        <label htmlFor="apply-referralSource" className="mb-1.5 block text-sm font-medium text-text-primary">
          How did you hear about us? (optional)
        </label>
        <select
          id="apply-referralSource"
          value={values.referralSource}
          onChange={(e) => set('referralSource', e.target.value)}
          className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary"
        >
          <option value="">Select…</option>
          {REFERRAL_SOURCES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {/* Honeypot: invisible to people and screen readers, bots tend to fill it. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>
          Website
          <input
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            value={values.website}
            onChange={(e) => set('website', e.target.value)}
          />
        </label>
      </div>

      <div>
        <label className="flex items-start gap-3 text-sm text-text-secondary">
          <input
            id="apply-consent"
            type="checkbox"
            checked={values.consent}
            onChange={(e) => set('consent', e.target.checked)}
            aria-invalid={!!errors.consent}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-accent"
          />
          <span>
            I agree that Vireek may store and process my application data to evaluate my candidacy, as described in
            the{' '}
            <Link to="/privacy" target="_blank" className="font-medium text-accent hover:underline">
              Privacy Policy
            </Link>
            .
          </span>
        </label>
        {errors.consent && (
          <p role="alert" className="mt-1.5 text-xs text-danger">
            {errors.consent}
          </p>
        )}
      </div>

      {submitError && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm text-danger"
        >
          <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          {submitError}
        </p>
      )}

      <Button type="submit" size="md" disabled={submitting} className="w-full sm:w-auto">
        {submitting && <Loader2 size={16} className="animate-spin" />}
        {submitting ? 'Sending…' : 'Submit application'}
      </Button>
    </form>
  );
}

// ============================================================
// PAGE
// ============================================================

export function CareerPostingPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [posting, setPosting] = useState<JobPosting | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    if (!slug) {
      setState('missing');
      return;
    }
    const requestId = ++requestRef.current;
    setState('loading');
    setPosting(null);
    try {
      const row = await fetchOpenPostingBySlug(slug);
      if (requestId !== requestRef.current) return;
      setPosting(row);
      setState(row ? 'ready' : 'missing');
    } catch {
      if (requestId === requestRef.current) setState('error');
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const salary = posting ? formatSalary(posting) : null;
  const paragraphs = posting ? posting.description.split(/\n{2,}/).filter((p) => p.trim()) : [];

  return (
    <>
      {posting ? <PostingSEO posting={posting} /> : state === 'missing' ? <MissingSEO /> : null}
      <Header />
      <main className="min-h-screen bg-bg-primary px-6 pb-24 pt-28">
        <div className="mx-auto max-w-3xl">
          <div className="mb-8">
            <BackButton fallback="/careers" label="All roles" />
          </div>

          {state === 'loading' && (
            <div className="space-y-4" aria-busy="true" aria-label="Loading role">
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-12 w-3/4" />
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="mt-8 h-40 w-full" />
            </div>
          )}

          {state === 'error' && (
            <div
              role="alert"
              className="flex flex-col items-center gap-3 rounded-2xl border border-danger/30 bg-danger/5 px-6 py-14 text-center"
            >
              <TriangleAlert size={26} className="text-danger" aria-hidden="true" />
              <p className="text-sm font-semibold text-text-primary">We couldn't load this role</p>
              <Button variant="secondary" size="sm" onClick={() => void load()}>
                <RefreshCw size={14} /> Try again
              </Button>
            </div>
          )}

          {state === 'missing' && (
            <EmptyState
              icon={Briefcase}
              title="This role isn't open anymore"
              description="The position may have been filled or taken down. Take a look at what we're hiring for right now."
              action={{ label: 'See open roles', onClick: () => navigate('/careers') }}
            />
          )}

          {posting && (
            <article>
              <header>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/20 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">
                  <Briefcase size={12} aria-hidden="true" />
                  {posting.department}
                </span>
                <h1 className="mt-4 text-balance text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
                  {posting.title}
                </h1>
                <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-text-secondary">
                  <Fact icon={MapPin}>
                    {posting.location} · {LOCATION_TYPE_LABELS[posting.location_type]}
                  </Fact>
                  <Fact icon={Clock}>{EMPLOYMENT_TYPE_LABELS[posting.employment_type]}</Fact>
                  {salary && <Fact icon={Wallet}>{salary}</Fact>}
                </div>
                <p className="mt-2 text-xs text-text-secondary/80">
                  {postedAgo(posting.published_at ?? posting.created_at)}
                </p>
                <a href="#apply" className="mt-6 inline-block">
                  <Button size="md">
                    Apply now <ArrowRight size={16} />
                  </Button>
                </a>
              </header>

              <div className="mt-10 space-y-6 text-base leading-8 text-text-secondary">
                <p className="text-lg text-text-primary">{posting.summary}</p>
                {paragraphs.map((p, i) => (
                  <p key={i} className="whitespace-pre-line">
                    {p}
                  </p>
                ))}
                {posting.responsibilities.length > 0 && (
                  <section>
                    <h2 className="mb-3 text-xl font-bold tracking-tight text-text-primary">What you'll do</h2>
                    <BulletList items={posting.responsibilities} />
                  </section>
                )}
                {posting.requirements.length > 0 && (
                  <section>
                    <h2 className="mb-3 text-xl font-bold tracking-tight text-text-primary">What we're looking for</h2>
                    <BulletList items={posting.requirements} />
                  </section>
                )}
              </div>

              <section id="apply" className="mt-14 scroll-mt-28 rounded-2xl border border-border bg-bg-secondary p-5 sm:p-8">
                <h2 className="text-2xl font-bold tracking-tight text-text-primary">Apply for this role</h2>
                <p className="mb-6 mt-1.5 text-sm text-text-secondary">
                  No cover-letter ceremony. Tell us who you are and point us to your best work.
                </p>
                <ApplicationForm slug={posting.slug} roleTitle={posting.title} />
              </section>
            </article>
          )}
        </div>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
