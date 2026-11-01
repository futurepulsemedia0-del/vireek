import type { ReactNode } from 'react';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';

/**
 * Drop-in replacement for <BrowserRouter>. It mounts a *data* router with one
 * catch-all route, so every existing <Routes>/<Route> below keeps working
 * unchanged while hooks that need a data router (useBlocker) become available.
 *
 * The router is a module singleton so React StrictMode's double render cannot
 * create two routers (each would register its own popstate listener).
 */
let slot: ReactNode = null;
let router: ReturnType<typeof createBrowserRouter> | null = null;

function Slot() {
  return <>{slot}</>;
}

export function DataRouterShell({ children }: { children: ReactNode }) {
  slot = children;
  router ??= createBrowserRouter([{ path: '*', element: <Slot /> }]);
  return <RouterProvider router={router} />;
}
