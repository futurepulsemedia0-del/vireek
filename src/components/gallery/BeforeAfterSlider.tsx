import { useState } from 'react';

interface Props {
  beforeUrl: string | undefined;
  afterUrl: string | undefined;
  label: string;
}

/**
 * Drag (or arrow-key) comparison slider. A transparent native range input sits
 * over the whole image, so mouse, touch and keyboard all work and screen
 * readers get a real slider.
 */
export function BeforeAfterSlider({ beforeUrl, afterUrl, label }: Props) {
  const [pos, setPos] = useState(50);

  if (!beforeUrl || !afterUrl) {
    return (
      <div
        className="aspect-[4/3] w-full animate-pulse rounded-xl bg-bg-tertiary"
        aria-busy="true"
      />
    );
  }

  return (
    <div className="relative aspect-[4/3] w-full select-none overflow-hidden rounded-xl bg-bg-tertiary">
      <img
        src={afterUrl}
        alt={`After: ${label}`}
        className="absolute inset-0 h-full w-full object-cover"
        draggable={false}
      />
      <img
        src={beforeUrl}
        alt={`Before: ${label}`}
        className="absolute inset-0 h-full w-full object-cover"
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
        draggable={false}
      />
      <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
        Before
      </span>
      <span className="pointer-events-none absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
        After
      </span>
      <div
        className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow-[0_0_6px_rgba(0,0,0,0.5)]"
        style={{ left: `${pos}%` }}
      >
        <span className="absolute left-1/2 top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-xs font-bold text-black shadow-md">
          ⇆
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={pos}
        onChange={(e) => setPos(Number(e.target.value))}
        aria-label={`Compare before and after: ${label}`}
        className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
      />
    </div>
  );
}
