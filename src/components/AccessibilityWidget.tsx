import { useState, useRef, useEffect, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Accessibility, X, RotateCcw, Check, Zap, Eye, Brain, Book, Shield,
  Keyboard, Volume2, User, Type, Minimize, Target, Sparkles,
  Contrast, Palette, BookOpen, Wind, Navigation, Globe,
  ChevronRight, Info,
} from 'lucide-react';
import {
  useAccessibility,
  PROFILES,
  QUICK_ACTIONS,
  type AccessibilityProfile,
  type AccessibilitySettings,
} from '@/contexts/AccessibilityContext';

const EASE = [0.16, 1, 0.0, 1] as const;

/* ------------------------------------------------------------------ */
/*  Icon map for profiles & quick actions                              */
/* ------------------------------------------------------------------ */

const ICON_MAP: Record<string, typeof Eye> = {
  universal: Accessibility,
  eye: Eye,
  brain: Brain,
  book: Book,
  shield: Shield,
  keyboard: Keyboard,
  volume: Volume2,
  user: User,
  type: Type,
  minimize: Minimize,
  target: Target,
};

/* ------------------------------------------------------------------ */
/*  Toggle switch                                                      */
/* ------------------------------------------------------------------ */

function Toggle({
  checked,
  onChange,
  label,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  id: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      tabIndex={0}
      onClick={() => onChange(!checked)}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          onChange(!checked);
        }
      }}
      className={`focus-ring relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 ease-out ${
        checked ? 'bg-accent' : 'bg-border hover:bg-border/70'
      }`}
    >
      <motion.span
        layout
        transition={{ type: 'spring', stiffness: 500, damping: 32 }}
        className={`pointer-events-none block h-4.5 w-4.5 rounded-full bg-white shadow-sm ${checked ? 'ml-auto mr-1' : 'ml-1'}`}
        style={{ height: '18px', width: '18px' }}
      />
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Setting row                                                        */
/* ------------------------------------------------------------------ */

