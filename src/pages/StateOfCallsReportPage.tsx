/**
 * State of Home Service Calls — public report page (/state-of-home-service-calls).
 * Renders ONLY a published edition document (or the labelled synthetic sample). No cross-tenant query lives here.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSEO } from '@/lib/seo';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { REPORT_PATH, embedSnippet, formatValue, isRealEdition, loadEdition, publicUrl, type EditionDocument, type PublishedCell } from '@/lib/stateOfCalls';
import { buildReportPdf } from '@/lib/stateOfCallsPdf';
import { renderSocialCardSvg } from '../../supabase/functions/_shared/state-of-calls/chart';

const DIM_LABEL: Record<string, string> = { national: 'All', trade: 'Trade', region: 'US Census region', season: 'Season', language: 'Language' };

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function svgToPng(svg: string): Promise<Blob> {
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('render failed')); img.src = url; });
  const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 630;
  canvas.getContext('2d')!.drawImage(img, 0, 0, 1200, 630);
  URL.revokeObjectURL(url);
  return await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('png failed'))), 'image/png'));
}

export function StateOfCallsReportPage() {
  const [doc, setDoc] = useState<EditionDocument | null>(null);
  const [error, setError] = useState(false);
  const [metric, setMetric] = useState('missed_call_rate');
  const [dim, setDim] = useState('trade');
  const [copied, setCopied] = useState(false);

  useEffect(() => { loadEdition().then(setDoc).catch(() => setError(true)); }, []);
  useSEO({
    title: doc && !doc.synthetic ? `${doc.title} | Vireek` : 'State of Home Service Calls | Vireek',
    description: 'Anonymized, opt-in statistics on how home service businesses handle inbound calls: answer rate, missed calls, after-hours demand and more.',
    canonical: `https://vireek.com${REPORT_PATH}`,
  });

  const metricDef = doc?.metrics.find((m) => m.key === metric);
  const dims = useMemo(() => {
    if (!doc) return [] as string[];
    return [...new Set(doc.cells.filter((c) => c.metric_key === metric).map((c) => c.dim))];
  }, [doc, metric]);
  const activeDim = dims.includes(dim) ? dim : dims[0] ?? 'national';
  const rows: PublishedCell[] = useMemo(() => (doc ? doc.cells.filter((c) => c.metric_key === metric && c.dim === activeDim && c.period_key === doc.period_key) : []), [doc, metric, activeDim]);

  if (error) return <main className="p-8">The report could not be loaded. Please try again later.</main>;
  if (!doc) return <main className="p-8" aria-busy="true">Loading report…</main>;
  const real = isRealEdition(doc);
  const max = Math.max(1, ...rows.map((r) => r.value ?? 0));
  const headline = doc.cells.filter((c) => c.dim === 'national' && !c.suppressed && ['answer_rate', 'missed_call_rate', 'after_hours_share', 'emergency_share'].includes(c.metric_key));
  const snippet = embedSnippet(real ? doc.slug : 'latest', metric, activeDim, `${metricDef?.label ?? metric} by ${DIM_LABEL[activeDim]?.toLowerCase()}`);

  return (
    <>
      <Header />
      <main id="main" className="mx-auto max-w-4xl px-4 py-10">
        {doc.synthetic && <div role="alert" className="mb-6 rounded-lg border-2 border-red-600 bg-red-50 p-4 text-sm font-semibold text-red-800">{doc.notice}</div>}
        <h1 className="text-3xl font-bold text-text-primary">{doc.title}</h1>
        <p className="mt-2 text-sm text-text-secondary">Period {doc.period_start} to {doc.period_end} · data as of {doc.as_of.slice(0, 10)} · method v{doc.method_version} · integrity hash {doc.cells_hash.slice(0, 12)}</p>
        <p className="mt-3 text-sm text-text-secondary">Built from anonymized statistics contributed by Vireek customers who opted in. Every figure reflects at least {doc.thresholds.k_min} businesses; smaller groups are withheld.</p>

        {doc.mode === 'methodology_preview' && (
          <section className="mt-8 rounded-lg border border-border p-5"><h2 className="text-xl font-semibold">Methodology preview</h2>
            {doc.narrative.sections.flatMap((s) => s.statements).map((st) => <p key={st.id} className="mt-2">{st.text}</p>)}
            <ul className="mt-2 list-disc pl-5 text-sm">{doc.preview_reasons.map((r) => <li key={r}>{r}</li>)}</ul></section>
        )}

        {doc.mode === 'report' && (
          <>
            <section aria-labelledby="hl" className="mt-8"><h2 id="hl" className="text-xl font-semibold">Headline figures</h2>
              <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">{headline.map((c) => (
                <div key={c.metric_key} className="rounded-lg border border-border p-3"><dt className="text-xs text-text-secondary">{doc.metrics.find((m) => m.key === c.metric_key)?.label}</dt><dd className="text-2xl font-bold">{formatValue(c)}</dd></div>))}</dl></section>

            <section aria-labelledby="exp" className="mt-10"><h2 id="exp" className="text-xl font-semibold">Explore</h2>
              <div className="mt-3 flex flex-wrap gap-3">
                <label className="text-sm">Metric <select className="ml-1 rounded border border-border bg-bg-primary p-1" value={metric} onChange={(e) => setMetric(e.target.value)}>{doc.metrics.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select></label>
                <label className="text-sm">Break down by <select className="ml-1 rounded border border-border bg-bg-primary p-1" value={activeDim} onChange={(e) => setDim(e.target.value)}>{dims.map((d) => <option key={d} value={d}>{DIM_LABEL[d] ?? d}</option>)}</select></label>
              </div>
              <p className="mt-2 text-sm text-text-secondary">{metricDef?.definition}</p>
              <ul className="mt-3 space-y-2" aria-label={`${metricDef?.label} by ${DIM_LABEL[activeDim]}`}>{rows.map((r) => (
                <li key={`${r.dim}-${r.dim_value}`} className="flex items-center gap-3 text-sm"><span className="w-32 shrink-0 capitalize">{r.dim_value.replace(/[-_]/g, ' ')}</span>
                  {r.suppressed ? <span className="text-text-secondary">Withheld — too few businesses to publish safely</span> : <>
                    <span aria-hidden="true" className="h-4 rounded bg-blue-700" style={{ width: `${Math.max(2, ((r.value ?? 0) / max) * 60)}%` }} />
                    <span className="font-semibold">{formatValue(r)}</span><span className="text-xs text-text-secondary">~{r.n_orgs} businesses</span></>}</li>))}</ul>
              <details className="mt-3"><summary className="cursor-pointer text-sm">Data table</summary>
                <table className="mt-2 w-full text-left text-sm"><thead><tr><th scope="col">Group</th><th scope="col">Value</th><th scope="col">Middle half</th><th scope="col">Businesses</th><th scope="col">{metricDef?.event_label}</th></tr></thead>
                  <tbody>{rows.map((r) => <tr key={r.dim_value}><th scope="row" className="font-normal capitalize">{r.dim_value.replace(/[-_]/g, ' ')}</th><td>{r.suppressed ? 'Withheld' : formatValue(r)}</td><td>{r.suppressed || r.p25 === null ? '—' : `${r.p25}–${r.p75}`}</td><td>{r.n_orgs ?? '—'}</td><td>{r.n_events ?? '—'}</td></tr>)}</tbody></table></details>
              <div className="mt-4 flex flex-wrap gap-3 text-sm">
                {real && <a className="rounded border border-border px-3 py-1.5" href={publicUrl(doc.slug, 'csv')}>Download CSV of aggregates</a>}
                <button className="rounded border border-border px-3 py-1.5" onClick={() => void buildReportPdf(doc).then((b) => download(b, `vireek-${doc.slug}.pdf`))}>Download PDF edition</button>
              </div>
              {real && <div className="mt-4"><label className="text-sm font-medium" htmlFor="embed">Embed this chart (attribution included)</label>
                <textarea id="embed" readOnly rows={3} className="mt-1 w-full rounded border border-border bg-bg-secondary p-2 font-mono text-xs" value={snippet} onFocus={(e) => e.currentTarget.select()} />
                <button className="mt-1 text-sm underline" onClick={() => void navigator.clipboard.writeText(snippet).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy embed code'}</button></div>}
            </section>

            {doc.narrative.sections.map((s) => <section key={s.id} className="mt-10"><h2 className="text-xl font-semibold">{s.title}</h2>{s.statements.map((st) => <p key={st.id} className="mt-2">{st.text}</p>)}</section>)}

            <section aria-labelledby="pk" className="mt-10"><h2 id="pk" className="text-xl font-semibold">Press kit</h2>
              <p className="mt-2 text-sm text-text-secondary">Cite as “{doc.title}, Vireek, {doc.period_start.slice(0, 4)}”. Use figures exactly as published, with the period and the contributing-businesses caveat. Press contact: <a className="underline" href="/press">/press</a>.</p>
              <div className="mt-3 flex flex-wrap gap-3 text-sm">{headline.slice(0, 4).map((c) => {
                const label = doc.metrics.find((m) => m.key === c.metric_key)?.label ?? c.metric_key;
                return <button key={c.metric_key} className="rounded border border-border px-3 py-1.5" onClick={() => void svgToPng(renderSocialCardSvg({ headline: label, value: formatValue(c), caption: `across ~${c.n_orgs} contributing businesses`, edition: doc.title, url: 'vireek.com/state-of-home-service-calls', synthetic: doc.synthetic })).then((b) => download(b, `social-${c.metric_key}.png`))}>Social card: {label}</button>; })}</div>
            </section>
          </>
        )}

        <section aria-labelledby="meth" className="mt-10"><h2 id="meth" className="text-xl font-semibold">Methodology</h2>
          <ul className="mt-2 list-disc pl-5 text-sm">{doc.metrics.map((m) => <li key={m.key}><strong>{m.label}:</strong> {m.definition}</li>)}</ul>
          <h3 className="mt-4 font-semibold">Exclusions</h3><ul className="list-disc pl-5 text-sm">{doc.exclusions.map((x) => <li key={x}>{x}</li>)}</ul>
          <h3 className="mt-4 font-semibold">Limitations</h3><ul className="list-disc pl-5 text-sm">{doc.limitations.map((x) => <li key={x}>{x}</li>)}</ul>
          <p className="mt-4 text-sm text-text-secondary">Privacy: figures use statistical disclosure control (minimum businesses per figure, dominance and volume limits, rounding, no finer geography than four US regions). This is practical anonymization, not a formal differential-privacy guarantee.</p></section>
      </main>
      <Footer />
    </>
  );
}
