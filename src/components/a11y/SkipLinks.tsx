const LABELS: Record<string, string> = {
  en: 'Skip to main content',
  fa: 'پرش به محتوای اصلی',
  ar: 'تخطي إلى المحتوى الرئيسي',
  es: 'Saltar al contenido principal',
  fr: 'Aller au contenu principal',
  de: 'Zum Hauptinhalt springen',
};

const SKIP_CLASS = [
  'sr-only',
  'focus:not-sr-only',
  'focus:fixed',
  'focus:left-4',
  'focus:top-4',
  'focus:z-[200]',
  'focus:rounded-xl',
  'focus:bg-accent',
  'focus:px-4',
  'focus:py-2.5',
  'focus:text-sm',
  'focus:font-semibold',
  'focus:text-white',
].join(' ');

export function SkipLinks({ language }: { language?: string }) {
  const key = (language ?? 'en').toLowerCase().split('-')[0];
  const label = LABELS[key] ?? LABELS.en;
  return (
    <a href="#main-content" className={SKIP_CLASS}>
      {label}
    </a>
  );
}
