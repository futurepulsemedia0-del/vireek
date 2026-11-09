import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Dev-only (/dev/design-system): the border-radius scale and the role -> alias mapping, rendered with the
 * REAL Tailwind classes so what you see is what ships. Values mirror scripts/design/radius-tokens.mjs
 * (DesignSystemPage.test.tsx fails if they drift). Strings go through i18next with English defaults.
 */
export interface ScaleStep {
  readonly name: string;
  readonly px: number | 'full';
  readonly className: string;
}
export interface RoleRow {
  readonly role: string;
  readonly alias: 'control' | 'inset' | 'chip' | 'surface' | 'overlay' | 'full';
  readonly className: string;
  readonly use: string;
}

// Class names are written out in full on purpose: Tailwind only generates classes it can see in source.
export const RADIUS_SCALE: readonly ScaleStep[] = [
  { name: 'sm', px: 4, className: 'rounded-sm' },
  { name: 'md', px: 6, className: 'rounded-md' },
  { name: 'lg', px: 8, className: 'rounded-lg' },
  { name: 'xl', px: 12, className: 'rounded-xl' },
  { name: '2xl', px: 16, className: 'rounded-2xl' },
  { name: '3xl', px: 24, className: 'rounded-3xl' },
  { name: 'full', px: 'full', className: 'rounded-full' },
];

export const RADIUS_ROLE_TABLE: readonly RoleRow[] = [
  { role: 'control', alias: 'control', className: 'rounded-control', use: 'Buttons, inputs, selects, tabs, menu items, tooltips' },
  { role: 'inset', alias: 'inset', className: 'rounded-inset', use: 'Non-interactive things nested in a surface: callouts, icon tiles, code/table wrappers, thumbnails' },
  { role: 'chip', alias: 'chip', className: 'rounded-chip', use: 'Rectangular badges, tags, kbd, counters (pills keep rounded-full)' },
  { role: 'surface', alias: 'surface', className: 'rounded-surface', use: 'Cards, panels, toasts, dropdowns, popovers' },
  { role: 'overlay', alias: 'overlay', className: 'rounded-overlay', use: 'Modals, bottom sheets, command palette' },
  { role: 'full', alias: 'full', className: 'rounded-full', use: 'Avatars, status dots, icon buttons that are truly circular, pill chips, progress bars' },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
      {children}
    </section>
  );
}

export default function DesignSystemPage() {
  const { t } = useTranslation();
  const d = (key: string, defaultValue: string) => t(`designSystem.${key}`, { defaultValue });
  return (
    <main className="mx-auto max-w-4xl space-y-10 px-4 py-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold text-text-primary">{d('title', 'Design system — border radius')}</h1>
        <p className="text-sm text-text-secondary">
          {d('intro', 'One monotonic scale, five role aliases. New code uses the aliases; the guard rejects raw steps in new files, rounded-2xl/3xl on small elements, arbitrary radii and non-allowlisted rounded-3xl.')}{' '}
          <code>npm run lint:design</code>
        </p>
      </header>

      <Section title={d('scale', 'Scale')}>
        <ul className="flex flex-wrap gap-4" aria-label={d('scaleLabel', 'Radius scale')}>
          {RADIUS_SCALE.map((s) => (
            <li key={s.name} className="flex flex-col items-center gap-2 text-xs text-text-secondary">
              <span className={`block h-14 w-14 border-2 border-accent bg-bg-tertiary ${s.className}`} />
              <span>
                {s.name} · {s.px === 'full' ? 'full' : `${s.px}px`}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={d('roles', 'Roles')}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-start text-sm">
            <caption className="sr-only">{d('caption', 'Radius role aliases and where to use them')}</caption>
            <thead>
              <tr className="text-text-secondary">
                <th scope="col" className="py-2 pe-3 text-start font-semibold">{d('colRole', 'Role')}</th>
                <th scope="col" className="py-2 pe-3 text-start font-semibold">{d('colClass', 'Class')}</th>
                <th scope="col" className="py-2 pe-3 text-start font-semibold">{d('colSample', 'Sample')}</th>
                <th scope="col" className="py-2 text-start font-semibold">{d('colUse', 'Use for')}</th>
              </tr>
            </thead>
            <tbody>
              {RADIUS_ROLE_TABLE.map((r) => (
                <tr key={r.role} className="border-t border-border align-middle">
                  <th scope="row" className="py-3 pe-3 text-start font-medium text-text-primary">{r.role}</th>
                  <td className="py-3 pe-3"><code>{r.className}</code></td>
                  <td className="py-3 pe-3">
                    <span className={`block h-10 w-24 border border-border bg-bg-tertiary ${r.className}`} />
                  </td>
                  <td className="py-3 text-text-secondary">{d(`use.${r.role}`, r.use)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={d('hierarchy', 'Hierarchy in practice')}>
        <div className="rounded-surface border border-border bg-bg-secondary p-6 shadow-card">
          <p className="font-semibold text-text-primary">{d('surface', 'Surface (rounded-surface)')}</p>
          <div className="mt-3 rounded-inset border border-border bg-bg-tertiary p-3 text-sm text-text-secondary">
            {d('inset', 'Inset (rounded-inset) — nested content is always tighter than its container.')}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="rounded-control border border-border bg-bg-primary px-3 py-2 text-sm text-text-secondary">{d('control', 'Control')}</span>
            <span className="rounded-chip bg-bg-tertiary px-2 py-0.5 text-xs font-semibold text-text-secondary">{d('chip', 'Chip')}</span>
            <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs font-semibold text-text-secondary">{d('pill', 'Pill')}</span>
          </div>
        </div>
      </Section>

      <Section title={d('rules', 'Rules')}>
        <ul className="list-disc space-y-1 ps-5 text-sm text-text-secondary">
          <li>{d('rule1', 'Small elements (buttons, inputs, chips, tiles, tabs) never exceed rounded-lg.')}</li>
          <li>{d('rule2', 'Nested elements are smaller than their container: surface 12px contains inset/control 8px.')}</li>
          <li>{d('rule3', 'rounded-full only for avatars, dots, truly circular icon buttons, pills and progress bars.')}</li>
          <li>{d('rule4', 'rounded-3xl only for allowlisted hero bands. No arbitrary radii. rounded-legacy-md is a one-release alias.')}</li>
        </ul>
      </Section>
    </main>
  );
}
