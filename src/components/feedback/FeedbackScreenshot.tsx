import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, EyeOff, ImagePlus, Square, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';

type Tool = 'highlight' | 'hide';
interface Box { x: number; y: number; w: number; h: number; tool: Tool }
const MAX_W = 1600;

/**
 * Optional screenshot with annotation. "Hide" boxes are painted opaque on export, so sensitive areas never leave
 * the browser. Drawing is pointer-only; keyboard users can skip the screenshot or attach an already-cleaned image.
 */
export function FeedbackScreenshot({ onChange }: { onChange: (blob: Blob | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [has, setHas] = useState(false);
  const [tool, setTool] = useState<Tool>('hide');
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [drag, setDrag] = useState<Box | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canCapture = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;

  const paint = useCallback((list: Box[], extra: Box | null) => {
    const c = canvasRef.current, img = imgRef.current;
    if (!c || !img) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    for (const b of extra ? [...list, extra] : list) {
      if (b.tool === 'hide') { ctx.fillStyle = '#000'; ctx.fillRect(b.x, b.y, b.w, b.h); }
      else { ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 4; ctx.strokeRect(b.x, b.y, b.w, b.h); }
    }
  }, []);

  const exportBlob = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.toBlob((png) => {
      if (png && png.size <= 1_900_000) return onChange(png);
      c.toBlob((jpg) => onChange(jpg && jpg.size <= 1_900_000 ? jpg : null), 'image/jpeg', 0.75);
    }, 'image/png');
  }, [onChange]);

  useEffect(() => {
    if (!has) return;
    paint(boxes, drag);
    if (!drag) exportBlob();
  }, [has, boxes, drag, paint, exportBlob]);

  const load = (src: string, revoke?: boolean) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_W / img.width);
      const c = canvasRef.current;
      if (!c) return;
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      imgRef.current = img; setBoxes([]); setHas(true); setError(null);
      if (revoke) URL.revokeObjectURL(src);
    };
    img.onerror = () => setError('That image could not be read.');
    img.src = src;
  };

  const capture = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const video = document.createElement('video');
      video.srcObject = stream; video.muted = true;
      await video.play();
      const c = document.createElement('canvas');
      c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext('2d')?.drawImage(video, 0, 0);
      stream.getTracks().forEach((t) => t.stop());
      load(c.toDataURL('image/png'));
    } catch { setError('Screen capture was cancelled or isn’t available. You can attach an image instead.'); }
  };

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current!, r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  };

  const clear = () => { imgRef.current = null; setHas(false); setBoxes([]); onChange(null); };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {canCapture && <Button type="button" variant="secondary" size="sm" onClick={() => void capture()}><Camera className="h-4 w-4" aria-hidden="true" /> Capture screen</Button>}
        <label className="focus-ring inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-tertiary">
          <ImagePlus className="h-4 w-4" aria-hidden="true" /> Attach image
          <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Attach a screenshot"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) load(URL.createObjectURL(f), true); e.target.value = ''; }} />
        </label>
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {has && (
        <>
          <div role="group" aria-label="Annotation tools" className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant={tool === 'hide' ? 'primary' : 'secondary'} aria-pressed={tool === 'hide'} onClick={() => setTool('hide')}><EyeOff className="h-4 w-4" aria-hidden="true" /> Hide private info</Button>
            <Button type="button" size="sm" variant={tool === 'highlight' ? 'primary' : 'secondary'} aria-pressed={tool === 'highlight'} onClick={() => setTool('highlight')}><Square className="h-4 w-4" aria-hidden="true" /> Highlight</Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setBoxes((b) => b.slice(0, -1))} disabled={boxes.length === 0}><Undo2 className="h-4 w-4" aria-hidden="true" /> Undo</Button>
            <Button type="button" size="sm" variant="secondary" onClick={clear}><Trash2 className="h-4 w-4" aria-hidden="true" /> Remove</Button>
          </div>
          <p className="text-xs text-text-secondary">Hidden areas are blacked out before anything is uploaded.</p>
        </>
      )}
      {/* one canvas, always mounted, so size and refs survive */}
          <canvas ref={canvasRef} role="img" aria-label="Screenshot preview. Drag with a pointer to hide or highlight an area."
            className={has ? 'max-h-64 w-full touch-none rounded-lg border border-border object-contain' : 'hidden'} aria-hidden={has ? undefined : true}
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); const p = pos(e); setDrag({ ...p, w: 0, h: 0, tool }); }}
            onPointerMove={(e) => { if (drag) { const p = pos(e); setDrag({ ...drag, w: p.x - drag.x, h: p.y - drag.y }); } }}
            onPointerUp={() => { if (drag && Math.abs(drag.w) > 6 && Math.abs(drag.h) > 6) { const next = [...boxes, drag]; setBoxes(next); } setDrag(null); }} />
    </div>
  );
}
