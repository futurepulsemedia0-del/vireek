import { translate } from '@/lib/a11y/strings';

const CLS =
  'sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-[200] focus:rounded-xl focus:bg-text-primary focus:px-4 focus:py-3 focus:text-sm focus:font-semibold focus:text-bg-primary focus:shadow-card-hover';

/** First focusable elements on every page (WCAG 2.4.1). "Skip to main content" already exists in SkipToContent. */
export function SkipLinks({ language }: { language: string }) {
  const toNav = () => {
    const nav = document.querySelector<HTMLElement>('nav,[role="navigation"]');
    if (!nav) return;
    nav.setAttribute('tabindex', '-1');
    nav.focus();
    nav.scrollIntoView({ block: 'start' });
  };
  return (
    <div data-a11y-ui>
      <button type="button" className={CLS} onClick={() => window.dispatchEvent(new CustomEvent('vk-a11y-open'))}>
        {translate(language, 'skipCenter')}
      </button>
      <button type="button" className={CLS} onClick={toNav}>
        {translate(language, 'skipNav')}
      </button>
    </div>
  );
}