function SettingRow({
  icon: Icon,
  label,
  description,
  checked,
  onChange,
}: {
  icon: typeof Eye;
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = `a11y-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <div className="group flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors duration-150 hover:bg-bg-tertiary/60">
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-200 ${
        checked ? 'bg-accent/15 text-accent' : 'bg-bg-tertiary text-text-secondary/60'
      }`}>
        <Icon size={15} />
      </span>
      <div className="flex-1 min-w-0">
        <label htmlFor={id} className="block text-sm font-medium text-text-primary cursor-pointer">
          {label}
        </label>
        <p className="text-xs text-text-secondary/70 truncate">{description}</p>
      </div>
      <Toggle id={id} checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Slider row                                                         */
/* ------------------------------------------------------------------ */

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  displayValue,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  displayValue: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-text-primary">{label}</span>
        <span className="text-xs font-semibold text-accent tabular-nums">{displayValue}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        aria-label={label}
        className="w-full h-1.5 cursor-pointer appearance-none rounded-full bg-border accent-accent focus-ring"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Section wrapper                                                    */
/* ------------------------------------------------------------------ */

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Eye;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 px-3 pt-4 pb-2">
        <Icon size={15} className="text-accent" />
        <h4 className="text-xs font-bold uppercase tracking-wider text-text-secondary">{title}</h4>
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Profile card                                                       */
/* ------------------------------------------------------------------ */

function ProfileCard({
  profile,
  isActive,
  onApply,
}: {
  profile: AccessibilityProfile;
  isActive: boolean;
  onApply: () => void;
}) {
  const Icon = ICON_MAP[profile.icon] ?? Accessibility;
  return (
    <motion.button
      type="button"
      onClick={onApply}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.97 }}
      transition={{ duration: 0.2, ease: EASE }}
      className={`group relative w-full overflow-hidden rounded-xl border p-3.5 text-left transition-colors duration-200 ${
        isActive
          ? 'border-accent/50 bg-accent/8'
          : 'border-border bg-bg-secondary hover:border-accent/30'
      }`}
    >
      {isActive && (
        <span className="absolute right-2.5 top-2.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-white">
          <Check size={10} strokeWidth={3} />
        </span>
      )}
      <span className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors duration-200 ${
        isActive ? 'bg-accent/15 text-accent' : 'bg-bg-tertiary text-text-secondary group-hover:text-accent'
      }`}>
        <Icon size={17} />
      </span>
      <h5 className="mt-2.5 text-sm font-semibold text-text-primary leading-tight">{profile.name}</h5>
      <p className="mt-1 text-xs text-text-secondary/70 leading-relaxed">{profile.description}</p>
    </motion.button>
  );
}

/* ------------------------------------------------------------------ */
/*  Accessibility score ring                                           */
/* ------------------------------------------------------------------ */

function ScoreRing({ score }: { score: number }) {
  const radius = 28;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  return (
    <div className="relative flex h-16 w-16 shrink-0 items-center justify-center">
      <svg className="absolute inset-0 -rotate-90" viewBox="0 0 64 64" fill="none">
        <circle cx="32" cy="32" r={radius} stroke="rgb(var(--border-default))" strokeWidth="4" />
        <motion.circle
          cx="32"
          cy="32"
          r={radius}
          stroke="rgb(var(--accent-primary))"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 0.8, ease: EASE }}
        />
      </svg>
      <span className="text-sm font-bold tabular-nums text-text-primary">{score}%</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab definition                                                     */
/* ------------------------------------------------------------------ */

type TabId = 'assistant' | 'profiles' | 'vision' | 'color' | 'reading' | 'motion' | 'navigation';

const TABS: { id: TabId; label: string; icon: typeof Eye }[] = [
  { id: 'assistant', label: 'Assistant', icon: Sparkles },
  { id: 'profiles', label: 'Profiles', icon: Accessibility },
  { id: 'vision', label: 'Vision', icon: Eye },
  { id: 'color', label: 'Color', icon: Palette },
  { id: 'reading', label: 'Reading', icon: BookOpen },
  { id: 'motion', label: 'Motion', icon: Wind },
  { id: 'navigation', label: 'Navigation', icon: Navigation },
];

/* ------------------------------------------------------------------ */
/*  Main panel content                                                 */
/* ------------------------------------------------------------------ */

function PanelContent({ onClose }: { onClose: () => void }) {
  const { settings, updateSetting, applyProfile, resetAll, activeProfile, score } = useAccessibility();
  const [activeTab, setActiveTab] = useState<TabId>('assistant');
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showResetFlash, setShowResetFlash] = useState(false);

  const handleReset = () => {
    resetAll();
    setShowResetConfirm(false);
    setShowResetFlash(true);
    setTimeout(() => setShowResetFlash(false), 2500);
  };

  const renderAssistant = () => (
    <div className="space-y-4 px-3 py-2">
      {/* Score */}
      <div className="flex items-center gap-4 rounded-xl border border-accent/20 bg-accent/5 p-4">
        <ScoreRing score={score} />
        <div>
          <h4 className="text-sm font-bold text-text-primary">Accessibility Score</h4>
          <p className="mt-0.5 text-xs text-text-secondary leading-relaxed">
            {score === 100
              ? 'Your accessibility experience: 100% optimized'
              : `Your accessibility experience: ${score}% optimized`}
          </p>
        </div>
      </div>

      {/* Quick actions */}
      <div>
        <h4 className="px-1 pb-2 text-xs font-bold uppercase tracking-wider text-text-secondary">Quick Actions</h4>
        <div className="grid grid-cols-2 gap-2">
          {QUICK_ACTIONS.map((action) => {
            const Icon = ICON_MAP[action.icon] ?? Zap;
            return (
              <motion.button
                key={action.id}
                type="button"
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.97 }}
                transition={{ duration: 0.2, ease: EASE }}
                onClick={() => {
                  (Object.keys(action.apply) as (keyof AccessibilitySettings)[]).forEach((k) => {
                    updateSetting(k, action.apply[k] as never);
                  });
                }}
                className="group rounded-xl border border-border bg-bg-secondary p-3 text-left transition-colors hover:border-accent/30"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
                  <Icon size={15} />
                </span>
                <h5 className="mt-2 text-xs font-semibold text-text-primary leading-tight">{action.label}</h5>
                <p className="mt-0.5 text-[0.7rem] text-text-secondary/60 leading-relaxed">{action.description}</p>
              </motion.button>
            );
          })}
        </div>
      </div>

      {/* Smart suggestions */}
      <div className="rounded-xl border border-border bg-bg-tertiary/50 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Info size={14} className="text-accent" />
          <h4 className="text-xs font-bold uppercase tracking-wider text-text-secondary">Smart Suggestions</h4>
        </div>
        <ul className="space-y-2.5">
          <li className="flex items-start gap-2 text-xs text-text-secondary">
            <Check size={14} className="mt-0.5 shrink-0 text-success" />
            <span>Enable <strong className="text-text-primary">strong focus indicators</strong> for better keyboard navigation.</span>
          </li>
          <li className="flex items-start gap-2 text-xs text-text-secondary">
            <Check size={14} className="mt-0.5 shrink-0 text-success" />
            <span>Increase <strong className="text-text-primary">line height</strong> to 1.8 for improved reading comfort.</span>
          </li>
          <li className="flex items-start gap-2 text-xs text-text-secondary">
            <Check size={14} className="mt-0.5 shrink-0 text-success" />
            <span>Turn on <strong className="text-text-primary">reduce motion</strong> if animations cause discomfort.</span>
          </li>
        </ul>
      </div>
    </div>
  );

  const renderProfiles = () => (
    <div className="grid grid-cols-2 gap-2.5 px-3 py-2">
      {PROFILES.map((profile) => (
        <ProfileCard
          key={profile.id}
          profile={profile}
          isActive={activeProfile === profile.id}
          onApply={() => applyProfile(profile)}
        />
      ))}
    </div>
  );

  const renderVision = () => (
    <>
      <Section icon={Type} title="Text & Font">
        <SliderRow
          label="Text Size"
          value={settings.textSize}
          min={0.875}
          max={1.5}
          step={0.025}
          displayValue={`${Math.round(settings.textSize * 100)}%`}
          onChange={(v) => updateSetting('textSize', v)}
        />
        <SliderRow
          label="Content Scaling"
          value={settings.contentScale}
          min={0.9}
          max={1.2}
          step={0.025}
          displayValue={`${Math.round(settings.contentScale * 100)}%`}
          onChange={(v) => updateSetting('contentScale', v)}
        />
        <SettingRow icon={Type} label="Readable Font" description="Switch to a highly legible serif font" checked={settings.readableFont} onChange={(v) => updateSetting('readableFont', v)} />
        <SettingRow icon={Type} label="Dyslexia Friendly Font" description="Specialized font for dyslexic readers" checked={settings.dyslexiaFont} onChange={(v) => updateSetting('dyslexiaFont', v)} />
      </Section>
      <Section icon={Eye} title="Visual Aids">
        <SettingRow icon={Eye} label="Large Cursor" description="Increase cursor size for visibility" checked={settings.largeCursor} onChange={(v) => updateSetting('largeCursor', v)} />
        <SettingRow icon={Type} label="Highlight Links" description="Underline all links clearly" checked={settings.highlightLinks} onChange={(v) => updateSetting('highlightLinks', v)} />
        <SettingRow icon={Book} label="Highlight Headings" description="Outline all headings" checked={settings.highlightHeadings} onChange={(v) => updateSetting('highlightHeadings', v)} />
        <SettingRow icon={Target} label="Strong Focus Indicators" description="Enhanced focus rings" checked={settings.strongFocus} onChange={(v) => updateSetting('strongFocus', v)} />
      </Section>
    </>
  );

  const renderColor = () => (
    <>
      <Section icon={Contrast} title="Contrast Modes">
        <SettingRow icon={Contrast} label="High Contrast" description="Maximum text/background contrast" checked={settings.highContrast} onChange={(v) => updateSetting('highContrast', v)} />
        <SettingRow icon={Eye} label="Dark Contrast" description="Force dark background" checked={settings.darkContrast} onChange={(v) => updateSetting('darkContrast', v)} />
        <SettingRow icon={Eye} label="Light Contrast" description="Force light background" checked={settings.lightContrast} onChange={(v) => updateSetting('lightContrast', v)} />
      </Section>
      <Section icon={Palette} title="Color Adjustments">
        <SettingRow icon={Palette} label="Invert Colors" description="Invert the entire color scheme" checked={settings.invertColors} onChange={(v) => updateSetting('invertColors', v)} />
        <SettingRow icon={Palette} label="Grayscale" description="Remove all color" checked={settings.grayscale} onChange={(v) => updateSetting('grayscale', v)} />
        <SettingRow icon={Palette} label="Monochrome" description="Black and white mode" checked={settings.monochrome} onChange={(v) => updateSetting('monochrome', v)} />
        <SettingRow icon={Palette} label="High Saturation" description="Boost color intensity" checked={settings.highSaturation} onChange={(v) => updateSetting('highSaturation', v)} />
        <SettingRow icon={Palette} label="Low Saturation" description="Reduce color intensity" checked={settings.lowSaturation} onChange={(v) => updateSetting('lowSaturation', v)} />
      </Section>
    </>
  );

  const renderReading = () => (
    <>
      <Section icon={BookOpen} title="Reading Comfort">
        <SettingRow icon={BookOpen} label="Reading Mode" description="Simplify layout, narrow content width" checked={settings.readingMode} onChange={(v) => updateSetting('readingMode', v)} />
        <SliderRow
          label="Line Height"
          value={settings.lineHeight}
          min={1.4}
          max={2.2}
          step={0.1}
          displayValue={settings.lineHeight.toFixed(1)}
          onChange={(v) => updateSetting('lineHeight', v)}
        />
        <SliderRow
          label="Letter Spacing"
          value={settings.letterSpacing}
          min={0}
          max={0.2}
          step={0.02}
          displayValue={`${settings.letterSpacing}em`}
          onChange={(v) => updateSetting('letterSpacing', v)}
        />
        <SliderRow
          label="Word Spacing"
          value={settings.wordSpacing}
          min={0}
          max={0.3}
          step={0.05}
          displayValue={`${settings.wordSpacing}em`}
          onChange={(v) => updateSetting('wordSpacing', v)}
        />
      </Section>
    </>
  );

  const renderMotion = () => (
    <Section icon={Wind} title="Motion & Media">
      <SettingRow icon={Minimize} label="Reduce Motion" description="Minimize transitions and animations" checked={settings.reduceMotion} onChange={(v) => updateSetting('reduceMotion', v)} />
      <SettingRow icon={X} label="Stop Animations" description="Disable all animated content" checked={settings.stopAnimations} onChange={(v) => updateSetting('stopAnimations', v)} />
      <SettingRow icon={Eye} label="Hide Images" description="Replace images with placeholders" checked={settings.hideImages} onChange={(v) => updateSetting('hideImages', v)} />
    </Section>
  );

  const renderNavigation = () => (
    <Section icon={Navigation} title="Navigation & Input">
      <SettingRow icon={Target} label="Highlight Keyboard Focus" description="Stronger focus visibility for tabbing" checked={settings.highlightKeyboardFocus} onChange={(v) => updateSetting('highlightKeyboardFocus', v)} />
      <SettingRow icon={Volume2} label="Screen Reader Mode" description="Optimize for assistive technology" checked={settings.screenReaderMode} onChange={(v) => updateSetting('screenReaderMode', v)} />
      <div className="px-3 py-3 rounded-xl bg-bg-tertiary/50 mt-2">
        <div className="flex items-center gap-2 mb-2">
          <Globe size={14} className="text-accent" />
          <span className="text-xs font-bold uppercase tracking-wider text-text-secondary">Language</span>
        </div>
        <p className="text-xs text-text-secondary/70 leading-relaxed">
          Multi-language architecture is ready. Language switching will be available when additional locales are added.
        </p>
      </div>
    </Section>
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="relative shrink-0 border-b border-border bg-bg-tertiary px-5 py-4">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage: 'radial-gradient(circle at 80% 20%, rgb(var(--accent-primary) / 0.08), transparent 60%)',
          }}
        />
        <div className="relative flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/10 text-accent ring-1 ring-accent/20">
              <Accessibility size={18} />
            </span>
            <div>
              <h3 className="text-base font-bold tracking-tight text-text-primary">Accessibility Center</h3>
              <p className="text-xs text-text-secondary/70">Customize your experience</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close accessibility center"
            className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="shrink-0 overflow-x-auto border-b border-border bg-bg-secondary">
        <div className="flex min-w-max px-2">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-semibold whitespace-nowrap transition-colors duration-200 ${
                  active
                    ? 'text-accent border-b-2 border-accent'
                    : 'text-text-secondary hover:text-text-primary border-b-2 border-transparent'
                }`}
              >
                <Icon size={14} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-1 py-2">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={{ duration: 0.2, ease: EASE }}
          >
            {activeTab === 'assistant' && renderAssistant()}
            {activeTab === 'profiles' && renderProfiles()}
            {activeTab === 'vision' && renderVision()}
            {activeTab === 'color' && renderColor()}
            {activeTab === 'reading' && renderReading()}
            {activeTab === 'motion' && renderMotion()}
            {activeTab === 'navigation' && renderNavigation()}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-border bg-bg-tertiary px-4 py-3">
        <AnimatePresence mode="wait">
          {showResetFlash ? (
            <motion.div
              key="flash"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="flex items-center justify-center gap-2 text-sm font-medium text-success"
            >
              <Check size={15} />
              Settings reset to defaults
            </motion.div>
          ) : showResetConfirm ? (
            <motion.div
              key="confirm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center justify-between gap-3"
            >
              <span className="text-xs text-text-secondary">Reset all accessibility settings?</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowResetConfirm(false)}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleReset}
                  className="rounded-lg bg-danger px-3 py-1.5 text-xs font-semibold text-white transition-all hover:brightness-110"
                >
                  Reset All
                </button>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="default"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-1.5 text-xs text-text-secondary/70">
                <Check size={13} className="text-success" />
                Auto-saved
              </div>
              <button
                type="button"
                onClick={() => setShowResetConfirm(true)}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:text-danger"
              >
                <RotateCcw size={13} />
                Reset
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Onboarding tooltip                                                 */
/* ------------------------------------------------------------------ */

