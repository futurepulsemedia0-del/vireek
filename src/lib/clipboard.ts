// src/lib/clipboard.ts
//
// Clipboard write with a real fallback. navigator.clipboard only exists in
// secure contexts and can be blocked by permissions policy / embedded webviews;
// document.execCommand('copy') still works there.

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const previouslyFocused = document.activeElement as HTMLElement | null;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;pointer-events:none;';
  document.body.appendChild(textarea);
  try {
    textarea.select();
    textarea.setSelectionRange(0, text.length); // iOS Safari
    return typeof document.execCommand === 'function' && document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
    previouslyFocused?.focus?.({ preventScroll: true });
  }
}

/** Resolves true when the text reached the clipboard, false otherwise. Never throws. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  return legacyCopy(text);
}
