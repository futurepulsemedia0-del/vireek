import { createContext, useContext, type ReactNode } from 'react';

const ScopeContext = createContext(false);

/** Marks a subtree as "a loader is already showing for this wait": nested Button/Boundary stay quiet. */
export function LoadingScope({ children }: { children: ReactNode }) {
  return <ScopeContext.Provider value={true}>{children}</ScopeContext.Provider>;
}

export function useInLoadingScope(): boolean {
  return useContext(ScopeContext);
}
