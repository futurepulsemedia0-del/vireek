import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  Mic,
  UserRound,
  Sparkles,
  Save,
  Loader as Loader2,
  Check,
  MessageCircle,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, BusinessProfile } from '@/lib/supabase';

// ============================================================
// CONSTANTS
// ============================================================

type ToneId = BusinessProfile['assistant_tone'];

interface VoiceOption {
  id: string;
  name: string;
  detail: string;
}

// Fixed, DB-constrained set — must stay in sync with the CHECK constraint
// on business_profile.assistant_voice (see the migration that added it).
// No audio backend is wired up yet, so this is a description-only picker
// rather than a "play sample" control — nothing here should claim to play
// real audio until an actual voice provider is connected.
const VOICE_OPTIONS: VoiceOption[] = [
  { id: 'sarah-warm-f-us', name: 'Sarah', detail: 'Warm, female, US accent — the current default' },
  { id: 'aria-friendly-f-us', name: 'Aria', detail: 'Upbeat, female, US accent' },
  { id: 'maya-calm-f-uk', name: 'Maya', detail: 'Calm, female, UK accent' },
  { id: 'miles-confident-m-us', name: 'Miles', detail: 'Confident, male, US accent' },
  { id: 'jay-easygoing-m-us', name: 'Jay', detail: 'Easygoing, male, US accent' },
  { id: 'oliver-polished-m-uk', name: 'Oliver', detail: 'Polished, male, UK accent' },
];

const TONE_OPTIONS: { id: ToneId; label: string; detail: string }[] = [
  { id: 'friendly', label: 'Friendly', detail: 'Casual and upbeat — small talk is welcome.' },
  { id: 'professional', label: 'Professional', detail: 'Polished and to the point, minimal chit-chat.' },
  { id: 'warm', label: 'Warm', detail: 'Patient and reassuring — good for sensitive calls.' },
  { id: 'direct', label: 'Direct', detail: 'Fast and efficient, gets straight to booking.' },
];

const NAME_MAX_LENGTH = 40;

// ============================================================
// MAIN PAGE
// ============================================================

