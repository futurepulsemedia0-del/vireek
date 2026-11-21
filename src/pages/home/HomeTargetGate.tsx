import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { isNative } from '@/lib/native/platform';
import { isStandaloneDisplay } from '@/lib/pwa/installPrompt';

/**
 * In the Vireek Home native build (`vite build --mode home`) the site root jumps
 * straight into the homeowner app; everywhere else it renders the normal page.
 */
export function HomeTargetGate({ children }: { children: ReactNode }) {
  if (import.meta.env.MODE === 'home') return <Navigate to="/home" replace />;
  // اپ نصب‌شده (PWA) یا اپ Capacitor: لندینگ بازاریابی نشان داده نمی‌شود.
  // /dashboard اگر کاربر وارد نشده باشد به /login می‌رود (ProtectedRoute) و بعد از ورود همان‌جا می‌ماند.
  if (isNative() || isStandaloneDisplay()) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}
