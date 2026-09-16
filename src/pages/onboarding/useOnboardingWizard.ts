import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase, BusinessProfile } from '@/lib/supabase';
import { purchasePhoneNumber } from '@/lib/phoneNumbers';
import { createArticle, EMPTY_ARTICLE_FORM } from '@/lib/knowledge';
import {
  EMPTY_WIZARD_DATA,
  STEPS,
  STEP_INDEX,
  type OnboardingWizardState,
  type StepId,
  type WizardData,
} from './types';

const DRAFT_KEY = 'vireek_onboarding_wizard_draft_v1';

function readDraft(): Partial<WizardData> | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as Partial<WizardData>) : null;
  } catch {
    return null;
  }
}

function writeDraft(data: WizardData) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
  } catch {
    // Best-effort only — draft loss just means re-typing a field, never data loss server-side.
  }
}

export function useOnboardingWizard() {
  const navigate = useNavigate();
  const { user, profile, profileLoading, refreshProfile } = useAuth();
  const { toast } = useToast();

  const [stepId, setStepId] = useState<StepId>('business');
  const [data, setData] = useState<WizardData>(EMPTY_WIZARD_DATA);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [launched, setLaunched] = useState(false);
  const hasSeeded = useRef(false);

  const stepIndex = STEP_INDEX[stepId];

  const update = useCallback((patch: Partial<WizardData>) => {
    setData((prev) => {
      const next = { ...prev, ...patch };
      writeDraft(next);
      return next;
    });
  }, []);

  // ------------------------------------------------------------
  // Load: profile + business_profile + any locally-drafted fields
  // that never made it to the server (e.g. the tab was closed
  // mid-step). Server data always wins over the local draft for
  // any field the server actually has a value for.
  // ------------------------------------------------------------
  useEffect(() => {
    if (!user || hasSeeded.current) return;

    (async () => {
      hasSeeded.current = true;
      const draft = readDraft();

      const { data: bp } = await supabase
        .from('business_profile')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();

      const businessProfile = bp as BusinessProfile | null;
      const wizardState = businessProfile?.onboarding_wizard_state as OnboardingWizardState | null | undefined;

      setData((prev) => ({
        ...prev,
        ...draft,
        fullName: profile?.full_name ?? draft?.fullName ?? prev.fullName,
        companyName: profile?.company_name ?? draft?.companyName ?? prev.companyName,
        phone: profile?.phone ?? draft?.phone ?? prev.phone,
        forwardingNumber: profile?.forwarding_number ?? draft?.forwardingNumber ?? prev.forwardingNumber,
        services: businessProfile?.services_offered ?? draft?.services ?? prev.services,
        serviceArea: businessProfile?.service_area ?? draft?.serviceArea ?? prev.serviceArea,
        hours: (businessProfile?.business_hours as WizardData['hours']) ?? draft?.hours ?? prev.hours,
        primaryIndustry: businessProfile?.primary_industry ?? draft?.primaryIndustry ?? prev.primaryIndustry,
        teamSize: businessProfile?.team_size ?? draft?.teamSize ?? prev.teamSize,
        currentCallHandling: businessProfile?.current_call_handling ?? draft?.currentCallHandling ?? prev.currentCallHandling,
        schedulingTool: businessProfile?.scheduling_tool ?? draft?.schedulingTool ?? prev.schedulingTool,
        avgJobValue: businessProfile?.avg_job_value != null ? String(businessProfile.avg_job_value) : draft?.avgJobValue ?? prev.avgJobValue,
        handlesEmergencyCalls: businessProfile?.handles_emergency_calls ?? draft?.handlesEmergencyCalls ?? prev.handlesEmergencyCalls,
        assistantName: businessProfile?.assistant_name ?? draft?.assistantName ?? prev.assistantName,
        assistantVoice: businessProfile?.assistant_voice ?? draft?.assistantVoice ?? prev.assistantVoice,
        assistantTone: businessProfile?.assistant_tone ?? draft?.assistantTone ?? prev.assistantTone,
        greetingScript: businessProfile?.greeting_script ?? draft?.greetingScript ?? prev.greetingScript,
        faqs: businessProfile?.faqs ?? draft?.faqs ?? prev.faqs,
        calendarProvider: wizardState?.calendar_provider ?? draft?.calendarProvider ?? prev.calendarProvider,
        testCallCompleted: wizardState?.test_call_completed ?? draft?.testCallCompleted ?? prev.testCallCompleted,
        completedSteps: wizardState?.completed_steps ?? draft?.completedSteps ?? prev.completedSteps,
      }));

      // Resume exactly where they left off, but never past "confirm" —
      // launch is always a deliberate final click, not something to
      // silently jump back into.
      if (wizardState?.current_step && wizardState.current_step !== 'launch') {
        setStepId(wizardState.current_step);
      }

      setLoading(false);
    })();
  }, [user, profile]);

  useEffect(() => {
    if (!profileLoading && profile?.onboarding_completed) {
      navigate('/dashboard', { replace: true });
    }
  }, [profile, profileLoading, navigate]);

  // ------------------------------------------------------------
  // Persist progress: called on every "Continue" so a refresh or a
  // dropped connection never costs more than the current step.
  // ------------------------------------------------------------
  const persistWizardState = useCallback(
    async (next: StepId, completed: StepId[]) => {
      if (!user) return;
      const wizardState: OnboardingWizardState = {
        current_step: next,
        completed_steps: completed,
        calendar_provider: data.calendarProvider,
        test_call_completed: data.testCallCompleted,
        updated_at: new Date().toISOString(),
      };
      await supabase.from('business_profile').upsert(
        {
          user_id: user.id,
          onboarding_wizard_state: wizardState,
        },
        { onConflict: 'user_id' },
      );
    },
    [user, data.calendarProvider, data.testCallCompleted],
  );

  const saveBusinessProfile = useCallback(async () => {
    if (!user) return;
    const parsedAvgJobValue = data.avgJobValue.trim() ? Number(data.avgJobValue.trim()) : null;
    const { error } = await supabase.from('business_profile').upsert(
      {
        user_id: user.id,
        services_offered: data.services.length > 0 ? data.services : null,
        service_area: data.serviceArea.trim() || null,
        business_hours: Object.keys(data.hours).length > 0 ? data.hours : null,
        primary_industry: data.primaryIndustry || null,
        team_size: data.teamSize || null,
        current_call_handling: data.currentCallHandling || null,
        scheduling_tool: data.schedulingTool || null,
        avg_job_value: parsedAvgJobValue != null && !Number.isNaN(parsedAvgJobValue) ? parsedAvgJobValue : null,
        handles_emergency_calls: data.handlesEmergencyCalls || null,
        assistant_name: data.assistantName.trim() || 'Sarah',
        assistant_voice: data.assistantVoice || null,
        assistant_tone: data.assistantTone || null,
        greeting_script: data.greetingScript.trim() || null,
        faqs: data.faqs.length > 0 ? data.faqs : null,
      },
      { onConflict: 'user_id' },
    );
    if (error) throw error;
  }, [user, data]);

  const provisionPhoneIfNeeded = useCallback(async () => {
    if (data.phoneChoice !== 'new_number' || !data.newPhoneNumber) return;
    try {
      await purchasePhoneNumber(data.newPhoneNumber, {
        friendly_name: data.newPhoneFriendlyName.trim() || 'Main Line',
        number_type: 'local',
        forwarding_number: data.forwardingNumber.trim() || null,
      });
    } catch {
      toast('Could not reserve that number automatically — add it from Phone Numbers in your dashboard.', 'info');
    }
  }, [data, toast]);

  const seedKnowledgeIfNeeded = useCallback(async () => {
    if (!user || data.faqs.length === 0) return;
    try {
      await Promise.all(
        data.faqs
          .filter((f) => f.question.trim() && f.answer.trim())
          .map((f) =>
            createArticle(
              {
                ...EMPTY_ARTICLE_FORM,
                title: f.question.trim(),
                summary: f.answer.trim().slice(0, 140),
                body: f.answer.trim(),
                audience: 'ai',
                status: 'published',
              },
              user.id,
            ),
          ),
      );
    } catch {
      toast('Saved your FAQs to the profile, but the knowledge base import needs a retry from Knowledge Base.', 'info');
    }
  }, [user, data.faqs, toast]);

  // ------------------------------------------------------------
  // Navigation
  // ------------------------------------------------------------
  const goTo = useCallback(
    async (id: StepId, markCurrentComplete: boolean) => {
      setSaving(true);
      try {
        await saveBusinessProfile();
        const completed = markCurrentComplete
          ? Array.from(new Set([...data.completedSteps, stepId]))
          : data.completedSteps;
        if (markCurrentComplete) update({ completedSteps: completed });
        await persistWizardState(id, completed);
        setStepId(id);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch {
        toast('Could not save this step — check your connection and try again.', 'error');
      } finally {
        setSaving(false);
      }
    },
    [saveBusinessProfile, persistWizardState, data.completedSteps, stepId, update, toast],
  );

  const goNext = useCallback(() => {
    const next = STEPS[stepIndex + 1];
    if (next) goTo(next.id, true);
  }, [stepIndex, goTo]);

  const goBack = useCallback(() => {
    const prev = STEPS[stepIndex - 1];
    if (prev) goTo(prev.id, false);
  }, [stepIndex, goTo]);

  const skip = useCallback(() => {
    const next = STEPS[stepIndex + 1];
    if (next) goTo(next.id, false);
  }, [stepIndex, goTo]);

  // ------------------------------------------------------------
  // Launch: the one step that actually flips onboarding_completed.
  // ------------------------------------------------------------
  const launch = useCallback(async () => {
    if (!user) return;
    if (!data.fullName.trim() || !data.companyName.trim()) {
      toast('Please fill in your name and company name.', 'error');
      goTo('business', false);
      return;
    }
    setSaving(true);
    try {
      const { data: updatedProfile, error: profError } = await supabase
        .from('profiles')
        .update({
          full_name: data.fullName.trim(),
          company_name: data.companyName.trim(),
          phone: data.phone.trim(),
          forwarding_number: data.forwardingNumber.trim(),
          onboarding_completed: true,
        })
        .eq('id', user.id)
        .select('onboarding_completed')
        .maybeSingle();
      if (profError) throw profError;
      if (!updatedProfile?.onboarding_completed) {
        toast('Could not save your setup — please sign out and back in, then try again.', 'error');
        return;
      }

      await saveBusinessProfile();
      await provisionPhoneIfNeeded();
      await seedKnowledgeIfNeeded();
      await persistWizardState('launch', STEPS.map((s) => s.id));

      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        /* non-fatal */
      }

      await refreshProfile();
      toast(`Welcome to Vireek! ${data.assistantName.trim() || 'Sarah'} is ready to take calls.`, 'success');
      setLaunched(true);
    } catch {
      toast('Could not save your setup. Please try again.', 'error');
    } finally {
      setSaving(false);
    }
  }, [user, data, saveBusinessProfile, provisionPhoneIfNeeded, seedKnowledgeIfNeeded, persistWizardState, refreshProfile, toast, goTo]);

  const finishToDashboard = useCallback(() => {
    navigate('/dashboard', { replace: true });
  }, [navigate]);

  return {
    stepId,
    stepIndex,
    data,
    update,
    loading,
    saving,
    launched,
    goNext,
    goBack,
    skip,
    goTo,
    launch,
    finishToDashboard,
  };
}
