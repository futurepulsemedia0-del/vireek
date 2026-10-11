import { useState } from 'react';
import { Check, Plus, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { PRESET_IDS, PRESET_LABELS, WIDGETS, type OverviewPreset, type OverviewPresetId, type OverviewWidgetId } from '@/lib/overviewLayout';
import type { LayoutSaveState } from '@/hooks/useOverviewLayout';

interface Props {
  editing: boolean;
  preset: OverviewPreset;
  hidden: OverviewWidgetId[];
  saveState: LayoutSaveState;
  onToggleEditing: () => void;
  onApplyPreset: (preset: OverviewPresetId) => void;
  onReset: () => void | Promise<void>;
  onShow: (id: OverviewWidgetId) => void;
}

const SAVE_LABEL: Record<LayoutSaveState, string> = {
  idle: '',
  saving: 'Saving…',
  saved: 'Saved to your account',
  error: 'Could not save — will retry on your next change',
};

type Pending = { kind: 'reset' } | { kind: 'preset'; id: OverviewPresetId } | null;

export function OverviewCustomizeBar({
  editing,
  preset,
  hidden,
  saveState,
  onToggleEditing,
  onApplyPreset,
  onReset,
  onShow,
}: Props) {
  const [pending, setPending] = useState<Pending>(null);

  if (!editing) {
    return (
      <div className="mb-4 flex justify-end">
        <Button variant="secondary" size="sm" onClick={onToggleEditing}>
          <SlidersHorizontal size={16} aria-hidden="true" />
          Customize
        </Button>
      </div>
    );
  }

  return (
    <section aria-label="Customize overview" className="mb-5 rounded-2xl border border-accent/30 bg-bg-secondary p-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm font-medium text-text-secondary">
          Layout preset
          <select
            value={preset}
            onChange={(e) => setPending({ kind: 'preset', id: e.target.value as OverviewPresetId })}
            className="focus-ring min-h-[40px] rounded-xl border border-border bg-bg-primary px-3 text-sm text-text-primary"
          >
            {preset === 'custom' && (
              <option value="custom" disabled>
                {PRESET_LABELS.custom}
              </option>
            )}
            {PRESET_IDS.map((id) => (
              <option key={id} value={id}>
                {PRESET_LABELS[id]}
              </option>
            ))}
          </select>
        </label>
        <Button variant="ghost" size="sm" onClick={() => setPending({ kind: 'reset' })}>
          <RotateCcw size={16} aria-hidden="true" />
          Reset to default
        </Button>
        <span role="status" aria-live="polite" className="ml-auto text-xs text-text-secondary">
          {SAVE_LABEL[saveState]}
        </span>
        <Button size="sm" onClick={onToggleEditing}>
          <Check size={16} aria-hidden="true" />
          Done
        </Button>
      </div>

      <p className="mt-3 text-xs text-text-secondary">
        Drag a widget by its title to reorder, drag the corner to resize, or focus a handle and use the arrow keys.
      </p>

      {hidden.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="Hidden widgets">
          <span className="text-xs font-medium text-text-secondary">Hidden:</span>
          {hidden.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => onShow(id)}
              aria-label={`Show ${WIDGETS[id].title}`}
              className="focus-ring inline-flex min-h-[32px] items-center gap-1 rounded-full border border-border bg-bg-primary px-3 text-xs font-medium text-text-primary hover:border-accent/50"
            >
              <Plus size={12} aria-hidden="true" />
              {WIDGETS[id].title}
            </button>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === 'reset' ? 'Reset to default?' : `Apply the ${pending?.kind === 'preset' ? PRESET_LABELS[pending.id] : ''} preset?`}
        description={
          pending?.kind === 'reset'
            ? 'Your saved layout is removed and the default for your role is restored.'
            : 'This replaces your current layout. You can customize it again afterwards.'
        }
        confirmLabel={pending?.kind === 'reset' ? 'Reset layout' : 'Apply preset'}
        onCancel={() => setPending(null)}
        onConfirm={async () => {
          const p = pending;
          setPending(null);
          if (p?.kind === 'reset') await onReset();
          else if (p?.kind === 'preset') onApplyPreset(p.id);
        }}
      />
    </section>
  );
}
