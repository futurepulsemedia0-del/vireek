import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Loader as Loader2, Phone } from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useOnboardingWizard } from './useOnboardingWizard';
import { Stepper } from './Stepper';
import { BusinessInfoStep } from './steps/BusinessInfoStep';
import { OperationsStep } from './steps/OperationsStep';
import { HoursStep } from './steps/HoursStep';
import { PhoneStep } from './steps/PhoneStep';
import { CalendarStep } from './steps/CalendarStep';
import { SarahStep } from './steps/SarahStep';
import { KnowledgeStep } from './steps/KnowledgeStep';
import { TestCallStep } from './steps/TestCallStep';
import { ConfirmStep } from './steps/ConfirmStep';
import { LaunchStep } from './steps/LaunchStep';
import type { StepProps } from './types';

export function OnboardingWizard() {
  const wizard = useOnboardingWizard();
  const { stepId, data, update, loading, saving, launched, goNext, goBack, skip, launch, finishToDashboard } = wizard;

  const stepProps: StepProps = {
    data,
    update,
    onBack: goBack,
    onNext: goNext,
    onSkip: skip,
    saving,
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-noise bg-gradient-mesh">
        <Loader2 size={28} className="animate-spin text-accent" />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-noise bg-gradient-mesh px-4 py-12 sm:px-6">
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-bg-primary via-bg-primary to-bg-secondary" />

      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-4 py-4 sm:px-6">
        <span className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-white">
            <Phone size={16} strokeWidth={2.5} />
          </span>
          <span className="text-lg font-bold tracking-tight text-accent">Vireek</span>
        </span>
        <div className="flex items-center gap-3">
          {stepId !== 'launch' && (
            <Link to="/onboarding/concierge" className="focus-ring hidden text-xs font-medium text-text-secondary hover:text-accent sm:block">
              ← Prefer to just talk it through?
            </Link>
          )}
          <ThemeToggle />
        </div>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-lg"
      >
        <div className="rounded-2xl border border-border bg-bg-secondary/90 p-6 shadow-card backdrop-blur-md dark:shadow-card-dark sm:p-8 md:p-10">
          {stepId !== 'launch' && <Stepper currentId={stepId} completedSteps={data.completedSteps} />}

          <AnimatePresence mode="wait">
            {stepId === 'business' && <BusinessInfoStep key="business" {...stepProps} onBack={undefined} />}
            {stepId === 'operations' && <OperationsStep key="operations" {...stepProps} />}
            {stepId === 'hours' && <HoursStep key="hours" {...stepProps} />}
            {stepId === 'phone' && <PhoneStep key="phone" {...stepProps} />}
            {stepId === 'calendar' && <CalendarStep key="calendar" {...stepProps} />}
            {stepId === 'sarah' && <SarahStep key="sarah" {...stepProps} />}
            {stepId === 'knowledge' && <KnowledgeStep key="knowledge" {...stepProps} />}
            {stepId === 'test_call' && <TestCallStep key="test_call" {...stepProps} />}
            {stepId === 'confirm' && <ConfirmStep key="confirm" {...stepProps} onSkip={undefined} />}
            {stepId === 'launch' && (
              <LaunchStep key="launch" {...stepProps} onLaunch={launch} onFinish={finishToDashboard} launched={launched} />
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
