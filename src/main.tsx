import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { DataRouterShell } from '@/components/system/DataRouterShell';
import { AuthProvider } from '@/contexts/AuthContext';
import { ToastProvider } from '@/contexts/ToastContext';
import { UndoProvider } from '@/contexts/UndoContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { CurrencyProvider } from '@/contexts/CurrencyContext';
import { ExperimentProvider } from '@/contexts/ExperimentContext';
import { AccessibilityProvider } from '@/contexts/AccessibilityContext';
import { ConnectivityProvider } from '@/contexts/ConnectivityContext';
import { AccessibilityWidget } from '@/components/AccessibilityWidget';
import { LanguagePersistenceSync } from '@/components/LanguagePersistenceSync';
import { RouteEffects } from '@/components/nav/RouteEffects';
import { RouteProgressBar } from '@/components/nav/RouteProgress';
import { SessionGuard } from '@/components/session/SessionGuard';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ProductTourProvider } from '@/contexts/ProductTourContext';
import { AnalyticsListener } from '@/components/AnalyticsListener';
import { ConsentManager } from '@/components/consent/ConsentManager';
import { ConnectivityShell } from '@/components/system/ConnectivityShell';
import { NativeBridge } from '@/components/native/NativeBridge';
import { AppLockGate } from '@/components/native/AppLockGate';
import { UpdateGate } from '@/components/native/UpdateGate';
import { BootDismiss } from '@/components/loading/BootDismiss';
import { initNativeRuntime } from '@/lib/native/lifecycle';
import { RegionalProvider } from '@/contexts/RegionalContext';
import { StepUpProvider } from '@/components/security/StepUpProvider';
import { isNative } from '@/lib/native/platform';
import { hideNativeSplash } from '@/lib/native/shell';
import { initInstallPrompt } from '@/lib/pwa/installPrompt';
import { initSentry } from '@/lib/sentry';
import { installChunkRecovery } from '@/lib/chunkRecovery';
import { registerServiceWorker } from '@/lib/pwa/swUpdate';
import { initWebVitals } from '@/lib/perf/webVitals';
import { IdleMount } from '@/components/system/LazyMount';
import '@/i18n'; // site-wide react-i18next setup — must load before any component uses useTranslation()
import './index.css';
import './styles/print.css';

const SiteAssistant = lazy(() => import('@/components/SiteAssistant').then((m) => ({ default: m.SiteAssistant })));
const LiveChatWidget = lazy(() => import('@/components/LiveChatWidget').then((m) => ({ default: m.LiveChatWidget })));

initWebVitals();
initSentry();
installChunkRecovery();
initNativeRuntime();
initInstallPrompt(); // must run at boot: beforeinstallprompt fires only once, early

// Register the push-notification service worker eagerly.
if (!isNative()) registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DataRouterShell>
      <RouteEffects />
      <RouteProgressBar />
      <BootDismiss />
      <AnalyticsListener />
      <ThemeProvider>
        <AccessibilityProvider>
          <ExperimentProvider>
            <CurrencyProvider>
              <ToastProvider>
                <UndoProvider>
                  <ConnectivityProvider>
                    <AuthProvider>
                      <SessionGuard />
                      <RegionalProvider>
                        <ErrorBoundary>
                          <AppLockGate>
                            <ConnectivityShell>
                              <App />
                            </ConnectivityShell>
                          </AppLockGate>
                          <AccessibilityWidget />
                          <LanguagePersistenceSync />
                          <Suspense fallback={null}>
                            <LiveChatWidget />
                          </Suspense>
                          <ConsentManager />
                        </ErrorBoundary>
                      </RegionalProvider>
                    </AuthProvider>
                  </ConnectivityProvider>
                </UndoProvider>
              </ToastProvider>
            </CurrencyProvider>
          </ExperimentProvider>
        </AccessibilityProvider>
      </ThemeProvider>
    </DataRouterShell>
  </StrictMode>,
);

hideNativeSplash();