export function AssistantPersonaPage() {
  const navigate = useNavigate();
  const { user, profile, profileLoading } = useAuth();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [greetingScript, setGreetingScript] = useState('');

  const [assistantName, setAssistantName] = useState('Sarah');
  const [assistantVoice, setAssistantVoice] = useState<string>(VOICE_OPTIONS[0].id);
  const [assistantTone, setAssistantTone] = useState<ToneId>('friendly');

  const loadProfile = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('business_profile')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) throw error;

      if (data) {
        const bp = data as BusinessProfile;
        setProfileId(bp.id);
        setGreetingScript(bp.greeting_script ?? '');
        setAssistantName(bp.assistant_name || 'Sarah');
        setAssistantVoice(bp.assistant_voice || VOICE_OPTIONS[0].id);
        setAssistantTone(bp.assistant_tone || 'friendly');
      }
    } catch {
      // empty state — user will create a business profile on save
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  useEffect(() => {
    if (!profileLoading && profile && !profile.onboarding_completed) {
      navigate('/onboarding', { replace: true });
    }
  }, [profile, profileLoading, navigate]);

  const handleSave = async () => {
    if (!user) return;
    const trimmedName = assistantName.trim();
    if (!trimmedName) {
      toast('Give your assistant a name before saving.', 'error');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        user_id: user.id,
        assistant_name: trimmedName.slice(0, NAME_MAX_LENGTH),
        assistant_voice: assistantVoice,
        assistant_tone: assistantTone,
      };

      if (profileId) {
        const { error } = await supabase
          .from('business_profile')
          .update(payload)
          .eq('id', profileId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from('business_profile')
          .insert(payload)
          .select('id')
          .single();
        if (error) throw error;
        if (data) setProfileId(data.id);
      }

      setAssistantName(trimmedName);
      toast(`Saved — your assistant now introduces itself as ${trimmedName}.`, 'success');
    } catch {
      toast('Could not save these changes. Please try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const previewGreeting = greetingScript.trim()
    ? greetingScript.trim().replace(/\bSarah\b/g, assistantName.trim() || 'Sarah')
    : `Thanks for calling! This is ${assistantName.trim() || 'Sarah'}, how can I help you today?`;

  return (
    <DashboardLayout activeLabel="Settings">
      <button
        type="button"
        onClick={() => navigate('/dashboard/settings')}
        className="focus-ring mb-5 flex items-center gap-2 text-sm text-text-secondary transition-colors hover:text-text-primary"
      >
        <ArrowLeft size={16} /> Back to settings
      </button>

      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <Mic size={24} />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">
            Assistant voice &amp; persona
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            Choose the name, voice, and tone your AI receptionist uses with callers.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="space-y-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
              <div className="h-5 w-40 animate-pulse rounded bg-bg-tertiary" />
              <div className="mt-4 h-10 w-full animate-pulse rounded bg-bg-tertiary" />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          {/* Name */}
          <SectionCard
            icon={UserRound}
            title="Assistant name"
            description="What your assistant calls itself on calls and in chat. Pick anything — it doesn't have to be Sarah."
          >
            <input
              type="text"
              value={assistantName}
              onChange={(e) => setAssistantName(e.target.value)}
              maxLength={NAME_MAX_LENGTH}
              placeholder="e.g. Sarah, Alex, Riley"
              className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors"
            />
            <p className="mt-2 text-xs text-text-secondary/60">
              {assistantName.trim().length}/{NAME_MAX_LENGTH} characters
            </p>
          </SectionCard>

          {/* Voice */}
          <SectionCard
            icon={Mic}
            title="Voice"
            description="Pick the voice your assistant uses on phone calls."
          >
            <div className="grid gap-2 sm:grid-cols-2">
              {VOICE_OPTIONS.map((voice) => (
                <button
                  key={voice.id}
                  type="button"
                  onClick={() => setAssistantVoice(voice.id)}
                  className={`focus-ring flex items-start justify-between gap-3 rounded-xl border p-3.5 text-left transition-colors ${
                    assistantVoice === voice.id
                      ? 'border-accent bg-accent/5'
                      : 'border-border bg-bg-primary hover:border-accent/30'
                  }`}
                >
                  <div>
                    <p className="text-sm font-medium text-text-primary">{voice.name}</p>
                    <p className="mt-0.5 text-xs text-text-secondary">{voice.detail}</p>
                  </div>
                  {assistantVoice === voice.id && (
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-white">
                      <Check size={12} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          </SectionCard>

          {/* Tone */}
          <SectionCard
            icon={Sparkles}
            title="Tone"
            description="How your assistant should come across in conversation."
          >
            <div className="grid gap-2 sm:grid-cols-2">
              {TONE_OPTIONS.map((tone) => (
                <button
                  key={tone.id}
                  type="button"
                  onClick={() => setAssistantTone(tone.id)}
                  className={`focus-ring flex items-start justify-between gap-3 rounded-xl border p-3.5 text-left transition-colors ${
                    assistantTone === tone.id
                      ? 'border-accent bg-accent/5'
                      : 'border-border bg-bg-primary hover:border-accent/30'
                  }`}
                >
                  <div>
                    <p className="text-sm font-medium text-text-primary">{tone.label}</p>
                    <p className="mt-0.5 text-xs text-text-secondary">{tone.detail}</p>
                  </div>
                  {assistantTone === tone.id && (
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-white">
                      <Check size={12} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          </SectionCard>

          {/* Preview */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className="flex items-start gap-4 rounded-2xl border border-accent/20 bg-accent/5 p-5"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <MessageCircle size={20} />
            </span>
            <div>
              <h3 className="text-sm font-semibold text-text-primary">Preview</h3>
              <p className="mt-1 text-sm italic leading-relaxed text-text-secondary">
                &ldquo;{previewGreeting}&rdquo;
              </p>
              <p className="mt-2 text-xs text-text-secondary/60">
                Based on your greeting script in Business Profile, with the name above swapped in.
              </p>
            </div>
          </motion.div>

          {/* Save bar */}
          <div className="sticky bottom-4 z-10 flex items-center justify-end gap-3 rounded-2xl border border-border bg-bg-secondary/95 p-4 shadow-card backdrop-blur-md dark:shadow-card-dark">
            <button
              type="button"
              onClick={() => navigate('/dashboard/settings')}
              className="focus-ring rounded-xl border border-border px-5 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="focus-ring flex items-center gap-2 rounded-xl bg-cta px-5 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}

// ============================================================
// SECTION CARD
// ============================================================

function SectionCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof Mic;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Icon size={20} />
        </span>
        <div>
          <h3 className="text-base font-semibold text-text-primary">{title}</h3>
          <p className="mt-0.5 text-sm text-text-secondary">{description}</p>
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </motion.div>
  );
}
