// Recreated: verify against original intent (recovered verbatim from homepage-redesign.patch)
import { Link } from 'react-router-dom';
import { INTEGRATION_GROUPS, TRADES } from '@/lib/homeContent';
import { container, eyebrow, textLink } from './sectionStyles';

/** Text marks only: no third-party logos are used, so no trademark or licensing question arises. */
export function IntegrationsStrip() {
  return (
    <section aria-labelledby="integrations-heading" className="border-y border-border bg-bg-secondary/50 py-10">
      <div className={container}>
        <h2 id="integrations-heading" className={eyebrow}>
          Works with the tools and trades you already have
        </h2>
        <div className="mt-6 grid gap-8 md:grid-cols-3">
          {INTEGRATION_GROUPS.map((group) => (
            <div key={group.heading}>
              <h3 className="text-sm font-semibold text-text-primary">{group.heading}</h3>
              <p className="mt-0.5 text-xs text-text-secondary">{group.note}</p>
              <ul className="mt-3 flex flex-wrap gap-2">
                {group.names.map((n) => (
                  <li key={n} className="rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm font-semibold text-text-primary">
                    {n}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Trades</h3>
            <p className="mt-0.5 text-xs text-text-secondary">Built for the vocabulary of each</p>
            <ul className="mt-3 flex flex-wrap gap-2">
              {TRADES.map((t) => (
                <li key={t} className="rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm font-semibold text-text-primary">
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-x-6">
          <Link to="/integrations" className={textLink}>All integrations</Link>
          <Link to="/industries" className={textLink}>All industries</Link>
        </div>
      </div>
    </section>
  );
}
