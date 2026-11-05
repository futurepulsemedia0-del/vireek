import { useTranslation } from 'react-i18next';
import './loading.css';

interface TopProgressBarProps {
  /** Real progress 0..1. Omit / null = indeterminate (never invent a value). */
  progress?: number | null;
  /** Accessible name. Defaults to the translated "Loading". */
  label?: string;
}

/** Thin brand bar fixed to the top edge (safe-area aware, mirrors under [dir="rtl"]). */
export function TopProgressBar({ progress, label }: TopProgressBarProps) {
  const { t } = useTranslation('common', { useSuspense: false });
  const determinate = typeof progress === 'number' && Number.isFinite(progress);
  const ratio = determinate ? Math.min(1, Math.max(0, progress)) : 0;
  return (
    <div
      className="vrk-topbar"
      role="progressbar"
      aria-label={label ?? t('loading.route', 'Loading')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate ? Math.round(ratio * 100) : undefined}
    >
      <div
        className={determinate ? 'vrk-fill' : 'vrk-fill vrk-fill--ind vrk-anim'}
        style={determinate ? { transform: `scaleX(${ratio})` } : undefined}
      />
    </div>
  );
}
