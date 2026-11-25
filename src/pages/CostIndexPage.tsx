/**
 * Vireek Cost Index — public page (/cost-index): methodology + the latest PUBLISHED release.
 * Renders only a frozen release document. If nothing is published it shows the methodology and an empty state — never sample numbers.
 */
import { useEffect, useState } from 'react';
import { useSEO } from '@/lib/seo';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { COST_INDEX_PATH, KIND_LABEL, REGION_LABEL, costIndexUrl, formatUsd, groupByTrade, loadLatestRelease, loadReleaseHistory, tradeLabel, type CostIndexDocument, type ReleaseNotice } from '@/lib/costIndex';

type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'empty' } | { kind: 'ready'; doc: CostIndexDocument & { superseded?: boolean } };

export function CostIndexPage() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [history, setHistory] = useState<ReleaseNotice[]>([]);
  const [kind, setKind] = useState<'repair' | 'install'>('repair');

  useEffect(() => {
    let live = true;
    loadLatestRelease().then((d) => live && setState(d ? { kind: 'ready', doc: d } : { kind: 'empty' })).catch(() => live && setState({ kind: 'error' }));
    loadReleaseHistory().then((h) => live && setHistory(h)).catch(() => {});
    return () => { live = false; };
  }, []);

  useSEO({
    title: 'Vireek Cost Index — home service repair and install prices | Vireek',
    description: 'Anonymized, opt-in price index for home service repairs and installs by US Census region and trade, with a full methodology.',
    canonical: `https://vireek.com${COST_INDEX_PATH}`,
  });

  const doc = state.kind === 'ready' ? state.doc : null;
  const groups = doc ? groupByTrade(doc.cells, kind) : [];

  return (
    <>
      <Header />
      <main id="main" className="mx-auto max-w-4xl px-4 py-10">
        <h1 className="text-3xl font-bold text-text-primary">Vireek Cost Index</h1>
        <p className="mt-3 text-text-secondary">
          Typical invoiced prices for completed repair and install jobs, by trade and US Census region. Built only from businesses that opted in to share anonymized statistics.
        </p>

        {state.kind === 'loading' && <p className="mt-8 text-text-secondary" role="status" aria-busy="true">Loading the latest release…</p>}
        {state.kind === 'error' && <p className="mt-8 rounded-lg border border-border p-4 text-text-primary" role="alert">The index could not be loaded. Please try again later.</p>}
        {state.kind === 'empty' && <p className="mt-8 rounded-lg border border-border p-4 text-text-primary">No release has been published yet. The methodology below is already in force.</p>}

        {doc && (
          <section className="mt-8" aria-labelledby="ci-release">
            <h2 id="ci-release" className="text-xl font-semibold text-text-primary">{doc.title}</h2>
            <p className="mt-1 text-sm text-text-secondary">
              Period {doc.period_start} to {doc.period_end} · data as of {doc.as_of.slice(0, 10)} · release {doc.release_seq} · method {doc.method_version}
            </p>
            {doc.superseded && <p className="mt-2 text-sm text-text-primary" role="note">A newer release exists for this period.</p>}

            <div role="tablist" aria-label="Job type" className="mt-4 flex gap-2">
              {(['repair', 'install'] as const).map((k) => (
                <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
                  className={`min-h-11 rounded-lg border px-4 text-sm font-medium ${kind === k ? 'border-accent bg-accent/10 text-text-primary' : 'border-border text-text-secondary'}`}>
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>

            {groups.length === 0 ? (
              <p className="mt-4 text-text-secondary">No figures met the privacy thresholds for {KIND_LABEL[kind].toLowerCase()} jobs in this release.</p>
            ) : groups.map((g) => (
              <div key={g.trade} className="mt-6 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <caption className="pb-2 text-left font-semibold text-text-primary">{tradeLabel(g.trade)} — {KIND_LABEL[kind].toLowerCase()}</caption>
                  <thead><tr className="border-b border-border text-text-secondary">
                    <th scope="col" className="py-2 pr-4">Region</th><th scope="col" className="py-2 pr-4">Typical (median)</th>
                    <th scope="col" className="py-2 pr-4">Middle half</th><th scope="col" className="py-2">Businesses</th></tr></thead>
                  <tbody>
                    {g.rows.map((r) => (
                      <tr key={r.region} className="border-b border-border">
                        <th scope="row" className="py-2 pr-4 font-medium text-text-primary">{REGION_LABEL[r.region]}</th>
                        {r.suppressed ? <td colSpan={3} className="py-2 text-text-secondary">Withheld to protect privacy</td> : (<>
                          <td className="py-2 pr-4 text-text-primary">{formatUsd(r.p50_cents)}</td>
                          <td className="py-2 pr-4 text-text-primary">{formatUsd(r.p25_cents)} – {formatUsd(r.p75_cents)}</td>
                          <td className="py-2 text-text-primary">about {r.n_orgs}</td></>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            <p className="mt-4 text-sm"><a className="text-accent underline" href={costIndexUrl(doc.slug, 'csv')}>Download this release (CSV)</a></p>
          </section>
        )}

        <section className="mt-12" aria-labelledby="ci-method">
          <h2 id="ci-method" className="text-xl font-semibold text-text-primary">Methodology</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-text-primary">
            <li><strong>Who contributes.</strong> Only businesses that explicitly opted in and have not withdrawn. Withdrawing excludes a business from every later release.</li>
            <li><strong>What is measured.</strong> The amount invoiced on completed jobs that Vireek has classified as a repair or an install. {doc?.statistic ? `Each figure is the ${doc.statistic}.` : 'Each business contributes one median per cell, so no single large job or business sets the figure.'}</li>
            <li><strong>Privacy thresholds.</strong> A figure is published only if at least {doc?.thresholds.k_min ?? 10} businesses and {doc?.thresholds.min_jobs_per_cell ?? 100} jobs stand behind it and no single business accounts for more than {Math.round((doc?.thresholds.dominance_max ?? 0.35) * 100)}% of the jobs. Otherwise it is shown as withheld, and a second figure may be withheld too so the first cannot be worked out by subtraction.</li>
            <li><strong>Rounding.</strong> {doc?.rounding ?? 'Prices are rounded to the nearest $10 below $1,000, $50 below $10,000 and $100 above. Counts are rounded.'}</li>
            <li><strong>Geography.</strong> US Census regions only; nothing finer is ever published.</li>
            <li><strong>Limits.</strong> Figures describe what participating businesses invoiced, not what any business should charge. Mix of jobs, parts and local conditions vary. This is not a formal privacy guarantee. Tax treatment of invoiced amounts: TODO(owner) confirm before first release.</li>
          </ul>
        </section>

        {history.length > 0 && (
          <section className="mt-10" aria-labelledby="ci-history">
            <h2 id="ci-history" className="text-xl font-semibold text-text-primary">Release history</h2>
            <ul className="mt-3 space-y-2 text-sm text-text-primary">
              {history.map((h) => (
                <li key={h.slug}>
                  <span className="font-medium">{h.slug}</span> — {h.status}{h.published_at ? `, published ${h.published_at.slice(0, 10)}` : ''}
                  {h.status === 'withdrawn' && h.withdrawn_reason ? `. Reason: ${h.withdrawn_reason}` : h.changelog ? `. ${h.changelog}` : ''}
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
      <Footer />
    </>
  );
}
