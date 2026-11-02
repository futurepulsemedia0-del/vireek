import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, ExternalLink, Pencil } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { API_VERSIONS, DOCS_PAGES, editOnGithubUrl, pagerFor } from '@/lib/docsIndex';
import { DocsSearch } from '@/components/developers/DocsSearch';

/** Top bar: search, version selector, changelog and status links, edit-on-GitHub (only when the repo URL is configured). */
export function DocsHeaderBar({ sourceFile }: { sourceFile: string }) {
  const edit = editOnGithubUrl(
    import.meta.env.VITE_DOCS_REPO_URL as string | undefined,
    sourceFile,
  );
  return (
    <div className="border-b border-border bg-bg-primary px-6 py-3">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
        <DocsSearch />
        <label className="flex items-center gap-2 text-xs text-text-secondary">
          <span>API version</span>
          <select
            aria-label="API version"
            className="focus-ring rounded-lg border border-border bg-bg-secondary px-2 py-1.5 text-xs text-text-primary"
            defaultValue={API_VERSIONS[0].version}
          >
            {API_VERSIONS.map((v) => (
              <option key={v.version} value={v.version}>
                {v.label} ({v.status})
              </option>
            ))}
          </select>
        </label>
        <nav
          aria-label="Developer resources"
          className="ml-auto flex flex-wrap items-center gap-4 text-xs font-medium"
        >
          <Link
            to="/developers/changelog"
            className="focus-ring rounded text-text-secondary hover:text-text-primary"
          >
            Changelog
          </Link>
          <Link
            to="/status"
            className="focus-ring rounded text-text-secondary hover:text-text-primary"
          >
            Status
          </Link>
          {edit && (
            <a
              href={edit}
              target="_blank"
              rel="noopener noreferrer"
              className="focus-ring inline-flex items-center gap-1 rounded text-text-secondary hover:text-text-primary"
            >
              <Pencil size={12} aria-hidden="true" /> Edit on GitHub{' '}
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          )}
        </nav>
      </div>
    </div>
  );
}

/** Three-column docs layout: page nav (left), content, "On this page" (right, wide screens). */
export function DocsLayout({
  toc,
  children,
}: {
  toc: { id: string; label: string }[];
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  return (
    <div className="mx-auto grid max-w-[88rem] gap-0 lg:grid-cols-[14rem_minmax(0,1fr)] xl:grid-cols-[14rem_minmax(0,1fr)_13rem]">
      <nav
        aria-label="Developer docs"
        className="sticky top-24 hidden self-start px-6 py-10 lg:block"
      >
        <ul className="space-y-1 text-sm">
          {DOCS_PAGES.map((p) => (
            <li key={p.path}>
              <Link
                to={p.path}
                aria-current={pathname === p.path ? 'page' : undefined}
                className={`focus-ring block rounded-lg px-3 py-1.5 ${pathname === p.path ? 'bg-accent/10 font-semibold text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
              >
                {p.title}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0">{children}</div>
      <nav
        aria-label="On this page"
        className="sticky top-24 hidden self-start px-6 py-10 xl:block"
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          On this page
        </p>
        <ul className="mt-3 space-y-1.5 text-sm">
          {toc.map((t) => (
            <li key={t.id}>
              <a
                href={`#${t.id}`}
                className="focus-ring rounded text-text-secondary hover:text-text-primary"
              >
                {t.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

export function DocsPager() {
  const { pathname } = useLocation();
  const { prev, next } = pagerFor(pathname);
  if (!prev && !next) return null;
  return (
    <nav
      aria-label="Previous and next page"
      className="mx-auto mt-10 flex max-w-6xl justify-between gap-4 px-6 pb-10"
    >
      {prev ? (
        <Link
          to={prev.path}
          rel="prev"
          className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border px-4 py-3 text-sm font-medium text-text-primary hover:border-accent/40"
        >
          <ArrowLeft size={14} aria-hidden="true" /> {prev.title}
        </Link>
      ) : (
        <span />
      )}
      {next && (
        <Link
          to={next.path}
          rel="next"
          className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border px-4 py-3 text-sm font-medium text-text-primary hover:border-accent/40"
        >
          {next.title} <ArrowRight size={14} aria-hidden="true" />
        </Link>
      )}
    </nav>
  );
}

/** "Was this helpful?" — one answer per page per browser; stored in docs_feedback (insert-only for visitors). */
export function DocsFeedback({ page }: { page: string }) {
  const key = `vireek_docs_feedback:${page}`;
  const [done, setDone] = useState(() => {
    try {
      return localStorage.getItem(key) !== null;
    } catch {
      return false;
    }
  });
  const [helpful, setHelpful] = useState<boolean | null>(null);
  const [comment, setComment] = useState('');
  const [error, setError] = useState(false);
  const [sending, setSending] = useState(false);

  const send = async (value: boolean, text: string) => {
    setSending(true);
    setError(false);
    const { error: err } = await supabase
      .from('docs_feedback')
      .insert({ page, helpful: value, comment: text.trim() || null });
    setSending(false);
    if (err) return setError(true);
    try {
      localStorage.setItem(key, value ? 'yes' : 'no');
    } catch {
      /* storage blocked: the answer was still sent */
    }
    setDone(true);
  };

  return (
    <section aria-label="Feedback" className="mx-auto max-w-6xl px-6 py-8">
      <div className="rounded-2xl border border-border bg-bg-secondary p-5">
        {done ? (
          <p className="flex items-center gap-2 text-sm text-text-secondary">
            <Check size={16} aria-hidden="true" /> Thanks for the feedback.
          </p>
        ) : helpful === null ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm font-medium text-text-primary">Was this helpful?</p>
            <button
              type="button"
              onClick={() => void send(true, '')}
              className="focus-ring rounded-lg border border-border px-3 py-1.5 text-sm hover:border-accent/40"
            >
              Yes
            </button>
            <button
              type="button"
              onClick={() => setHelpful(false)}
              className="focus-ring rounded-lg border border-border px-3 py-1.5 text-sm hover:border-accent/40"
            >
              No
            </button>
          </div>
        ) : (
          <div>
            <label
              htmlFor="docs-feedback-comment"
              className="text-sm font-medium text-text-primary"
            >
              What was missing or wrong?
            </label>
            <textarea
              id="docs-feedback-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={500}
              rows={3}
              className="focus-ring mt-2 w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
            />
            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                disabled={sending}
                onClick={() => void send(false, comment)}
                className="focus-ring rounded-lg bg-cta px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
              <span className="text-xs text-text-secondary">
                Don&rsquo;t include API keys or customer data.
              </span>
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            Could not send feedback. Please try again later.
          </p>
        )}
        <p className="mt-3 text-xs text-text-secondary">
          Need help? Email{' '}
          <a className="underline" href="mailto:ali@vireek.com">
            ali@vireek.com
          </a>{' '}
          <ExternalLink size={10} className="inline" aria-hidden="true" />
        </p>
      </div>
    </section>
  );
}
