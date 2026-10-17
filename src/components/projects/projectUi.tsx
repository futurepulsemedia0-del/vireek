import { useCallback, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import type { ProjectBundle } from '@/lib/installProjectsApi';
import {
  clamp,
  type BillingRowStatus,
  type MarginLevel,
  type MaterialStatus,
  type PhaseStatus,
  type ProjectStatus,
  type ScheduleState,
} from '@/lib/installProjects';

export const panelClass = 'rounded-2xl border border-border bg-bg-secondary p-5';
export const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary transition-colors focus-visible:border-accent disabled:opacity-50';
/** Compact override for <Input> inside dense inline forms. */
export const compactInput = 'py-2 text-sm';

export interface TabProps {
  ownerId: string;
  bundle: ProjectBundle;
  today: string;
  onChanged: () => Promise<void>;
}

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-bg-tertiary text-text-secondary',
  info: 'bg-accent/10 text-accent',
  success: 'bg-success-500/10 text-success-500',
  warning: 'bg-warning-500/15 text-warning-500',
  danger: 'bg-danger-500/15 text-danger-500',
};

export const projectStatusTone: Record<ProjectStatus, Tone> = { planning: 'neutral', active: 'info', on_hold: 'warning', completed: 'success', cancelled: 'danger' };
export const scheduleTone: Record<ScheduleState, Tone> = { not_started: 'neutral', on_track: 'success', at_risk: 'warning', late: 'danger', paused: 'warning', done: 'success', cancelled: 'neutral' };
export const billingTone: Record<BillingRowStatus, Tone> = { scheduled: 'neutral', invoiced: 'info', overdue: 'danger', paid: 'success' };
export const phaseTone: Record<PhaseStatus, Tone> = { not_started: 'neutral', in_progress: 'info', blocked: 'danger', completed: 'success' };
export const materialTone: Record<MaterialStatus, Tone> = { planned: 'neutral', ordered: 'info', delivered: 'warning', installed: 'success' };
export const marginTone: Record<MarginLevel, Tone> = { healthy: 'success', thin: 'warning', at_risk: 'danger', unknown: 'neutral' };

export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE_CLASS[tone]}`}>{children}</span>;
}

export function ProgressBar({ value, label, tone = 'info' }: { value: number; label: string; tone?: Tone }) {
  const pct = clamp(Math.round(value), 0, 100);
  const bar = tone === 'success' ? 'bg-success-500' : tone === 'warning' ? 'bg-warning-500' : tone === 'danger' ? 'bg-danger-500' : 'bg-accent';
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="h-2 w-full overflow-hidden rounded-full bg-bg-tertiary"
    >
      <div className={`h-full rounded-full transition-all duration-300 ${bar}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  return (
    <div className={panelClass}>
      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className={`mt-1.5 text-2xl font-bold tabular-nums ${tone === 'danger' ? 'text-danger-500' : tone === 'warning' ? 'text-warning-500' : tone === 'success' ? 'text-success-500' : 'text-text-primary'}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

export function SectionHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold text-text-primary">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-text-secondary">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/** Runs a mutation, toasts the outcome, refreshes the project, tracks which control is busy. */
export function useAction(onChanged: () => Promise<void>) {
  const { toast } = useToast();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>, success?: string): Promise<boolean> => {
      setBusyKey(key);
      try {
        await fn();
        if (success) toast(success, 'success');
        await onChanged();
        return true;
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Something went wrong. Please try again.', 'error');
        return false;
      } finally {
        setBusyKey(null);
      }
    },
    [onChanged, toast],
  );
  return { busyKey, run };
}

interface ConfirmConfig {
  title: string;
  description: string;
  label: string;
  confirmPhrase?: string;
  onConfirm: () => Promise<unknown> | unknown;
}

export function useConfirm() {
  const [cfg, setCfg] = useState<ConfirmConfig | null>(null);
  const ask = useCallback((c: ConfirmConfig) => setCfg(c), []);
  const dialog = (
    <ConfirmDialog
      open={cfg !== null}
      title={cfg?.title ?? ''}
      description={cfg?.description ?? ''}
      confirmLabel={cfg?.label}
      confirmPhrase={cfg?.confirmPhrase}
      onCancel={() => setCfg(null)}
      onConfirm={async () => {
        const current = cfg;
        setCfg(null);
        await current?.onConfirm();
      }}
    />
  );
  return { ask, dialog };
}
