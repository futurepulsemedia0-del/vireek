import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { buildBreadcrumbJsonLd, buildBreadcrumbs, collapseCrumbs, isPublicPath, type Crumb } from '@/lib/nav/routeMeta';

interface Props {
  /** href -> entity name, e.g. { '/dashboard/customers/<id>': 'Acme Plumbing' } */
  entityLabels?: Readonly<Record<string, string>>;
  skipHrefs?: readonly string[];
  className?: string;
}

const Sep = () => <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text-secondary rtl:rotate-180" />;

export function Breadcrumbs({ entityLabels, skipHrefs, className = '' }: Props) {
  const { pathname } = useLocation();
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const crumbs = useMemo(() => buildBreadcrumbs(pathname, { entityLabels, skipHrefs }), [pathname, entityLabels, skipHrefs]);
  const label = (c: Crumb) => (c.dynamic ? c.fallback : t(c.labelKey, { defaultValue: c.fallback }));

  const jsonLd = useMemo(() => {
    if (!isPublicPath(pathname) || typeof window === 'undefined') return null;
    return buildBreadcrumbJsonLd(
      crumbs.map((c) => ({ name: c.dynamic ? c.fallback : t(c.labelKey, { defaultValue: c.fallback }), href: c.href })),
      window.location.origin,
    );
  }, [crumbs, pathname, t]);

  if (crumbs.length < 2) return null;

  const item = (c: Crumb) =>
    c.current ? (
      <span aria-current="page" title={label(c)} className="block max-w-[14rem] truncate font-medium text-text-primary">
        {label(c)}
      </span>
    ) : (
      <Link to={c.href} title={label(c)} className="focus-ring block max-w-[10rem] truncate rounded text-text-secondary hover:text-accent">
        {label(c)}
      </Link>
    );

  const renderList = (list: ReturnType<typeof collapseCrumbs>, cls: string) => (
    <ol className={`items-center gap-1.5 text-sm ${cls}`}>
      {list.map((c, i) =>
        'ellipsis' in c ? (
          <li key="ellipsis" className="flex items-center gap-1.5">
            {i > 0 && <Sep />}
            {expanded ? (
              <ol className="flex items-center gap-1.5">
                {c.hidden.map((h) => (
                  <li key={h.href} className="flex items-center gap-1.5">
                    {item(h)}
                    <Sep />
                  </li>
                ))}
              </ol>
            ) : (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                aria-label={t('navflow.showHiddenCrumbs', { defaultValue: 'Show hidden pages in the path' })}
                className="focus-ring rounded p-1 text-text-secondary hover:text-accent"
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </li>
        ) : (
          <li key={c.href} className="flex min-w-0 items-center gap-1.5">
            {i > 0 && <Sep />}
            {item(c)}
          </li>
        ),
      )}
    </ol>
  );

  return (
    <nav aria-label={t('navflow.breadcrumb', { defaultValue: 'Breadcrumb' })} className={className}>
      {renderList(crumbs, 'hidden sm:flex')}
      {renderList(collapseCrumbs(crumbs, 3), 'flex sm:hidden')}
      {jsonLd && (
        <script
          type="application/ld+json"
          // `<` escaped so entity names can never close the script tag.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
        />
      )}
    </nav>
  );
}
