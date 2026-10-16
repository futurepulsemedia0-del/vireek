import { CustomDomainGate } from '@/components/CustomDomainGate';
import { Suspense, lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
import { HomePage } from '@/pages/HomePage';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { StaffRoute } from '@/components/StaffRoute';
import { TechnicianRoute } from '@/components/TechnicianRoute';
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
const AudiencesPage = lazy(() => import('@/pages/AudiencesPage'));
const EmailCampaignsPage = lazy(() => import('@/pages/EmailCampaignsPage'));
const EmailUnsubscribePage = lazy(() => import('@/pages/EmailUnsubscribePage'));
const CampaignDetailPage = lazy(() => import('@/pages/CampaignDetailPage').then((m) => ({ default: m.CampaignDetailPage })));
const LoginPage = lazy(() => import('@/pages/LoginPage').then((m) => ({ default: m.LoginPage })));
const ForgotPasswordPage = lazy(() => import('@/pages/ForgotPasswordPage').then((m) => ({ default: m.ForgotPasswordPage })));
const VerifyEmailPage = lazy(() => import('@/pages/VerifyEmailPage').then((m) => ({ default: m.VerifyEmailPage })));
const ResetPasswordPage = lazy(() => import('@/pages/ResetPasswordPage').then((m) => ({ default: m.ResetPasswordPage })));
const MfaChallengePage = lazy(() => import('@/pages/MfaChallengePage').then((m) => ({ default: m.MfaChallengePage })));
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
const SupportTicketsPage = lazy(() => import('@/pages/SupportTicketsPage').then((m) => ({ default: m.SupportTicketsPage })));
const GettingStartedPage = lazy(() => import('@/pages/GettingStartedPage').then((m) => ({ default: m.GettingStartedPage })));
const PropertyIntelligencePage = lazy(() => import('@/pages/PropertyIntelligencePage').then((m) => ({ default: m.PropertyIntelligencePage })));
const ProcurementPage = lazy(() => import('@/pages/ProcurementPage').then((m) => ({ default: m.ProcurementPage })));
const CallsPage = lazy(() => import('@/pages/CallsPage').then((m) => ({ default: m.CallsPage })));
const CallDetailPage = lazy(() => import('@/pages/CallDetailPage').then((m) => ({ default: m.CallDetailPage })));
const UnifiedInboxPage = lazy(() => import('@/pages/UnifiedInboxPage').then((m) => ({ default: m.UnifiedInboxPage })));
const GoalOrchestratorPage = lazy(() => import('@/pages/GoalOrchestratorPage').then((m) => ({ default: m.GoalOrchestratorPage })));
const VoicemailsPage = lazy(() => import('@/pages/VoicemailsPage').then((m) => ({ default: m.VoicemailsPage })));
const LeadsPage = lazy(() => import('@/pages/LeadsPage').then((m) => ({ default: m.LeadsPage })));
const LeadDetailPage = lazy(() => import('@/pages/LeadDetailPage').then((m) => ({ default: m.LeadDetailPage })));
const CustomersPage = lazy(() => import('@/pages/CustomersPage').then((m) => ({ default: m.CustomersPage })));
const CustomerIntelligencePage = lazy(() => import('@/pages/CustomerIntelligencePage').then((m) => ({ default: m.CustomerIntelligencePage })));
const TradePlaybooksPage = lazy(() => import('@/pages/TradePlaybooksPage').then((m) => ({ default: m.TradePlaybooksPage })));
const PlaybooksPage = lazy(() => import('@/pages/PlaybooksPage').then((m) => ({ default: m.PlaybooksPage })));
const AgentGovernancePage = lazy(() => import('@/pages/AgentGovernancePage').then((m) => ({ default: m.AgentGovernancePage })));
const AgentCompanyPage = lazy(() => import('@/pages/AgentCompanyPage').then((m) => ({ default: m.AgentCompanyPage })));
const AgentNetworkPage = lazy(() => import('@/pages/AgentNetworkPage').then((m) => ({ default: m.AgentNetworkPage })));
const EvaluationPlanePage = lazy(() => import('@/pages/EvaluationPlanePage').then((m) => ({ default: m.EvaluationPlanePage })));
const AgentMarketplacePage = lazy(() => import('@/pages/AgentMarketplacePage').then((m) => ({ default: m.AgentMarketplacePage })));
const AutonomyBudgetPage = lazy(() => import('@/pages/AutonomyBudgetPage').then((m) => ({ default: m.AutonomyBudgetPage })));
const ExecutionReliabilityPage = lazy(() => import('@/pages/ExecutionReliabilityPage').then((m) => ({ default: m.ExecutionReliabilityPage })));
const OutboundCampaignsPage = lazy(() => import('@/pages/OutboundCampaignsPage').then((m) => ({ default: m.OutboundCampaignsPage })));
const ReferralsPage = lazy(() => import('@/pages/ReferralsPage').then((m) => ({ default: m.ReferralsPage })));
const VoicemailDropsPage = lazy(() => import('@/pages/VoicemailDropsPage').then((m) => ({ default: m.VoicemailDropsPage })));
const NeighborhoodRevenuePage = lazy(() => import('@/pages/NeighborhoodRevenuePage').then((m) => ({ default: m.NeighborhoodRevenuePage })));
const JobsPage = lazy(() => import('@/pages/JobsPage').then((m) => ({ default: m.JobsPage })));
const JobDetailPage = lazy(() => import('@/pages/JobDetailPage').then((m) => ({ default: m.JobDetailPage })));
const CalendarPage = lazy(() => import('@/pages/CalendarPage').then((m) => ({ default: m.CalendarPage })));
const BusinessProfilePage = lazy(() => import('@/pages/BusinessProfilePage').then((m) => ({ default: m.BusinessProfilePage })));
const InsightsPage = lazy(() => import('@/pages/InsightsPage').then((m) => ({ default: m.InsightsPage })));
const QuotesPage = lazy(() => import('@/pages/QuotesPage').then((m) => ({ default: m.QuotesPage })));
const QuoteDetailPage = lazy(() => import('@/pages/QuoteDetailPage').then((m) => ({ default: m.QuoteDetailPage })));
const KnowledgeBasePage = lazy(() => import('@/pages/KnowledgeBasePage').then((m) => ({ default: m.KnowledgeBasePage })));
const WorkflowsPage = lazy(() => import('@/pages/WorkflowsPage').then((m) => ({ default: m.WorkflowsPage })));
const WorkflowCompilerPage = lazy(() => import('@/pages/WorkflowCompilerPage').then((m) => ({ default: m.WorkflowCompilerPage })));
const RevenueRecoveryLedgerPage = lazy(() => import('@/pages/RevenueRecoveryLedgerPage').then((m) => ({ default: m.RevenueRecoveryLedgerPage })));
const RevenueProtectionPage = lazy(() => import('@/pages/RevenueProtectionPage').then((m) => ({ default: m.RevenueProtectionPage })));
const BusinessDecisionEnginePage = lazy(() => import('@/pages/BusinessDecisionEnginePage').then((m) => ({ default: m.BusinessDecisionEnginePage })));
const AskVireekPage = lazy(() => import('@/pages/AskVireekPage').then((m) => ({ default: m.AskVireekPage })));
const CsrDeskPage = lazy(() => import('@/pages/CsrDeskPage').then((m) => ({ default: m.CsrDeskPage })));
const CausalWorldSimulatorPage = lazy(() => import('@/pages/CausalWorldSimulatorPage').then((m) => ({ default: m.CausalWorldSimulatorPage })));
const PartsMarketPage = lazy(() => import('@/pages/PartsMarketPage').then((m) => ({ default: m.PartsMarketPage })));
const PartsIntelligencePage = lazy(() => import('@/pages/PartsIntelligencePage').then((m) => ({ default: m.PartsIntelligencePage })));
const SupplierIntelligencePage = lazy(() => import('@/pages/SupplierIntelligencePage').then((m) => ({ default: m.SupplierIntelligencePage })));
const SupplyChainOutcomePage = lazy(() => import('@/pages/SupplyChainOutcomePage').then((m) => ({ default: m.SupplyChainOutcomePage })));
const OutcomeAssurancePage = lazy(() => import('@/pages/OutcomeAssurancePage').then((m) => ({ default: m.OutcomeAssurancePage })));
const OutcomeIntelligenceNetworkPage = lazy(() => import('@/pages/OutcomeIntelligenceNetworkPage').then((m) => ({ default: m.OutcomeIntelligenceNetworkPage })));
const OutcomeClearinghousePage = lazy(() => import('@/pages/OutcomeClearinghousePage').then((m) => ({ default: m.OutcomeClearinghousePage })));
const OutcomeVerifyPage = lazy(() => import('@/pages/OutcomeVerifyPage').then((m) => ({ default: m.OutcomeVerifyPage })));
const EvidenceMarketplacePage = lazy(() => import('@/pages/EvidenceMarketplacePage').then((m) => ({ default: m.EvidenceMarketplacePage })));
const EvidencePartnersAdminPage = lazy(() => import('@/pages/admin/EvidencePartnersAdminPage').then((m) => ({ default: m.EvidencePartnersAdminPage })));
const StaffCustomersPage = lazy(() => import('@/pages/admin/StaffCustomersPage').then((m) => ({ default: m.StaffCustomersPage })));
onst StaffUsagePage = lazy(() => import('@/pages/admin/StaffUsagePage').then((m) => ({ default: m.StaffUsagePage })));
const FeatureFlagsAdminPage = lazy(() => import('@/pages/admin/FeatureFlagsAdminPage').then((m) => ({ default: m.FeatureFlagsAdminPage })));
const TruckRollEliminationPage = lazy(() => import('@/pages/TruckRollEliminationPage').then((m) => ({ default: m.TruckRollEliminationPage })));
const EmergencyNetworkPage = lazy(() => import('@/pages/EmergencyNetworkPage').then((m) => ({ default: m.EmergencyNetworkPage })));
const AiReliabilityPage = lazy(() => import('@/pages/AiReliabilityPage').then((m) => ({ default: m.AiReliabilityPage })));
const ServiceGuaranteePage = lazy(() => import('@/pages/ServiceGuaranteePage').then((m) => ({ default: m.ServiceGuaranteePage })));
const ServiceGuaranteePublicPage = lazy(() => import('@/pages/ServiceGuaranteePublicPage').then((m) => ({ default: m.ServiceGuaranteePublicPage })));
const JoinMembershipPage = lazy(() => import('@/pages/JoinMembershipPage').then((m) => ({ default: m.JoinMembershipPage })));
const FinancingOfferPage = lazy(() => import('@/pages/FinancingOfferPage').then((m) => ({ default: m.FinancingOfferPage })));
const ContinuousImprovementPage = lazy(() => import('@/pages/ContinuousImprovementPage').then((m) => ({ default: m.ContinuousImprovementPage })));
const LearningCompilerPage = lazy(() => import('@/pages/LearningCompilerPage').then((m) => ({ default: m.LearningCompilerPage })));
const OperationsSandboxPage = lazy(() => import('@/pages/OperationsSandboxPage').then((m) => ({ default: m.OperationsSandboxPage })));
const OperationsLoopPage = lazy(() => import('@/pages/OperationsLoopPage').then((m) => ({ default: m.OperationsLoopPage })));
const PricingFlywheelPage = lazy(() => import('@/pages/PricingFlywheelPage').then((m) => ({ default: m.PricingFlywheelPage })));
const IdentityLearnerPage = lazy(() => import('@/pages/IdentityLearnerPage').then((m) => ({ default: m.IdentityLearnerPage })));
const RegretConsolePage = lazy(() => import('@/pages/RegretConsolePage').then((m) => ({ default: m.RegretConsolePage })));
const BusinessIdentityPage = lazy(() => import('@/pages/BusinessIdentityPage').then((m) => ({ default: m.BusinessIdentityPage })));
const BusinessScientistPage = lazy(() => import('@/pages/BusinessScientistPage').then((m) => ({ default: m.BusinessScientistPage })));
const DecisionDebtPage = lazy(() => import('@/pages/DecisionDebtPage').then((m) => ({ default: m.DecisionDebtPage })));
const OperationsCenterPage = lazy(() => import('@/pages/OperationsCenterPage').then((m) => ({ default: m.OperationsCenterPage })));
const DecisionLedgerPage = lazy(() => import('@/pages/DecisionLedgerPage').then((m) => ({ default: m.DecisionLedgerPage })));
const OutcomePricingPage = lazy(() => import('@/pages/OutcomePricingPage').then((m) => ({ default: m.OutcomePricingPage })));
const ServiceGraphPage = lazy(() => import('@/pages/ServiceGraphPage').then((m) => ({ default: m.ServiceGraphPage })));
const PropertyVisionPage = lazy(() => import('@/pages/PropertyVisionPage').then((m) => ({ default: m.PropertyVisionPage })));
const DataFabricPage = lazy(() => import('@/pages/DataFabricPage').then((m) => ({ default: m.DataFabricPage })));
const CustomerTrustLayerPage = lazy(() => import('@/pages/CustomerTrustLayerPage').then((m) => ({ default: m.CustomerTrustLayerPage })));
const VerifiedServicePage = lazy(() => import('@/pages/VerifiedServicePage').then((m) => ({ default: m.VerifiedServicePage })));
const OperationalEntropyPage = lazy(() => import('@/pages/OperationalEntropyPage').then((m) => ({ default: m.OperationalEntropyPage })));
const BusinessDigitalTwinPage = lazy(() => import('@/pages/BusinessDigitalTwinPage').then((m) => ({ default: m.BusinessDigitalTwinPage })));
const BusinessWorldModelPage = lazy(() => import('@/pages/BusinessWorldModelPage').then((m) => ({ default: m.BusinessWorldModelPage })));
const BusinessRealityPage = lazy(() => import('@/pages/BusinessRealityPage').then((m) => ({ default: m.BusinessRealityPage })));
const InvisibleRevenueMapPage = lazy(() => import('@/pages/InvisibleRevenueMapPage').then((m) => ({ default: m.InvisibleRevenueMapPage })));
const CashFlowForecastPage = lazy(() => import('@/pages/CashFlowForecastPage').then((m) => ({ default: m.CashFlowForecastPage })));
const BusinessForecastPage = lazy(() => import('@/pages/BusinessForecastPage').then((m) => ({ default: m.BusinessForecastPage })));
const CashFlowWarRoomPage = lazy(() => import('@/pages/CashFlowWarRoomPage').then((m) => ({ default: m.CashFlowWarRoomPage })));
const BankIntelligencePage = lazy(() => import('@/pages/BankIntelligencePage').then((m) => ({ default: m.BankIntelligencePage })));
const RegionalDemandPage = lazy(() => import('@/pages/RegionalDemandPage').then((m) => ({ default: m.RegionalDemandPage })));
const PriceAccuracyPage = lazy(() => import('@/pages/PriceAccuracyPage').then((m) => ({ default: m.PriceAccuracyPage })));
const BenchmarksPage = lazy(() => import('@/pages/BenchmarksPage').then((m) => ({ default: m.BenchmarksPage })));
const ServiceDataExchangePage = lazy(() => import('@/pages/ServiceDataExchangePage').then((m) => ({ default: m.ServiceDataExchangePage })));
const QuoteAcceptPage = lazy(() => import('@/pages/QuoteAcceptPage').then((m) => ({ default: m.QuoteAcceptPage })));
const SignDocumentPage = lazy(() => import('@/pages/SignDocumentPage').then((m) => ({ default: m.SignDocumentPage })));
const InvoicePage = lazy(() => import('@/pages/InvoicePage').then((m) => ({ default: m.InvoicePage })));
const DashboardSnapshotsPage = lazy(() => import('@/pages/DashboardSnapshotsPage').then((m) => ({ default: m.DashboardSnapshotsPage })));
const SharedDashboardPage = lazy(() => import('@/pages/SharedDashboardPage').then((m) => ({ default: m.SharedDashboardPage })));
const DispatchBoardPage = lazy(() => import('@/pages/DispatchBoardPage').then((m) => ({ default: m.DispatchBoardPage })));
const InventoryPage = lazy(() => import('@/pages/InventoryPage').then((m) => ({ default: m.InventoryPage })));
const InventoryCountsPage = lazy(() => import('@/pages/InventoryCountsPage').then((m) => ({ default: m.InventoryCountsPage })));
const VendorManagementPage = lazy(() => import('@/pages/VendorManagementPage').then((m) => ({ default: m.VendorManagementPage })));
const InsuranceClaimsPage = lazy(() => import('@/pages/InsuranceClaimsPage').then((m) => ({ default: m.InsuranceClaimsPage })));
const RiskIntelligencePage = lazy(() => import('@/pages/RiskIntelligencePage').then((m) => ({ default: m.RiskIntelligencePage })));
const ComplianceCenterPage = lazy(() => import('@/pages/ComplianceCenterPage').then((m) => ({ default: m.ComplianceCenterPage })));
const PermitCenterPage = lazy(() => import('@/pages/PermitCenterPage').then((m) => ({ default: m.PermitCenterPage })));
const DocumentsPage = lazy(() => import('@/pages/DocumentsPage').then((m) => ({ default: m.DocumentsPage })));
const GalleryPage = lazy(() => import('@/pages/GalleryPage').then((m) => ({ default: m.GalleryPage })));
const CallbackRootCausePage = lazy(() => import('@/pages/CallbackRootCausePage').then((m) => ({ default: m.CallbackRootCausePage })));
const ReportsPage = lazy(() => import('@/pages/ReportsPage').then((m) => ({ default: m.ReportsPage })));
const ScheduledReportsPage = lazy(() => import('@/pages/ScheduledReportsPage').then((m) => ({ default: m.ScheduledReportsPage })));
const JobAutopsyPage = lazy(() => import('@/pages/JobAutopsyPage').then((m) => ({ default: m.JobAutopsyPage })));
const AutonomyReadinessPage = lazy(() => import('@/pages/AutonomyReadinessPage').then((m) => ({ default: m.AutonomyReadinessPage })));
const AccountingPage = lazy(() => import('@/pages/AccountingPage').then((m) => ({ default: m.AccountingPage })));
const BudgetsPage = lazy(() => import('@/pages/BudgetsPage').then((m) => ({ default: m.BudgetsPage })));
const ChartOfAccountsPage = lazy(() => import('@/pages/ChartOfAccountsPage').then((m) => ({ default: m.ChartOfAccountsPage })));
const BankIntelligencePage = lazy(() => import('@/pages/BankIntelligencePage').then((m) => ({ default: m.BankIntelligencePage })));
const PayrollPage = lazy(() => import('@/pages/PayrollPage').then((m) => ({ default: m.PayrollPage })));
const SessionsPage = lazy(() => import('@/pages/SessionsPage').then((m) => ({ default: m.SessionsPage })));
const CommissionsPage = lazy(() => import('@/pages/CommissionsPage').then((m) => ({ default: m.CommissionsPage })));
const ServiceTwinPage = lazy(() => import('@/pages/ServiceTwinPage').then((m) => ({ default: m.ServiceTwinPage })));
const JobQualityGateSettingsPage = lazy(() => import('@/pages/JobQualityGateSettingsPage').then((m) => ({ default: m.JobQualityGateSettingsPage })));|
const EvidenceChainPage = lazy(() => import('@/pages/EvidenceChainPage').then((m) => ({ default: m.EvidenceChainPage })));
const WarrantyClaimRecoveryPage = lazy(() => import('@/pages/WarrantyClaimRecoveryPage').then((m) => ({ default: m.WarrantyClaimRecoveryPage })));
const ServiceRecoveryPage = lazy(() => import('@/pages/ServiceRecoveryPage').then((m) => ({ default: m.ServiceRecoveryPage })));
const SelfHealingPage = lazy(() => import('@/pages/SelfHealingPage').then((m) => ({ default: m.SelfHealingPage })));
const TemporalRegulationPage = lazy(() => import('@/pages/TemporalRegulationPage').then((m) => ({ default: m.TemporalRegulationPage })));
const CompoundingFlywheelPage = lazy(() => import('@/pages/CompoundingFlywheelPage').then((m) => ({ default: m.CompoundingFlywheelPage })));
const BusinessImmuneSystemPage = lazy(() => import('@/pages/BusinessImmuneSystemPage').then((m) => ({ default: m.BusinessImmuneSystemPage })));
const LaborMarketplacePage = lazy(() => import('@/pages/LaborMarketplacePage').then((m) => ({ default: m.LaborMarketplacePage })));
const CommercialContractsPage = lazy(() => import('@/pages/CommercialContractsPage').then((m) => ({ default: m.CommercialContractsPage })));
const WorkOrdersPage = lazy(() => import('@/pages/WorkOrdersPage').then((m) => ({ default: m.WorkOrdersPage })));
const ContractIntelligencePage = lazy(() => import('@/pages/ContractIntelligencePage').then((m) => ({ default: m.ContractIntelligencePage })));
const ServiceAgreementsPage = lazy(() => import('@/pages/ServiceAgreementsPage').then((m) => ({ default: m.ServiceAgreementsPage })));
const ServiceAgreementDetailPage = lazy(() => import('@/pages/ServiceAgreementDetailPage').then((m) => ({ default: m.ServiceAgreementDetailPage })));
const CustomerSitesPage = lazy(() => import('@/pages/CustomerSitesPage').then((m) => ({ default: m.CustomerSitesPage })));
const PropertyDigitalTwinPage = lazy(() => import('@/pages/PropertyDigitalTwinPage').then((m) => ({ default: m.PropertyDigitalTwinPage })));
const HomeLifetimeGraphPage = lazy(() => import('@/pages/HomeLifetimeGraphPage').then((m) => ({ default: m.HomeLifetimeGraphPage })));
const HomeCapitalPlanPage = lazy(() => import('@/pages/HomeCapitalPlanPage').then((m) => ({ default: m.HomeCapitalPlanPage })));
const HomePassportNetworkPage = lazy(() => import('@/pages/HomePassportNetworkPage').then((m) => ({ default: m.HomePassportNetworkPage })));
const PermitIntelligencePage = lazy(() => import('@/pages/PermitIntelligencePage').then((m) => ({ default: m.PermitIntelligencePage })));
const ReviewsPage = lazy(() => import('@/pages/ReviewsPage').then((m) => ({ default: m.ReviewsPage })));
const MembershipsPage = lazy(() => import('@/pages/MembershipsPage').then((m) => ({ default: m.MembershipsPage })));
const GiftCardsPage = lazy(() => import('@/pages/GiftCardsPage').then((m) => ({ default: m.GiftCardsPage })));
const RecurringJobsPage = lazy(() => import('@/pages/RecurringJobsPage').then((m) => ({ default: m.RecurringJobsPage })));
const TechnicianTodayPage = lazy(() => import('@/pages/TechnicianTodayPage').then((m) => ({ default: m.TechnicianTodayPage })));
const TechnicianJobBriefPage = lazy(() => import('@/pages/TechnicianJobBriefPage').then((m) => ({ default: m.TechnicianJobBriefPage })));
const TechnicianMessagesPage = lazy(() => import('@/pages/TechnicianMessagesPage').then((m) => ({ default: m.TechnicianMessagesPage })));
const TechnicianJobThreadPage = lazy(() => import('@/pages/TechnicianJobThreadPage').then((m) => ({ default: m.TechnicianJobThreadPage })));
const FieldMessagesPage = lazy(() => import('@/pages/FieldMessagesPage').then((m) => ({ default: m.FieldMessagesPage })));
const TechnicianSchedulePage = lazy(() => import('@/pages/TechnicianSchedulePage').then((m) => ({ default: m.TechnicianSchedulePage })));
const TruckStockPage = lazy(() => import('@/pages/TruckStockPage').then((m) => ({ default: m.TruckStockPage })));
const TechEarningsPage = lazy(() => import('@/pages/TechEarningsPage').then((m) => ({ default: m.TechEarningsPage })));
const TechnicianDepositsPage = lazy(() => import('@/pages/TechnicianDepositsPage').then((m) => ({ default: m.TechnicianDepositsPage })));
const ExpertAssistInboxPage = lazy(() => import('@/pages/ExpertAssistInboxPage').then((m) => ({ default: m.ExpertAssistInboxPage })));
const ExpertAssistThreadPage = lazy(() => import('@/pages/ExpertAssistThreadPage').then((m) => ({ default: m.ExpertAssistThreadPage })));
const OnCallPage = lazy(() => import('@/pages/OnCallPage').then((m) => ({ default: m.OnCallPage })));
const NotificationRoutingPage = lazy(() => import('@/pages/NotificationRoutingPage').then((m) => ({ default: m.NotificationRoutingPage })));
const MutualAidPage = lazy(() => import('@/pages/MutualAidPage').then((m) => ({ default: m.MutualAidPage })));
const NetworkHubPage = lazy(() => import('@/pages/NetworkHubPage').then((m) => ({ default: m.NetworkHubPage })));
const NetworkHandoffsPage = lazy(() => import('@/pages/NetworkHandoffsPage').then((m) => ({ default: m.NetworkHandoffsPage })));
const SkillMarketPage = lazy(() => import('@/pages/SkillMarketPage').then((m) => ({ default: m.SkillMarketPage })));
const CapacityExchangePage = lazy(() => import('@/pages/CapacityExchangePage').then((m) => ({ default: m.CapacityExchangePage })));
const HomeDemandExchangePage = lazy(() => import('@/pages/HomeDemandExchangePage').then((m) => ({ default: m.HomeDemandExchangePage })));
const ContextEnginePage = lazy(() => import('@/pages/ContextEnginePage').then((m) => ({ default: m.ContextEnginePage })));
const AckEscalationPage = lazy(() => import('@/pages/AckEscalationPage').then((m) => ({ default: m.AckEscalationPage })));
const UnderpricedJobsPage = lazy(() => import('@/pages/UnderpricedJobsPage').then((m) => ({ default: m.UnderpricedJobsPage })));
const ExpensesPage = lazy(() => import('@/pages/ExpensesPage').then((m) => ({ default: m.ExpensesPage })));
const EquipmentLifecyclePage = lazy(() => import('@/pages/EquipmentLifecyclePage').then((m) => ({ default: m.EquipmentLifecyclePage })));
const BuildingTelemetryPage = lazy(() => import('@/pages/BuildingTelemetryPage').then((m) => ({ default: m.BuildingTelemetryPage })));
const EquipmentPassportsPage = lazy(() => import('@/pages/EquipmentPassportsPage').then((m) => ({ default: m.EquipmentPassportsPage })));
const EquipmentPassportDetailPage = lazy(() => import('@/pages/EquipmentPassportDetailPage').then((m) => ({ default: m.EquipmentPassportDetailPage })));
const PublicEquipmentPassportPage = lazy(() => import('@/pages/PublicEquipmentPassportPage').then((m) => ({ default: m.PublicEquipmentPassportPage })));
const WarrantyRegisterPage = lazy(() => import('@/pages/WarrantyRegisterPage').then((m) => ({ default: m.WarrantyRegisterPage })));
const PublicHomePassportPage = lazy(() => import('@/pages/PublicHomePassportPage').then((m) => ({ default: m.PublicHomePassportPage })));
const HomePassportsPage = lazy(() => import('@/pages/HomePassportsPage').then((m) => ({ default: m.HomePassportsPage })));
const HomePassportDetailPage = lazy(() => import('@/pages/HomePassportDetailPage').then((m) => ({ default: m.HomePassportDetailPage })));
const OEMIntelligencePage = lazy(() => import('@/pages/OEMIntelligencePage').then((m) => ({ default: m.OEMIntelligencePage })));
const OemGraphPage = lazy(() => import('@/pages/OemGraphPage').then((m) => ({ default: m.OemGraphPage })));
const LocationsSettingsPage = lazy(() => import('@/pages/LocationsSettingsPage').then((m) => ({ default: m.LocationsSettingsPage })));
const TimeOffPage = lazy(() => import('@/pages/TimeOffPage').then((m) => ({ default: m.TimeOffPage })));
const TemplatesPage = lazy(() => import('@/pages/TemplatesPage').then((m) => ({ default: m.TemplatesPage })));
const UniversalIdentityPage = lazy(() => import('@/pages/UniversalIdentityPage').then((m) => ({ default: m.UniversalIdentityPage })));
const FieldIntelligencePage = lazy(() => import('@/pages/FieldIntelligencePage').then((m) => ({ default: m.FieldIntelligencePage })));
const PropertyIntelligencePage = lazy(() => import('@/pages/PropertyIntelligencePage').then((m) => ({ default: m.PropertyIntelligencePage })));
const HomeHealthPage = lazy(() => import('@/pages/HomeHealthPage').then((m) => ({ default: m.HomeHealthPage })));
const FleetEconomicsPage = lazy(() => import('@/pages/FleetEconomicsPage').then((m) => ({ default: m.FleetEconomicsPage })));
const TelematicsOSPage = lazy(() => import('@/pages/TelematicsOSPage').then((m) => ({ default: m.TelematicsOSPage })));
const FleetIntelligencePage = lazy(() => import('@/pages/FleetIntelligencePage').then((m) => ({ default: m.FleetIntelligencePage })));
const VehiclesPage = lazy(() => import('@/pages/VehiclesPage').then((m) => ({ default: m.VehiclesPage })));
const TechnicianDvirPage = lazy(() => import('@/pages/TechnicianDvirPage').then((m) => ({ default: m.TechnicianDvirPage })));
const FleetDvirPage = lazy(() => import('@/pages/FleetDvirPage').then((m) => ({ default: m.FleetDvirPage })));
const LiveMapPage = lazy(() => import('@/pages/LiveMapPage').then((m) => ({ default: m.LiveMapPage })));
const FieldEvidencePage = lazy(() => import('@/pages/FieldEvidencePage').then((m) => ({ default: m.FieldEvidencePage })));
const CustomerTrustBankPage = lazy(() => import('@/pages/CustomerTrustBankPage').then((m) => ({ default: m.CustomerTrustBankPage })));
const SwitchingShieldPage = lazy(() => import('@/pages/SwitchingShieldPage').then((m) => ({ default: m.SwitchingShieldPage })));
const NextBestActionsPage = lazy(() => import('@/pages/NextBestActionsPage').then((m) => ({ default: m.NextBestActionsPage })));
const CallQueuePage = lazy(() => import('@/pages/CallQueuePage').then((m) => ({ default: m.CallQueuePage })));
const DiagnosisCopilotPage = lazy(() => import('@/pages/DiagnosisCopilotPage').then((m) => ({ default: m.DiagnosisCopilotPage })));
const ServiceIntelligenceLoopPage = lazy(() => import('@/pages/ServiceIntelligenceLoopPage').then((m) => ({ default: m.ServiceIntelligenceLoopPage })));
const FailureGenomePage = lazy(() => import('@/pages/FailureGenomePage').then((m) => ({ default: m.FailureGenomePage })));
const LiveCopilotPage = lazy(() => import('@/pages/LiveCopilotPage').then((m) => ({ default: m.LiveCopilotPage })));
const MarginGuardrailsPage = lazy(() => import('@/pages/MarginGuardrailsPage').then((m) => ({ default: m.MarginGuardrailsPage })));
const PromoCodesPage = lazy(() => import('@/pages/PromoCodesPage').then((m) => ({ default: m.PromoCodesPage })));
const QuoteTruthEnginePage = lazy(() => import('@/pages/QuoteTruthEnginePage').then((m) => ({ default: m.QuoteTruthEnginePage })));
const OperationalTruthPage = lazy(() => import('@/pages/OperationalTruthPage').then((m) => ({ default: m.OperationalTruthPage })));
const IncentiveEnginePage = lazy(() => import('@/pages/IncentiveEnginePage').then((m) => ({ default: m.IncentiveEnginePage })));
const RebateIntelligencePage = lazy(() => import('@/pages/RebateIntelligencePage').then((m) => ({ default: m.RebateIntelligencePage })));
const EnergyIntelligencePage = lazy(() => import('@/pages/EnergyIntelligencePage').then((m) => ({ default: m.EnergyIntelligencePage })));
const PriceBookPage = lazy(() => import('@/pages/PriceBookPage').then((m) => ({ default: m.PriceBookPage })));
const PriceListsPage = lazy(() => import('@/pages/PriceListsPage').then((m) => ({ default: m.PriceListsPage })));
const FormBuilderPage = lazy(() => import('@/pages/FormBuilderPage').then((m) => ({ default: m.FormBuilderPage })));
const JobTemplatesPage = lazy(() => import('@/pages/JobTemplatesPage').then((m) => ({ default: m.JobTemplatesPage })));
const ServiceCatalogPage = lazy(() => import('@/pages/ServiceCatalogPage').then((m) => ({ default: m.ServiceCatalogPage })));
const AutomationMarketplacePage = lazy(() => import('@/pages/AutomationMarketplacePage').then((m) => ({ default: m.AutomationMarketplacePage })));
const FranchiseCommandCenterPage = lazy(() => import('@/pages/FranchiseCommandCenterPage').then((m) => ({ default: m.FranchiseCommandCenterPage })));
const FranchiseGovernancePage = lazy(() => import('@/pages/FranchiseGovernancePage').then((m) => ({ default: m.FranchiseGovernancePage })));
const BusinessContradictionsPage = lazy(() => import('@/pages/BusinessContradictionsPage').then((m) => ({ default: m.BusinessContradictionsPage })));
const CounterfactualLibraryPage = lazy(() => import('@/pages/CounterfactualLibraryPage').then((m) => ({ default: m.CounterfactualLibraryPage })));
const OrganizationalMemoryPage = lazy(() => import('@/pages/OrganizationalMemoryPage').then((m) => ({ default: m.OrganizationalMemoryPage })));
const CausalRoiAttributionPage = lazy(() => import('@/pages/CausalRoiAttributionPage').then((m) => ({ default: m.CausalRoiAttributionPage })));
const FieldScientistPage = lazy(() => import('@/pages/FieldScientistPage').then((m) => ({ default: m.FieldScientistPage })));
const CounterfactualRealityEnginePage = lazy(() => import('@/pages/CounterfactualRealityEnginePage').then((m) => ({ default: m.CounterfactualRealityEnginePage })));
const CausalChainsPage = lazy(() => import('@/pages/CausalChainsPage').then((m) => ({ default: m.CausalChainsPage })));
const ReceivablesIntelligencePage = lazy(() => import('@/pages/ReceivablesIntelligencePage').then((m) => ({ default: m.ReceivablesIntelligencePage })));
const CollectionsPage = lazy(() => import('@/pages/CollectionsPage').then((m) => ({ default: m.CollectionsPage })));
onst RevenueCausalityGraphPage = lazy(() => import('@/pages/RevenueCausalityGraphPage').then((m) => ({ default: m.RevenueCausalityGraphPage })));
const AdaptiveDiagnosticsPage = lazy(() => import('@/pages/AdaptiveDiagnosticsPage').then((m) => ({ default: m.AdaptiveDiagnosticsPage })));
const PredictiveFailurePage = lazy(() => import('@/pages/PredictiveFailurePage').then((m) => ({ default: m.PredictiveFailurePage })));
const LiveCallsPage = lazy(() => import('@/pages/LiveCallsPage').then((m) => ({ default: m.LiveCallsPage })));
const VerificationNetworkPage = lazy(() => import('@/pages/VerificationNetworkPage').then((m) => ({ default: m.VerificationNetworkPage })));
const PhysicalEconomyNetworkPage = lazy(() => import('@/pages/PhysicalEconomyNetworkPage').then((m) => ({ default: m.PhysicalEconomyNetworkPage })));
const InvoicesPage = lazy(() => import('@/pages/InvoicesPage').then((m) => ({ default: m.InvoicesPage })));
const InvoiceDetailPage = lazy(() => import('@/pages/InvoiceDetailPage').then((m) => ({ default: m.InvoiceDetailPage })));
const TaxCenterPage = lazy(() => import('@/pages/TaxCenterPage').then((m) => ({ default: m.TaxCenterPage })));
const NegativeKnowledgeStorePage = lazy(() => import('@/pages/NegativeKnowledgeStorePage').then((m) => ({ default: m.NegativeKnowledgeStorePage })));
const KnowledgeCapturePage = lazy(() => import('@/pages/KnowledgeCapturePage').then((m) => ({ default: m.KnowledgeCapturePage })));
const FailureAtlasPage = lazy(() => import('@/pages/FailureAtlasPage').then((m) => ({ default: m.FailureAtlasPage })));
const FeedbackAnalyticsPage = lazy(() => import('@/pages/FeedbackAnalyticsPage').then((m) => ({ default: m.FeedbackAnalyticsPage })));
const ImportsPage = lazy(() => import('@/pages/ImportsPage').then((m) => ({ default: m.ImportsPage })));
const CommitmentGraphPage = lazy(() => import('@/pages/CommitmentGraphPage').then((m) => ({ default: m.CommitmentGraphPage })));
const CompanyReflexesPage = lazy(() => import('@/pages/CompanyReflexesPage').then((m) => ({ default: m.CompanyReflexesPage })));
const BusinessEvolutionRoadmapPage = lazy(() => import('@/pages/BusinessEvolutionRoadmapPage').then((m) => ({ default: m.BusinessEvolutionRoadmapPage })));
const BusinessConstitutionPage = lazy(() => import('@/pages/BusinessConstitutionPage').then((m) => ({ default: m.BusinessConstitutionPage })));
const MarketIntelligencePage = lazy(() => import('@/pages/MarketIntelligencePage').then((m) => ({ default: m.MarketIntelligencePage })));
const GovernanceCenterPage = lazy(() => import('@/pages/GovernanceCenterPage').then((m) => ({ default: m.GovernanceCenterPage })));
const SelfEvolvingModelPage = lazy(() => import('@/pages/SelfEvolvingModelPage').then((m) => ({ default: m.SelfEvolvingModelPage })));
const ValueAtRiskPage = lazy(() => import('@/pages/ValueAtRiskPage').then((m) => ({ default: m.ValueAtRiskPage })));
const RevenueAutopsyPage = lazy(() => import('@/pages/RevenueAutopsyPage').then((m) => ({ default: m.RevenueAutopsyPage })));
const LtvAutopilotPage = lazy(() => import('@/pages/LtvAutopilotPage').then((m) => ({ default: m.LtvAutopilotPage })));
const BottleneckMarketMakerPage = lazy(() => import('@/pages/BottleneckMarketMakerPage').then((m) => ({ default: m.BottleneckMarketMakerPage })));
const PreventiveMaintenanceCommandCenterPage = lazy(() => import('@/pages/PreventiveMaintenanceCommandCenterPage').then((m) => ({ default: m.PreventiveMaintenanceCommandCenterPage })));
const UncertaintyMapPage = lazy(() => import('@/pages/UncertaintyMapPage').then((m) => ({ default: m.UncertaintyMapPage })));
const UnknownsEnginePage = lazy(() => import('@/pages/UnknownsEnginePage').then((m) => ({ default: m.UnknownsEnginePage })));
const EventBusPage = lazy(() => import('@/pages/EventBusPage').then((m) => ({ default: m.EventBusPage })));
const EventPredictionMeshPage = lazy(() => import('@/pages/EventPredictionMeshPage').then((m) => ({ default: m.EventPredictionMeshPage })));
const ActivityLedgerPage = lazy(() => import('@/pages/ActivityLedgerPage').then((m) => ({ default: m.ActivityLedgerPage })));
const TrashPage = lazy(() => import('@/pages/TrashPage').then((m) => ({ default: m.TrashPage })));
const DuplicatesPage = lazy(() => import('@/pages/DuplicatesPage').then((m) => ({ default: m.DuplicatesPage })));
const TechnicianCapacityPage = lazy(() => import('@/pages/TechnicianCapacityPage').then((m) => ({ default: m.TechnicianCapacityPage })));
const ServiceAreasPage = lazy(() => import('@/pages/ServiceAreasPage').then((m) => ({ default: m.ServiceAreasPage })));
const CapacityDemandPage = lazy(() => import('@/pages/CapacityDemandPage').then((m) => ({ default: m.CapacityDemandPage })));
const WorkforceEquilibriumPage = lazy(() => import('@/pages/WorkforceEquilibriumPage').then((m) => ({ default: m.WorkforceEquilibriumPage })));
const BusinessDriftPage = lazy(() => import('@/pages/BusinessDriftPage').then((m) => ({ default: m.BusinessDriftPage })));
const ExecutiveReportsPage = lazy(() => import('@/pages/ExecutiveReportsPage').then((m) => ({ default: m.ExecutiveReportsPage })));
const OpportunityCostLedgerPage = lazy(() => import('@/pages/OpportunityCostLedgerPage').then((m) => ({ default: m.OpportunityCostLedgerPage })));
const CausalShockSimulatorPage = lazy(() => import('@/pages/CausalShockSimulatorPage').then((m) => ({ default: m.CausalShockSimulatorPage })));
const TechnicianPerformancePage = lazy(() => import('@/pages/TechnicianPerformancePage').then((m) => ({ default: m.TechnicianPerformancePage })));
const TechnicianSkillGraphPage = lazy(() => import('@/pages/TechnicianSkillGraphPage').then((m) => ({ default: m.TechnicianSkillGraphPage })));
const TechnicianTrustPassportPage = lazy(() => import('@/pages/TechnicianTrustPassportPage').then((m) => ({ default: m.TechnicianTrustPassportPage })));
const TechnicianIdentityGraphPage = lazy(() => import('@/pages/TechnicianIdentityGraphPage').then((m) => ({ default: m.TechnicianIdentityGraphPage })));
const PublicTechnicianPassportPage = lazy(() => import('@/pages/PublicTechnicianPassportPage').then((m) => ({ default: m.PublicTechnicianPassportPage })));
const HomeServicePassportPage = lazy(() => import('@/pages/HomeServicePassportPage').then((m) => ({ default: m.HomeServicePassportPage })));
const PublicHomePassportPage = lazy(() => import('@/pages/PublicHomePassportPage').then((m) => ({ default: m.PublicHomePassportPage })));
const TechnicianSimulatorPage = lazy(() => import('@/pages/TechnicianSimulatorPage').then((m) => ({ default: m.TechnicianSimulatorPage })));
const TechnicianApprenticeshipPage = lazy(() => import('@/pages/TechnicianApprenticeshipPage').then((m) => ({ default: m.TechnicianApprenticeshipPage })));
const AdoptionOSPage = lazy(() => import('@/pages/AdoptionOSPage').then((m) => ({ default: m.AdoptionOSPage })));
const FirstTimeFixAutopilotPage = lazy(() => import('@/pages/FirstTimeFixAutopilotPage').then((m) => ({ default: m.FirstTimeFixAutopilotPage })));
const ResolutionProbabilityPage = lazy(() => import('@/pages/ResolutionProbabilityPage').then((m) => ({ default: m.ResolutionProbabilityPage })));
const OpsExperimentsPage = lazy(() => import('@/pages/OpsExperimentsPage').then((m) => ({ default: m.OpsExperimentsPage })));
const OutcomeBenchmarkNetworkPage = lazy(() => import('@/pages/OutcomeBenchmarkNetworkPage').then((m) => ({ default: m.OutcomeBenchmarkNetworkPage })));
const ClickToCashAttributionPage = lazy(() => import('@/pages/ClickToCashAttributionPage').then((m) => ({ default: m.ClickToCashAttributionPage })));
const LeadMarketplacesPage = lazy(() => import('@/pages/LeadMarketplacesPage').then((m) => ({ default: m.LeadMarketplacesPage })));
const DemandOsPage = lazy(() => import('@/pages/DemandOsPage').then((m) => ({ default: m.DemandOsPage })));
const AdvancedRoutingPage = lazy(() => import('@/pages/AdvancedRoutingPage').then((m) => ({ default: m.AdvancedRoutingPage })));
const BlocklistPage = lazy(() => import('@/pages/BlocklistPage').then((m) => ({ default: m.BlocklistPage })));
const CallRoutingPage = lazy(() => import('@/pages/CallRoutingPage').then((m) => ({ default: m.CallRoutingPage })));
const WeatherSurgeIntelligencePage = lazy(() => import('@/pages/WeatherSurgeIntelligencePage').then((m) => ({ default: m.WeatherSurgeIntelligencePage })));
const EmergencyOperationsPage = lazy(() => import('@/pages/EmergencyOperationsPage').then((m) => ({ default: m.EmergencyOperationsPage })));
const ProfitabilityPage = lazy(() => import('@/pages/ProfitabilityPage').then((m) => ({ default: m.ProfitabilityPage })));
const EconomicAutopilotPage = lazy(() => import('@/pages/EconomicAutopilotPage').then((m) => ({ default: m.EconomicAutopilotPage })));
const TeamPage = lazy(() => import('@/pages/TeamPage').then((m) => ({ default: m.TeamPage })));
const TechnicianDetailPage = lazy(() => import('@/pages/TechnicianDetailPage').then((m) => ({ default: m.TechnicianDetailPage })));
const BillingPage = lazy(() => import('@/pages/BillingPage').then((m) => ({ default: m.BillingPage })));
const BillingPlansPage = lazy(() => import('@/pages/BillingPlansPage').then((m) => ({ default: m.BillingPlansPage })));
const CancelSubscriptionPage = lazy(() => import('@/pages/CancelSubscriptionPage').then((m) => ({ default: m.CancelSubscriptionPage })));
const FinancingCenterPage = lazy(() => import('@/pages/FinancingCenterPage').then((m) => ({ default: m.FinancingCenterPage })));
const UpdatePaymentMethodPage = lazy(() => import('@/pages/UpdatePaymentMethodPage').then((m) => ({ default: m.UpdatePaymentMethodPage })));
const SlackTeamsSettingsPage = lazy(() => import('@/pages/SlackTeamsSettingsPage').then((m) => ({ default: m.SlackTeamsSettingsPage })));
const BillingInvoicesPage = lazy(() => import('@/pages/BillingInvoicesPage').then((m) => ({ default: m.BillingInvoicesPage })));
const IntegrationsPage = lazy(() => import('@/pages/IntegrationsPage').then((m) => ({ default: m.IntegrationsPage })));
const PaymentsPage = lazy(() => import('@/pages/PaymentsPage').then((m) => ({ default: m.PaymentsPage })));
const RefundsPage = lazy(() => import('@/pages/RefundsPage').then((m) => ({ default: m.RefundsPage })));
const PaymentResultPage = lazy(() => import('@/pages/PaymentResultPage').then((m) => ({ default: m.PaymentResultPage })));
const PublicPaymentPage = lazy(() => import('@/pages/PublicPaymentPage').then((m) => ({ default: m.PublicPaymentPage })));
const PrivacyPage = lazy(() => import('@/pages/PrivacyPage').then((m) => ({ default: m.PrivacyPage })));
const CookiePolicyPage = lazy(() => import('@/pages/CookiePolicyPage').then((m) => ({ default: m.CookiePolicyPage })));
const TermsPage = lazy(() => import('@/pages/TermsPage').then((m) => ({ default: m.TermsPage })));
const DpaPage = lazy(() => import('@/pages/DpaPage').then((m) => ({ default: m.DpaPage })));
const SubprocessorsPage = lazy(() => import('@/pages/SubprocessorsPage').then((m) => ({ default: m.SubprocessorsPage })));
const RefundPolicyPage = lazy(() => import('@/pages/RefundPolicyPage').then((m) => ({ default: m.RefundPolicyPage })));
const SlaPage = lazy(() => import('@/pages/SlaPage').then((m) => ({ default: m.SlaPage })));
const AcceptableUsePage = lazy(() => import('@/pages/AcceptableUsePage').then((m) => ({ default: m.AcceptableUsePage })));
const ResponsibleAiPage = lazy(() => import('@/pages/ResponsibleAiPage').then((m) => ({ default: m.ResponsibleAiPage })));
const MsaPage = lazy(() => import('@/pages/MsaPage').then((m) => ({ default: m.MsaPage })));
const AiDisclosurePage = lazy(() => import('@/pages/AiDisclosurePage').then((m) => ({ default: m.AiDisclosurePage })));
const TrademarkPolicyPage = lazy(() => import('@/pages/TrademarkPolicyPage').then((m) => ({ default: m.TrademarkPolicyPage })));
const DmcaPage = lazy(() => import('@/pages/DmcaPage').then((m) => ({ default: m.DmcaPage })));
const VulnerabilityDisclosurePage = lazy(() => import('@/pages/VulnerabilityDisclosurePage').then((m) => ({ default: m.VulnerabilityDisclosurePage })));
const CcpaPage = lazy(() => import('@/pages/CcpaPage').then((m) => ({ default: m.CcpaPage })));
const SmsTermsPage = lazy(() => import('@/pages/SmsTermsPage').then((m) => ({ default: m.SmsTermsPage })));
const DataRequestPage = lazy(() => import('@/pages/DataRequestPage').then((m) => ({ default: m.DataRequestPage })));
const AccessibilityStatementPage = lazy(() => import('@/pages/AccessibilityStatementPage').then((m) => ({ default: m.AccessibilityStatementPage })));
const GdprDpaPage = lazy(() => import('@/pages/GdprDpaPage').then((m) => ({ default: m.GdprDpaPage })));
const FAQPage = lazy(() => import('@/pages/FAQPage').then((m) => ({ default: m.FAQPage })));
const HelpCenterPage = lazy(() => import('@/pages/HelpCenterPage').then((m) => ({ default: m.HelpCenterPage })));
const HelpArticlePage = lazy(() => import('@/pages/HelpArticlePage').then((m) => ({ default: m.HelpArticlePage })));
const HelpPage = lazy(() => import('@/pages/HelpPage').then((m) => ({ default: m.HelpPage })));
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
const ContactSalesPage = lazy(() => import('@/pages/ContactSalesPage').then((m) => ({ default: m.ContactSalesPage })));
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
const UseCasePage = lazy(() => import('@/pages/UseCasePage').then((m) => ({ default: m.UseCasePage })));
const LocationsPage = lazy(() => import('@/pages/LocationsPage').then((m) => ({ default: m.LocationsPage })));
const LocationCityPage = lazy(() => import('@/pages/LocationCityPage').then((m) => ({ default: m.LocationCityPage })));
const LocationTradePage = lazy(() => import('@/pages/LocationTradePage').then((m) => ({ default: m.LocationTradePage })));
const DemoPage = lazy(() => import('@/pages/DemoPage').then((m) => ({ default: m.DemoPage })));
const ReschedulePage = lazy(() => import('@/pages/ReschedulePage').then((m) => ({ default: m.ReschedulePage })));
const SurveysPage = lazy(() => import('@/pages/SurveysPage').then((m) => ({ default: m.SurveysPage })));
const SurveyResponsePage = lazy(() => import('@/pages/SurveyResponsePage').then((m) => ({ default: m.SurveyResponsePage })));
const PreferencesPage = lazy(() => import('@/pages/PreferencesPage').then((m) => ({ default: m.PreferencesPage })));
const BookingPage = lazy(() => import('@/pages/BookingPage').then((m) => ({ default: m.BookingPage })));
const LandingPagesPage = lazy(() => import('@/pages/LandingPagesPage').then((m) => ({ default: m.LandingPagesPage })));
const PublicLandingPage = lazy(() => import('@/pages/PublicLandingPage').then((m) => ({ default: m.PublicLandingPage })));
const CustomerPortalPage = lazy(() => import('@/pages/CustomerPortalPage').then((m) => ({ default: m.CustomerPortalPage })));
const CustomerPortalHistoryPage = lazy(() => import('@/pages/CustomerPortalHistoryPage').then((m) => ({ default: m.CustomerPortalHistoryPage })));
const EmergencyTriagePage = lazy(() => import('@/pages/EmergencyTriagePage').then((m) => ({ default: m.EmergencyTriagePage })));
const JobRoomPage = lazy(() => import('@/pages/JobRoomPage').then((m) => ({ default: m.JobRoomPage })));
const DiagnosePage = lazy(() => import('@/pages/DiagnosePage').then((m) => ({ default: m.DiagnosePage })));
const AdaptiveDiagnosticsPage = lazy(() => import('@/pages/AdaptiveDiagnosticsPage').then((m) => ({ default: m.AdaptiveDiagnosticsPage })));
const NoSurpriseApprovePage = lazy(() => import('@/pages/NoSurpriseApprovePage').then((m) => ({ default: m.NoSurpriseApprovePage })));
const RemoteResolutionRoomPage = lazy(() => import('@/pages/RemoteResolutionRoomPage').then((m) => ({ default: m.RemoteResolutionRoomPage })));
const RemoteResolutionPage = lazy(() => import('@/pages/RemoteResolutionPage').then((m) => ({ default: m.RemoteResolutionPage })));
const CalculatorPage = lazy(() => import('@/pages/CalculatorPage').then((m) => ({ default: m.CalculatorPage })));
const SecurityPage = lazy(() => import('@/pages/SecurityPage').then((m) => ({ default: m.SecurityPage })));
const SecurityWhitepaperPage = lazy(() => import('@/pages/SecurityWhitepaperPage').then((m) => ({ default: m.SecurityWhitepaperPage })));
const StatusPage = lazy(() => import('@/pages/StatusPage').then((m) => ({ default: m.StatusPage })));
const OfflinePage = lazy(() => import('@/pages/OfflinePage').then((m) => ({ default: m.OfflinePage })));
const StatusUnsubscribePage = lazy(() => import('@/pages/StatusUnsubscribePage').then((m) => ({ default: m.StatusUnsubscribePage })));
const CaseStudiesPage = lazy(() => import('@/pages/CaseStudiesPage').then((m) => ({ default: m.CaseStudiesPage })));
const ChangelogPage = lazy(() => import('@/pages/ChangelogPage').then((m) => ({ default: m.ChangelogPage })));
const RoadmapPage = lazy(() => import('@/pages/RoadmapPage').then((m) => ({ default: m.RoadmapPage })));
const DeveloperChangelogPage = lazy(() => import('@/pages/DeveloperChangelogPage').then((m) => ({ default: m.DeveloperChangelogPage })));
const AccessibilityPage = lazy(() => import('@/pages/AccessibilityPage').then((m) => ({ default: m.AccessibilityPage })));
const AccessibilityConformancePage = lazy(() => import('@/pages/AccessibilityConformancePage').then((m) => ({ default: m.AccessibilityConformancePage })));
const CareersPage = lazy(() => import('@/pages/CareersPage').then((m) => ({ default: m.CareersPage })));
const CareerPostingPage = lazy(() => import('@/pages/CareerPostingPage').then((m) => ({ default: m.CareerPostingPage })));
const HiringPage = lazy(() => import('@/pages/admin/HiringPage').then((m) => ({ default: m.HiringPage })));
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
const ResourcesPage = lazy(() => import('@/pages/ResourcesPage').then((m) => ({ default: m.ResourcesPage })));
const ResourcePage = lazy(() => import('@/pages/ResourcePage').then((m) => ({ default: m.ResourcePage })));
const EventsPage = lazy(() => import('@/pages/EventsPage').then((m) => ({ default: m.EventsPage })));
const CustomerRoiPage = lazy(() => import('@/pages/CustomerRoiPage').then((m) => ({ default: m.CustomerRoiPage })));
const SystemRequirementsPage = lazy(() => import('@/pages/SystemRequirementsPage').then((m) => ({ default: m.SystemRequirementsPage })));
const MaintenancePage = lazy(() => import('@/pages/MaintenancePage').then((m) => ({ default: m.MaintenancePage })));
const CustomerDetailPage = lazy(() => import('@/pages/CustomerDetailPage').then((m) => ({ default: m.CustomerDetailPage })));
const FeedbackPage = lazy(() => import('@/pages/FeedbackPage').then((m) => ({ default: m.FeedbackPage })));
const TechnicianProfilePage = lazy(() => import('@/pages/TechnicianProfilePage').then((m) => ({ default: m.TechnicianProfilePage })));
const NotificationsPage = lazy(() => import('@/pages/NotificationsPage').then((m) => ({ default: m.NotificationsPage })));
const CrmSyncPage = lazy(() => import('@/pages/CrmSyncPage').then((m) => ({ default: m.CrmSyncPage })));
const CustomFieldsPage = lazy(() => import('@/pages/CustomFieldsPage').then((m) => ({ default: m.CustomFieldsPage })));
const ExportsPage = lazy(() => import('@/pages/ExportsPage').then((m) => ({ default: m.ExportsPage })));
const SettingsPage = lazy(() => import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const SecuritySettingsPage = lazy(() => import('@/pages/SecuritySettingsPage').then((m) => ({ default: m.SecuritySettingsPage })));
const EnterpriseSecurityPage = lazy(() => import('@/pages/EnterpriseSecurityPage').then((m) => ({ default: m.EnterpriseSecurityPage })));
const DataGovernancePage = lazy(() => import('@/pages/DataGovernancePage').then((m) => ({ default: m.DataGovernancePage })));
const AiSecurityCenterPage = lazy(() => import('@/pages/AiSecurityCenterPage').then((m) => ({ default: m.AiSecurityCenterPage })));
const SsoLoginPage = lazy(() => import('@/pages/SsoLoginPage').then((m) => ({ default: m.SsoLoginPage })));
const ReliabilityPage = lazy(() => import('@/pages/ReliabilityPage').then((m) => ({ default: m.ReliabilityPage })));
const AccountPage = lazy(() => import('@/pages/AccountPage').then((m) => ({ default: m.AccountPage })));
const ApiKeysPage = lazy(() => import('@/pages/ApiKeysPage').then((m) => ({ default: m.ApiKeysPage })));
const OAuthAppsPage = lazy(() => import('@/pages/OAuthAppsPage').then((m) => ({ default: m.OAuthAppsPage })));
const SmsCompliancePage = lazy(() => import('@/pages/SmsCompliancePage').then((m) => ({ default: m.SmsCompliancePage })));
const AuditLogPage = lazy(() => import('@/pages/AuditLogPage').then((m) => ({ default: m.AuditLogPage })));
const AssistantPersonaPage = lazy(() => import('@/pages/AssistantPersonaPage').then((m) => ({ default: m.AssistantPersonaPage })));
const BrandingSettingsPage = lazy(() => import('@/pages/BrandingSettingsPage').then((m) => ({ default: m.BrandingSettingsPage })));
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage })));
const WhatsNewPage = lazy(() => import('@/pages/WhatsNewPage').then((m) => ({ default: m.WhatsNewPage })));
const ThankYouPage = lazy(() => import('@/pages/ThankYouPage').then((m) => ({ default: m.ThankYouPage })));
const ServerErrorPage = lazy(() => import('@/pages/ServerErrorPage').then((m) => ({ default: m.ServerErrorPage })));
const BadgePage = lazy(() => import('@/pages/BadgePage').then((m) => ({ default: m.BadgePage })));
const IntegrationsHubPage = lazy(() => import('@/pages/IntegrationsHubPage').then((m) => ({ default: m.IntegrationsHubPage })));
const IntegrationDetailPage = lazy(() => import('@/pages/IntegrationDetailPage').then((m) => ({ default: m.IntegrationDetailPage })));
const TrustCenterPage = lazy(() => import('@/pages/TrustCenterPage').then((m) => ({ default: m.TrustCenterPage })));
const ComplianceStatusPage = lazy(() => import('@/pages/ComplianceStatusPage').then((m) => ({ default: m.ComplianceStatusPage })));
const AnalyticsPage = lazy(() => import('@/pages/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })));
const CommandCenterPage = lazy(() => import('@/pages/CommandCenterPage').then((m) => ({ default: m.CommandCenterPage })));
const PhoneNumbersPage = lazy(() => import('@/pages/PhoneNumbersPage').then((m) => ({ default: m.PhoneNumbersPage })));
const UsageDashboardPage = lazy(() => import('@/pages/UsageDashboardPage').then((m) => ({ default: m.UsageDashboardPage })));
const SitemapPage = lazy(() => import('@/pages/SitemapPage').then((m) => ({ default: m.SitemapPage })));
const EnterprisePage = lazy(() => import('@/pages/EnterprisePage').then((m) => ({ default: m.EnterprisePage })));
const MarketplacePage = lazy(() => import('@/pages/MarketplacePage').then((m) => ({ default: m.MarketplacePage })));
const SdksPage = lazy(() => import('@/pages/SdksPage').then((m) => ({ default: m.SdksPage })));
const PromiseTrackerPage = lazy(() => import('@/pages/PromiseTrackerPage').then((m) => ({ default: m.PromiseTrackerPage })));
const TasksPage = lazy(() => import('@/pages/TasksPage').then((m) => ({ default: m.TasksPage })));
const TeamChatPage = lazy(() => import('@/pages/TeamChatPage').then((m) => ({ default: m.TeamChatPage })));
const ServiceRecoveryPage = lazy(() => import('@/pages/ServiceRecoveryPage').then((m) => ({ default: m.ServiceRecoveryPage })));
const SandboxPage = lazy(() => import('@/pages/SandboxPage').then((m) => ({ default: m.SandboxPage })));
const ApiReferencePage = lazy(() => import('@/pages/ApiReferencePage').then((m) => ({ default: m.ApiReferencePage })));
const CoachingReportsPage = lazy(() => import('@/pages/CoachingReportsPage').then((m) => ({ default: m.CoachingReportsPage })));
const InviteAcceptPage = lazy(() => import('@/pages/InviteAcceptPage').then((m) => ({ default: m.InviteAcceptPage })));

function RouteLoadingFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
    </div>
  );
}

