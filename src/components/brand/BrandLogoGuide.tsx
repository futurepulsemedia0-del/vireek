import { Check, X } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Logo } from './Logo';
import { LogoConstruction } from './LogoConstruction';

/**
 * Logo section of /brand: primary versions, construction grid, clear space,
 * minimum sizes, color specs, and correct / incorrect usage. All artwork is
 * the same SVG paths the product renders (see logoPaths.generated.ts).
 */

const MIN_SIZES: { label: string; node: JSX.Element; digital: string; print: string }[] = [
  { label: 'Wordmark', node: <Logo variant="wordmark" size={16} tone="mono" decorative />, digital: '72 px wide', print: '18 mm' },
  { label: 'Symbol', node: <Logo variant="symbol" size={16} tone="mono" decorative />, digital: '16 px tall', print: '5 mm' },
  { label: 'App tile', node: <Logo variant="tile" size={16} decorative />, digital: '16 px', print: '5 mm' },
  { label: 'Horizontal lockup', node: <Logo variant="lockup" size={24} tone="mono" decorative />, digital: '98 px wide', print: '25 mm' },
  { label: 'Stacked lockup', node: <Logo variant="stacked" size={40} tone="mono" decorative />, digital: '45 px wide', print: '12 mm' },
];

const COLOR_SPECS: { name: string; hex: string; rgb: string; use: string }[] = [
  { name: 'Slate', hex: '#141413', rgb: '20 20 19', use: 'Letters on light backgrounds (17.5:1 on Ivory #FAF9F5); V on the app tile (5.9:1); one-color black version' },
  { name: 'Ivory', hex: '#FAF9F5', rgb: '250 249 245', use: 'Letters on dark backgrounds (17.5:1 on Slate #141413); pulse dot on the app tile; one-color white version' },
  { name: 'Clay', hex: '#D97757', rgb: '217 119 87', use: 'The pulse dot on dark backgrounds (5.9:1 on Slate) and the app tile fill. On light backgrounds the in-app dot uses the deeper token #C76747 (3.7:1)' },
  { name: 'Clay — logo dot (light, artwork files)', hex: '#D97757', rgb: '217 119 87', use: 'Static SVG artwork on Ivory (3.0:1, graphic). A logo is exempt from WCAG 1.4.11; use the in-app component where 3:1 is required' },
];

const SWATCH_TEXT = 'text-text-secondary';

const DOS: string[] = [
  'Use the provided SVG or PNG files exactly as delivered',
  'Keep clear space of at least x (half the height of the V) on every side',
  'Use full color on light, the dark-background version on dark, and one-color white or black on photos',
  'Scale proportionally; never go below the minimum sizes',
];

function Panel({ children, className = '', label }: { children: React.ReactNode; className?: string; label: string }) {
  return (
    <Card className={`flex flex-col items-center justify-center gap-5 py-14 ${className}`}>
      {children}
      <span className="text-sm font-medium opacity-70">{label}</span>
    </Card>
  );
}

function Example({ ok, caption, children, bg = 'bg-white' }: { ok: boolean; caption: string; children: React.ReactNode; bg?: string }) {
  return (
    <figure className="overflow-hidden rounded-2xl border border-border bg-bg-secondary">
      <div className={`relative flex h-36 items-center justify-center overflow-hidden ${bg}`}>
        {children}
        <span
          className={`absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full ${ok ? 'bg-success text-on-success' : 'bg-danger text-on-danger'}`}
          aria-hidden="true"
        >
          {ok ? <Check size={14} /> : <X size={14} />}
        </span>
      </div>
      <figcaption className="px-4 py-3 text-sm text-text-secondary">
        <span className="sr-only">{ok ? 'Correct: ' : 'Incorrect: '}</span>
        {caption}
      </figcaption>
    </figure>
  );
}

