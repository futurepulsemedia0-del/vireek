// src/components/a11y/SkipToContent.tsx
//
// WCAG 2.4.1 Bypass Blocks — کاربر کیبورد/screen reader بتونه از header/nav
// مستقیم بپره به محتوای اصلی صفحه. تا وقتی focus نگیره مخفیه (اولین Tab
// از بالای صفحه ظاهر می‌شه). یک‌بار توی App.tsx mount می‌شه؛ در کنار
// id="main-content" روی <main>.
export function SkipToContent() {
  return (
    
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[200] focus:rounded-xl focus:bg-accent focus:px-4 focus:py-2.5 focus:text-sm focus:font-semibold focus:text-white focus:shadow-card-hover"
    >
      Skip to main content
    </a>
  );
}
