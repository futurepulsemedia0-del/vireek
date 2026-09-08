import { PhoneCall } from 'lucide-react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ThemeToggle } from '@/components/ThemeToggle';

interface Ramp {
  name: string;
  role: string;
  shades: { step: string; hex: string }[];
}

const ramps: Ramp[] = [
  {
    name: 'Primary',
    role: 'Brand / accent',
    shades: [
      { step: '50', hex: '#EFF6FF' },
      { step: '100', hex: '#DBEAFE' },
      { step: '200', hex: '#BFDBFE' },
      { step: '300', hex: '#93C5FD' },
      { step: '400', hex: '#60A5FA' },
      { step: '500', hex: '#3B82F6' },
      { step: '600', hex: '#2563EB' },
      { step: '700', hex: '#1D4ED8' },
      { step: '800', hex: '#1E40AF' },
      { step: '900', hex: '#1E3A8A' },
    ],
  },
  {
    name: 'Secondary / Neutral',
    role: 'Text, surfaces, borders',
    shades: [
      { step: '50', hex: '#F8FAFC' },
      { step: '100', hex: '#F1F5F9' },
      { step: '200', hex: '#E2E8F0' },
      { step: '300', hex: '#CBD5E1' },
      { step: '400', hex: '#94A3B8' },
      { step: '500', hex: '#64748B' },
      { step: '600', hex: '#475569' },
      { step: '700', hex: '#334155' },
      { step: '800', hex: '#1E293B' },
      { step: '900', hex: '#0F172A' },
      { step: '950', hex: '#020617' },
    ],
  },
  {
    name: 'Accent (CTA)',
    role: 'Primary buttons only',
    shades: [
      { step: '50', hex: '#FFF7ED' },
      { step: '100', hex: '#FFEDD5' },
      { step: '200', hex: '#FED7AA' },
      { step: '300', hex: '#FDBA74' },
      { step: '400', hex: '#FB923C' },
      { step: '500', hex: '#F97316' },
      { step: '600', hex: '#EA580C' },
      { step: '700', hex: '#C2410C' },
      { step: '800', hex: '#9A3412' },
      { step: '900', hex: '#7C2D12' },
    ],
  },
  {
    name: 'Success',
    role: 'Confirmations, positive states',
    shades: [
      { step: '50', hex: '#F0FDF4' },
      { step: '100', hex: '#DCFCE7' },
      { step: '300', hex: '#86EFAC' },
      { step: '400', hex: '#4ADE80' },
      { step: '500', hex: '#22C55E' },
      { step: '600', hex: '#16A34A' },
      { step: '700', hex: '#15803D' },
    ],
  },
  {
    name: 'Warning',
    role: 'Caution states',
    shades: [
      { step: '50', hex: '#FFFBEB' },
      { step: '100', hex: '#FEF3C7' },
      { step: '300', hex: '#FCD34D' },
      { step: '400', hex: '#FBBF24' },
      { step: '500', hex: '#F59E0B' },
      { step: '600', hex: '#D97706' },
      { step: '700', hex: '#B45309' },
    ],
  },
  {
    name: 'Error',
    role: 'Missed calls, urgent alerts',
    shades: [
      { step: '50', hex: '#FEF2F2' },
      { step: '100', hex: '#FEE2E2' },
      { step: '300', hex: '#FCA5A5' },
      { step: '400', hex: '#F87171' },
      { step: '500', hex: '#EF4444' },
      { step: '600', hex: '#DC2626' },
      { step: '700', hex: '#B91C1C' },
    ],
  },
];

function hexToLuminance(hex: string) {
  const value = hex.replace('#', '');
  const r = parseInt(value.substring(0, 2), 16) / 255;
  const g = parseInt(value.substring(2, 4), 16) / 255;
  const b = parseInt(value.substring(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function Swatch({ step, hex }: { step: string; hex: string }) {
  const isLight = hexToLuminance(hex) > 0.55;
  return (
    <div
      className="flex h-16 flex-1 flex-col items-start justify-between rounded-lg p-2"
      style={{ backgroundColor: hex, color: isLight ? '#0F172A' : '#F8FAFC' }}
    >
      <span className="text-xs font-semibold">{step}</span>
      <span className="text-[10px] opacity-80">{hex}</span>
    </div>
  );
}

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="mb-10">
      <p className="text-eyebrow font-semibold uppercase text-accent">{eyebrow}</p>
      <h2 className="mt-3 text-3xl font-bold tracking-tight text-text-primary md:text-5xl leading-[1.2]">
        {title}
      </h2>
    </div>
  );
}

function fadeUp(delay = 0) {
  return {
    initial: { opacity: 0, y: 16 },
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true, margin: '-80px' },
    transition: { duration: 0.5, delay, ease: [0.16, 1, 0.3, 1] },
  };
}

