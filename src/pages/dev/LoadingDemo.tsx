import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import {
  BackgroundTask,
  BlockingOverlay,
  BrandDot,
  BrandLoader,
  CardSkeleton,
  ChartSkeleton,
  FormSkeleton,
  KpiSkeleton,
  ListRowSkeleton,
  LoadingBoundary,
  Progress,
  PullToRefresh,
  PulseMark,
  RouteFallback,
  type RouteFallbackVariant,
  Spinner,
  TableSkeleton,
  TopProgressBar,
  TranscriptSkeleton,
  useLoading,
} from '@/components/loading';

/** Dev-only (/dev/loading): every Vireek Pulse state in one place. */
type BoundaryMode = 'loading' | 'content' | 'empty' | 'error' | 'slow' | 'timeout';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
      {children}
    </section>
  );
}

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

export default function LoadingDemo() {
  const [route, setRoute] = useState<RouteFallbackVariant | null>(null);
  const [overlay, setOverlay] = useState(false);
  const [overlayPct, setOverlayPct] = useState<number | null>(null);
  const [bg, setBg] = useState(false);
  const [pct, setPct] = useState(0);
  const [mode, setMode] = useState<BoundaryMode>('loading');
  const [refreshes, setRefreshes] = useState(0);
  const btn = useLoading();

  useEffect(() => {
    if (!route) return;
    const id = window.setTimeout(() => setRoute(null), 3500);
    return () => window.clearTimeout(id);
  }, [route]);

  useEffect(() => {
    if (!overlay) return;
    setOverlayPct(0);
    let p = 0;
    const id = window.setInterval(() => {
      p += 20;
      setOverlayPct(p);
      if (p >= 100) {
        window.clearInterval(id);
        window.setTimeout(() => setOverlay(false), 300);
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [overlay]);

  const isLoading = mode === 'loading' || mode === 'slow' || mode === 'timeout';
  const slowMs = mode === 'slow' ? 1500 : 8000;
  const timeoutMs = mode === 'timeout' ? 3000 : 30000;

  return (
    <PullToRefresh onRefresh={async () => { await wait(800); setRefreshes((n) => n + 1); }}>
      <main className="mx-auto max-w-4xl space-y-10 p-6" data-testid="loading-demo">
        <h1 className="text-2xl font-bold text-text-primary">Vireek Pulse — loading states</h1>

        <Section title="Marks & spinners">
          <div className="flex flex-wrap items-center gap-6 text-accent">
            <PulseMark size="xs" /><PulseMark size="sm" /><PulseMark size="md" /><PulseMark size="lg" />
            <Spinner size={14} /><Spinner size={20} label="Saving" />
          </div>
          <p className="text-sm text-text-secondary">Pull down on a touch device to try pull-to-refresh (refreshed {refreshes}×).</p>
        </Section>
        <Section title="Brand loaders">
          <div className="flex flex-wrap items-end gap-8">
            {(['thread', 'fill', 'signal', 'network', 'pulse'] as const).map((v) => (
              <figure key={v} className="flex flex-col items-center gap-2">
                <BrandLoader variant={v} size="lg" />
                <figcaption className="text-xs text-text-secondary">{v}</figcaption>
              </figure>
            ))}
            <figure className="flex flex-col items-center gap-2">
              <BrandLoader variant="fill" size="lg" progress={65} />
              <figcaption className="text-xs text-text-secondary">fill · 65%</figcaption>
            </figure>
            <figure className="flex flex-col items-center gap-2">
              <div className="flex items-end gap-3">
                <BrandDot size={16} /><BrandDot size={24} /><BrandDot size={32} />
              </div>
              <figcaption className="text-xs text-text-secondary">dot · under 32px</figcaption>
            </figure>
          </div>
        </Section>
        <Section title="Route transition">
          <TopProgressBar progress={0.55} />
          <div className="flex flex-wrap gap-3">
            {(['marketing', 'app', 'portal', 'data'] as const).map((v) => (
              <Button key={v} variant="secondary" onClick={() => setRoute(v)}>Preview route fallback · {v} (3.5s)</Button>
            ))}
          </div>
          {route && <div className="fixed inset-0 z-[2147482500]"><RouteFallback variant={route} fullScreen /></div>}
        </Section>

        <Section title="Button loading (keeps width)">
          <div className="flex gap-3">
            <Button loading={btn.isLoading} onClick={() => void btn.run(() => wait(1500))}>Save changes</Button>
            <Button variant="secondary" loading loadingLabel="Saving">Always loading</Button>
          </div>
        </Section>

        <Section title="Progress">
          <Progress label="Determinate (real value)" value={pct} showValue />
          <input aria-label="Progress value" type="range" min={0} max={100} value={pct} onChange={(e) => setPct(Number(e.target.value))} />
          <Progress label="Indeterminate" />
        </Section>

        <Section title="Overlay">
          <div className="flex gap-3">
            <Button onClick={() => setOverlay(true)}>Blocking overlay (3s)</Button>
            <Button variant="secondary" onClick={() => { setBg(true); window.setTimeout(() => setBg(false), 4000); }}>Background task (4s)</Button>
          </div>
          <BlockingOverlay open={overlay} label="Processing payment…" progress={overlayPct} />
          <BackgroundTask open={bg} label="Exporting invoices…" />
        </Section>

        <Section title="LoadingBoundary">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Boundary state">
            {(['loading', 'slow', 'timeout', 'error', 'empty', 'content'] as const).map((m) => (
              <Button key={m} size="sm" variant={mode === m ? 'primary' : 'secondary'} onClick={() => setMode(m)}>{m}</Button>
            ))}
          </div>
          <LoadingBoundary
            isLoading={isLoading}
            error={mode === 'error' ? new Error('demo') : undefined}
            isEmpty={mode === 'empty'}
            empty={<p className="rounded-2xl border border-border p-6 text-center text-text-secondary">Nothing here yet.</p>}
            onRetry={() => setMode('loading')}
            skeleton={<ListRowSkeleton count={3} />}
            slowAfterMs={slowMs}
            timeoutMs={timeoutMs}
            label="Loading demo list"
          >
            <ul className="divide-y divide-border rounded-2xl border border-border bg-bg-secondary" data-testid="demo-content">
              {[0, 1, 2].map((i) => (
                <li key={i} className="flex h-[60px] items-center px-4 text-text-primary">Row {i + 1}</li>
              ))}
            </ul>
          </LoadingBoundary>
        </Section>

        <Section title="Skeletons">
          <div className="grid gap-4 sm:grid-cols-3"><KpiSkeleton /><KpiSkeleton /><KpiSkeleton /></div>
          <ChartSkeleton />
          <TableSkeleton />
          <CardSkeleton />
          <FormSkeleton />
          <TranscriptSkeleton />
        </Section>
      </main>
    </PullToRefresh>
  );
}
