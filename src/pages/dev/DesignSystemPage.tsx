import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TYPE_SCALE, TYPE_UTILITIES, toPx, MIN_REM } from '../../../scripts/type/type-scale.mjs';
import { applyDensity, readDensity, setDensity, type Density } from '@/lib/density';
import { findSmallText, type SmallTextHit } from '@/lib/typeAudit';

/**
 * /dev/design-system — developer-only (registered only when import.meta.env.DEV, like /dev/colors).
 *
 * Documents the type scale from its single source of truth (scripts/type/type-scale.mjs — the same module that feeds
 * tailwind.config.js, the CI guard and the tests), and VERIFIES it live: every sample reports its computed pixel size
 * and turns into an error if it is below the 12px floor, at any browser zoom, text-size setting or density.
 */

/**
 * Tailwind only generates classes it can see as literals, so the token → class map is explicit (never a class name built from a template string).
 * A unit test asserts every token in TYPE_SCALE has an entry.
 */
export const SAMPLE_CLASS: Record<string, string> = {
  eyebrow: 'text-eyebrow uppercase',
  caption: 'text-caption',
  small: 'text-small',
  body: 'text-body',
  lead: 'text-lead',
  h4: 'text-h4 font-display',
  h3: 'text-h3 font-display',
  h2: 'text-h2 font-display',
  h1: 'text-h1 font-display',
  display: 'text-display font-display',
  'display-lg': 'text-display-lg font-display',
};

const FLOOR_PX = toPx(MIN_REM);

function SampleRow({ name, tick }: { name: string; tick: number }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLSpanElement>(null);
  const [px, setPx] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (ref.current) setPx(Math.round(parseFloat(getComputedStyle(ref.current).fontSize) * 100) / 100);
  }, [tick]);
  const token = TYPE_SCALE.find((x) => x.name === name);
  if (!token) return null;
  const bad = px !== null && px < FLOOR_PX - 0.01;
  return (
    <tr className="border-t border-border align-baseline">
      <td className="py-row pr-3 text-small font-semibold"><code>{token.name}</code></td>
      <td className="pr-3 text-caption"><code className="type-id">{SAMPLE_CLASS[name]?.split(' ')[0]}</code>{token.alias ? <span className="text-text-secondary"> = text-{token.alias}</span> : null}</td>
      <td className="pr-3 text-caption type-figure">{token.rem}rem / {toPx(token.rem)}px</td>
      <td className="pr-3 text-caption type-figure">{token.lineHeight}</td>
      <td className="pr-3 text-caption type-figure">{token.tracking ?? '0'}</td>
      <td className="pr-3 text-caption type-figure">{token.weight ?? '—'}</td>
      <td className="pr-3 text-caption text-text-secondary">{token.role}. {token.guidance}</td>
      <td className="min-w-[10rem] pr-3"><span ref={ref} className={SAMPLE_CLASS[name]}>{t('devDesignSystem.sample', 'Dispatch the nearest technician')}</span></td>
      <td className={`type-figure text-caption font-semibold ${bad ? 'text-danger' : 'text-success'}`} data-testid={`rendered-${name}`}>
        {px === null ? '…' : `${px}px`} {bad ? t('devDesignSystem.belowFloor', 'BELOW FLOOR') : '✓'}
      </td>
    </tr>
  );
}

