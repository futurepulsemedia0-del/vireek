import { Suspense, lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
import { HomePage } from '@/pages/HomePage';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { GlossaryPage } from '@/pages/GlossaryPage';

// Performance pass: only the landing page (the route almost every first-time
// visitor lands on) ships eagerly in the main bundle. Every other route —
// marketing pages, auth flows, and the entire authenticated dashboard — is
// code-split behind React.lazy so the initial JS payload (and therefore LCP)
// stays small regardless of how large the app grows. Named exports are kept
// consistent across pages specifically so this mapping stays mechanical.
const LoginPage = lazy(() => import('@/pages/LoginPage').then((m) => ({ default: m.LoginPage })));
const ForgotPasswordPage = lazy(() => import('@/pages/ForgotPasswordPage').then((m) => ({ default: m.ForgotPasswordPage })));
const ResetPasswordPage = lazy(() => import('@/pages/ResetPasswordPage').then((m) => ({ default: m.ResetPasswordPage })));
const SignupPage = lazy(() => import('@/pages/SignupPage').then((m) => ({ default: m.SignupPage })));
const OnboardingPage = lazy(() => import('@/pages/OnboardingPage').then((m) => ({ default: m.OnboardingPage })));
const OnboardingGuidePage = lazy(() => import('@/pages/OnboardingGuidePage').then((m) => ({ default: m.OnboardingGuidePage })));
const PricingPage = lazy(() => import('@/pages/PricingPage').then((m) => ({ default: m.PricingPage })));
const DashboardPage = lazy(() => import('@/pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const CallsPage = lazy(() => import('@/pages/CallsPage').then((m) => ({ default: m.CallsPage })));
const VoicemailsPage = lazy(() => import('@/pages/VoicemailsPage').then((m) => ({ default: m.VoicemailsPage })));
const LeadsPage = lazy(() => import('@/pages/LeadsPage').then((m) => ({ default: m.LeadsPage })));
const JobsPage = lazy(() => import('@/pages/JobsPage').then((m) => ({ default: m.JobsPage })));
const CalendarPage = lazy(() => import('@/pages/CalendarPage').then((m) => ({ default: m.CalendarPage })));
const BusinessProfilePage = lazy(() => import('@/pages/BusinessProfilePage').then((m) => ({ default: m.BusinessProfilePage })));
const InsightsPage = lazy(() => import('@/pages/InsightsPage').then((m) => ({ default: m.InsightsPage })));
const ReviewsPage = lazy(() => import('@/pages/ReviewsPage').then((m) => ({ default: m.ReviewsPage })));
const TeamPage = lazy(() => import('@/pages/TeamPage').then((m) => ({ default: m.TeamPage })));
const BillingPage = lazy(() => import('@/pages/BillingPage').then((m) => ({ default: m.BillingPage })));
const IntegrationsPage = lazy(() => import('@/pages/IntegrationsPage').then((m) => ({ default: m.IntegrationsPage })));
const PrivacyPage = lazy(() => import('@/pages/PrivacyPage').then((m) => ({ default: m.PrivacyPage })));
const CookiePolicyPage = lazy(() => import('@/pages/CookiePolicyPage').then((m) => ({ default: m.CookiePolicyPage })));
const TermsPage = lazy(() => import('@/pages/TermsPage').then((m) => ({ default: m.TermsPage })));
const DpaPage = lazy(() => import('@/pages/DpaPage').then((m) => ({ default: m.DpaPage })));
const SubprocessorsPage = lazy(() => import('@/pages/SubprocessorsPage').then((m) => ({ default: m.SubprocessorsPage })));
const FAQPage = lazy(() => import('@/pages/FAQPage').then((m) => ({ default: m.FAQPage })));
const HelpCenterPage = lazy(() => import('@/pages/HelpCenterPage').then((m) => ({ default: m.HelpCenterPage })));
const AboutPage = lazy(() => import('@/pages/AboutPage').then((m) => ({ default: m.AboutPage })));
const DeveloperDocsPage = lazy(() => import('@/pages/DeveloperDocsPage').then((m) => ({ default: m.DeveloperDocsPage })));
const BlogPage = lazy(() => import('@/pages/BlogPage').then((m) => ({ default: m.BlogPage })));
const BlogPostPage = lazy(() => import('@/pages/BlogPostPage').then((m) => ({ default: m.BlogPostPage })));
const GlossaryPage = lazy(() => import('@/pages/GlossaryPage').then((m) => ({ default: m.GlossaryPage })));
const TestimonialsPage = lazy(() => import('@/pages/TestimonialsPage').then((m) => ({ default: m.TestimonialsPage })));
const ContactPage = lazy(() => import('@/pages/ContactPage').then((m) => ({ default: m.ContactPage })));
const ServicesPage = lazy(() => import('@/pages/ServicesPage').then((m) => ({ default: m.ServicesPage })));
const FeaturesPage = lazy(() => import('@/pages/FeaturesPage').then((m) => ({ default: m.FeaturesPage })));
const LeadQualificationPage = lazy(() => import('@/pages/LeadQualificationPage').then((m) => ({ default: m.LeadQualificationPage })));
const SmsTextBackPage = lazy(() => import('@/pages/SmsTextBackPage').then((m) => ({ default: m.SmsTextBackPage })));
const WhatsAppInstagramDMPage = lazy(() => import('@/pages/WhatsAppInstagramDMPage').then((m) => ({ default: m.WhatsAppInstagramDMPage })));
const WebhookLogsPage = lazy(() => import('@/pages/WebhookLogsPage').then((m) => ({ default: m.WebhookLogsPage })));
const LiveEscalationPage = lazy(() => import('@/pages/LiveEscalationPage').then((m) => ({ default: m.LiveEscalationPage })));
const PlatformPage = lazy(() => import('@/pages/PlatformPage').then((m) => ({ default: m.PlatformPage })));
const ComparePage = lazy(() => import('@/pages/ComparePage').then((m) => ({ default: m.ComparePage })));
const CompetitorPage = lazy(() => import('@/pages/CompetitorPage').then((m) => ({ default: m.CompetitorPage })));
const AIReceptionistVsHumanPage = lazy(() => import('@/pages/AIReceptionistVsHumanPage').then((m) => ({ default: m.AIReceptionistVsHumanPage })));
const IndustriesPage = lazy(() => import('@/pages/IndustriesPage').then((m) => ({ default: m.IndustriesPage })));
const IndustryPage = lazy(() => import('@/pages/IndustryPage').then((m) => ({ default: m.IndustryPage })));
const DemoPage = lazy(() => import('@/pages/DemoPage').then((m) => ({ default: m.DemoPage })));
const CalculatorPage = lazy(() => import('@/pages/CalculatorPage').then((m) => ({ default: m.CalculatorPage })));
const SecurityPage = lazy(() => import('@/pages/SecurityPage').then((m) => ({ default: m.SecurityPage })));
const StatusPage = lazy(() => import('@/pages/StatusPage').then((m) => ({ default: m.StatusPage })));
const CaseStudiesPage = lazy(() => import('@/pages/CaseStudiesPage').then((m) => ({ default: m.CaseStudiesPage })));
const ChangelogPage = lazy(() => import('@/pages/ChangelogPage').then((m) => ({ default: m.ChangelogPage })));
const AccessibilityPage = lazy(() => import('@/pages/AccessibilityPage').then((m) => ({ default: m.AccessibilityPage })));
const AccessibilityConformancePage = lazy(() => import('@/pages/AccessibilityConformancePage').then((m) => ({ default: m.AccessibilityConformancePage })));
const CareersPage = lazy(() => import('@/pages/CareersPage').then((m) => ({ default: m.CareersPage })));
const PressPage = lazy(() => import('@/pages/PressPage').then((m) => ({ default: m.PressPage })));
const PartnersPage = lazy(() => import('@/pages/PartnersPage').then((m) => ({ default: m.PartnersPage })));
const AffiliatePage = lazy(() => import('@/pages/AffiliatePage').then((m) => ({ default: m.AffiliatePage })));
const NotificationsPage = lazy(() => import('@/pages/NotificationsPage').then((m) => ({ default: m.NotificationsPage })));
const SettingsPage = lazy(() => import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const SecuritySettingsPage = lazy(() => import('@/pages/SecuritySettingsPage').then((m) => ({ default: m.SecuritySettingsPage })));
const AssistantPersonaPage = lazy(() => import('@/pages/AssistantPersonaPage').then((m) => ({ default: m.AssistantPersonaPage })));
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage })));
const BadgePage = lazy(() => import('@/pages/BadgePage').then((m) => ({ default: m.BadgePage })));
const IntegrationsHubPage = lazy(() => import('@/pages/IntegrationsHubPage').then((m) => ({ default: m.IntegrationsHubPage })));
const IntegrationDetailPage = lazy(() => import('@/pages/IntegrationDetailPage').then((m) => ({ default: m.IntegrationDetailPage })));
const TrustCenterPage = lazy(() => import('@/pages/TrustCenterPage').then((m) => ({ default: m.TrustCenterPage })));
const AnalyticsPage = lazy(() => import('@/pages/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })));
const SitemapPage = lazy(() => import('@/pages/SitemapPage').then((m) => ({ default: m.SitemapPage })));

function RouteLoadingFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
    </div>
  );
}

