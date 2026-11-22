import { createContext, useContext, type HTMLAttributes, type ReactNode } from 'react';

/**
 * Is the loader rendered inside the persistent dashboard chrome (mobile header, sidebar, bottom nav)?
 * Provided by DashboardChrome. Outside it (marketing, auth guards, the shell's own fallback) it is false.
 */
const InShellContext = createContext(false);

export function LoaderInsetProvider({ children }: { children: ReactNode }) {
  return <InShellContext.Provider value={true}>{children}</InShellContext.Provider>;
}

/**
 * Full-area stage for page-level loaders. It is `fixed`, so the mark is centred in the area the person can
 * actually see, no matter what sits above it in the page (breadcrumbs, banners, headers), how tall the page is,
 * or whether the loader has copy under it. Inside the dashboard it leaves the chrome uncovered:
 *   mobile  → below the 56px header, above the bottom nav (+ any sticky bottom bar)
 *   desktop → right of the 15rem sidebar
 * Sits at z-20, under the chrome (sidebar z-30, header z-40, bottom nav z-40) and the drawers/overlays.
 */
export function LoaderStage({ className = '', children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const inShell = useContext(InShellContext);
  const box = inShell
    ? 'inset-x-0 top-[calc(3.5rem+1px)] bottom-[calc(var(--vk-bottom-nav-h,0px)+var(--vk-bottom-bar-h,0px))] lg:left-60 lg:top-0'
    : 'inset-0 pb-[env(safe-area-inset-bottom,0px)] pt-[env(safe-area-inset-top,0px)]';
  return (
    <div
      data-loader-stage={inShell ? 'shell' : 'viewport'}
      className={`fixed z-20 flex flex-col items-center justify-center bg-bg-primary print:hidden ${box} ${className}`.trim()}
      {...rest}
    >
      {children}
    </div>
  );
}
