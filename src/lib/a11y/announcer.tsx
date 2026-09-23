// src/lib/a11y/announcer.tsx
//
// Global aria-live region (WCAG 4.1.3 Status Messages). Toast/تایید‌های
// async روی صفحه دیده می‌شن ولی برای screen reader هیچی نمی‌گن مگر یک
// عنصر aria-live اونا رو اعلام کنه — این همون یک ریجن مشترکه که یک‌بار
// توی App.tsx mount می‌شه.
import { useEffect, useState } from 'react';

type Politeness = 'polite' | 'assertive';

let listeners: Array<(msg: string, politeness: Politeness) => void> = [];

/** از هرجای اپ می‌شه صداش زد — بدون نیاز به context/provider. */
export function announce(message: string, politeness: Politeness = 'polite') {
  listeners.forEach((l) => l(message, politeness));
}

export function AriaLiveRegion() {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');

  useEffect(() => {
    const listener = (msg: string, politeness: Politeness) => {
      if (politeness === 'assertive') {
        setAssertive('');
        requestAnimationFrame(() => setAssertive(msg));
      } else {
        setPolite('');
        requestAnimationFrame(() => setPolite(msg));
      }
    };
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  }, []);

  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {polite}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true" className="sr-only">
        {assertive}
      </div>
    </>
  );
}