function App() {
  return (
    <Suspense fallback={<RouteLoadingFallback />}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<LoginPage />} />
        {/*
          /forgot-password and /reset-password are intentionally plain,
          unprotected routes — never wrapped in <ProtectedRoute>. In
          particular /reset-password must render for visitors with no
          session at all (that's the normal case for a password reset) and
          must never bounce to /login or /dashboard. See
          src/pages/ResetPasswordPage.tsx for the recovery-token handling.
        */}
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/onboarding-guide" element={<OnboardingGuidePage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/cookies" element={<CookiePolicyPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/dpa" element={<DpaPage />} />
        <Route path="/subprocessors" element={<SubprocessorsPage />} />
        <Route path="/faq" element={<FAQPage />} />
        <Route path="/help" element={<HelpCenterPage />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="/docs" element={<DeveloperDocsPage />} />
        <Route path="/blog" element={<BlogPage />} />
        <Route path="/blog/:slug" element={<BlogPostPage />} />
        <Route path="/glossary" element={<GlossaryPage />} />
        <Route path="/testimonials" element={<TestimonialsPage />} />
        <Route path="/contact" element={<ContactPage />} />
        <Route path="/services" element={<ServicesPage />} />
        <Route path="/solutions" element={<ServicesPage />} />
        <Route path="/features" element={<FeaturesPage />} />
        <Route path="/features/lead-qualification" element={<LeadQualificationPage />} />
        <Route path="/features/sms-text-back" element={<SmsTextBackPage />} />
        <Route path="/features/whatsapp-instagram-dm" element={<WhatsAppInstagramDMPage />} />
        <Route path="/features/live-escalation" element={<LiveEscalationPage />} />
        <Route path="/platform" element={<PlatformPage />} />
        <Route path="/compare" element={<ComparePage />} />
        <Route path="/compare/:slug" element={<CompetitorPage />} />
        <Route path="/ai-receptionist-vs-human-receptionist" element={<AIReceptionistVsHumanPage />} />
        <Route path="/industries" element={<IndustriesPage />} />
        <Route path="/industries/:slug" element={<IndustryPage />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/demo" element={<DemoPage />} />
        <Route path="/calculator" element={<CalculatorPage />} />
        <Route path="/security" element={<SecurityPage />} />
        <Route path="/trust" element={<TrustCenterPage />} />
        <Route path="/integrations" element={<IntegrationsHubPage />} />
        <Route path="/integrations/:slug" element={<IntegrationDetailPage />} />
        <Route path="/status" element={<StatusPage />} />
        <Route path="/case-studies" element={<CaseStudiesPage />} />
        <Route path="/changelog" element={<ChangelogPage />} />
        <Route path="/accessibility" element={<AccessibilityPage />} />
        <Route path="/accessibility/conformance" element={<AccessibilityConformancePage />} />
        <Route path="/careers" element={<CareersPage />} />
        <Route path="/press" element={<PressPage />} />
        <Route path="/partners" element={<PartnersPage />} />
        <Route path="/affiliate" element={<AffiliatePage />} />
        <Route path="/badge" element={<BadgePage />} />
        <Route path="/sitemap" element={<SitemapPage />} />
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
          path="/dashboard/notifications"
          element={
            <ProtectedRoute>
              <NotificationsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/settings"
          element={
            <ProtectedRoute>
              <SettingsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/settings/security"
          element={
            <ProtectedRoute>
              <SecuritySettingsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/settings/assistant"
          element={
            <ProtectedRoute>
              <AssistantPersonaPage />
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
          path="/dashboard/voicemails"
          element={
            <ProtectedRoute>
              <VoicemailsPage />
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
        <Route
          path="/dashboard/calendar"
          element={
            <ProtectedRoute>
              <CalendarPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/business-profile"
          element={
            <ProtectedRoute>
              <BusinessProfilePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/insights"
          element={
            <ProtectedRoute>
              <InsightsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/reviews"
          element={
            <ProtectedRoute>
              <ReviewsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/team"
          element={
            <ProtectedRoute>
              <TeamPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/billing"
          element={
            <ProtectedRoute>
              <BillingPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/integrations"
          element={
            <ProtectedRoute>
              <IntegrationsPage />
            </ProtectedRoute>
          }
        />
                <Route
          path="/dashboard/webhook-logs"
          element={
            <ProtectedRoute>
              <WebhookLogsPage />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}

export default App;
