import { BrowserRouter } from 'react-router-dom';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { AuthProvider } from '@/contexts/AuthContext';
import { ToastProvider } from '@/contexts/ToastContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { AccessibilityProvider } from '@/contexts/AccessibilityContext';
import { AccessibilityWidget } from '@/components/AccessibilityWidget';
import { ScrollToTop } from '@/components/ScrollToTop';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ScrollToTop />
      <ThemeProvider>
        <AccessibilityProvider>
          <ToastProvider>
            <AuthProvider>
              <ErrorBoundary>
                <App />
                <AccessibilityWidget />
              </ErrorBoundary>
            </AuthProvider>
          </ToastProvider>
        </AccessibilityProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>
);
