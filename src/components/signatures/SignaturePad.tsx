/**
 * Signature capture pad — draw with a mouse/finger, or type your name in
 * a cursive font. Emits a value shaped exactly like what submitSignature()
 * in src/lib/signatures.ts expects: drawn signatures are a PNG data URL
 * from the canvas, typed signatures are plain text + a font id.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Eraser, PenLine, Type } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import type { SignatureType } from '@/lib/signatures';

export const TYPED_SIGNATURE_FONTS: { id: string; label: string; family: string }[] = [
  { id: 'dancing-script', label: 'Dancing Script', family: "'Dancing Script', cursive" },
  { id: 'caveat', label: 'Caveat', family: "'Caveat', cursive" },
  { id: 'great-vibes', label: 'Great Vibes', family: "'Great Vibes', cursive" },
];

export interface SignaturePadValue {
  type: SignatureType;
  data: string;
  typedFont?: string;
}

interface SignaturePadProps {
  defaultName?: string;
  onChange: (value: SignaturePadValue | null) => void;
}

export function SignaturePad({ defaultName = '', onChange }: SignaturePadProps) {
  const [mode, setMode] = useState<'draw' | 'type'>('draw');
  const [hasDrawing, setHasDrawing] = useState(false);
  const [typedName, setTypedName] = useState(defaultName);
  const [typedFont, setTypedFont] = useState(TYPED_SIGNATURE_FONTS[0].id);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);

  const setupCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#171717';
  }, []);

  useEffect(() => {
    setupCanvas();
    window.addEventListener('resize', setupCanvas);
    return () => window.removeEventListener('resize', setupCanvas);
  }, [setupCanvas]);

  const pointerPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    lastPoint.current = pointerPos(e);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx || !lastPoint.current) return;
    const point = pointerPos(e);
    ctx.beginPath();
    ctx.moveTo(lastPoint.current.x, lastPoint.current.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    lastPoint.current = point;
    setHasDrawing(true);
  };

  const handlePointerUp = () => {
    if (!drawing.current) return;
    drawing.current = false;
    lastPoint.current = null;
    const canvas = canvasRef.current;
    if (canvas) onChange({ type: 'drawn', data: canvas.toDataURL('image/png') });
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasDrawing(false);
    onChange(null);
  };

  const handleModeChange = (next: 'draw' | 'type') => {
    setMode(next);
    if (next === 'draw') {
      onChange(hasDrawing && canvasRef.current ? { type: 'drawn', data: canvasRef.current.toDataURL('image/png') } : null);
    } else {
      onChange(typedName.trim() ? { type: 'typed', data: typedName.trim(), typedFont } : null);
    }
  };

  const handleTypedChange = (name: string, font: string) => {
    setTypedName(name);
    setTypedFont(font);
    onChange(name.trim() ? { type: 'typed', data: name.trim(), typedFont: font } : null);
  };

  const activeFont = TYPED_SIGNATURE_FONTS.find((f) => f.id === typedFont) ?? TYPED_SIGNATURE_FONTS[0];

  return (
    <div>
      <div className="mb-3 flex gap-1 rounded-xl border border-border bg-bg-tertiary p-1">
        <button
          type="button"
          onClick={() => handleModeChange('draw')}
          className={`focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium transition-colors ${
            mode === 'draw' ? 'bg-bg-primary text-text-primary shadow-sm' : 'text-text-secondary'
          }`}
        >
          <PenLine size={14} /> Draw
        </button>
        <button
          type="button"
          onClick={() => handleModeChange('type')}
          className={`focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium transition-colors ${
            mode === 'type' ? 'bg-bg-primary text-text-primary shadow-sm' : 'text-text-secondary'
          }`}
        >
          <Type size={14} /> Type
        </button>
      </div>

      {mode === 'draw' ? (
        <div>
          <div className="relative overflow-hidden rounded-xl border border-border bg-white">
            <canvas
              ref={canvasRef}
              className="h-40 w-full touch-none"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={handlePointerUp}
            />
            {!hasDrawing && (
              <p className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-xs text-text-secondary/60">
                Sign above with your mouse or finger
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={clearCanvas}
            className="focus-ring mt-2 flex items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
          >
            <Eraser size={13} /> Clear
          </button>
        </div>
      ) : (
        <div>
          <Input label="Type your full name" value={typedName} onChange={(e) => handleTypedChange(e.target.value, typedFont)} placeholder="Jane Doe" />
          <div className="mt-3 flex gap-2">
            {TYPED_SIGNATURE_FONTS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => handleTypedChange(typedName, f.id)}
                className={`focus-ring flex-1 rounded-lg border px-2 py-1.5 text-xs ${
                  typedFont === f.id ? 'border-accent text-accent' : 'border-border text-text-secondary'
                }`}
                style={{ fontFamily: f.family }}
              >
                {f.label}
              </button>
            ))}
          </div>
          {typedName.trim() && (
            <div className="mt-3 flex h-24 items-center justify-center rounded-xl border border-border bg-white">
              <span style={{ fontFamily: activeFont.family, fontSize: 34 }} className="text-neutral-900">
                {typedName}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