export function BrandLogoGuide() {
  return (
    <div className="mt-12 space-y-16">
      {/* Primary versions — fixed-color files so the panels are correct in either theme */}
      <div className="grid gap-6 sm:grid-cols-2">
        <Panel className="!bg-[#FAF9F5] text-neutral-500" label="Full color — on light backgrounds">
          <img src="/brand/vireek-wordmark-color.svg" alt="Vireek wordmark, full color" width={260} height={64} className="h-16 w-auto" />
        </Panel>
        <Panel className="!bg-[#141413] text-neutral-400" label="Dark-background version">
          <img src="/brand/vireek-wordmark-reverse.svg" alt="Vireek wordmark, dark-background version" width={260} height={64} className="h-16 w-auto" />
        </Panel>
        <Panel className="!bg-[#FAF9F5] text-neutral-500" label="Horizontal lockup">
          <img src="/brand/vireek-lockup-horizontal-color.svg" alt="Vireek horizontal lockup" width={260} height={64} className="h-14 w-auto" />
        </Panel>
        <Panel className="!bg-[#FAF9F5] text-neutral-500" label="Symbol and app tile">
          <div className="flex items-center gap-8">
            <img src="/brand/vireek-symbol-color.svg" alt="Vireek symbol" width={52} height={56} className="h-14 w-auto" />
            <img src="/brand/vireek-tile.svg" alt="Vireek app tile" width={56} height={56} className="h-14 w-14" />
          </div>
        </Panel>
      </div>

      {/* Construction + clear space */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h3 className="text-lg font-semibold text-text-primary">Construction</h3>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">
            Outlined, hand-spaced letterforms on one stroke weight. The only accent is the dot of the i:
            a circle 1.13× the stem width, centered on the stem axis with its top on the top guide. Every letter is
            original geometry (circles, stems and cuts), not a typeface. The symbol places the same dot inside the V.
          </p>
          <div className="mt-6"><LogoConstruction mode="grid" /></div>
        </Card>
        <Card>
          <h3 className="text-lg font-semibold text-text-primary">Clear space</h3>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">
            Keep an empty margin of <strong className="text-text-primary">x</strong> on every side, where
            x is half the height of the V. Nothing — text, edges, other logos — enters this zone.
          </p>
          <div className="mt-6"><LogoConstruction mode="clearspace" /></div>
        </Card>
      </div>

      {/* Minimum sizes */}
      <Card>
        <h3 className="text-lg font-semibold text-text-primary">Minimum sizes</h3>
        <p className="mt-2 text-sm leading-relaxed text-text-secondary">
          Shown here at their smallest allowed size. Below these, switch to the symbol.
        </p>
        <div className="mt-6 grid grid-cols-2 gap-6 text-text-primary sm:grid-cols-5">
          {MIN_SIZES.map((m) => (
            <div key={m.label} className="flex flex-col items-start gap-3">
              <div className="flex h-12 items-center">{m.node}</div>
              <div>
                <p className="text-sm font-semibold">{m.label}</p>
                <p className={`text-xs ${SWATCH_TEXT}`}>{m.digital} · {m.print} print</p>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Color specs */}
      <Card>
        <h3 className="text-lg font-semibold text-text-primary">Logo color specifications</h3>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wider text-text-secondary">
                <th className="py-2 pr-4 font-semibold">Color</th>
                <th className="py-2 pr-4 font-semibold">HEX</th>
                <th className="py-2 pr-4 font-semibold">RGB</th>
                <th className="py-2 font-semibold">Use &amp; contrast</th>
              </tr>
            </thead>
            <tbody>
              {COLOR_SPECS.map((c) => (
                <tr key={c.name} className="border-b border-border/60 align-top">
                  <td className="py-3 pr-4">
                    <span className="flex items-center gap-2 font-medium text-text-primary">
                      <span aria-hidden="true" className="h-4 w-4 rounded border border-border" style={{ backgroundColor: c.hex }} />
                      {c.name}
                    </span>
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs text-text-primary">{c.hex}</td>
                  <td className="py-3 pr-4 font-mono text-xs text-text-secondary">{c.rgb}</td>
                  <td className="py-3 text-text-secondary">{c.use}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-text-secondary">
          The app tile is a fixed-color asset (Clay #D97757, Slate V, Ivory dot) in both themes,
          like any app icon. The wordmark switches between Slate and Ivory letters (with the Clay dot) automatically
          when drawn with the in-app component.
        </p>
      </Card>

      {/* Correct / incorrect */}
      <div>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-success/30 bg-success/[0.04] p-6 md:p-8">
            <p className="mb-4 text-sm font-semibold uppercase tracking-[0.16em] text-success">Do</p>
            <ul className="space-y-2 text-sm leading-relaxed text-text-secondary">
              {DOS.map((d) => (<li key={d}>• {d}</li>))}
            </ul>
          </div>
          <div className="rounded-2xl border border-danger/30 bg-danger/[0.04] p-6 md:p-8">
            <p className="mb-4 text-sm font-semibold uppercase tracking-[0.16em] text-danger">Don&apos;t</p>
            <ul className="space-y-2 text-sm leading-relaxed text-text-secondary">
              <li>• Recolor, outline, add gradients, shadows or glows</li>
              <li>• Stretch, skew or rotate; move or remove the dot</li>
              <li>• Retype the name in another font or redraw the mark</li>
              <li>• Place it on low-contrast or busy backgrounds without a scrim</li>
            </ul>
          </div>
        </div>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Example ok caption="Full color on a light surface.">
            <img src="/brand/vireek-wordmark-color.svg" alt="" aria-hidden="true" className="h-10 w-auto" />
          </Example>
          <Example ok caption="Dark-background version on dark." bg="bg-[#141413]">
            <img src="/brand/vireek-wordmark-reverse.svg" alt="" aria-hidden="true" className="h-10 w-auto" />
          </Example>
          <Example ok caption="One-color white on a photo with a dark scrim." bg="bg-gradient-to-br from-slate-700 to-slate-900">
            <img src="/brand/vireek-wordmark-white.svg" alt="" aria-hidden="true" className="h-10 w-auto" />
          </Example>
          <Example ok caption="Symbol when space is tight (avatars, tabs).">
            <img src="/brand/vireek-tile.svg" alt="" aria-hidden="true" className="h-14 w-14" />
          </Example>
          <Example ok={false} caption="Stretched or squashed.">
            <img src="/brand/vireek-wordmark-color.svg" alt="" aria-hidden="true" className="h-7 w-60 max-w-full" style={{ objectFit: 'fill' }} />
          </Example>
          <Example ok={false} caption="Recolored.">
            <img src="/brand/vireek-wordmark-color.svg" alt="" aria-hidden="true" className="h-10 w-auto" style={{ filter: 'hue-rotate(120deg) saturate(1.4)' }} />
          </Example>
          <Example ok={false} caption="Effects such as shadows and glows.">
            <img src="/brand/vireek-wordmark-color.svg" alt="" aria-hidden="true" className="h-10 w-auto" style={{ filter: 'drop-shadow(4px 6px 3px rgba(0,0,0,.45))' }} />
          </Example>
          <Example ok={false} caption="Low contrast on a busy background." bg="bg-[conic-gradient(at_30%_40%,#6A9BCC,#34C759,#FFCC00,#D97757,#6A9BCC)]">
            <img src="/brand/vireek-wordmark-color.svg" alt="" aria-hidden="true" className="h-10 w-auto" />
          </Example>
        </div>
      </div>
    </div>
  );
}
