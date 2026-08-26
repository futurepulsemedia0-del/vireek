import { Routes, Route } from 'react-router-dom';
import { LoginPage } from '@/pages/LoginPage';
import { OnboardingPage } from '@/pages/OnboardingPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { AnalyticsPage } from '@/pages/AnalyticsPage';
import { CallsPage } from '@/pages/CallsPage';
import { LeadsPage } from '@/pages/LeadsPage';
import { JobsPage } from '@/pages/JobsPage';
import { ProtectedRoute } from '@/components/ProtectedRoute';

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/onboarding" element={<OnboardingPage />} />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/dashboard/analytics"
        element={
          <ProtectedRoute>
            <AnalyticsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/dashboard/calls"
        element={
          <ProtectedRoute>
            <CallsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/dashboard/leads"
        element={
          <ProtectedRoute>
            <LeadsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/dashboard/jobs"
        element={
          <ProtectedRoute>
            <JobsPage />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<LoginPage />} />
    </Routes>
  );
}

export default App;
