import { useMemo, useState } from 'react';
import { BRAND_COLORS, VIZ_MARKERS, VIZ_PATTERNS } from '@/styles/tokens.generated';
import { contrast, hexToRgb, simulate, rgbCss, type Vision } from '@/lib/colorMath';

/**
 * /dev/colors — developer-only colour lab (registered only when import.meta.env.DEV).
 * Swatches, pairings with LIVE computed ratios, colour-blind simulation, light/dark side by side.
 * Values come from the generated token file, i.e. exactly what CI verifies.
 */
type ThemeKey = 'light' | 'dark';
const FAMILIES = ['accent', 'cta', 'success', 'danger', 'warning', 'info'] as const;
const VISIONS: Vision[] = ['normal', 'protanopia', 'deuteranopia', 'tritanopia', 'grayscale'];

interface Pair { fg: string; bg: string; min: number; use: string }
const PAIRS: Pair[] = [
  { fg: 'text-primary', bg: 'bg-primary', min: 7, use: 'Body text (AAA)' },
  { fg: 'text-secondary', bg: 'bg-tertiary', min: 4.5, use: 'Secondary text on the darkest surface' },
  { fg: 'text-muted', bg: 'bg-tertiary', min: 4.5, use: 'Muted text' },
  { fg: 'border-strong', bg: 'bg-secondary', min: 3, use: 'Control border (1.4.11)' },
  ...FAMILIES.flatMap((f): Pair[] => [
    { fg: `on-${f}`, bg: `${f}-fill`, min: 4.5, use: `Text on ${f} fill` },
    { fg: `${f}-text`, bg: 'bg-tertiary', min: 4.5, use: `${f} text` },
    { fg: `${f}-strong`, bg: `${f}-subtle`, min: 7, use: `${f} on its tint` },
    { fg: `${f}-graphic`, bg: 'bg-tertiary', min: 3, use: `${f} icon / graphic` },
  ]),
];

function Panel({ theme }: { theme: ThemeKey }) {
  const T = BRAND_COLORS[theme] as Record<string, string>;
  const rows = useMemo(() => PAIRS.map((p) => ({ ...p, ratio: contrast(hexToRgb(T[p.fg]), hexToRgb(T[p.bg])) })), [T]);
  const viz = [...Array(8)].map((_, i) => T[`viz-${i + 1}`]);
  return (
    <section className={`${theme === 'dark' ? 'dark' : ''} rounded-2xl border border-border-strong bg-bg-primary p-5 text-text-primary`} aria-label={`${theme} theme`}>
      <h2 className="text-lg font-bold">{theme === 'dark' ? 'Dark' : 'Light'}</h2>
      <h3 className="mt-5 text-sm font-semibold text-text-secondary">Pairings (live ratios)</h3>
      <table className="mt-2 w-full text-left text-xs">
        <thead><tr className="text-text-secondary"><th className="py-1 pr-2">Sample</th><th className="pr-2">Pair</th><th className="pr-2">Ratio</th><th>Min</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.fg}/${r.bg}`} className="border-t border-border">
              <td className="py-1 pr-2"><span className="rounded px-2 py-0.5 font-semibold" style={{ color: T[r.fg], backgroundColor: T[r.bg] }}>Aa</span></td>
              <td className="pr-2 font-mono">{r.fg} / {r.bg}</td>
              <td className={`pr-2 font-mono ${r.ratio >= r.min ? 'text-success' : 'text-danger'}`}>{r.ratio.toFixed(2)} {r.ratio >= r.min ? '✓' : '✗ FAIL'}</td>
              <td className="font-mono">{r.min}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 className="mt-6 text-sm font-semibold text-text-secondary">Data-viz under colour-vision deficiency</h3>
      {VISIONS.map((v) => (
        <div key={v} className="mt-2 flex items-center gap-2">
          <span className="w-24 text-xs text-text-secondary">{v}</span>
          {viz.map((hex, i) => (
            <span key={hex} className="flex h-8 w-8 items-center justify-center rounded text-[10px] font-bold text-static-white" style={{ backgroundColor: rgbCss(simulate(hexToRgb(hex), v)) }} title={`${hex} · ${VIZ_PATTERNS[i]} · ${VIZ_MARKERS[i]}`}>{i + 1}</span>
          ))}
        </div>
      ))}
      <p className="mt-2 text-xs text-text-secondary">Colour alone never carries meaning: each series also has a pattern ({VIZ_PATTERNS.join(', ')}), a marker and a direct label.</p>
      <h3 className="mt-6 text-sm font-semibold text-text-secondary">Sequential / diverging</h3>
      <div className="mt-2 flex">{[...Array(9)].map((_, i) => <span key={i} className="h-6 flex-1" style={{ backgroundColor: T[`viz-seq-${i + 1}`] }} />)}</div>
      <div className="mt-2 flex">{[...Array(9)].map((_, i) => <span key={i} className="h-6 flex-1" style={{ backgroundColor: T[`viz-div-${i + 1}`] }} />)}</div>
    </section>
  );
}

export function DevColorsPage() {
  const [only, setOnly] = useState<'both' | ThemeKey>('both');
  return (
    <main className="min-h-screen bg-bg-primary p-6 text-text-primary">
      <meta name="robots" content="noindex" />
      <h1 className="text-2xl font-bold">/dev/colors</h1>
      <p className="mt-1 text-sm text-text-secondary">Generated from scripts/color/palette.mjs. CI fails any pair below its minimum.</p>
      <div className="mt-4 flex gap-2" role="group" aria-label="Theme filter">
        {(['both', 'light', 'dark'] as const).map((k) => (
          <button key={k} type="button" aria-pressed={only === k} onClick={() => setOnly(k)} className={`focus-ring rounded-lg border px-3 py-1.5 text-sm ${only === k ? 'border-accent bg-accent text-on-accent' : 'border-border-strong text-text-primary'}`}>{k}</button>
        ))}
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {only !== 'dark' && <Panel theme="light" />}
        {only !== 'light' && <Panel theme="dark" />}
      </div>
    </main>
  );
}