export function DevDesignSystemPage() {
  const { t } = useTranslation();
  const [tick, setTick] = useState(0);
  const [density, setDensityState] = useState<Density>(() => readDensity());
  const [spacingTest, setSpacingTest] = useState(false);
  const [scan, setScan] = useState<SmallTextHit[] | null>(null);
  const mainRef = useRef<HTMLElement>(null);

  const remeasure = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    window.addEventListener('resize', remeasure);
    return () => window.removeEventListener('resize', remeasure);
  }, [remeasure]);
  useEffect(() => {
    remeasure();
  }, [density, remeasure]);

  const changeDensity = (d: Density) => {
    setDensity(d);
    setDensityState(d);
  };
  useEffect(() => () => applyDensity(readDensity()), []);

  return (
    <main ref={mainRef} className="mx-auto max-w-6xl px-4 py-8 text-text-primary" aria-labelledby="ds-title">
      <p className="text-eyebrow text-text-secondary">{t('devDesignSystem.eyebrow', 'Developer tools')}</p>
      <h1 id="ds-title" className="mt-1 font-display text-h1">{t('devDesignSystem.title', 'Design system — typography')}</h1>
      <p className="mt-3 max-w-prose text-body text-text-secondary">
        {t('devDesignSystem.intro', 'One rem-based scale. Nothing is smaller than 12px in any density, zoom or text-size setting. Source of truth: scripts/type/type-scale.mjs. Colours live in the')}{' '}
        <a className="underline" href="/dev/colors">{t('devDesignSystem.colorLab', 'colour lab')}</a>.
      </p>

      <section className="mt-8" aria-labelledby="ds-scale">
        <h2 id="ds-scale" className="font-display text-h3">{t('devDesignSystem.scale', 'Type scale')}</h2>
        <p className="mt-1 text-small text-text-secondary">{t('devDesignSystem.scaleHelp', 'Rendered size is read from the browser, live. It changes with browser zoom, the in-app text size and the OS font scale, and turns red below 12px.')}</p>
        <div className="mt-3 overflow-x-auto rounded-md border border-border bg-bg-secondary p-3">
          <table className="w-full min-w-[60rem] text-left">
            <thead>
              <tr className="text-caption text-text-secondary">
                {['Token', 'Class', 'Size', 'Line-height', 'Tracking', 'Weight', 'Role and guidance', 'Sample', 'Rendered'].map((h) => (
                  <th key={h} scope="col" className="pb-2 pr-3 font-medium">{t(`devDesignSystem.col.${h}`, h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>{TYPE_SCALE.map((x) => <SampleRow key={x.name} name={x.name} tick={tick} />)}</tbody>
          </table>
        </div>
      </section>

      <section className="mt-10" aria-labelledby="ds-utils">
        <h2 id="ds-utils" className="font-display text-h3">{t('devDesignSystem.utilities', 'Figures, identifiers and inline text')}</h2>
        <ul className="mt-3 space-y-1 text-small">
          {TYPE_UTILITIES.map((u) => (
            <li key={u.className}><code className="type-id">{u.className}</code> <span className="text-text-secondary">— {u.role} ({u.css})</span></li>
          ))}
        </ul>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="rounded-md border border-border bg-bg-secondary p-4">
            <p className="text-caption text-text-secondary">{t('devDesignSystem.figures', 'Tabular figures line up in columns')}</p>
            <p className="type-figure text-h3">1,111.11</p>
            <p className="type-figure text-h3">8,888.88</p>
            <p className="mt-3 text-small">{t('devDesignSystem.ids', 'Job')} <span className="type-id">JOB-8F2A-91C7</span> · <span className="type-id">+1 (415) 555-0132</span></p>
            <p className="mt-3 text-small">{t('devDesignSystem.inline', 'Run')} <code className="type-inline rounded bg-bg-tertiary px-1.5 py-0.5">npm run lint:type</code> {t('devDesignSystem.inline2', 'before you push. Inline code follows its parent but never goes below 12px.')}</p>
          </div>
          <div className="rounded-md border border-border bg-bg-secondary p-4" dir="rtl" lang="fa">
            <p className="text-caption text-text-secondary">{t('devDesignSystem.rtl', 'RTL: identifiers stay left-to-right and letter-spacing is reset')}</p>
            <p className="mt-2 text-small tracking-wider">
              {t('devDesignSystem.rtlText', 'شماره تماس')}: <span className="type-id">+98 21 5555 0132</span>
            </p>
          </div>
        </div>
      </section>

      <section className="mt-10" aria-labelledby="ds-density">
        <h2 id="ds-density" className="font-display text-h3">{t('devDesignSystem.density', 'Density')}</h2>
        <p className="mt-1 text-small text-text-secondary">{t('devDesignSystem.densityHelp', 'Compact tightens spacing only. Type never changes and targets stay at least 2rem.')}</p>
        <div className="mt-3 inline-flex gap-2" role="group" aria-label={t('devDesignSystem.density', 'Density')}>
          {(['comfortable', 'compact'] as const).map((d) => (
            <button key={d} type="button" aria-pressed={density === d} onClick={() => changeDensity(d)}
              className={`min-h-target rounded-md border px-3 text-small ${density === d ? 'border-accent bg-accent-subtle' : 'border-border'}`}>
              {t(`devDesignSystem.density_${d}`, d)}
            </button>
          ))}
        </div>
        <table className="mt-3 w-full max-w-lg text-left text-small">
          <tbody>
            {['Maya Chen', 'Dev Patel', 'Sofia Rossi'].map((n) => (
              <tr key={n} className="border-t border-border"><td className="py-row">{n}</td><td className="py-row text-caption text-text-secondary">Dispatched 09:41</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mt-10" aria-labelledby="ds-wcag">
        <h2 id="ds-wcag" className="font-display text-h3">{t('devDesignSystem.spacing', 'WCAG 1.4.12 text spacing')}</h2>
        <label className="mt-2 flex items-center gap-2 text-small">
          <input type="checkbox" checked={spacingTest} onChange={(e) => setSpacingTest(e.target.checked)} />
          {t('devDesignSystem.spacingToggle', 'Apply line-height 1.5, paragraph spacing 2×, letter-spacing 0.12em, word-spacing 0.16em')}
        </label>
        <div data-testid="spacing-sample"
          className={`mt-3 max-w-md rounded-md border border-border bg-bg-secondary p-4 ${spacingTest ? '[&_*]:!leading-[1.5] [&_*]:!tracking-[0.12em] [&_*]:![word-spacing:0.16em] [&_p]:!mb-[2em]' : ''}`}>
          <p className="text-small">{t('devDesignSystem.spacingA', 'Technician Maya Chen is en route to 214 Harbor Street and will arrive in about twelve minutes.')}</p>
          <p className="text-caption text-text-secondary">{t('devDesignSystem.spacingB', 'Status updates every 30 seconds. Nothing here may clip or overlap.')}</p>
        </div>
      </section>

      <section className="mt-10" aria-labelledby="ds-scan">
        <h2 id="ds-scan" className="font-display text-h3">{t('devDesignSystem.scan', 'Scan this page')}</h2>
        <button type="button" className="mt-2 min-h-target rounded-md border border-border px-3 text-small" onClick={() => setScan(findSmallText(mainRef.current ?? document, FLOOR_PX))}>
          {t('devDesignSystem.scanButton', 'Find text below 12px')}
        </button>
        {scan && (
          <p role="status" data-testid="scan-result" className={`mt-2 text-small ${scan.length ? 'text-danger' : 'text-success'}`}>
            {scan.length ? `${scan.length} ${t('devDesignSystem.scanFound', 'element(s) below 12px')}: ${scan.slice(0, 5).map((h) => `${h.selector} ${h.px}px`).join('; ')}` : t('devDesignSystem.scanClean', 'Nothing below 12px on this page.')}
          </p>
        )}
      </section>
    </main>
  );
}
