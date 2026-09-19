import { Suspense, lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
import { HomePage } from '@/pages/HomePage';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { ProfitabilityPage } from '@/pages/ProfitabilityPage';
import { StaffRoute } from '@/components/StaffRoute';
import MarketingPage from './pages/MarketingPage';

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
const OnboardingWizard = lazy(() => import('@/pages/onboarding/OnboardingWizard').then((m) => ({ default: m.OnboardingWizard })));
const OnboardingConciergePage = lazy(() => import('@/pages/OnboardingConciergePage').then((m) => ({ default: m.OnboardingConciergePage })));
const OnboardingGuidePage = lazy(() => import('@/pages/OnboardingGuidePage').then((m) => ({ default: m.OnboardingGuidePage })));
const AcademyPage = lazy(() => import('@/pages/AcademyPage').then((m) => ({ default: m.AcademyPage })));
const AcademyCertificatePage = lazy(() => import('@/pages/AcademyCertificatePage').then((m) => ({ default: m.AcademyCertificatePage })));
const CommunityPage = lazy(() => import('@/pages/CommunityPage').then((m) => ({ default: m.CommunityPage })));
const AmbassadorPage = lazy(() => import('@/pages/AmbassadorPage').then((m) => ({ default: m.AmbassadorPage })));
const SupportInboxPage = lazy(() => import('@/pages/SupportInboxPage').then((m) => ({ default: m.SupportInboxPage })));
const PricingPage = lazy(() => import('@/pages/PricingPage').then((m) => ({ default: m.PricingPage })));
const DashboardPage = lazy(() => import('@/pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const CallsPage = lazy(() => import('@/pages/CallsPage').then((m) => ({ default: m.CallsPage })));
const VoicemailsPage = lazy(() => import('@/pages/VoicemailsPage').then((m) => ({ default: m.VoicemailsPage })));
const LeadsPage = lazy(() => import('@/pages/LeadsPage').then((m) => ({ default: m.LeadsPage })));
const CustomersPage = lazy(() => import('@/pages/CustomersPage').then((m) => ({ default: m.CustomersPage })));
const CustomerIntelligencePage = lazy(() => import('@/pages/CustomerIntelligencePage').then((m) => ({ default: m.CustomerIntelligencePage })));
const PlaybooksPage = lazy(() => import('@/pages/PlaybooksPage').then((m) => ({ default: m.PlaybooksPage })));
const OutboundCampaignsPage = lazy(() => import('@/pages/OutboundCampaignsPage').then((m) => ({ default: m.OutboundCampaignsPage })));
const JobsPage = lazy(() => import('@/pages/JobsPage').then((m) => ({ default: m.JobsPage })));
const CalendarPage = lazy(() => import('@/pages/CalendarPage').then((m) => ({ default: m.CalendarPage })));
const BusinessProfilePage = lazy(() => import('@/pages/BusinessProfilePage').then((m) => ({ default: m.BusinessProfilePage })));
const InsightsPage = lazy(() => import('@/pages/InsightsPage').then((m) => ({ default: m.InsightsPage })));
const QuotesPage = lazy(() => import('@/pages/QuotesPage').then((m) => ({ default: m.QuotesPage })));
const KnowledgeBasePage = lazy(() => import('@/pages/KnowledgeBasePage').then((m) => ({ default: m.KnowledgeBasePage })));
const RevenueRecoveryLedgerPage = lazy(() => import('@/pages/RevenueRecoveryLedgerPage').then((m) => ({ default: m.RevenueRecoveryLedgerPage })));
const WorkflowsPage = lazy(() => import('@/pages/WorkflowsPage').then((m) => ({ default: m.WorkflowsPage })));
const BusinessDecisionEnginePage = lazy(() => import('@/pages/BusinessDecisionEnginePage').then((m) => ({ default: m.BusinessDecisionEnginePage })));
const CashFlowForecastPage = lazy(() => import('@/pages/CashFlowForecastPage').then((m) => ({ default: m.CashFlowForecastPage })));
const RegionalDemandPage = lazy(() => import('@/pages/RegionalDemandPage').then((m) => ({ default: m.RegionalDemandPage })));
const PriceAccuracyPage = lazy(() => import('@/pages/PriceAccuracyPage').then((m) => ({ default: m.PriceAccuracyPage })));
const BenchmarksPage = lazy(() => import('@/pages/BenchmarksPage').then((m) => ({ default: m.BenchmarksPage })));
const QuoteAcceptPage = lazy(() => import('@/pages/QuoteAcceptPage').then((m) => ({ default: m.QuoteAcceptPage })));
const DispatchBoardPage = lazy(() => import('@/pages/DispatchBoardPage').then((m) => ({ default: m.DispatchBoardPage })));
const InsuranceClaimsPage = lazy(() => import('@/pages/InsuranceClaimsPage').then((m) => ({ default: m.InsuranceClaimsPage })));
const LaborMarketplacePage = lazy(() => import('@/pages/LaborMarketplacePage').then((m) => ({ default: m.LaborMarketplacePage })));
const CommercialContractsPage = lazy(() => import('@/pages/CommercialContractsPage').then((m) => ({ default: m.CommercialContractsPage })));
const ReviewsPage = lazy(() => import('@/pages/ReviewsPage').then((m) => ({ default: m.ReviewsPage })));
const MembershipsPage = lazy(() => import('@/pages/MembershipsPage').then((m) => ({ default: m.MembershipsPage })));
const OnCallPage = lazy(() => import('@/pages/OnCallPage').then((m) => ({ default: m.OnCallPage })));
const MutualAidPage = lazy(() => import('@/pages/MutualAidPage').then((m) => ({ default: m.MutualAidPage })));
const AckEscalationPage = lazy(() => import('@/pages/AckEscalationPage').then((m) => ({ default: m.AckEscalationPage })));
const UnderpricedJobsPage = lazy(() => import('@/pages/UnderpricedJobsPage').then((m) => ({ default: m.UnderpricedJobsPage })));
const PriceBookPage = lazy(() => import('@/pages/PriceBookPage').then((m) => ({ default: m.PriceBookPage })));
const AutomationMarketplacePage = lazy(() => import('@/pages/AutomationMarketplacePage').then((m) => ({ default: m.AutomationMarketplacePage })));
const FranchiseCommandCenterPage = lazy(() => import('@/pages/FranchiseCommandCenterPage').then((m) => ({ default: m.FranchiseCommandCenterPage })));
const EventBusPage = lazy(() => import('@/pages/EventBusPage').then((m) => ({ default: m.EventBusPage })));
const ActivityLedgerPage = lazy(() => import('@/pages/ActivityLedgerPage').then((m) => ({ default: m.ActivityLedgerPage })));
const TechnicianCapacityPage = lazy(() => import('@/pages/TechnicianCapacityPage').then((m) => ({ default: m.TechnicianCapacityPage })));
const TechnicianPerformancePage = lazy(() => import('@/pages/TechnicianPerformancePage').then((m) => ({ default: m.TechnicianPerformancePage })));
const WeatherSurgeIntelligencePage = lazy(() => import('@/pages/WeatherSurgeIntelligencePage').then((m) => ({ default: m.WeatherSurgeIntelligencePage })));
const ProfitabilityPage = lazy(() => import('@/pages/ProfitabilityPage').then((m) => ({ default: m.ProfitabilityPage })));
const TeamPage = lazy(() => import('@/pages/TeamPage').then((m) => ({ default: m.TeamPage })));
const BillingPage = lazy(() => import('@/pages/BillingPage').then((m) => ({ default: m.BillingPage })));
const UpdatePaymentMethodPage = lazy(() => import('@/pages/UpdatePaymentMethodPage').then((m) => ({ default: m.UpdatePaymentMethodPage })));
const IntegrationsPage = lazy(() => import('@/pages/IntegrationsPage').then((m) => ({ default: m.IntegrationsPage })));
const PaymentsPage = lazy(() => import('@/pages/PaymentsPage').then((m) => ({ default: m.PaymentsPage })));
const PaymentResultPage = lazy(() => import('@/pages/PaymentResultPage').then((m) => ({ default: m.PaymentResultPage })));
const PrivacyPage = lazy(() => import('@/pages/PrivacyPage').then((m) => ({ default: m.PrivacyPage })));
const CookiePolicyPage = lazy(() => import('@/pages/CookiePolicyPage').then((m) => ({ default: m.CookiePolicyPage })));
const TermsPage = lazy(() => import('@/pages/TermsPage').then((m) => ({ default: m.TermsPage })));
const DpaPage = lazy(() => import('@/pages/DpaPage').then((m) => ({ default: m.DpaPage })));
const SubprocessorsPage = lazy(() => import('@/pages/SubprocessorsPage').then((m) => ({ default: m.SubprocessorsPage })));
const RefundPolicyPage = lazy(() => import('@/pages/RefundPolicyPage').then((m) => ({ default: m.RefundPolicyPage })));
const SlaPage = lazy(() => import('@/pages/SlaPage').then((m) => ({ default: m.SlaPage })));
const AcceptableUsePage = lazy(() => import('@/pages/AcceptableUsePage').then((m) => ({ default: m.AcceptableUsePage })));
const ResponsibleAiPage = lazy(() => import('@/pages/ResponsibleAiPage').then((m) => ({ default: m.ResponsibleAiPage })));
const TrademarkPolicyPage = lazy(() => import('@/pages/TrademarkPolicyPage').then((m) => ({ default: m.TrademarkPolicyPage })));
const VulnerabilityDisclosurePage = lazy(() => import('@/pages/VulnerabilityDisclosurePage').then((m) => ({ default: m.VulnerabilityDisclosurePage })));
const CcpaPage = lazy(() => import('@/pages/CcpaPage').then((m) => ({ default: m.CcpaPage })));
const GdprDpaPage = lazy(() => import('@/pages/GdprDpaPage').then((m) => ({ default: m.GdprDpaPage })));
const FAQPage = lazy(() => import('@/pages/FAQPage').then((m) => ({ default: m.FAQPage })));
const HelpCenterPage = lazy(() => import('@/pages/HelpCenterPage').then((m) => ({ default: m.HelpCenterPage })));
const AboutPage = lazy(() => import('@/pages/AboutPage').then((m) => ({ default: m.AboutPage })));
const ManifestoPage = lazy(() => import('@/pages/ManifestoPage').then((m) => ({ default: m.ManifestoPage })));
const LeadershipPage = lazy(() => import('@/pages/LeadershipPage').then((m) => ({ default: m.LeadershipPage })));
const DeveloperDocsPage = lazy(() => import('@/pages/DeveloperDocsPage').then((m) => ({ default: m.DeveloperDocsPage })));
const BlogPage = lazy(() => import('@/pages/BlogPage').then((m) => ({ default: m.BlogPage })));
const BlogPostPage = lazy(() => import('@/pages/BlogPostPage').then((m) => ({ default: m.BlogPostPage })));
const ReportPage = lazy(() => import('@/pages/ReportPage').then((m) => ({ default: m.ReportPage })));
const PodcastPage = lazy(() => import('@/pages/PodcastPage').then((m) => ({ default: m.PodcastPage })));
const GlossaryPage = lazy(() => import('@/pages/GlossaryPage').then((m) => ({ default: m.GlossaryPage })));
const TestimonialsPage = lazy(() => import('@/pages/TestimonialsPage').then((m) => ({ default: m.TestimonialsPage })));
const ContactPage = lazy(() => import('@/pages/ContactPage').then((m) => ({ default: m.ContactPage })));
const ServicesPage = lazy(() => import('@/pages/ServicesPage').then((m) => ({ default: m.ServicesPage })));
const FeaturesPage = lazy(() => import('@/pages/FeaturesPage').then((m) => ({ default: m.FeaturesPage })));
const LeadQualificationPage = lazy(() => import('@/pages/LeadQualificationPage').then((m) => ({ default: m.LeadQualificationPage })));
const SmsTextBackPage = lazy(() => import('@/pages/SmsTextBackPage').then((m) => ({ default: m.SmsTextBackPage })));
const WhatsAppInstagramDMPage = lazy(() => import('@/pages/WhatsAppInstagramDMPage').then((m) => ({ default: m.WhatsAppInstagramDMPage })));
const WebhookLogsPage = lazy(() => import('@/pages/WebhookLogsPage').then((m) => ({ default: m.WebhookLogsPage })));
const LiveEscalationPage = lazy(() => import('./pages/LiveEscalationPage').then((m) => ({ default: m.LiveEscalationPage })));
const PlatformPage = lazy(() => import('@/pages/PlatformPage').then((m) => ({ default: m.PlatformPage })));
const ComparePage = lazy(() => import('@/pages/ComparePage').then((m) => ({ default: m.ComparePage })));
const CompetitorPage = lazy(() => import('@/pages/CompetitorPage').then((m) => ({ default: m.CompetitorPage })));
const SwitchGuidesPage = lazy(() => import('@/pages/SwitchGuidesPage').then((m) => ({ default: m.SwitchGuidesPage })));
const SwitchGuidePage = lazy(() => import('@/pages/SwitchGuidePage').then((m) => ({ default: m.SwitchGuidePage })));
const FeatureMatrixPage = lazy(() => import('@/pages/FeatureMatrixPage').then((m) => ({ default: m.FeatureMatrixPage })));
const AIReceptionistVsHumanPage = lazy(() => import('@/pages/AIReceptionistVsHumanPage').then((m) => ({ default: m.AIReceptionistVsHumanPage })));
const IndustriesPage = lazy(() => import('@/pages/IndustriesPage').then((m) => ({ default: m.IndustriesPage })));
const IndustryPage = lazy(() => import('@/pages/IndustryPage').then((m) => ({ default: m.IndustryPage })));
const DemoPage = lazy(() => import('@/pages/DemoPage').then((m) => ({ default: m.DemoPage })));
const ReschedulePage = lazy(() => import('@/pages/ReschedulePage').then((m) => ({ default: m.ReschedulePage })));
const CustomerPortalPage = lazy(() => import('@/pages/CustomerPortalPage').then((m) => ({ default: m.CustomerPortalPage })));
const CalculatorPage = lazy(() => import('@/pages/CalculatorPage').then((m) => ({ default: m.CalculatorPage })));
const SecurityPage = lazy(() => import('@/pages/SecurityPage').then((m) => ({ default: m.SecurityPage })));
const StatusPage = lazy(() => import('@/pages/StatusPage').then((m) => ({ default: m.StatusPage })));
const StatusUnsubscribePage = lazy(() => import('@/pages/StatusUnsubscribePage').then((m) => ({ default: m.StatusUnsubscribePage })));
const CaseStudiesPage = lazy(() => import('@/pages/CaseStudiesPage').then((m) => ({ default: m.CaseStudiesPage })));
const ChangelogPage = lazy(() => import('@/pages/ChangelogPage').then((m) => ({ default: m.ChangelogPage })));
const RoadmapPage = lazy(() => import('@/pages/RoadmapPage').then((m) => ({ default: m.RoadmapPage })));
const DeveloperChangelogPage = lazy(() => import('@/pages/DeveloperChangelogPage').then((m) => ({ default: m.DeveloperChangelogPage })));
const AccessibilityPage = lazy(() => import('@/pages/AccessibilityPage').then((m) => ({ default: m.AccessibilityPage })));
const AccessibilityConformancePage = lazy(() => import('@/pages/AccessibilityConformancePage').then((m) => ({ default: m.AccessibilityConformancePage })));
const CareersPage = lazy(() => import('@/pages/CareersPage').then((m) => ({ default: m.CareersPage })));
const CulturePage = lazy(() => import('@/pages/CulturePage').then((m) => ({ default: m.CulturePage })));
const PressPage = lazy(() => import('@/pages/PressPage').then((m) => ({ default: m.PressPage })));
const BrandGuidelinesPage = lazy(() => import('@/pages/BrandGuidelinesPage').then((m) => ({ default: m.BrandGuidelinesPage })));
const PartnersPage = lazy(() => import('@/pages/PartnersPage').then((m) => ({ default: m.PartnersPage })));
const AffiliatePage = lazy(() => import('@/pages/AffiliatePage').then((m) => ({ default: m.AffiliatePage })));
const ReferralPage = lazy(() => import('@/pages/ReferralPage').then((m) => ({ default: m.ReferralPage })));
const BetaProgramPage = lazy(() => import('@/pages/BetaProgramPage').then((m) => ({ default: m.BetaProgramPage })));
const WebinarsPage = lazy(() => import('@/pages/WebinarsPage').then((m) => ({ default: m.WebinarsPage })));
const CustomerRoiPage = lazy(() => import('@/pages/CustomerRoiPage').then((m) => ({ default: m.CustomerRoiPage })));
const SystemRequirementsPage = lazy(() => import('@/pages/SystemRequirementsPage').then((m) => ({ default: m.SystemRequirementsPage })));
const CustomerDetailPage = lazy(() => import('@/pages/CustomerDetailPage').then((m) => ({ default: m.CustomerDetailPage })));
const NotificationsPage = lazy(() => import('@/pages/NotificationsPage').then((m) => ({ default: m.NotificationsPage })));
const SettingsPage = lazy(() => import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const SecuritySettingsPage = lazy(() => import('@/pages/SecuritySettingsPage').then((m) => ({ default: m.SecuritySettingsPage })));
const AccountPage = lazy(() => import('@/pages/AccountPage').then((m) => ({ default: m.AccountPage })));
const ApiKeysPage = lazy(() => import('@/pages/ApiKeysPage').then((m) => ({ default: m.ApiKeysPage })));
const AssistantPersonaPage = lazy(() => import('@/pages/AssistantPersonaPage').then((m) => ({ default: m.AssistantPersonaPage })));
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage })));
const BadgePage = lazy(() => import('@/pages/BadgePage').then((m) => ({ default: m.BadgePage })));
const IntegrationsHubPage = lazy(() => import('@/pages/IntegrationsHubPage').then((m) => ({ default: m.IntegrationsHubPage })));
const IntegrationDetailPage = lazy(() => import('@/pages/IntegrationDetailPage').then((m) => ({ default: m.IntegrationDetailPage })));
const TrustCenterPage = lazy(() => import('@/pages/TrustCenterPage').then((m) => ({ default: m.TrustCenterPage })));
const AnalyticsPage = lazy(() => import('@/pages/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })));
const CommandCenterPage = lazy(() => import('@/pages/CommandCenterPage').then((m) => ({ default: m.CommandCenterPage })));
const PhoneNumbersPage = lazy(() => import('@/pages/PhoneNumbersPage').then((m) => ({ default: m.PhoneNumbersPage })));
const UsageDashboardPage = lazy(() => import('@/pages/UsageDashboardPage').then((m) => ({ default: m.UsageDashboardPage })));
const SitemapPage = lazy(() => import('@/pages/SitemapPage').then((m) => ({ default: m.SitemapPage })));
const EnterprisePage = lazy(() => import('@/pages/EnterprisePage').then((m) => ({ default: m.EnterprisePage })));
const MarketplacePage = lazy(() => import('@/pages/MarketplacePage').then((m) => ({ default: m.MarketplacePage })));
const SdksPage = lazy(() => import('@/pages/SdksPage').then((m) => ({ default: m.SdksPage })));
const PromiseTrackerPage = lazy(() => import('@/pages/PromiseTrackerPage').then((m) => ({ default: m.PromiseTrackerPage })));
const SandboxPage = lazy(() => import('@/pages/SandboxPage').then((m) => ({ default: m.SandboxPage })));
const CoachingReportsPage = lazy(() => import('@/pages/CoachingReportsPage').then((m) => ({ default: m.CoachingReportsPage })));
const InviteAcceptPage = lazy(() => import('@/pages/InviteAcceptPage').then((m) => ({ default: m.InviteAcceptPage })));

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
        <Route path="/onboarding" element={<OnboardingWizard />} />
        <Route path="/onboarding/concierge" element={<OnboardingConciergePage />} />
        <Route path="/onboarding/classic" element={<OnboardingPage />} />
        <Route path="/onboarding-guide" element={<OnboardingGuidePage />} />
        <Route path="/academy" element={<AcademyPage />} />
        <Route path="/academy/certificate" element={<AcademyCertificatePage />} />
        <Route path="/community" element={<CommunityPage />} />
        <Route path="/ambassador" element={<AmbassadorPage />} />
        <Route
          path="/staff/support-inbox"
          element={
            <StaffRoute>
              <SupportInboxPage />
            </StaffRoute>
          }
        />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/cookies" element={<CookiePolicyPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/dpa" element={<DpaPage />} />
        <Route path="/subprocessors" element={<SubprocessorsPage />} />
        <Route path="/refund-policy" element={<RefundPolicyPage />} />
        <Route path="/sla" element={<SlaPage />} />
        <Route path="/acceptable-use-policy" element={<AcceptableUsePage />} />
        <Route path="/responsible-ai" element={<ResponsibleAiPage />} />
        <Route path="/trademark-policy" element={<TrademarkPolicyPage />} />
        <Route path="/vulnerability-disclosure" element={<VulnerabilityDisclosurePage />} />
        <Route path="/ccpa" element={<CcpaPage />} />
        <Route path="/gdpr-dpa" element={<GdprDpaPage />} />
        <Route path="/faq" element={<FAQPage />} />
        <Route path="/help" element={<HelpCenterPage />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="/manifesto" element={<ManifestoPage />} />
        <Route path="/leadership" element={<LeadershipPage />} />
        <Route path="/docs" element={<DeveloperDocsPage />} />
        <Route path="/blog" element={<BlogPage />} />
        <Route path="/blog/:slug" element={<BlogPostPage />} />
        <Route path="/report" element={<ReportPage />} />
        <Route path="/podcast" element={<PodcastPage />} />
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
        <Route path="/compare/matrix" element={<FeatureMatrixPage />} />
        <Route path="/compare/:slug" element={<CompetitorPage />} />
        <Route path="/switch" element={<SwitchGuidesPage />} />
        <Route path="/switch/:slug" element={<SwitchGuidePage />} />
        <Route path="/ai-receptionist-vs-human-receptionist" element={<AIReceptionistVsHumanPage />} />
        <Route path="/industries" element={<IndustriesPage />} />
        <Route path="/industries/:slug" element={<IndustryPage />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/enterprise" element={<EnterprisePage />} />
        <Route path="/marketplace" element={<MarketplacePage />} />
        <Route path="/sdks" element={<SdksPage />} />
        <Route path="/sandbox" element={<SandboxPage />} />
        <Route path="/developers/changelog" element={<DeveloperChangelogPage />} />
        <Route path="/demo" element={<DemoPage />} />
        <Route path="/reschedule/:token" element={<ReschedulePage />} />
        <Route path="/ack/:token" element={<AckEscalationPage />} />
        <Route path="/portal/:token" element={<CustomerPortalPage />} />
        <Route path="/calculator" element={<CalculatorPage />} />
        <Route path="/security" element={<SecurityPage />} />
        <Route path="/trust" element={<TrustCenterPage />} />
        <Route path="/integrations" element={<IntegrationsHubPage />} />
        <Route path="/integrations/:slug" element={<IntegrationDetailPage />} />
        <Route path="/status" element={<StatusPage />} />
        <Route path="/status/unsubscribe" element={<StatusUnsubscribePage />} />
        <Route path="/case-studies" element={<CaseStudiesPage />} />
        <Route path="/changelog" element={<ChangelogPage />} />
        <Route path="/roadmap" element={<RoadmapPage />} />
        <Route path="/accessibility" element={<AccessibilityPage />} />
        <Route path="/accessibility/conformance" element={<AccessibilityConformancePage />} />
        <Route path="/careers" element={<CareersPage />} />
        <Route path="/culture" element={<CulturePage />} />
        <Route path="/press" element={<PressPage />} />
        <Route path="/brand" element={<BrandGuidelinesPage />} />
        <Route path="/partners" element={<PartnersPage />} />
        <Route path="/pay-result" element={<PaymentResultPage />} />
        <Route path="/affiliate" element={<AffiliatePage />} />
        <Route path="/referral" element={<ReferralPage />} />
        <Route path="/beta" element={<BetaProgramPage />} />
        <Route path="/webinars" element={<WebinarsPage />} />
        <Route path="/roi" element={<CustomerRoiPage />} />
        <Route path="/system-requirements" element={<SystemRequirementsPage />} />
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
        <Route path="/dashboard/profitability" element={<ProfitabilityPage />} />
        <Route
          path="/dashboard/analytics"
          element={
            <ProtectedRoute>
              <AnalyticsPage />
            </ProtectedRoute>
          }
        />
                <Route
          path="/dashboard/command-center"
          element={
            <ProtectedRoute>
              <CommandCenterPage />
            </ProtectedRoute>
          }
        />
        <Route
  path="/dashboard/phone-numbers"
  element={
    <ProtectedRoute>
      <PhoneNumbersPage />
    </ProtectedRoute>
  }
/>
                <Route
          path="/dashboard/usage"
          element={
            <ProtectedRoute>
              <UsageDashboardPage />
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
          path="/dashboard/promises"
          element={
            <ProtectedRoute>
              <PromiseTrackerPage />
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
          path="/dashboard/settings/api-keys"
          element={
            <ProtectedRoute>
              <ApiKeysPage />
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
          path="/dashboard/coaching-reports"
          element={
            <ProtectedRoute>
              <CoachingReportsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/decision-engine"
          element={
            <ProtectedRoute>
              <BusinessDecisionEnginePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/cash-flow"
          element={
            <ProtectedRoute>
              <CashFlowForecastPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/regional-demand"
          element={
            <ProtectedRoute>
              <RegionalDemandPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/price-accuracy"
          element={
            <ProtectedRoute>
              <PriceAccuracyPage />
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
          path="/dashboard/customers"
          element={
            <ProtectedRoute>
              <CustomersPage />
            </ProtectedRoute>
          }
        />
                <Route
          path="/dashboard/customers/:id"
          element={
            <ProtectedRoute>
              <CustomerDetailPage />
            </ProtectedRoute>
          }
        />
                <Route
          path="/dashboard/customer-intelligence"
          element={
            <ProtectedRoute>
              <CustomerIntelligencePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/outbound-campaigns"
          element={
            <ProtectedRoute>
              <OutboundCampaignsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/marketing"
          element={
            <ProtectedRoute>
              <MarketingPage />
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
          path="/dashboard/quotes"
          element={
            <ProtectedRoute>
              <QuotesPage />
            </ProtectedRoute>
          }
        />
        <Route path="/quote/:token" element={<QuoteAcceptPage />} />
        <Route path="/invite/:token" element={<InviteAcceptPage />} />
                <Route
          path="/dashboard/knowledge"
          element={
            <ProtectedRoute>
              <KnowledgeBasePage />
            </ProtectedRoute>
          }
        />
                <Route
          path="/dashboard/recovery"
          element={
            <ProtectedRoute>
              <RevenueRecoveryLedgerPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/workflows"
          element={
            <ProtectedRoute>
              <WorkflowsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/benchmarks"
          element={
            <ProtectedRoute>
              <BenchmarksPage />
            </ProtectedRoute>
          }
        />
                <Route
          path="/dashboard/playbooks"
          element={
            <ProtectedRoute>
              <PlaybooksPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/dispatch"
          element={
            <ProtectedRoute>
              <DispatchBoardPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/insurance-claims"
          element={
            <ProtectedRoute>
              <InsuranceClaimsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/labor-marketplace"
          element={
            <ProtectedRoute>
              <LaborMarketplacePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/contracts"
          element={
            <ProtectedRoute>
              <CommercialContractsPage />
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
          path="/dashboard/memberships"
          element={
            <ProtectedRoute>
              <MembershipsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/on-call"
          element={
            <ProtectedRoute>
              <OnCallPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/mutual-aid"
          element={
            <ProtectedRoute>
              <MutualAidPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/price-book"
          element={
            <ProtectedRoute>
              <PriceBookPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/underpriced-jobs"
          element={
            <ProtectedRoute>
              <UnderpricedJobsPage />
            </ProtectedRoute>
          }
        />
                <Route
          path="/dashboard/automation-marketplace"
          element={
            <ProtectedRoute>
              <AutomationMarketplacePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/franchise"
          element={
            <ProtectedRoute>
              <FranchiseCommandCenterPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/event-bus"
          element={
            <ProtectedRoute>
              <EventBusPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/activity-ledger"
          element={
            <ProtectedRoute>
              <ActivityLedgerPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/technician-capacity"
          element={
            <ProtectedRoute>
              <TechnicianCapacityPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/technician-performance"
          element={
            <ProtectedRoute>
              <TechnicianPerformancePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/weather-surge"
          element={
            <ProtectedRoute>
              <WeatherSurgeIntelligencePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/profitability"
          element={
            <ProtectedRoute>
              <ProfitabilityPage />
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
          path="/dashboard/billing/update-payment"
          element={
            <ProtectedRoute>
              <UpdatePaymentMethodPage />
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
          path="/dashboard/payments"
          element={
            <ProtectedRoute>
              <PaymentsPage />
            </ProtectedRoute>
          }
        />
                <Route
          path="/dashboard/benchmarks"
          element={
            <ProtectedRoute>
              <BenchmarksPage />
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
