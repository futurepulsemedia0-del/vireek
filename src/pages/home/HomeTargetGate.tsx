import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';

/**
 * In the Vireek Home native build (`vite build --mode home`) the site root jumps
 * straight into the homeowner app; everywhere else it renders the normal page.
 */
export function HomeTargetGate({ children }: { children: ReactNode }) {
  if (import.meta.env.MODE === 'home') return <Navigate to="/home" replace />;
  return <>{children}</>;
}
