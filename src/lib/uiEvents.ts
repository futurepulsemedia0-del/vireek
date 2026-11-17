/**
 * Tiny bridge so any button (sidebar, footer, settings, shortcuts) can open a
 * global panel without importing the panel's component. Same pattern as
 * 'vireek:open-consent' and 'vireek:open-support-agent'.
 */
export const OPEN_ACCESSIBILITY_EVENT = 'vireek:open-accessibility';
export const OPEN_ASK_DATA_EVENT = 'vireek:open-ask-data';

function fire(name: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(name));
}

export const openAccessibilityCenter = (): void => fire(OPEN_ACCESSIBILITY_EVENT);
export const openAskData = (): void => fire(OPEN_ASK_DATA_EVENT);
