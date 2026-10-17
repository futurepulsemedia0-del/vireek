import { X } from 'lucide-react';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';

export function ChatLightbox({ url, onClose }: { url: string | null; onClose: () => void }) {
  const open = Boolean(url);
  const ref = useFocusTrap(open);
  useEscapeToClose(open, onClose);
  if (!url) return null;
  return (
    <div
      ref={ref as React.RefObject<HTMLDivElement>}
      role="dialog"
      aria-modal="true"
      aria-label="Photo"
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/85 p-4"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close photo"
        className="focus-ring absolute right-4 top-4 flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25"
      >
        <X size={22} />
      </button>
      <img
        src={url}
        alt="Shared photo"
        className="max-h-full max-w-full rounded-lg object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
