import { AlertTriangle, CheckCircle2, CircleDashed, ClipboardCheck, Factory, FileText, Hash, Box, Package, ShieldCheck, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ChainStep, StepKey, StepStatus } from '@/lib/oemGraph';

const ICONS: Record<StepKey, LucideIcon> = {
  serial: Hash,
  oem: Factory,
  model: Box,
  issue: AlertTriangle,
  bulletin: FileText,
  part: Package,
  warranty: ShieldCheck,
  claim: ClipboardCheck,
};

const STATUS_STYLE: Record<StepStatus, { ring: string; pill: string; label: string; Icon: LucideIcon }> = {
  ok: { ring: 'border-success-500/40 bg-success-500/10 text-success-500', pill: 'bg-success-500/10 text-success-500', label: 'On record', Icon: CheckCircle2 },
  attention: { ring: 'border-warning-500/40 bg-warning-500/10 text-warning-500', pill: 'bg-warning-500/10 text-warning-500', label: 'Review', Icon: TriangleAlert },
  critical: { ring: 'border-danger/40 bg-danger/10 text-danger', pill: 'bg-danger/10 text-danger', label: 'Act now', Icon: TriangleAlert },
  empty: { ring: 'border-border bg-bg-tertiary text-text-secondary', pill: 'bg-bg-tertiary text-text-secondary', label: 'Nothing yet', Icon: CircleDashed },
};

/**
 * The OEM chain, top to bottom. Each node is a real link in the graph; a grey node means the graph has
 * no data there yet (never "all clear"). Purely presentational — all logic lives in lib/oemGraph.ts.
 */
export function OemGraphChain({ steps }: { steps: ChainStep[] }) {
  return (
    <ol className="relative" aria-label="OEM intelligence chain">
      {steps.map((step, index) => {
        const Icon = ICONS[step.key];
        const style = STATUS_STYLE[step.status];
        const StatusIcon = style.Icon;
        const isLast = index === steps.length - 1;
        return (
          <li key={step.key} className="relative flex gap-3 pb-4 last:pb-0">
            {!isLast && <span className="absolute left-[19px] top-10 h-[calc(100%-2.25rem)] w-px bg-border" aria-hidden="true" />}
            <span className={`relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${style.ring}`}>
              <Icon size={18} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1 rounded-xl border border-border bg-bg-primary p-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{step.label}</p>
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${style.pill}`}>
                  <StatusIcon size={11} aria-hidden="true" /> {style.label}
                </span>
              </div>
              <p className="mt-0.5 break-words text-sm font-semibold text-text-primary">{step.headline}</p>
              {step.detail.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {step.detail.map((line) => (
                    <li key={line} className="break-words text-xs leading-relaxed text-text-secondary">
                      {line}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
