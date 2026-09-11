import { BrowserRouter } from 'react-router-dom';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { AuthProvider } from '@/contexts/AuthContext';
import { ToastProvider } from '@/contexts/ToastContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { CurrencyProvider } from '@/contexts/CurrencyContext';
import { ExperimentProvider } from '@/contexts/ExperimentContext';
import { AccessibilityProvider } from '@/contexts/AccessibilityContext';
import { AccessibilityWidget } from '@/components/AccessibilityWidget';
import { SiteAssistant } from '@/components/SiteAssistant';
import { ScrollToTop } from '@/components/ScrollToTop';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AnalyticsListener } from '@/components/AnalyticsListener';
import { initSentry } from '@/lib/sentry';
import '@/i18n'; // site-wide react-i18next setup — must load before any component uses useTranslation()
import './index.css';
import './styles/print.css';

initSentry();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ScrollToTop />
      <AnalyticsListener />
      <ThemeProvider>
        <AccessibilityProvider>
          <ExperimentProvider>
            <CurrencyProvider>
              <ToastProvider>
                <AuthProvider>
                  <ErrorBoundary>
                    <App />
                    <AccessibilityWidget />
                    <SiteAssistant />
                  </ErrorBoundary>
                </AuthProvider>
              </ToastProvider>
            </CurrencyProvider>
          </ExperimentProvider>
        </AccessibilityProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>
);