function AppRoutes() {
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
        <Route path="/mfa" element={<MfaChallengePage />} />
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
        <Route
          path="/staff/customers"
          element={
            <StaffRoute>
              <StaffCustomersPage />
            </StaffRoute>
          }
        />
        <Route
          path="/staff/evidence-partners"
          element={
            <StaffRoute>
              <EvidencePartnersAdminPage />
            </StaffRoute>
          }
        />
        <Route
          path="/dashboard/hiring"
          element={
            <StaffRoute>
              <HiringPage />
            </StaffRoute>
          }
        />
<Route
  path="/staff/usage"
  element={
    <StaffRoute>
      <Suspense fallback={<PageLoader />}>
        <StaffUsagePage />
      </Suspense>
    </StaffRoute>
  }
/>
        <Route
          path="/staff/feature-flags"
          element={
            <StaffRoute>
              <FeatureFlagsAdminPage />
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
        <Route path="/msa" element={<MsaPage />} />
        <Route path="/ai-disclosure" element={<AiDisclosurePage />} />
        <Route path="/trademark-policy" element={<TrademarkPolicyPage />} />
        <Route path="/dmca" element={<DmcaPage />} />
        <Route path="/vulnerability-disclosure" element={<VulnerabilityDisclosurePage />} />
        <Route path="/ccpa" element={<CcpaPage />} />
        <Route path="/sms-terms" element={<SmsTermsPage />} />
        <Route path="/data-request" element={<DataRequestPage />} />
        <Route path="/accessibility-statement" element={<AccessibilityStatementPage />} />
        <Route path="/gdpr-dpa" element={<GdprDpaPage />} />
        <Route path="/faq" element={<FAQPage />} />
        <Route path="/help" element={<HelpCenterPage />} />
        <Route path="/help/:slug" element={<HelpArticlePage />} />
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
        <Route path="/contact-sales" element={<ContactSalesPage />} />
        <Route path="/error" element={<ServerErrorPage />} />
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
        <Route path="/use-cases/:slug" element={<UseCasePage />} />
        <Route path="/locations" element={<LocationsPage />} />
        <Route path="/locations/:city" element={<LocationCityPage />} />
        <Route path="/locations/:city/:trade" element={<LocationTradePage />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/enterprise" element={<EnterprisePage />} />
        <Route path="/marketplace" element={<MarketplacePage />} />
        <Route path="/sdks" element={<SdksPage />} />
        <Route path="/sandbox" element={<SandboxPage />} />
        <Route path="/developers/api-reference" element={<ApiReferencePage />} />
        <Route path="/developers/changelog" element={<DeveloperChangelogPage />} />
        <Route path="/demo" element={<DemoPage />} />
        <Route path="/reschedule/:token" element={<ReschedulePage />} />
        <Route path="/s/:token" element={<SurveyResponsePage />} />
        <Route path="/preferences/:token" element={<PreferencesPage />} />
        <Route path="/book/:slug" element={<BookingPage />} />
        <Route path="/lp/:slug" element={<PublicLandingPage />} />
        <Route path="/ack/:token" element={<AckEscalationPage />} />
        <Route path="/portal/:token" element={<CustomerPortalPage />} />
        <Route path="/portal/:token/history" element={<CustomerPortalHistoryPage />} />
        <Route path="/verified/:token" element={<VerifiedServicePage />} />
        <Route path="/guarantee/:token" element={<ServiceGuaranteePublicPage />} />
        <Route path="/outcome/:token" element={<OutcomeVerifyPage />} />
        <Route path="/join/:planSlug" element={<JoinMembershipPage />} />
        <Route path="/financing/:token" element={<FinancingOfferPage />} />
        <Route path="/verify/technician/:token" element={<PublicTechnicianPassportPage />} />
        <Route path="/verify/home/:token" element={<PublicHomePassportPage />} />
        <Route path="/e/:code" element={<PublicEquipmentPassportPage />} />
        <Route path="/warranty/register" element={<WarrantyRegisterPage />} />
        <Route path="/h/:code" element={<PublicHomePassportPage />} />
        <Route path="/emergency/:token" element={<EmergencyTriagePage />} />
        <Route path="/service/:token" element={<JobRoomPage />} />
        <Route path="/approve/:token" element={<NoSurpriseApprovePage />} />
        <Route path="/resolve/:token" element={<RemoteResolutionRoomPage />} />
        <Route path="/diagnose/:token" element={<DiagnosePage />} />
        <Route path="/calculator" element={<CalculatorPage />} />
        <Route path="/security" element={<SecurityPage />} />
        <Route path="/security/whitepaper" element={<SecurityWhitepaperPage />} />
        <Route path="/trust" element={<TrustCenterPage />} />
        <Route path="/trust/compliance" element={<ComplianceStatusPage />} />
        <Route path="/integrations" element={<IntegrationsHubPage />} />
        <Route path="/integrations/:slug" element={<IntegrationDetailPage />} />
        <Route path="/offline" element={<OfflinePage />} />
        <Route path="/status" element={<StatusPage />} />
        <Route path="/status/unsubscribe" element={<StatusUnsubscribePage />} />
        <Route path="/email/unsubscribe/:token" element={<EmailUnsubscribePage />} />
        <Route path="/maintenance" element={<MaintenancePage />} />
        <Route path="/case-studies" element={<CaseStudiesPage />} />
        <Route path="/changelog" element={<ChangelogPage />} />
        <Route path="/roadmap" element={<RoadmapPage />} />
        <Route path="/accessibility" element={<AccessibilityPage />} />
        <Route path="/accessibility/conformance" element={<AccessibilityConformancePage />} />
        <Route path="/careers" element={<CareersPage />} />
        <Route path="/careers/:slug" element={<CareerPostingPage />} />
        <Route path="/culture" element={<CulturePage />} />
        <Route path="/press" element={<PressPage />} />
        <Route path="/brand" element={<BrandGuidelinesPage />} />
        <Route path="/partners" element={<PartnersPage />} />
        <Route path="/pay-result" element={<PaymentResultPage />} />
        <Route path="/thank-you" element={<ThankYouPage />} />
        <Route path="/pay/:token" element={<PublicPaymentPage />} />
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
        <Route path="/resources" element={<ResourcesPage />} />
        <Route path="/resources/:slug" element={<ResourcePage />} />
        <Route path="/events" element={<EventsPage />} />
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
          path="/dashboard/support"
          element={
            <ProtectedRoute>
              <SupportTicketsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/getting-started"
          element={
            <ProtectedRoute>
              <GettingStartedPage />
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
          path="/dashboard/feedback"
          element={
            <ProtectedRoute>
              <FeedbackPage />
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
    path="/dashboard/crm-sync"
    element={
      <ProtectedRoute>
        <CrmSyncPage />
      </ProtectedRoute>
    }
  />
  <Route
    path="/dashboard/custom-fields"
    element={
      <ProtectedRoute>
        <CustomFieldsPage />
      </ProtectedRoute>
    }
  />
  <Route
    path="/dashboard/exports"
    element={
      <ProtectedRoute>
        <ExportsPage />
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
          path="/dashboard/tasks"
          element={
            <ProtectedRoute>
              <TasksPage />
            </ProtectedRoute>
          }
        />
<Route
  path="/dashboard/team-chat"
  element={
    <ProtectedRoute>
      <TeamChatPage />
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
          path="/dashboard/switching-shield"
          element={
            <ProtectedRoute>
              <SwitchingShieldPage />
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
          path="/dashboard/property-vision"
          element={
            <ProtectedRoute>
              <PropertyVisionPage />
            </ProtectedRoute>
          }
        />
        <Route
  path="/dashboard/self-healing"
  element={
    <ProtectedRoute>
      <SelfHealingPage />
    </ProtectedRoute>
  }
/>
        <Route
          path="/dashboard/regulation-graph"
          element={
            <ProtectedRoute>
              <TemporalRegulationPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/procurement"
          element={
            <ProtectedRoute>
              <ProcurementPage />
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
          path="/dashboard/adaptive-diagnostics"
          element={
            <ProtectedRoute>
              <AdaptiveDiagnosticsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/live-calls"
          element={
            <ProtectedRoute>
              <LiveCallsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/predictive-failure"
          element={
            <ProtectedRoute>
              <PredictiveFailurePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/preventive-maintenance"
          element={
            <ProtectedRoute>
              <PreventiveMaintenanceCommandCenterPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/verification-network"
          element={
            <ProtectedRoute>
              <VerificationNetworkPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/physical-economy-network"
          element={
            <ProtectedRoute>
              <PhysicalEconomyNetworkPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/data-exchange"
          element={
            <ProtectedRoute>
              <ServiceDataExchangePage />
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
  path="/dashboard/settings/sessions"
  element={
    <ProtectedRoute>
      <SessionsPage />
    </ProtectedRoute>
  }
/>
        <Route
          path="/dashboard/settings/locations"
          element={
            <ProtectedRoute>
              <LocationsSettingsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/settings/audit-log"
          element={
            <ProtectedRoute>
              <AuditLogPage />
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
        <Route
          path="/dashboard/security-center"
          element={
            <ProtectedRoute>
              <AiSecurityCenterPage />
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
          path="/dashboard/settings/oauth-apps"
          element={
            <ProtectedRoute>
              <OAuthAppsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/settings/sms-compliance"
          element={
            <ProtectedRoute>
              <SmsCompliancePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/landing-pages"
          element={
            <ProtectedRoute>
              <LandingPagesPage />
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
  path="/dashboard/settings/branding"
  element={
    <ProtectedRoute>
      <BrandingSettingsPage />
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
          path="/dashboard/calls/:id"
          element={
            <ProtectedRoute>
              <CallDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/inbox"
          element={
            <ProtectedRoute>
              <UnifiedInboxPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/goals"
          element={
            <ProtectedRoute>
              <GoalOrchestratorPage />
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
        />|
        <Route
          path="/dashboard/ask-vireek"
          element={
            <ProtectedRoute>
              <AskVireekPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/csr-desk"
          element={
            <ProtectedRoute>
              <CsrDeskPage />
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
          path="/dashboard/parts-market"
          element={
            <ProtectedRoute>
              <PartsMarketPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/parts-intelligence"
          element={
            <ProtectedRoute>
              <PartsIntelligencePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/supplier-intelligence"
          element={
            <ProtectedRoute>
              <SupplierIntelligencePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/supply-chain-outcomes"
          element={
            <ProtectedRoute>
              <SupplyChainOutcomePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/outcome-assurance"
          element={
            <ProtectedRoute>
              <OutcomeAssurancePage />
            </ProtectedRoute>
          }
        />
        <Route
  path="/dashboard/outcome-network"
  element={
    <ProtectedRoute>
      <OutcomeIntelligenceNetworkPage />
    </ProtectedRoute>
  }
/>
        <Route
          path="/dashboard/truck-roll"
          element={
            <ProtectedRoute>
              <TruckRollEliminationPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/evidence-marketplace"
          element={
            <ProtectedRoute>
              <EvidenceMarketplacePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/service-guarantee"
          element={
            <ProtectedRoute>
              <ServiceGuaranteePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/continuous-improvement"
          element={
            <ProtectedRoute>
              <ContinuousImprovementPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/learning-compiler"
          element={
            <ProtectedRoute>
              <LearningCompilerPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/operations-sandbox"
          element={
            <ProtectedRoute>
              <OperationsSandboxPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/operations-loop"
          element={
            <ProtectedRoute>
              <OperationsLoopPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/pricing-flywheel"
          element={
            <ProtectedRoute>
              <PricingFlywheelPage />
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
          path="/dashboard/field-scientist"
          element={
            <ProtectedRoute>
              <FieldScientistPage />
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
          path="/dashboard/operations-center"
          element={
            <ProtectedRoute>
              <OperationsCenterPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/decision-ledger"
          element={
            <ProtectedRoute>
              <DecisionLedgerPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/outcome-pricing"
          element={
            <ProtectedRoute>
              <OutcomePricingPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/trust-layer"
          element={
            <ProtectedRoute>
              <CustomerTrustLayerPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/service-graph"
          element={
            <ProtectedRoute>
              <ServiceGraphPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/data-fabric"
          element={
            <ProtectedRoute>
              <DataFabricPage />
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
          path="/dashboard/business-forecast"
          element={
            <ProtectedRoute>
              <BusinessForecastPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/cash-flow-war-room"
          element={
            <ProtectedRoute>
              <CashFlowWarRoomPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/bank-intelligence"
          element={
            <ProtectedRoute>
              <BankIntelligencePage />
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
          path="/dashboard/org-memory"
          element={
            <ProtectedRoute>
              <OrganizationalMemoryPage />
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
          path="/dashboard/receivables"
          element={
            <ProtectedRoute>
              <ReceivablesIntelligencePage />
            </ProtectedRoute>
          }
        />
<Route
  path="/dashboard/collections"
  element={
    <ProtectedRoute>
      <CollectionsPage />
    </ProtectedRoute>
  }
/>
        <Route
          path="/dashboard/revenue-causality"
          element={
            <ProtectedRoute>
              <RevenueCausalityGraphPage />
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
          path="/dashboard/invoicing/:id"
          element={
            <ProtectedRoute>
              <InvoiceDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/tax"
          element={
            <ProtectedRoute>
              <TaxCenterPage />
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
          path="/dashboard/knowledge-capture"
          element={
            <ProtectedRoute>
              <KnowledgeCapturePage />
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
          path="/dashboard/imports"
          element={
            <ProtectedRoute>
              <ImportsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/feedback-analytics"
          element={
            <ProtectedRoute>
              <FeedbackAnalyticsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/failure-atlas"
          element={
            <ProtectedRoute>
              <FailureAtlasPage />
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
          path="/dashboard/market-intelligence"
          element={
            <ProtectedRoute>
              <MarketIntelligencePage />
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
  path="/dashboard/revenue-autopsy"
  element={
    <ProtectedRoute>
      <RevenueAutopsyPage />
    </ProtectedRoute>
  }
/>
<Route
  path="/dashboard/ltv-autopilot"
  element={
    <ProtectedRoute>
      <LtvAutopilotPage />
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
     path="/dashboard/unknowns"
     element={
       <ProtectedRoute>
         <UnknownsEnginePage />
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
          path="/dashboard/leads/:id"
          element={
            <ProtectedRoute>
              <LeadDetailPage />
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
          path="/dashboard/customers/:customerId/sites/:siteId/intelligence"
          element={
            <ProtectedRoute>
              <PropertyIntelligencePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/homes/:siteId"
          element={
            <ProtectedRoute>
              <HomeLifetimeGraphPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/homes/:siteId/capital-plan"
          element={
            <ProtectedRoute>
              <HomeCapitalPlanPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/homes/:siteId/passport"
          element={
            <ProtectedRoute>
              <HomePassportNetworkPage />
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
          path="/dashboard/referrals"
          element={
            <ProtectedRoute>
              <ReferralsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/voicemail-drops"
          element={
            <ProtectedRoute>
              <VoicemailDropsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/neighborhood-revenue"
          element={
            <ProtectedRoute>
              <NeighborhoodRevenuePage />
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
          path="/dashboard/email-campaigns"
          element={
            <ProtectedRoute>
              <EmailCampaignsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/audiences"
          element={
            <ProtectedRoute>
              <AudiencesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/campaigns/:id"
          element={
            <ProtectedRoute>
              <CampaignDetailPage />
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
          path="/dashboard/jobs/:id"
          element={
            <ProtectedRoute>
              <JobDetailPage />
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
        <Route
          path="/dashboard/snapshots"
          element={
            <ProtectedRoute>
              <DashboardSnapshotsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/quotes/:id"
          element={
            <ProtectedRoute>
              <QuoteDetailPage />
            </ProtectedRoute>
          }
        />
        <Route path="/quote/:token" element={<QuoteAcceptPage />} />
        <Route path="/sign/:token" element={<SignDocumentPage />} />
        <Route path="/invoice/:token" element={<InvoicePage />} />
        <Route path="/shared/dashboard/:token" element={<SharedDashboardPage />} />
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
          path="/dashboard/revenue-protection"
          element={
            <ProtectedRoute>
              <RevenueProtectionPage />
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
          path="/dashboard/workflow-compiler"
          element={
            <ProtectedRoute>
              <WorkflowCompilerPage />
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
          path="/dashboard/emergency-network"
          element={
            <ProtectedRoute>
              <EmergencyNetworkPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/ai-reliability"
          element={
            <ProtectedRoute>
              <AiReliabilityPage />
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
          path="/dashboard/agent-network"
          element={
            <ProtectedRoute>
              <AgentNetworkPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/evaluation-plane"
          element={
            <ProtectedRoute>
              <EvaluationPlanePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/agent-marketplace"
          element={
            <ProtectedRoute>
              <AgentMarketplacePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/outcome-clearinghouse/:recordId?"
          element={
            <ProtectedRoute>
              <OutcomeClearinghousePage />
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
          path="/dashboard/blocklist"
          element={
            <ProtectedRoute>
              <BlocklistPage />
            </ProtectedRoute>
          }
        />
              <Route
          path="/dashboard/call-routing"
          element={
            <ProtectedRoute>
              <CallRoutingPage />
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
          path="/dashboard/risk-intelligence"
          element={
            <ProtectedRoute>
              <RiskIntelligencePage />
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
          path="/dashboard/documents"
          element={
            <ProtectedRoute>
              <DocumentsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/gallery"
          element={
            <ProtectedRoute>
              <GalleryPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/permit-intelligence"
          element={
            <ProtectedRoute>
              <PermitIntelligencePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/permits"
          element={
            <ProtectedRoute>
              <PermitCenterPage />
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
          path="/dashboard/reports"
          element={
            <ProtectedRoute>
              <ReportsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/reports/scheduled"
          element={
            <ProtectedRoute>
              <ScheduledReportsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/job-autopsy"
          element={
            <ProtectedRoute>
              <JobAutopsyPage />
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
  path="/dashboard/budgets"
  element={
    <ProtectedRoute>
      <BudgetsPage />
    </ProtectedRoute>
  }
/>
<Route
  path="/dashboard/chart-of-accounts"
  element={
    <ProtectedRoute>
      <ChartOfAccountsPage />
    </ProtectedRoute>
  }
/>
<Route
  path="/dashboard/bank-intelligence"
  element={
    <ProtectedRoute>
      <BankIntelligencePage />
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
  path="/dashboard/expenses"
  element={
    <ProtectedRoute>
      <ExpensesPage />
    </ProtectedRoute>
  }
/>
<Route
  path="/dashboard/commissions"
  element={
    <ProtectedRoute>
      <CommissionsPage />
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
          path="/dashboard/evidence-chain"
          element={
            <ProtectedRoute>
              <EvidenceChainPage />
            </ProtectedRoute>
          }
        />
  <Route
    path="/dashboard/service-twin"
    element={
      <ProtectedRoute>
        <ServiceTwinPage />
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
          path="/dashboard/work-orders"
          element={
            <ProtectedRoute>
              <WorkOrdersPage />
            </ProtectedRoute>
          }
        />
<Route
  path="/dashboard/agreements"
  element={
    <ProtectedRoute>
      <ServiceAgreementsPage />
    </ProtectedRoute>
  }
/>
<Route
  path="/dashboard/agreements/:id"
  element={
    <ProtectedRoute>
      <ServiceAgreementDetailPage />
    </ProtectedRoute>
  }
/>
        <Route
          path="/dashboard/contract-intelligence"
          element={
            <ProtectedRoute>
              <ContractIntelligencePage />
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
          path="/dashboard/gift-cards"
          element={
            <ProtectedRoute>
              <GiftCardsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/recurring-jobs"
          element={
            <ProtectedRoute>
              <RecurringJobsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/tech/today"
          element={
            <TechnicianRoute>
              <TechnicianTodayPage />
            </TechnicianRoute>
          }
        />
        <Route
          path="/tech/dvir"
          element={
            <TechnicianRoute>
              <TechnicianDvirPage />
            </TechnicianRoute>
          }
        />
        <Route
          path="/tech/profile"
          element={
            <TechnicianRoute>
              <TechnicianProfilePage />
            </TechnicianRoute>
          }
        />
        <Route
          path="/tech/job/:jobId"
          element={
            <TechnicianRoute>
              <TechnicianJobBriefPage />
            </TechnicianRoute>
          }
        />
        <Route
          path="/tech/messages"
          element={
            <TechnicianRoute>
              <TechnicianMessagesPage />
            </TechnicianRoute>
          }
        />
        <Route
          path="/tech/messages/:jobId"
          element={
            <TechnicianRoute>
              <TechnicianJobThreadPage />
            </TechnicianRoute>
          }
        />
        <Route
          path="/dashboard/field-messages"
          element={
            <ProtectedRoute>
              <FieldMessagesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/tech/schedule"
          element={
            <TechnicianRoute>
              <TechnicianSchedulePage />
            </TechnicianRoute>
          }
        />
        <Route
          path="/tech/truck-stock"
          element={
            <TechnicianRoute>
              <TruckStockPage />
            </TechnicianRoute>
          }
        />
        <Route
          path="/tech/earnings"
          element={
            <TechnicianRoute>
              <TechEarningsPage />
            </TechnicianRoute>
          }
        />
        <Route
          path="/tech/deposits"
          element={
            <TechnicianRoute>
              <TechnicianDepositsPage />
            </TechnicianRoute>
          }
        />
        <Route
          path="/dashboard/expert-assist"
          element={
            <TechnicianRoute>
              <ExpertAssistInboxPage />
            </TechnicianRoute>
          }
        />
        <Route
          path="/dashboard/expert-assist/:requestId"
          element={
            <TechnicianRoute>
              <ExpertAssistThreadPage />
            </TechnicianRoute>
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
          path="/dashboard/notification-routing"
          element={
            <ProtectedRoute>
              <NotificationRoutingPage />
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
          path="/dashboard/network/capacity-exchange"
          element={
            <ProtectedRoute>
              <CapacityExchangePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/surveys"
          element={
            <ProtectedRoute>
              <SurveysPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/demand-exchange"
          element={
            <ProtectedRoute>
              <HomeDemandExchangePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/network/skill-market"
          element={
            <ProtectedRoute>
              <SkillMarketPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/context-engine"
          element={
            <ProtectedRoute>
              <ContextEnginePage />
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
          path="/dashboard/price-lists"
          element={
            <ProtectedRoute>
              <PriceListsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/form-builder"
          element={
            <ProtectedRoute>
              <FormBuilderPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/job-templates"
          element={
            <ProtectedRoute>
              <JobTemplatesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/service-catalog"
          element={
            <ProtectedRoute>
              <ServiceCatalogPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/vendors"
          element={
            <ProtectedRoute>
              <VendorManagementPage />
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
          path="/dashboard/inventory/counts"
          element={
            <ProtectedRoute>
              <InventoryCountsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/help"
          element={
            <ProtectedRoute>
              <HelpPage />
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
          path="/dashboard/building-telemetry"
          element={
            <ProtectedRoute>
              <BuildingTelemetryPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/equipment-passports"
          element={
            <ProtectedRoute>
              <EquipmentPassportsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/equipment-passports/:code"
          element={
            <ProtectedRoute>
              <EquipmentPassportDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/home-passports"
          element={
            <ProtectedRoute>
              <HomePassportsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/home-passports/:code"
          element={
            <ProtectedRoute>
              <HomePassportDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/oem-intelligence"
          element={
            <ProtectedRoute>
              <OEMIntelligencePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/oem-graph"
          element={
            <ProtectedRoute>
              <OemGraphPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/time-off"
          element={
            <ProtectedRoute>
              <TimeOffPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/templates"
          element={
            <ProtectedRoute>
              <TemplatesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/identity-graph"
          element={
            <ProtectedRoute>
              <UniversalIdentityPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/field-intelligence"
          element={
            <ProtectedRoute>
              <FieldIntelligencePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/home-health"
          element={
            <ProtectedRoute>
              <HomeHealthPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/home-passport"
          element={
            <ProtectedRoute>
              <HomeServicePassportPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/property-intelligence"
          element={
            <ProtectedRoute>
              <PropertyIntelligencePage />
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
          path="/dashboard/telematics"
          element={
            <ProtectedRoute>
              <TelematicsOSPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/team/:id"
          element={
            <ProtectedRoute>
              <TechnicianDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/fleet-intelligence"
          element={
            <ProtectedRoute>
              <FleetIntelligencePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/vehicles"
          element={
            <ProtectedRoute>
              <VehiclesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/fleet-dvir"
          element={
            <ProtectedRoute>
              <FleetDvirPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/live-map"
          element={
            <ProtectedRoute>
              <LiveMapPage />
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
          path="/dashboard/call-queue"
          element={
            <ProtectedRoute>
              <CallQueuePage />
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
          path="/dashboard/remote-resolution"
          element={
            <ProtectedRoute>
              <RemoteResolutionPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/failure-genome"
          element={
            <ProtectedRoute>
              <FailureGenomePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/adaptive-diagnostics"
          element={
            <ProtectedRoute>
              <AdaptiveDiagnosticsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/live-copilot"
          element={
            <TechnicianRoute>
              <LiveCopilotPage />
            </TechnicianRoute>
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
          path="/dashboard/promo-codes"
          element={
            <ProtectedRoute>
              <PromoCodesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/quote-truth"
          element={
            <ProtectedRoute>
              <QuoteTruthEnginePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/operational-truth"
          element={
            <ProtectedRoute>
              <OperationalTruthPage />
            </ProtectedRoute>
          }
        />
            <Route
          path="/dashboard/incentives"
          element={
            <ProtectedRoute>
              <IncentiveEnginePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/rebate-intelligence"
          element={
            <ProtectedRoute>
              <RebateIntelligencePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/energy-intelligence"
          element={
            <ProtectedRoute>
              <EnergyIntelligencePage />
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
          path="/dashboard/event-prediction-mesh"
          element={
            <ProtectedRoute>
              <EventPredictionMeshPage />
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
          path="/dashboard/trash"
          element={
            <ProtectedRoute>
              <TrashPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/duplicates"
          element={
            <ProtectedRoute>
              <DuplicatesPage />
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
          path="/dashboard/service-areas"
          element={
            <ProtectedRoute>
              <ServiceAreasPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/apprenticeship"
          element={
            <ProtectedRoute>
              <TechnicianApprenticeshipPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/adoption"
          element={
            <ProtectedRoute>
              <AdoptionOSPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/outcome-benchmarks"
          element={
            <ProtectedRoute>
              <OutcomeBenchmarkNetworkPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/first-time-fix"
          element={
            <ProtectedRoute>
              <FirstTimeFixAutopilotPage />
            </ProtectedRoute>
          }
        />
          <Route
            path="/dashboard/service-intelligence-loop"
            element={
              <ProtectedRoute>
                <ServiceIntelligenceLoopPage />
              </ProtectedRoute>
            }
          />
<Route
  path="/dashboard/resolution-probability"
  element={
    <ProtectedRoute>
      <ResolutionProbabilityPage />
    </ProtectedRoute>
  }
/>
        <Route
          path="/dashboard/experiments"
          element={
            <ProtectedRoute>
              <OpsExperimentsPage />
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
          path="/dashboard/workforce-equilibrium"
          element={
            <ProtectedRoute>
              <WorkforceEquilibriumPage />
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
          path="/dashboard/reports/executive"
          element={
            <ProtectedRoute>
              <ExecutiveReportsPage />
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
          path="/dashboard/lead-marketplaces"
          element={
            <ProtectedRoute>
              <LeadMarketplacesPage />
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
          path="/dashboard/demand-os"
          element={
            <ProtectedRoute>
              <DemandOsPage />
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
          path="/dashboard/trust-passport"
          element={
            <ProtectedRoute>
              <TechnicianTrustPassportPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/technician-identity"
          element={
            <ProtectedRoute>
              <TechnicianIdentityGraphPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/technician-simulator"
          element={
            <ProtectedRoute>
              <TechnicianSimulatorPage />
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
          path="/dashboard/billing/plans"
          element={
            <ProtectedRoute>
              <BillingPlansPage />
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
          path="/dashboard/settings/slack-teams"
          element={
            <ProtectedRoute>
              <SlackTeamsSettingsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/billing/invoices"
          element={
            <ProtectedRoute>
              <BillingInvoicesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/billing/cancel"
          element={
            <ProtectedRoute>
              <CancelSubscriptionPage />
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
          path="/dashboard/refunds"
          element={
            <ProtectedRoute>
              <RefundsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/financing"
          element={
            <ProtectedRoute>
              <FinancingCenterPage />
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
        <Route
          path="/dashboard/whats-new"
          element={
            <ProtectedRoute>
              <WhatsNewPage />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}

function App() {
  return (
    <CustomDomainGate>
      <AppRoutes />
    </CustomDomainGate>
  );
}
export default App;
