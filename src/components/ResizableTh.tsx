import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useDirection } from '@/hooks/useDirection';

const MIN = 48;
const MAX = 800;
const STEP = 16;

interface Props {
  width: number | undefined;
  label: string;
  onResize: (px: number) => void;
  className?: string;
  children: ReactNode;
}

/** <th> with a pointer- and keyboard-operable resize handle (←/→ ±16px, Shift ±64px, Home resets). */
export function ResizableTh({ width, label, onResize, className = '', children }: Props) {
  const { t } = useTranslation();
  const { isRtl } = useDirection();
  const thRef = useRef<HTMLTableCellElement>(null);
  const [live, setLive] = useState<number | null>(null);
  const start = useRef<{ x: number; w: number } | null>(null);
  const current = live ?? width ?? thRef.current?.offsetWidth ?? 160;
  const clamp = (n: number) => Math.min(MAX, Math.max(MIN, Math.round(n)));

  const onDown = (e: PointerEvent<HTMLSpanElement>) => {
    start.current = { x: e.clientX, w: thRef.current?.offsetWidth ?? current };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent<HTMLSpanElement>) => {
    if (!start.current) return;
    const dx = (e.clientX - start.current.x) * (isRtl ? -1 : 1);
    setLive(clamp(start.current.w + dx));
  };
  const onUp = () => {
    if (start.current && live !== null) onResize(live);
    start.current = null;
    setLive(null);
  };
  const onKey = (e: KeyboardEvent<HTMLSpanElement>) => {
    const step = e.shiftKey ? STEP * 4 : STEP;
    const grow = isRtl ? 'ArrowLeft' : 'ArrowRight';
    const shrink = isRtl ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === grow) onResize(clamp(current + step));
    else if (e.key === shrink) onResize(clamp(current - step));
    else if (e.key === 'Home') onResize(160);
    else return;
    e.preventDefault();
  };

  return (
    <th ref={thRef} scope="col" style={width || live ? { width: live ?? width } : undefined} className={`relative ${className}`}>
      {children}
      <span
        role="separator"
        aria-orientation="vertical"
        tabIndex={0}
        aria-label={t('navflow.table.resize', { defaultValue: 'Resize column {{name}}', name: label })}
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        aria-valuenow={Math.round(current)}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onKeyDown={onKey}
        className="focus-ring absolute inset-y-0 end-0 w-2 cursor-col-resize touch-none select-none hover:bg-accent/30"
      />
    </th>
  );
}
