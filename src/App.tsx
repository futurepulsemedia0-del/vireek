import { Suspense, lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
import { HomePage } from '@/pages/HomePage';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { StaffRoute } from '@/components/StaffRoute';
import { PartnerRoute } from '@/components/PartnerRoute';
import { SkipToContent } from '@/components/a11y/SkipToContent';
import { AriaLiveRegion } from '@/lib/a11y/announcer';

// Performance pass: only the landing page (the route almost every first-time
// visitor lands on) ships eagerly in the main bundle. Every other route —
// marketing pages, auth flows, and the entire authenticated dashboard — is
// code-split behind React.lazy so the initial JS payload (and therefore LCP)
// stays small regardless of how large the app grows. Named exports are kept
// consistent across pages specifically so this mapping stays mechanical.
const MarketingPage = lazy(() => import('@/pages/MarketingPage'));
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
const CommunityForumPage = lazy(() => import('@/pages/CommunityForumPage').then((m) => ({ default: m.CommunityForumPage })));
const CommunityThreadPage = lazy(() => import('@/pages/CommunityThreadPage').then((m) => ({ default: m.CommunityThreadPage })));
const AmbassadorPage = lazy(() => import('@/pages/AmbassadorPage').then((m) => ({ default: m.AmbassadorPage })));
const SupportInboxPage = lazy(() => import('@/pages/SupportInboxPage').then((m) => ({ default: m.SupportInboxPage })));
const PricingPage = lazy(() => import('@/pages/PricingPage').then((m) => ({ default: m.PricingPage })));
const DashboardPage = lazy(() => import('@/pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const CallsPage = lazy(() => import('@/pages/CallsPage').then((m) => ({ default: m.CallsPage })));
const VoicemailsPage = lazy(() => import('@/pages/VoicemailsPage').then((m) => ({ default: m.VoicemailsPage })));
const LeadsPage = lazy(() => import('@/pages/LeadsPage').then((m) => ({ default: m.LeadsPage })));
const CustomersPage = lazy(() => import('@/pages/CustomersPage').then((m) => ({ default: m.CustomersPage })));
const CustomerIntelligencePage = lazy(() => import('@/pages/CustomerIntelligencePage').then((m) => ({ default: m.CustomerIntelligencePage })));
const TradePlaybooksPage = lazy(() => import('@/pages/TradePlaybooksPage').then((m) => ({ default: m.TradePlaybooksPage })));
const PlaybooksPage = lazy(() => import('@/pages/PlaybooksPage').then((m) => ({ default: m.PlaybooksPage })));
const AgentGovernancePage = lazy(() => import('@/pages/AgentGovernancePage').then((m) => ({ default: m.AgentGovernancePage })));
const AgentCompanyPage = lazy(() => import('@/pages/AgentCompanyPage').then((m) => ({ default: m.AgentCompanyPage })));
const AutonomyBudgetPage = lazy(() => import('@/pages/AutonomyBudgetPage').then((m) => ({ default: m.AutonomyBudgetPage })));
const ExecutionReliabilityPage = lazy(() => import('@/pages/ExecutionReliabilityPage').then((m) => ({ default: m.ExecutionReliabilityPage })));
const OutboundCampaignsPage = lazy(() => import('@/pages/OutboundCampaignsPage').then((m) => ({ default: m.OutboundCampaignsPage })));
const JobsPage = lazy(() => import('@/pages/JobsPage').then((m) => ({ default: m.JobsPage })));
const CalendarPage = lazy(() => import('@/pages/CalendarPage').then((m) => ({ default: m.CalendarPage })));
const BusinessProfilePage = lazy(() => import('@/pages/BusinessProfilePage').then((m) => ({ default: m.BusinessProfilePage })));
const InsightsPage = lazy(() => import('@/pages/InsightsPage').then((m) => ({ default: m.InsightsPage })));
const QuotesPage = lazy(() => import('@/pages/QuotesPage').then((m) => ({ default: m.QuotesPage })));
const KnowledgeBasePage = lazy(() => import('@/pages/KnowledgeBasePage').then((m) => ({ default: m.KnowledgeBasePage })));
const WorkflowsPage = lazy(() => import('@/pages/WorkflowsPage').then((m) => ({ default: m.WorkflowsPage })));
const RevenueRecoveryLedgerPage = lazy(() => import('@/pages/RevenueRecoveryLedgerPage').then((m) => ({ default: m.RevenueRecoveryLedgerPage })));
const BusinessDecisionEnginePage = lazy(() => import('@/pages/BusinessDecisionEnginePage').then((m) => ({ default: m.BusinessDecisionEnginePage })));
const CausalWorldSimulatorPage = lazy(() => import('@/pages/CausalWorldSimulatorPage').then((m) => ({ default: m.CausalWorldSimulatorPage })));
const IdentityLearnerPage = lazy(() => import('@/pages/IdentityLearnerPage').then((m) => ({ default: m.IdentityLearnerPage })));
const RegretConsolePage = lazy(() => import('@/pages/RegretConsolePage').then((m) => ({ default: m.RegretConsolePage })));
const BusinessIdentityPage = lazy(() => import('@/pages/BusinessIdentityPage').then((m) => ({ default: m.BusinessIdentityPage })));
const BusinessScientistPage = lazy(() => import('@/pages/BusinessScientistPage').then((m) => ({ default: m.BusinessScientistPage })));
const DecisionDebtPage = lazy(() => import('@/pages/DecisionDebtPage').then((m) => ({ default: m.DecisionDebtPage })));
const OperationalEntropyPage = lazy(() => import('@/pages/OperationalEntropyPage').then((m) => ({ default: m.OperationalEntropyPage })));
const BusinessDigitalTwinPage = lazy(() => import('@/pages/BusinessDigitalTwinPage').then((m) => ({ default: m.BusinessDigitalTwinPage })));
const BusinessWorldModelPage = lazy(() => import('@/pages/BusinessWorldModelPage').then((m) => ({ default: m.BusinessWorldModelPage })));
const BusinessRealityPage = lazy(() => import('@/pages/BusinessRealityPage').then((m) => ({ default: m.BusinessRealityPage })));
const InvisibleRevenueMapPage = lazy(() => import('@/pages/InvisibleRevenueMapPage').then((m) => ({ default: m.InvisibleRevenueMapPage })));
const CashFlowForecastPage = lazy(() => import('@/pages/CashFlowForecastPage').then((m) => ({ default: m.CashFlowForecastPage })));
const RegionalDemandPage = lazy(() => import('@/pages/RegionalDemandPage').then((m) => ({ default: m.RegionalDemandPage })));
const PriceAccuracyPage = lazy(() => import('@/pages/PriceAccuracyPage').then((m) => ({ default: m.PriceAccuracyPage })));
const BenchmarksPage = lazy(() => import('@/pages/BenchmarksPage').then((m) => ({ default: m.BenchmarksPage })));
const QuoteAcceptPage = lazy(() => import('@/pages/QuoteAcceptPage').then((m) => ({ default: m.QuoteAcceptPage })));
const InvoicePage = lazy(() => import('@/pages/InvoicePage').then((m) => ({ default: m.InvoicePage })));
const DispatchBoardPage = lazy(() => import('@/pages/DispatchBoardPage').then((m) => ({ default: m.DispatchBoardPage })));
const InventoryPage = lazy(() => import('@/pages/InventoryPage').then((m) => ({ default: m.InventoryPage })));
const InsuranceClaimsPage = lazy(() => import('@/pages/InsuranceClaimsPage').then((m) => ({ default: m.InsuranceClaimsPage })));
const ComplianceCenterPage = lazy(() => import('@/pages/ComplianceCenterPage').then((m) => ({ default: m.ComplianceCenterPage })));
const CallbackRootCausePage = lazy(() => import('@/pages/CallbackRootCausePage').then((m) => ({ default: m.CallbackRootCausePage })));
const AutonomyReadinessPage = lazy(() => import('@/pages/AutonomyReadinessPage').then((m) => ({ default: m.AutonomyReadinessPage })));
const AccountingPage = lazy(() => import('@/pages/AccountingPage').then((m) => ({ default: m.AccountingPage })));
const PayrollPage = lazy(() => import('@/pages/PayrollPage').then((m) => ({ default: m.PayrollPage })));
const JobQualityGateSettingsPage = lazy(() => import('@/pages/JobQualityGateSettingsPage').then((m) => ({ default: m.JobQualityGateSettingsPage })));
const WarrantyClaimRecoveryPage = lazy(() => import('@/pages/WarrantyClaimRecoveryPage').then((m) => ({ default: m.WarrantyClaimRecoveryPage })));
const ServiceRecoveryPage = lazy(() => import('@/pages/ServiceRecoveryPage').then((m) => ({ default: m.ServiceRecoveryPage })));
const CompoundingFlywheelPage = lazy(() => import('@/pages/CompoundingFlywheelPage').then((m) => ({ default: m.CompoundingFlywheelPage })));
const BusinessImmuneSystemPage = lazy(() => import('@/pages/BusinessImmuneSystemPage').then((m) => ({ default: m.BusinessImmuneSystemPage })));
const LaborMarketplacePage = lazy(() => import('@/pages/LaborMarketplacePage').then((m) => ({ default: m.LaborMarketplacePage })));
const CommercialContractsPage = lazy(() => import('@/pages/CommercialContractsPage').then((m) => ({ default: m.CommercialContractsPage })));
const CustomerSitesPage = lazy(() => import('@/pages/CustomerSitesPage').then((m) => ({ default: m.CustomerSitesPage })));
const PropertyDigitalTwinPage = lazy(() => import('@/pages/PropertyDigitalTwinPage').then((m) => ({ default: m.PropertyDigitalTwinPage })));
const ReviewsPage = lazy(() => import('@/pages/ReviewsPage').then((m) => ({ default: m.ReviewsPage })));
const MembershipsPage = lazy(() => import('@/pages/MembershipsPage').then((m) => ({ default: m.MembershipsPage })));
const OnCallPage = lazy(() => import('@/pages/OnCallPage').then((m) => ({ default: m.OnCallPage })));
const MutualAidPage = lazy(() => import('@/pages/MutualAidPage').then((m) => ({ default: m.MutualAidPage })));
const NetworkHubPage = lazy(() => import('@/pages/NetworkHubPage').then((m) => ({ default: m.NetworkHubPage })));
const NetworkHandoffsPage = lazy(() => import('@/pages/NetworkHandoffsPage').then((m) => ({ default: m.NetworkHandoffsPage })));
const AckEscalationPage = lazy(() => import('@/pages/AckEscalationPage').then((m) => ({ default: m.AckEscalationPage })));
const UnderpricedJobsPage = lazy(() => import('@/pages/UnderpricedJobsPage').then((m) => ({ default: m.UnderpricedJobsPage })));
const EquipmentLifecyclePage = lazy(() => import('@/pages/EquipmentLifecyclePage').then((m) => ({ default: m.EquipmentLifecyclePage })));
const FleetEconomicsPage = lazy(() => import('@/pages/FleetEconomicsPage').then((m) => ({ default: m.FleetEconomicsPage })));
const FieldEvidencePage = lazy(() => import('@/pages/FieldEvidencePage').then((m) => ({ default: m.FieldEvidencePage })));
const CustomerTrustBankPage = lazy(() => import('@/pages/CustomerTrustBankPage').then((m) => ({ default: m.CustomerTrustBankPage })));
const NextBestActionsPage = lazy(() => import('@/pages/NextBestActionsPage').then((m) => ({ default: m.NextBestActionsPage })));
const DiagnosisCopilotPage = lazy(() => import('@/pages/DiagnosisCopilotPage').then((m) => ({ default: m.DiagnosisCopilotPage })));
const MarginGuardrailsPage = lazy(() => import('@/pages/MarginGuardrailsPage').then((m) => ({ default: m.MarginGuardrailsPage })));
const PriceBookPage = lazy(() => import('@/pages/PriceBookPage').then((m) => ({ default: m.PriceBookPage })));
const AutomationMarketplacePage = lazy(() => import('@/pages/AutomationMarketplacePage').then((m) => ({ default: m.AutomationMarketplacePage })));
const FranchiseCommandCenterPage = lazy(() => import('@/pages/FranchiseCommandCenterPage').then((m) => ({ default: m.FranchiseCommandCenterPage })));
const FranchiseGovernancePage = lazy(() => import('@/pages/FranchiseGovernancePage').then((m) => ({ default: m.FranchiseGovernancePage })));
const BusinessContradictionsPage = lazy(() => import('@/pages/BusinessContradictionsPage').then((m) => ({ default: m.BusinessContradictionsPage })));
const CounterfactualLibraryPage = lazy(() => import('@/pages/CounterfactualLibraryPage').then((m) => ({ default: m.CounterfactualLibraryPage })));
const CausalRoiAttributionPage = lazy(() => import('@/pages/CausalRoiAttributionPage').then((m) => ({ default: m.CausalRoiAttributionPage })));
const CounterfactualRealityEnginePage = lazy(() => import('@/pages/CounterfactualRealityEnginePage').then((m) => ({ default: m.CounterfactualRealityEnginePage })));
const CausalChainsPage = lazy(() => import('@/pages/CausalChainsPage').then((m) => ({ default: m.CausalChainsPage })));
const InvoicesPage = lazy(() => import('@/pages/InvoicesPage').then((m) => ({ default: m.InvoicesPage })));
const NegativeKnowledgeStorePage = lazy(() => import('@/pages/NegativeKnowledgeStorePage').then((m) => ({ default: m.NegativeKnowledgeStorePage })));
const CommitmentGraphPage = lazy(() => import('@/pages/CommitmentGraphPage').then((m) => ({ default: m.CommitmentGraphPage })));
const CompanyReflexesPage = lazy(() => import('@/pages/CompanyReflexesPage').then((m) => ({ default: m.CompanyReflexesPage })));
const BusinessEvolutionRoadmapPage = lazy(() => import('@/pages/BusinessEvolutionRoadmapPage').then((m) => ({ default: m.BusinessEvolutionRoadmapPage })));
const BusinessConstitutionPage = lazy(() => import('@/pages/BusinessConstitutionPage').then((m) => ({ default: m.BusinessConstitutionPage })));
const GovernanceCenterPage = lazy(() => import('@/pages/GovernanceCenterPage').then((m) => ({ default: m.GovernanceCenterPage })));
const SelfEvolvingModelPage = lazy(() => import('@/pages/SelfEvolvingModelPage').then((m) => ({ default: m.SelfEvolvingModelPage })));
const ValueAtRiskPage = lazy(() => import('@/pages/ValueAtRiskPage').then((m) => ({ default: m.ValueAtRiskPage })));
const BottleneckMarketMakerPage = lazy(() => import('@/pages/BottleneckMarketMakerPage').then((m) => ({ default: m.BottleneckMarketMakerPage })));
const UncertaintyMapPage = lazy(() => import('@/pages/UncertaintyMapPage').then((m) => ({ default: m.UncertaintyMapPage })));
const EventBusPage = lazy(() => import('@/pages/EventBusPage').then((m) => ({ default: m.EventBusPage })));
const ActivityLedgerPage = lazy(() => import('@/pages/ActivityLedgerPage').then((m) => ({ default: m.ActivityLedgerPage })));
const TechnicianCapacityPage = lazy(() => import('@/pages/TechnicianCapacityPage').then((m) => ({ default: m.TechnicianCapacityPage })));
const CapacityDemandPage = lazy(() => import('@/pages/CapacityDemandPage').then((m) => ({ default: m.CapacityDemandPage })));
const BusinessDriftPage = lazy(() => import('@/pages/BusinessDriftPage').then((m) => ({ default: m.BusinessDriftPage })));
const OpportunityCostLedgerPage = lazy(() => import('@/pages/OpportunityCostLedgerPage').then((m) => ({ default: m.OpportunityCostLedgerPage })));
const CausalShockSimulatorPage = lazy(() => import('@/pages/CausalShockSimulatorPage').then((m) => ({ default: m.CausalShockSimulatorPage })));
const TechnicianPerformancePage = lazy(() => import('@/pages/TechnicianPerformancePage').then((m) => ({ default: m.TechnicianPerformancePage })));
const TechnicianSkillGraphPage = lazy(() => import('@/pages/TechnicianSkillGraphPage').then((m) => ({ default: m.TechnicianSkillGraphPage })));
const ClickToCashAttributionPage = lazy(() => import('@/pages/ClickToCashAttributionPage').then((m) => ({ default: m.ClickToCashAttributionPage })));
const AdvancedRoutingPage = lazy(() => import('@/pages/AdvancedRoutingPage').then((m) => ({ default: m.AdvancedRoutingPage })));
const WeatherSurgeIntelligencePage = lazy(() => import('@/pages/WeatherSurgeIntelligencePage').then((m) => ({ default: m.WeatherSurgeIntelligencePage })));
const EmergencyOperationsPage = lazy(() => import('@/pages/EmergencyOperationsPage').then((m) => ({ default: m.EmergencyOperationsPage })));
const ProfitabilityPage = lazy(() => import('@/pages/ProfitabilityPage').then((m) => ({ default: m.ProfitabilityPage })));
const EconomicAutopilotPage = lazy(() => import('@/pages/EconomicAutopilotPage').then((m) => ({ default: m.EconomicAutopilotPage })));
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
const AccessibilityStatementPage = lazy(() => import('@/pages/AccessibilityStatementPage').then((m) => ({ default: m.AccessibilityStatementPage })));
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
const BookingPage = lazy(() => import('@/pages/BookingPage').then((m) => ({ default: m.BookingPage })));
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
const PartnerApplyPage = lazy(() => import('@/pages/PartnerApplyPage').then((m) => ({ default: m.PartnerApplyPage })));
const PartnerPortalDashboardPage = lazy(() => import('@/pages/PartnerPortalDashboardPage').then((m) => ({ default: m.PartnerPortalDashboardPage })));
const PartnerPortalReferralsPage = lazy(() => import('@/pages/PartnerPortalReferralsPage').then((m) => ({ default: m.PartnerPortalReferralsPage })));
const PartnerPortalResourcesPage = lazy(() => import('@/pages/PartnerPortalResourcesPage').then((m) => ({ default: m.PartnerPortalResourcesPage })));
const PartnerPortalCertificationPage = lazy(() => import('@/pages/PartnerPortalCertificationPage').then((m) => ({ default: m.PartnerPortalCertificationPage })));
const PartnerCertificatePage = lazy(() => import('@/pages/PartnerCertificatePage').then((m) => ({ default: m.PartnerCertificatePage })));
const PartnerReferralRedirectPage = lazy(() => import('@/pages/PartnerReferralRedirectPage').then((m) => ({ default: m.PartnerReferralRedirectPage })));
const PartnerApplicationsAdminPage = lazy(() => import('@/pages/admin/PartnerApplicationsAdminPage').then((m) => ({ default: m.PartnerApplicationsAdminPage })));
const ReferralPage = lazy(() => import('@/pages/ReferralPage').then((m) => ({ default: m.ReferralPage })));
const BetaProgramPage = lazy(() => import('@/pages/BetaProgramPage').then((m) => ({ default: m.BetaProgramPage })));
const WebinarsPage = lazy(() => import('@/pages/WebinarsPage').then((m) => ({ default: m.WebinarsPage })));
const CustomerRoiPage = lazy(() => import('@/pages/CustomerRoiPage').then((m) => ({ default: m.CustomerRoiPage })));
const SystemRequirementsPage = lazy(() => import('@/pages/SystemRequirementsPage').then((m) => ({ default: m.SystemRequirementsPage })));
const CustomerDetailPage = lazy(() => import('@/pages/CustomerDetailPage').then((m) => ({ default: m.CustomerDetailPage })));
const NotificationsPage = lazy(() => import('@/pages/NotificationsPage').then((m) => ({ default: m.NotificationsPage })));
const SettingsPage = lazy(() => import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const SecuritySettingsPage = lazy(() => import('@/pages/SecuritySettingsPage').then((m) => ({ default: m.SecuritySettingsPage })));
const EnterpriseSecurityPage = lazy(() => import('@/pages/EnterpriseSecurityPage').then((m) => ({ default: m.EnterpriseSecurityPage })));
const DataGovernancePage = lazy(() => import('@/pages/DataGovernancePage').then((m) => ({ default: m.DataGovernancePage })));
const SsoLoginPage = lazy(() => import('@/pages/SsoLoginPage').then((m) => ({ default: m.SsoLoginPage })));
const ReliabilityPage = lazy(() => import('@/pages/ReliabilityPage').then((m) => ({ default: m.ReliabilityPage })));
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
const ServiceRecoveryPage = lazy(() => import('@/pages/ServiceRecoveryPage').then((m) => ({ default: m.ServiceRecoveryPage })));
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
        <Route
          path="/staff/partners"
          element={
            <StaffRoute>
              <PartnerApplicationsAdminPage />
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
        <Route path="/accessibility-statement" element={<AccessibilityStatementPage />} />
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
        <Route path="/book/:slug" element={<BookingPage />} />
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
        <Route path="/r/:code" element={<PartnerReferralRedirectPage />} />
        <Route path="/partner-portal/apply" element={<PartnerApplyPage />} />
        <Route path="/partner-portal/certificate" element={<PartnerCertificatePage />} />
        <Route
          path="/partner-portal"
          element={
            <PartnerRoute>
              <PartnerPortalDashboardPage />
            </PartnerRoute>
          }
        />
        <Route
          path="/partner-portal/referrals"
          element={
            <PartnerRoute>
              <PartnerPortalReferralsPage />
            </PartnerRoute>
          }
        />
        <Route
          path="/partner-portal/resources"
          element={
            <PartnerRoute>
              <PartnerPortalResourcesPage />
            </PartnerRoute>
          }
        />
        <Route
          path="/partner-portal/certification"
          element={
            <PartnerRoute>
              <PartnerPortalCertificationPage />
            </PartnerRoute>
          }
        />
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
          path="/dashboard/service-recovery"
          element={
            <ProtectedRoute>
              <ServiceRecoveryPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/flywheel"
          element={
            <ProtectedRoute>
              <CompoundingFlywheelPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/immune-system"
          element={
            <ProtectedRoute>
              <BusinessImmuneSystemPage />
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
          path="/dashboard/settings/enterprise-security"
          element={
            <ProtectedRoute>
              <EnterpriseSecurityPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/settings/data-governance"
          element={
            <ProtectedRoute>
              <DataGovernancePage />
            </ProtectedRoute>
          }
        />
        <Route path="/sso-login" element={<SsoLoginPage />} />
                <Route
          path="/dashboard/settings/api-keys"
          element={
            <ProtectedRoute>
              <ApiKeysPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/reliability"
          element={
            <ProtectedRoute>
              <ReliabilityPage />
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
          path="/dashboard/causal-simulator"
          element={
            <ProtectedRoute>
              <CausalWorldSimulatorPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/identity-learner"
          element={
            <ProtectedRoute>
              <IdentityLearnerPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/regret-console"
          element={
            <ProtectedRoute>
              <RegretConsolePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/business-scientist"
          element={
            <ProtectedRoute>
              <BusinessScientistPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/operating-model"
          element={
            <ProtectedRoute>
              <SelfEvolvingModelPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/decision-debt"
          element={
            <ProtectedRoute>
              <DecisionDebtPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/entropy"
          element={
            <ProtectedRoute>
              <OperationalEntropyPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/digital-twin"
          element={
            <ProtectedRoute>
              <BusinessDigitalTwinPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/world-model"
          element={
            <ProtectedRoute>
              <BusinessWorldModelPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/reality"
          element={
            <ProtectedRoute>
              <BusinessRealityPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/identity"
          element={
            <ProtectedRoute>
              <BusinessIdentityPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/revenue-map"
          element={
            <ProtectedRoute>
              <InvisibleRevenueMapPage />
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
          path="/dashboard/contradictions"
          element={
            <ProtectedRoute>
              <BusinessContradictionsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/counterfactuals"
          element={
            <ProtectedRoute>
              <CounterfactualLibraryPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/causal-roi"
          element={
            <ProtectedRoute>
              <CausalRoiAttributionPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/reality-engine"
          element={
            <ProtectedRoute>
              <CounterfactualRealityEnginePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/causal-chains"
          element={
            <ProtectedRoute>
              <CausalChainsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/invoicing"
          element={
            <ProtectedRoute>
              <InvoicesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/community"
          element={
            <ProtectedRoute>
              <CommunityForumPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/community/:threadId"
          element={
            <ProtectedRoute>
              <CommunityThreadPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/negative-knowledge"
          element={
            <ProtectedRoute>
              <NegativeKnowledgeStorePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/commitments"
          element={
            <ProtectedRoute>
              <CommitmentGraphPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/reflexes"
          element={
            <ProtectedRoute>
              <CompanyReflexesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/roadmap"
          element={
            <ProtectedRoute>
              <BusinessEvolutionRoadmapPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/constitution"
          element={
            <ProtectedRoute>
              <BusinessConstitutionPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/governance"
          element={
            <ProtectedRoute>
              <GovernanceCenterPage />
            </ProtectedRoute>
          }
        />
        <Route
  path="/dashboard/value-at-risk"
  element={
    <ProtectedRoute>
      <ValueAtRiskPage />
    </ProtectedRoute>
  }
/>
<Route
  path="/dashboard/bottleneck-market"
  element={
    <ProtectedRoute>
      <BottleneckMarketMakerPage />
    </ProtectedRoute>
  }
/>
<Route
  path="/dashboard/uncertainty-map"
  element={
    <ProtectedRoute>
      <UncertaintyMapPage />
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
          path="/dashboard/customers/:id/sites"
          element={
            <ProtectedRoute>
              <CustomerSitesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/customers/:customerId/sites/:siteId/twin"
          element={
            <ProtectedRoute>
              <PropertyDigitalTwinPage />
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
        <Route path="/invoice/:token" element={<InvoicePage />} />
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
          path="/dashboard/trust-bank"
          element={
            <ProtectedRoute>
              <CustomerTrustBankPage />
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
          path="/dashboard/trade-playbooks"
          element={
            <ProtectedRoute>
              <TradePlaybooksPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/agent-governance"
          element={
            <ProtectedRoute>
              <AgentGovernancePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/agent-company"
          element={
            <ProtectedRoute>
              <AgentCompanyPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/autonomy-budget"
          element={
            <ProtectedRoute>
              <AutonomyBudgetPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/execution-reliability"
          element={
            <ProtectedRoute>
              <ExecutionReliabilityPage />
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
          path="/dashboard/routing"
          element={
            <ProtectedRoute>
              <AdvancedRoutingPage />
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
          path="/dashboard/compliance"
          element={
            <ProtectedRoute>
              <ComplianceCenterPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/callback-root-cause"
          element={
            <ProtectedRoute>
              <CallbackRootCausePage />
            </ProtectedRoute>
          }
        />
        <Route
  path="/dashboard/autonomy-readiness"
  element={
    <ProtectedRoute>
      <AutonomyReadinessPage />
    </ProtectedRoute>
  }
/>
<Route
  path="/dashboard/accounting"
  element={
    <ProtectedRoute>
      <AccountingPage />
    </ProtectedRoute>
  }
/>
<Route
  path="/dashboard/payroll"
  element={
    <ProtectedRoute>
      <PayrollPage />
    </ProtectedRoute>
  }
/>
        <Route
          path="/dashboard/job-quality-gate"
          element={
            <ProtectedRoute>
              <JobQualityGateSettingsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/warranty-claims"
          element={
            <ProtectedRoute>
              <WarrantyClaimRecoveryPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/service-recovery"
          element={
            <ProtectedRoute>
              <ServiceRecoveryPage />
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
          path="/dashboard/network"
          element={
            <ProtectedRoute>
              <NetworkHubPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/network/handoffs"
          element={
            <ProtectedRoute>
              <NetworkHandoffsPage />
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
          path="/dashboard/inventory"
          element={
            <ProtectedRoute>
              <InventoryPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/inventory"
          element={
            <ProtectedRoute>
              <InventoryPage />
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
          path="/dashboard/equipment-health"
          element={
            <ProtectedRoute>
              <EquipmentLifecyclePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/fleet-economics"
          element={
            <ProtectedRoute>
              <FleetEconomicsPage />
            </ProtectedRoute>
          }
        />

        <Route
          path="/dashboard/next-best-actions"
          element={
            <ProtectedRoute>
              <NextBestActionsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/diagnosis-copilot"
          element={
            <ProtectedRoute>
              <DiagnosisCopilotPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/margin-guardrails"
          element={
            <ProtectedRoute>
              <MarginGuardrailsPage />
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
          path="/dashboard/franchise/governance"
          element={
            <ProtectedRoute>
              <FranchiseGovernancePage />
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
          path="/dashboard/capacity-demand"
          element={
            <ProtectedRoute>
              <CapacityDemandPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/business-drift"
          element={
            <ProtectedRoute>
              <BusinessDriftPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/opportunity-cost"
          element={
            <ProtectedRoute>
              <OpportunityCostLedgerPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/causal-shock-simulator"
          element={
            <ProtectedRoute>
              <CausalShockSimulatorPage />
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
          path="/dashboard/click-to-cash"
          element={
            <ProtectedRoute>
              <ClickToCashAttributionPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/skill-graph"
          element={
            <ProtectedRoute>
              <TechnicianSkillGraphPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/emergency-ops"
          element={
            <ProtectedRoute>
              <EmergencyOperationsPage />
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
          path="/dashboard/economic-autopilot"
          element={
            <ProtectedRoute>
              <EconomicAutopilotPage />
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