export function TokensPreview() {
  return (
    <div className="min-h-screen bg-bg-primary text-text-primary">
      <header className="sticky top-0 z-10 border-b border-border bg-bg-primary/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-white">
              <PhoneCall size={16} strokeWidth={2.5} />
            </span>
            <span className="text-lg font-bold tracking-tight">Vireek</span>
            <span className="ml-2 rounded-full bg-bg-tertiary px-2.5 py-1 text-xs font-medium text-text-secondary">
              Design tokens
            </span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-24 md:py-28">
        <section className="relative mb-32 overflow-hidden rounded-2xl border border-border bg-noise bg-gradient-mesh px-8 py-20 text-center md:py-28">
          <motion.p
            {...fadeUp(0)}
            className="text-eyebrow font-semibold uppercase text-accent"
          >
            Foundation preview
          </motion.p>
          <motion.h1
            {...fadeUp(0.05)}
            className="mx-auto mt-4 max-w-3xl text-5xl font-bold leading-[1.1] tracking-tight text-text-primary md:text-7xl"
          >
            Never Miss Another <span className="text-accent">Emergency Call.</span>
          </motion.h1>
          <motion.p
            {...fadeUp(0.1)}
            className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-text-secondary md:text-lg"
          >
            This is the design system Vireek will be built on — colors, type, buttons,
            and surfaces, checked for quality before a single content section gets written.
          </motion.p>
          <motion.div {...fadeUp(0.15)} className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <Button variant="primary" size="lg">
              Talk to Sarah
            </Button>
            <Button variant="secondary" size="lg">
              See how it works
            </Button>
          </motion.div>
        </section>

        <section className="mb-32">
          <SectionHeading eyebrow="Foundation" title="Color system" />
          <div className="space-y-8">
            {ramps.map((ramp) => (
              <div key={ramp.name}>
                <div className="mb-3 flex items-baseline justify-between">
                  <h3 className="text-xl font-semibold text-text-primary">{ramp.name}</h3>
                  <span className="text-sm text-text-secondary">{ramp.role}</span>
                </div>
                <div className="flex gap-2 overflow-x-auto">
                  {ramp.shades.map((shade) => (
                    <Swatch key={shade.step} step={shade.step} hex={shade.hex} />
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-10 grid gap-6 md:grid-cols-3">
            <Card className="hover:-translate-y-0">
              <p className="text-sm font-semibold text-text-secondary">Background layers</p>
              <div className="mt-4 space-y-2">
                <div className="flex items-center justify-between rounded-lg bg-bg-primary px-4 py-3 text-sm">
                  Primary <span className="text-text-secondary">bg-bg-primary</span>
                </div>
                <div className="flex items-center justify-between rounded-lg bg-bg-secondary px-4 py-3 text-sm">
                  Secondary <span className="text-text-secondary">bg-bg-secondary</span>
                </div>
                <div className="flex items-center justify-between rounded-lg bg-bg-tertiary px-4 py-3 text-sm">
                  Tertiary <span className="text-text-secondary">bg-bg-tertiary</span>
                </div>
              </div>
            </Card>
            <Card className="hover:-translate-y-0">
              <p className="text-sm font-semibold text-text-secondary">Text layers</p>
              <div className="mt-4 space-y-2">
                <p className="text-lg font-semibold text-text-primary">Primary text</p>
                <p className="text-base text-text-secondary">Secondary text</p>
                <p className="text-eyebrow font-semibold uppercase text-accent">Eyebrow / accent</p>
              </div>
            </Card>
            <Card className="hover:-translate-y-0">
              <p className="text-sm font-semibold text-text-secondary">Status colors</p>
              <div className="mt-4 space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-success-500" /> Success
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-warning-500" /> Warning
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-danger-500" /> Danger / urgent
                </div>
              </div>
            </Card>
          </div>
        </section>

        <section className="mb-32">
          <SectionHeading eyebrow="Foundation" title="Type scale" />
          <Card className="hover:-translate-y-0">
            <div className="space-y-8">
              <div>
                <p className="text-eyebrow font-semibold uppercase text-accent">Eyebrow label</p>
                <span className="mt-1 block text-xs text-text-secondary">text-xs md:text-sm, uppercase, tracking-[0.2em]</span>
              </div>
              <div className="border-t border-border pt-8">
                <h1 className="text-5xl font-bold leading-[1.1] tracking-tight text-text-primary md:text-7xl">
                  Heading One
                </h1>
                <span className="mt-2 block text-xs text-text-secondary">text-5xl md:text-7xl, font-bold, tracking-tight</span>
              </div>
              <div className="border-t border-border pt-8">
                <h2 className="text-3xl font-bold leading-[1.2] tracking-tight text-text-primary md:text-5xl">
                  Heading Two
                </h2>
                <span className="mt-2 block text-xs text-text-secondary">text-3xl md:text-5xl, font-bold, tracking-tight</span>
              </div>
              <div className="border-t border-border pt-8">
                <h3 className="text-xl font-semibold text-text-primary md:text-2xl">Heading Three</h3>
                <span className="mt-2 block text-xs text-text-secondary">text-xl md:text-2xl, font-semibold</span>
              </div>
              <div className="border-t border-border pt-8">
                <p className="text-base leading-relaxed text-text-secondary md:text-lg">
                  Body text is set in Inter with a relaxed line height, so paragraphs describing
                  what Sarah does for a plumbing or HVAC business stay easy to scan on any screen.
                </p>
                <span className="mt-2 block text-xs text-text-secondary">text-base md:text-lg, leading-relaxed</span>
              </div>
            </div>
          </Card>
        </section>

        <section className="mb-32">
          <SectionHeading eyebrow="Foundation" title="Buttons" />
          <p className="mb-8 max-w-2xl text-base leading-relaxed text-text-secondary md:text-lg">
            Hover and click each button to check the interaction states: a soft glow and
            brightness lift on hover, a pressed dim on click, and a visible ring when
            navigating with a keyboard.
          </p>
          <div className="grid gap-6 md:grid-cols-3">
            <Card className="hover:-translate-y-0">
              <p className="mb-4 text-sm font-semibold text-text-secondary">Primary</p>
              <div className="flex flex-col gap-3">
                <Button variant="primary" size="sm">Small</Button>
                <Button variant="primary" size="md">Medium</Button>
                <Button variant="primary" size="lg">Large</Button>
                <Button variant="primary" disabled>Disabled</Button>
              </div>
            </Card>
            <Card className="hover:-translate-y-0">
              <p className="mb-4 text-sm font-semibold text-text-secondary">Secondary</p>
              <div className="flex flex-col gap-3">
                <Button variant="secondary" size="sm">Small</Button>
                <Button variant="secondary" size="md">Medium</Button>
                <Button variant="secondary" size="lg">Large</Button>
                <Button variant="secondary" disabled>Disabled</Button>
              </div>
            </Card>
            <Card className="hover:-translate-y-0">
              <p className="mb-4 text-sm font-semibold text-text-secondary">Ghost</p>
              <div className="flex flex-col gap-3">
                <Button variant="ghost" size="sm">Small</Button>
                <Button variant="ghost" size="md">Medium</Button>
                <Button variant="ghost" size="lg">Large</Button>
                <Button variant="ghost" disabled>Disabled</Button>
              </div>
            </Card>
          </div>
        </section>

        <section>
          <SectionHeading eyebrow="Foundation" title="Card & surfaces" />
          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <PhoneCall size={18} />
              </span>
              <h3 className="mt-4 text-xl font-semibold text-text-primary md:text-2xl">
                24/7 call coverage
              </h3>
              <p className="mt-2 text-base leading-relaxed text-text-secondary">
                A multi-layer shadow and a subtle lift on hover give every card a sense
                of depth without ever feeling heavy.
              </p>
            </Card>
            <div className="relative overflow-hidden rounded-2xl border border-border bg-noise bg-gradient-mesh p-8">
              <p className="text-sm font-semibold text-text-secondary">Section background</p>
              <p className="mt-2 text-base leading-relaxed text-text-primary">
                bg-noise + bg-gradient-mesh: a near-invisible grain layer over a soft
                radial gradient mesh, for hero and CTA sections.
              </p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
