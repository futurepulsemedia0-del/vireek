/** Tiny store feeding the global aria-live region (works from shortcuts/voice even when the panel is closed). */
type Listener = () => void;
let message = '';
let flip = false;
const listeners = new Set<Listener>();

export function announce(text: string): void {
  flip = !flip;
  message = flip ? text : `${text}\u00A0`; // nbsp makes identical consecutive messages re-announce
  listeners.forEach((l) => l());
}
export const getAnnouncement = (): string => message;
export function subscribeAnnouncement(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