function OnboardingTip({ onDismiss }: { onDismiss: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.95 }}
      transition={{ duration: 0.35, ease: EASE }}
      className="a11y-widget absolute bottom-[72px] right-0 w-64 overflow-hidden rounded-2xl border border-border bg-bg-secondary/95 shadow-2xl backdrop-blur-xl"
    >
      <div className="h-px bg-gradient-to-r from-transparent via-accent/50 to-transparent" />
      <div className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Sparkles size={14} />
          </span>
          <h4 className="text-sm font-bold text-text-primary">Accessibility Center</h4>
        </div>
        <p className="text-xs text-text-secondary leading-relaxed">
          Customize text size, contrast, motion, and more. Your preferences are saved automatically.
        </p>
        <button
          type="button"
          onClick={onDismiss}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent py-2 text-xs font-semibold text-white transition-all hover:brightness-110"
        >
          Got it
          <ChevronRight size={13} />
        </button>
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main widget                                                        */
/* ------------------------------------------------------------------ */

export function AccessibilityWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const { hasOnboarded, setHasOnboarded } = useAccessibility();
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // First-time onboarding
  useEffect(() => {
    if (!hasOnboarded) {
      const timer = setTimeout(() => setShowOnboarding(true), 2000);
      return () => clearTimeout(timer);
    }
  }, [hasOnboarded]);

  const dismissOnboarding = () => {
    setShowOnboarding(false);
    setHasOnboarded(true);
  };

  // Focus trap
  useEffect(() => {
    if (!isOpen) return;
    const panel = panelRef.current;
    if (!panel) return;

    const focusable = panel.querySelectorAll<HTMLElement>(
      'button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first?.focus();

    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    panel.addEventListener('keydown', trap);
    return () => panel.removeEventListener('keydown', trap);
  }, [isOpen]);

  // Escape to close
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen]);

  return (
    <div className="a11y-widget fixed bottom-5 right-5 z-[75] print:hidden">
      {/* Onboarding tooltip */}
      <AnimatePresence>
        {showOnboarding && !isOpen && (
          <OnboardingTip onDismiss={dismissOnboarding} />
        )}
      </AnimatePresence>

      {/* Floating button */}
      <motion.button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setIsOpen((prev) => !prev);
          if (showOnboarding) dismissOnboarding();
        }}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        aria-label={isOpen ? 'Close accessibility center' : 'Open accessibility center'}
        aria-expanded={isOpen}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.92 }}
        transition={{ type: 'spring', stiffness: 400, damping: 17 }}
        className="group relative flex h-12 w-12 items-center justify-center rounded-2xl border border-accent/20 bg-bg-secondary/80 text-accent shadow-glow-accent backdrop-blur-xl transition-colors duration-200 hover:border-accent/40"
      >
        <AnimatePresence mode="wait" initial={false}>
          {isOpen ? (
            <motion.span
              key="close"
              initial={{ rotate: -90, opacity: 0 }}
              animate={{ rotate: 0, opacity: 1 }}
              exit={{ rotate: 90, opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              <X size={20} />
            </motion.span>
          ) : (
            <motion.span
              key="open"
              initial={{ rotate: 90, opacity: 0 }}
              animate={{ rotate: 0, opacity: 1 }}
              exit={{ rotate: -90, opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              <Accessibility size={20} />
            </motion.span>
          )}
        </AnimatePresence>

        {/* Hover tooltip */}
        <AnimatePresence>
          {showTooltip && !isOpen && !showOnboarding && (
            <motion.span
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={{ duration: 0.15 }}
              className="pointer-events-none absolute right-14 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-lg border border-border bg-bg-secondary/95 px-3 py-1.5 text-xs font-medium text-text-primary shadow-lg backdrop-blur-xl"
            >
              Accessibility Center
            </motion.span>
          )}
        </AnimatePresence>
      </motion.button>

      {/* Panel / Modal */}
      <AnimatePresence>
        {isOpen && (
          <>
            {/* Mobile backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setIsOpen(false)}
              className="fixed inset-0 z-[73] bg-slate-950/40 backdrop-blur-sm sm:hidden"
            />

            {/* Desktop: floating panel */}
            <motion.div
              ref={panelRef}
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 16, scale: 0.96 }}
              transition={{ type: 'spring', stiffness: 320, damping: 28 }}
              className="fixed bottom-[72px] right-5 z-[74] hidden h-[min(640px,80vh)] w-[400px] flex-col overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-2xl sm:flex"
              role="dialog"
              aria-modal="true"
              aria-label="Accessibility Center"
            >
              <PanelContent onClose={() => setIsOpen(false)} />
            </motion.div>

            {/* Mobile: bottom sheet */}
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', stiffness: 320, damping: 30 }}
              className="fixed inset-x-0 bottom-0 z-[74] flex h-[80vh] flex-col overflow-hidden rounded-t-3xl border border-border bg-bg-secondary shadow-2xl sm:hidden"
              role="dialog"
              aria-modal="true"
              aria-label="Accessibility Center"
            >
              {/* Drag handle */}
              <div className="flex justify-center pt-2.5 pb-1 shrink-0">
                <span className="h-1 w-10 rounded-full bg-border" />
              </div>
              <PanelContent onClose={() => setIsOpen(false)} />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
