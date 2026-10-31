# INSTALL-PULSE — Vireek Pulse (loading system)
Separate from the Ask Vireek `INSTALL.md` (do not overwrite it). The two features touch different anchors; the only shared file is `src/App.tsx` and each uses its own Ctrl+F strings.

## 1. New files (copy as-is, same paths)
`src/components/loading/*` · `src/pages/dev/LoadingDemo.tsx` · `e2e/loading.spec.ts` · `scripts/codemod-loading.mjs` · `scripts/add-loading-i18n.mjs` · `BRAND_MOTION.md` · replace `public/favicon.svg`

## 2. Edits to existing files
**index.html** — paste `_snippets/index-head.html` below `<meta name="viewport"`; paste `_snippets/index-body.html` above `<div id="root"></div>`.

**src/main.tsx**
- below `import { ScrollToTop } from '@/components/ScrollToTop';` add `import { BootDismiss } from '@/components/loading/BootDismiss';`
- below `<ScrollToTop />` add `<BootDismiss />`
- replace the 9-line duplicated block (second `<ToastProvider>` … `<ConnectivityProvider>` that follows `</ToastProvider>`) with:
```tsx
              <ToastProvider>
                <UndoProvider>
                <ConnectivityProvider>
```
- Ctrl+F `</AuthProvider>`; between the next `</ConnectivityProvider>` and `</ToastProvider>` insert `</UndoProvider>`
- after the `);` that closes `</StrictMode>,` add `hideNativeSplash();`

**src/App.tsx** (do this BEFORE the codemod)
- below `import { Suspense, lazy } from 'react';` add `import { RouteFallback } from '@/components/loading/RouteFallback';`
- delete the whole `function RouteLoadingFallback() { … }`
- replace `<RouteLoadingFallback />` and all 5 `<PageLoader />` with `<RouteFallback variant="app" />`
- above `const InviteAcceptPage = lazy(` add `const LoadingDemo = import.meta.env.DEV ? lazy(() => import('@/pages/dev/LoadingDemo')) : null; // dev-only`
- below `<Routes>` add `{LoadingDemo && <Route path="/dev/loading" element={<Suspense fallback={<RouteFallback />}><LoadingDemo /></Suspense>} />}`

**src/components/ui/Button.tsx**
- below the first import add:
```tsx
import { useInLoadingScope } from '@/components/loading/LoadingScope';
import { Spinner } from '@/components/loading/Spinner';
import { useDelayedLoading } from '@/components/loading/useDelayedLoading';
```
- below `size?: ButtonSize;` add `/** Keeps width, blocks clicks/submits, announces status. */ loading?: boolean; loadingLabel?: string;`
- in `baseStyles`: `'focus-ring inline-flex` → `'focus-ring relative inline-flex`, and append ` aria-[busy=true]:cursor-progress` before the closing quote
- replace everything from `export const Button = forwardRef` up to (not including) `Button.displayName` with:
```tsx
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { variant = 'primary', size = 'md', className = '', children, loading = false, loadingLabel = 'Loading', onClick, ...props },
    ref
  ) => {
    const scoped = useInLoadingScope();
    const spinnerVisible = useDelayedLoading(loading && !scoped);
    return (
      <button
        ref={ref}
        className={`${baseStyles} ${sizeStyles[size]} ${variantStyles[variant]} ${className}`}
        {...props}
        aria-busy={loading || undefined}
        aria-disabled={loading || props.disabled || undefined}
        onClick={loading ? (e) => e.preventDefault() : onClick}
      >
        {/* display:contents keeps the original flex layout; invisible keeps the exact width */}
        <span className={spinnerVisible ? 'invisible contents' : 'contents'}>{children}</span>
        {spinnerVisible && (
          <span className="absolute inset-0 flex items-center justify-center">
            <Spinner size={size === 'sm' ? 16 : 20} />
          </span>
        )}
        <span role="status" aria-live="polite" className="sr-only">
          {loading ? loadingLabel : ''}
        </span>
      </button>
    );
  }
);
```

## 3. Run order
```
node scripts/add-loading-i18n.mjs
npm run typecheck && npx vitest run
node scripts/codemod-loading.mjs            # dry run
node scripts/codemod-loading.mjs --write    # then review MIGRATION_REPORT.md
npm run typecheck && npm run lint:design
npx playwright test e2e/loading.spec.ts
E2E_DEV=1 E2E_BASE_URL=http://localhost:5173 npx playwright test e2e/loading.spec.ts   # demo-page checks (dev server)
```
