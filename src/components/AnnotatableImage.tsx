import { useRef, useState } from 'react';
import type { AnnotationPoint } from '@/lib/expertAssist';

interface Props {
  imageUrl: string;
  existingAnnotations: AnnotationPoint[];
  editable: boolean;
  onAddPoint?: (point: AnnotationPoint) => void;
}

export function AnnotatableImage({ imageUrl, existingAnnotations, editable, onAddPoint }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pendingLabel, setPendingLabel] = useState<{ x: number; y: number } | null>(null);
  const [labelText, setLabelText] = useState('');

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!editable || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    setPendingLabel({ x, y });
  }

  function confirmLabel() {
    if (!pendingLabel || !onAddPoint) return;
    onAddPoint({ x: pendingLabel.x, y: pendingLabel.y, type: labelText ? 'label' : 'circle', label: labelText || undefined });
    setPendingLabel(null);
    setLabelText('');
  }

  return (
    <div className="space-y-2">
      <div
        ref={containerRef}
        onClick={handleClick}
        className={`relative overflow-hidden rounded-lg border border-border ${editable ? 'cursor-crosshair' : ''}`}
      >
        <img src={imageUrl} alt="Field photo" className="block w-full select-none" draggable={false} />
        {existingAnnotations.map((p, i) => (
          <div
            key={i}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
          >
            <div className="h-6 w-6 rounded-full border-2 border-danger bg-danger/20" />
            {p.label && (
              <span className="absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap rounded bg-danger px-1.5 py-0.5 text-[10px] font-medium text-white">
                {p.label}
              </span>
            )}
          </div>
        ))}
        {pendingLabel && (
          <div
            className="absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-accent/20"
            style={{ left: `${pendingLabel.x * 100}%`, top: `${pendingLabel.y * 100}%` }}
          />
        )}
      </div>

      {editable && pendingLabel && (
        <div className="flex gap-2">
          <input
            value={labelText}
            onChange={(e) => setLabelText(e.target.value)}
            placeholder="e.g. Check this capacitor"
            className="flex-1 rounded-md border border-border bg-bg-primary px-2 py-1 text-sm"
          />
          <button onClick={confirmLabel} className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-white">Pin</button>
          <button onClick={() => setPendingLabel(null)} className="rounded-md border border-border px-3 py-1 text-sm">Cancel</button>
        </div>
      )}
      {editable && !pendingLabel && (
        <p className="text-xs text-text-secondary">Tap anywhere on the photo to drop a pin and tell the technician what to check.</p>
      )}
    </div>
  );
}
