import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Keyboard, ScanLine, X } from 'lucide-react';
import { cleanScan } from '@/lib/truckStockField';

// Minimal typing for the Shape Detection API (not in lib.dom for our TypeScript version).
interface DetectedCode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedCode[]>;
}
interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

const WANTED_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code', 'data_matrix'];
const SCAN_INTERVAL_MS = 220;
const SAME_CODE_COOLDOWN_MS = 1500;

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called with a cleaned code from the camera, a native scanner, a Bluetooth/USB scanner or the keyboard. */
  onCode: (code: string) => void;
  /** Shown above the camera, e.g. "Scan the part's barcode". */
  hint?: string;
}

type Mode = 'starting' | 'camera' | 'manual';

/**
 * Full-screen scanner. Order of preference: native ML Kit scanner (installed app) → browser
 * BarcodeDetector camera → typed / hardware-scanner input. The text box is always available because
 * Bluetooth and USB scanners behave like keyboards (they "type" the code and press Enter).
 */
export function BarcodeScanSheet({ open, onClose, onCode, hint = 'Point the camera at the part barcode' }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [mode, setMode] = useState<Mode>('starting');
  const [notice, setNotice] = useState<string | null>(null);
  const [text, setText] = useState('');
  const lastRef = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const emit = useCallback((raw: string) => {
    const code = cleanScan(raw);
    if (!code) return;
    const now = Date.now();
    if (lastRef.current.code === code && now - lastRef.current.at < SAME_CODE_COOLDOWN_MS) return;
    lastRef.current = { code, at: now };
    try {
      navigator.vibrate?.(35);
    } catch {
      /* not supported */
    }
    onCodeRef.current(code);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let timer: number | null = null;
    setMode('starting');
    setNotice(null);
    setText('');

    const toManual = (message: string | null) => {
      if (cancelled) return;
      setNotice(message);
      setMode('manual');
    };

    (async () => {
      // 1. Installed app: native scanner (its own full-screen UI).
      try {
        const { isNative } = await import('@/lib/native/platform');
        if (isNative()) {
          const { scanNativeCode } = await import('@/lib/native/scanner');
          try {
            const { value } = await scanNativeCode();
            if (!cancelled) emit(value);
          } catch (e) {
            if (e instanceof DOMException && e.name === 'AbortError') {
              if (!cancelled) onCloseRef.current();
              return;
            }
            toManual(e instanceof Error ? e.message : 'The scanner could not start. Type the code instead.');
          }
          return;
        }
      } catch {
        /* native bridge not available in this build: use the web scanner */
      }

      // 2. Browser camera + BarcodeDetector.
      const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
      if (!Detector || !navigator.mediaDevices?.getUserMedia) {
        toManual('Camera scanning is not supported in this browser. Type the code or use a Bluetooth scanner.');
        return;
      }
      try {
        const supported = (await Detector.getSupportedFormats?.()) ?? WANTED_FORMATS;
        const formats = WANTED_FORMATS.filter((f) => supported.includes(f));
        const detector = new Detector({ formats: formats.length ? formats : undefined });
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        setMode('camera');

        let busy = false;
        timer = window.setInterval(() => {
          if (busy || video.readyState < 2) return;
          busy = true;
          detector
            .detect(video)
            .then((codes) => {
              if (codes[0]?.rawValue) emit(codes[0].rawValue);
            })
            .catch(() => undefined)
            .finally(() => {
              busy = false;
            });
        }, SCAN_INTERVAL_MS);
      } catch (e) {
        const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
        toManual(
          denied
            ? 'Camera permission is blocked. Allow it in your browser settings, or type the code instead.'
            : 'The camera could not start. Type the code instead.',
        );
      }
    })();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [open, emit]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open && mode === 'manual') inputRef.current?.focus();
  }, [open, mode]);

  if (!open) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // A hardware scanner may repeat the same code on purpose: manual entry skips the cooldown.
    lastRef.current = { code: '', at: 0 };
    emit(text);
    setText('');
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Scan a part" className="fixed inset-0 z-50 flex flex-col bg-black text-white">
      <div className="flex items-center justify-between px-4 pb-2 pt-[max(1rem,env(safe-area-inset-top))]">
        <p className="flex items-center gap-2 text-sm font-medium">
          <ScanLine className="h-4 w-4" aria-hidden /> {hint}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close scanner"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10 active:bg-white/20"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="relative flex-1 overflow-hidden">
        <video ref={videoRef} playsInline muted className={`h-full w-full object-cover ${mode === 'camera' ? '' : 'hidden'}`} />
        {mode === 'camera' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden>
            <div className="h-40 w-[78%] max-w-sm rounded-2xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" />
          </div>
        )}
        {mode === 'starting' && (
          <div className="flex h-full items-center justify-center" role="status">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            <span className="sr-only">Starting camera…</span>
          </div>
        )}
        {mode === 'manual' && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <Keyboard className="h-10 w-10 text-white/60" aria-hidden />
            <p className="max-w-xs text-sm text-white/80">{notice ?? 'Type the code, or scan with a Bluetooth / USB scanner.'}</p>
          </div>
        )}
      </div>

      <form onSubmit={submit} className="flex gap-2 bg-neutral-900 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        <label className="sr-only" htmlFor="truck-stock-code">Barcode or part number</label>
        <input
          id="truck-stock-code"
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          placeholder="Barcode or part number"
          className="h-12 min-w-0 flex-1 rounded-xl border border-white/20 bg-white/10 px-4 text-base text-white placeholder:text-white/50 focus:border-white focus:outline-none"
        />
        <button
          type="submit"
          disabled={!cleanScan(text)}
          className="h-12 rounded-xl bg-white px-5 text-sm font-semibold text-black disabled:opacity-40"
        >
          Find
        </button>
      </form>
    </div>
  );
}
