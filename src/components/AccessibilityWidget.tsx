import { useState, useRef, useEffect, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Accessibility, X, RotateCcw, Check, Zap, Eye, Brain, Book, Shield,
  Keyboard, Volume2, User, Type, Minimize, Target, Sparkles,
  Contrast, Palette, BookOpen, Wind, Navigation, Globe,
  ChevronRight, Info, Search, Mic, Languages,
  type LucideIcon,
} from 'lucide-react';
import {
  useAccessibility,
  PROFILES,
  QUICK_ACTIONS,
  type AccessibilityProfile,
  type AccessibilitySettings,
} from '@/contexts/AccessibilityContext';
import {
  LANGUAGES,
  GLOBAL_PROFILES,
  type LanguageCode,
  type Language,
  type TranslationKey,
} from '@/lib/i18n';

const EASE = [0.16, 1, 0.0, 1] as const;

/* ------------------------------------------------------------------ */
/*  Icon map                                                           */
/* ------------------------------------------------------------------ */

const ICON_MAP: Record<string, LucideIcon> = {
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
  globe: Globe,
  languages: Languages,
};

/* ------------------------------------------------------------------ */
/*  Toggle switch                                                      */
/* ------------------------------------------------------------------ */

function Toggle({ checked, onChange, label, id }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; id: string;
}) {
  return (
    <button
      type="button" role="switch" id={id} aria-checked={checked} aria-label={label}
      tabIndex={0}
      onClick={() => onChange(!checked)}
      onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onChange(!checked); } }}
      className={`focus-ring relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 ease-out ${checked ? 'bg-accent' : 'bg-border hover:bg-border/70'}`}
    >
      <motion.span layout transition={{ type: 'spring', stiffness: 500, damping: 32 }}
        className="pointer-events-none rounded-full bg-white shadow-sm"
        style={{ height: '18px', width: '18px', marginLeft: checked ? 'auto' : '4px', marginRight: checked ? '4px' : '0' }}
      />
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Setting row                                                        */
/* ------------------------------------------------------------------ */

function SettingRow({ icon: Icon, label, description, checked, onChange }: {
  icon: LucideIcon; label: string; description: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  const id = `a11y-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <div className="group flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors duration-150 hover:bg-bg-tertiary/60">
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-200 ${checked ? 'bg-accent/15 text-accent' : 'bg-bg-tertiary text-text-secondary/60'}`}>
        <Icon size={15} />
      </span>
      <div className="flex-1 min-w-0">
        <label htmlFor={id} className="block cursor-pointer text-sm font-medium text-text-primary">{label}</label>
        <p className="truncate text-xs text-text-secondary/70">{description}</p>
      </div>
      <Toggle id={id} checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Slider row                                                         */
/* ------------------------------------------------------------------ */

function SliderRow({ label, value, min, max, step, displayValue, onChange }: {
  label: string; value: number; min: number; max: number; step: number; displayValue: string; onChange: (v: number) => void;
}) {
  return (
    <div className="px-3 py-2.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-text-primary">{label}</span>
        <span className="text-xs font-semibold tabular-nums text-accent">{displayValue}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))} aria-label={label}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border accent-accent focus-ring"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Section wrapper                                                    */
/* ------------------------------------------------------------------ */

function Section({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 px-3 pb-2 pt-4">
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

function ProfileCard({ profile, isActive, onApply }: {
  profile: AccessibilityProfile; isActive: boolean; onApply: () => void;
}) {
  const Icon = ICON_MAP[profile.icon] ?? Accessibility;
  return (
    <motion.button type="button" onClick={onApply} whileHover={{ y: -2 }} whileTap={{ scale: 0.97 }}
      transition={{ duration: 0.2, ease: EASE }}
      className={`group relative w-full overflow-hidden rounded-xl border p-3.5 text-left transition-colors duration-200 ${isActive ? 'border-accent/50 bg-accent/8' : 'border-border bg-bg-secondary hover:border-accent/30'}`}
    >
      {isActive && <span className="absolute right-2.5 top-2.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-white"><Check size={10} strokeWidth={3} /></span>}
      <span className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors duration-200 ${isActive ? 'bg-accent/15 text-accent' : 'bg-bg-tertiary text-text-secondary group-hover:text-accent'}`}>
        <Icon size={17} />
      </span>
      <h5 className="mt-2.5 text-sm font-semibold leading-tight text-text-primary">{profile.name}</h5>
      <p className="mt-1 text-xs leading-relaxed text-text-secondary/70">{profile.description}</p>
    </motion.button>
  );
}

/* ------------------------------------------------------------------ */
/*  Score ring                                                         */
/* ------------------------------------------------------------------ */

function ScoreRing({ score }: { score: number }) {
  const radius = 28;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  return (
    <div className="relative flex h-16 w-16 shrink-0 items-center justify-center">
      <svg className="absolute inset-0 -rotate-90" viewBox="0 0 64 64" fill="none">
        <circle cx="32" cy="32" r={radius} stroke="rgb(var(--border-default))" strokeWidth="4" />
        <motion.circle cx="32" cy="32" r={radius} stroke="rgb(var(--accent-primary))" strokeWidth="4" strokeLinecap="round"
          strokeDasharray={circumference} initial={{ strokeDashoffset: circumference }} animate={{ strokeDashoffset: offset }}
          transition={{ duration: 0.8, ease: EASE }}
        />
      </svg>
      <span className="text-sm font-bold tabular-nums text-text-primary">{score}%</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Score bar (for dashboard sub-scores)                               */
/* ------------------------------------------------------------------ */

function ScoreBar({ label, value, icon: Icon }: { label: string; value: number; icon: LucideIcon }) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-3">
      <div className="flex items-center gap-2">
        <Icon size={14} className="text-accent" />
        <span className="text-xs font-medium text-text-secondary">{label}</span>
        <span className="ml-auto text-xs font-bold tabular-nums text-text-primary">{value}%</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
        <motion.div
          className="h-full rounded-full bg-accent"
          initial={{ width: 0 }}
          animate={{ width: `${value}%` }}
          transition={{ duration: 0.6, ease: EASE }}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Language card                                                      */
/* ------------------------------------------------------------------ */

function LanguageCard({ lang, isActive, onSelect }: { lang: Language; isActive: boolean; onSelect: () => void }) {
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.97 }}
      transition={{ duration: 0.2, ease: EASE }}
      className={`flex items-center gap-3 rounded-xl border p-3 text-left transition-colors duration-200 ${
        isActive ? 'border-accent/50 bg-accent/8' : 'border-border bg-bg-secondary hover:border-accent/30'
      }`}
    >
      <span className="text-2xl leading-none">{lang.flag}</span>
      <div className="flex-1 min-w-0">
        <p className="truncate text-sm font-semibold text-text-primary">{lang.nativeName}</p>
        <p className="truncate text-xs text-text-secondary/70">{lang.name}</p>
      </div>
      {isActive && <Check size={16} className="shrink-0 text-accent" />}
      {lang.direction === 'rtl' && <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-[0.6rem] font-semibold text-text-secondary">RTL</span>}
    </motion.button>
  );
}

/* ------------------------------------------------------------------ */
/*  AI Recommendation engine                                          */
/* ------------------------------------------------------------------ */

function AIRecommendation() {
  const { settings, language, t, updateSetting } = useAccessibility();
  const lang = LANGUAGES.find((l) => l.code === language) ?? LANGUAGES[0];

  const recommendations: string[] = [];
  if (lang.direction === 'rtl') recommendations.push(lang.nativeName);
  if (settings.textSize < 1.1) recommendations.push(t('readingComfort'));
  if (!settings.reduceMotion) recommendations.push(t('motion'));
  if (!settings.highContrast) recommendations.push(t('visualComfort'));

  const recText = [
    lang.nativeName,
    settings.textSize < 1.1 ? t('readingComfort') : null,
    !settings.reduceMotion ? t('motion') : null,
  ].filter(Boolean).join(' + ');

  const applyRec = () => {
    if (settings.textSize < 1.1) updateSetting('textSize', 1.15);
    updateSetting('reduceMotion', true);
    updateSetting('lineHeight', 1.8);
  };

  return (
    <div className="rounded-xl border border-accent/30 bg-gradient-to-br from-accent/8 to-cta/5 p-4">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/15 text-accent">
          <Sparkles size={14} />
        </span>
        <h4 className="text-xs font-bold uppercase tracking-wider text-text-secondary">{t('aiRecommendation')}</h4>
      </div>
      <p className="mt-2.5 text-xs leading-relaxed text-text-secondary">{t('basedOnPreferences')}</p>
      <p className="mt-2 text-sm font-semibold text-text-primary">
        {recText || `${lang.nativeName} + ${t('readingComfort')}`}
      </p>
      <motion.button
        type="button"
        onClick={applyRec}
        whileTap={{ scale: 0.97 }}
        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent py-2 text-xs font-semibold text-white transition-all hover:brightness-110"
      >
        <Check size={13} />
        {t('applyRecommendation')}
      </motion.button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tabs                                                               */
/* ------------------------------------------------------------------ */

type TabId = 'assistant' | 'language' | 'profiles' | 'vision' | 'color' | 'reading' | 'motion' | 'navigation';

function getTabs(t: (key: TranslationKey) => string): { id: TabId; label: string; icon: LucideIcon }[] {
  return [
    { id: 'assistant', label: t('assistant'), icon: Sparkles },
    { id: 'language', label: t('language'), icon: Globe },
    { id: 'profiles', label: t('profiles'), icon: Accessibility },
    { id: 'vision', label: t('vision'), icon: Eye },
    { id: 'color', label: t('color'), icon: Palette },
    { id: 'reading', label: t('reading'), icon: BookOpen },
    { id: 'motion', label: t('motion'), icon: Wind },
    { id: 'navigation', label: t('navigation'), icon: Navigation },
  ];
}

/* ------------------------------------------------------------------ */
/*  Panel content                                                      */
/* ------------------------------------------------------------------ */

function PanelContent({ onClose }: { onClose: () => void }) {
  const { settings, updateSetting, applyProfile, resetAll, activeProfile, score, language, setLanguage, recentLanguages, t } = useAccessibility();
  const [activeTab, setActiveTab] = useState<TabId>('assistant');
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showResetFlash, setShowResetFlash] = useState(false);
  const [langSearch, setLangSearch] = useState('');

  const tabs = getTabs(t);

  const handleReset = () => {
    resetAll();
    setShowResetConfirm(false);
    setShowResetFlash(true);
    setTimeout(() => setShowResetFlash(false), 2500);
  };

  const filteredLanguages = LANGUAGES.filter((l) => {
    if (!langSearch) return true;
    const q = langSearch.toLowerCase();
    return l.name.toLowerCase().includes(q) || l.nativeName.toLowerCase().includes(q) || l.code.includes(q);
  });

  const renderAssistant = () => {
    // Calculate sub-scores
    const langScore = language !== 'en' ? 90 : 70;
    const readingScore = settings.lineHeight >= 1.7 && settings.textSize > 1 ? 90 : settings.lineHeight >= 1.6 ? 75 : 55;
    const visualScore = settings.highContrast || settings.strongFocus ? 90 : settings.highlightLinks ? 70 : 55;
    const navScore = settings.strongFocus || settings.highlightKeyboardFocus ? 90 : 60;
    const personalScore = score;

    return (
      <div className="space-y-4 px-3 py-2">
        {/* Score */}
        <div className="flex items-center gap-4 rounded-xl border border-accent/20 bg-accent/5 p-4">
          <ScoreRing score={score} />
          <div>
            <h4 className="text-sm font-bold text-text-primary">{t('accessibilityScore')}</h4>
            <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">
              {score === 100 ? `${t('optimized')} 100%` : `${t('optimized')} ${score}%`}
            </p>
          </div>
        </div>

        {/* Dashboard sub-scores */}
        <div className="grid grid-cols-2 gap-2">
          <ScoreBar label={t('languageExperience')} value={langScore} icon={Globe} />
          <ScoreBar label={t('readingComfort')} value={readingScore} icon={BookOpen} />
          <ScoreBar label={t('visualComfort')} value={visualScore} icon={Eye} />
          <ScoreBar label={t('navigationComfort')} value={navScore} icon={Navigation} />
        </div>

        {/* AI Recommendation */}
        <AIRecommendation />

        {/* Quick actions */}
        <div>
          <h4 className="px-1 pb-2 text-xs font-bold uppercase tracking-wider text-text-secondary">{t('quickActions')}</h4>
          <div className="grid grid-cols-2 gap-2">
            {QUICK_ACTIONS.map((action) => {
              const Icon = ICON_MAP[action.icon] ?? Zap;
              return (
                <motion.button key={action.id} type="button" whileHover={{ y: -2 }} whileTap={{ scale: 0.97 }}
                  transition={{ duration: 0.2, ease: EASE }}
                  onClick={() => { (Object.keys(action.apply) as (keyof AccessibilitySettings)[]).forEach((k) => { updateSetting(k, action.apply[k] as never); }); }}
                  className="group rounded-xl border border-border bg-bg-secondary p-3 text-left transition-colors hover:border-accent/30"
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent"><Icon size={15} /></span>
                  <h5 className="mt-2 text-xs font-semibold leading-tight text-text-primary">{action.label}</h5>
                  <p className="mt-0.5 text-[0.7rem] leading-relaxed text-text-secondary/60">{action.description}</p>
                </motion.button>
              );
            })}
          </div>
        </div>

        {/* Smart translation preview */}
        <div className="rounded-xl border border-border bg-bg-tertiary/50 p-4">
          <div className="flex items-center gap-2">
            <Languages size={14} className="text-accent" />
            <h4 className="text-xs font-bold uppercase tracking-wider text-text-secondary">{t('simplifyText')}</h4>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-text-secondary">{t('makeEasier')}</p>
          <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-accent/10 px-3 py-1.5">
            <Sparkles size={12} className="text-accent" />
            <span className="text-[0.7rem] font-medium text-accent">AI-powered simplification ready</span>
          </div>
        </div>

        {/* Voice readiness */}
        <div className="rounded-xl border border-border bg-bg-tertiary/50 p-4">
          <div className="flex items-center gap-2">
            <Mic size={14} className="text-accent" />
            <h4 className="text-xs font-bold uppercase tracking-wider text-text-secondary">{t('voiceReady')}</h4>
          </div>
          <div className="mt-2.5 space-y-1.5">
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <Check size={12} className="text-success" /> {t('voiceNavReady')}
            </div>
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <Check size={12} className="text-success" /> {t('textToSpeechReady')}
            </div>
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <Check size={12} className="text-success" /> {t('multiLanguageVoice')}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderLanguage = () => (
    <div className="space-y-4 px-3 py-2">
      {/* Search */}
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary/50" />
        <input
          type="text"
          value={langSearch}
          onChange={(e) => setLangSearch(e.target.value)}
          placeholder={t('searchLanguages')}
          aria-label={t('searchLanguages')}
          className="w-full rounded-xl border border-border bg-bg-secondary py-2.5 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-secondary/50 focus-ring"
        />
      </div>

      {/* Recently used */}
      {recentLanguages.length > 0 && !langSearch && (
        <div>
          <h4 className="px-1 pb-2 text-xs font-bold uppercase tracking-wider text-text-secondary">{t('recentlyUsed')}</h4>
          <div className="grid grid-cols-1 gap-2">
            {recentLanguages.map((code) => {
              const lang = LANGUAGES.find((l) => l.code === code)!;
              return <LanguageCard key={code} lang={lang} isActive={language === code} onSelect={() => setLanguage(code)} />;
            })}
          </div>
        </div>
      )}

      {/* All languages */}
      <div>
        <h4 className="px-1 pb-2 text-xs font-bold uppercase tracking-wider text-text-secondary">{t('allLanguages')}</h4>
        <div className="grid grid-cols-1 gap-2">
          {filteredLanguages.map((lang) => (
            <LanguageCard key={lang.code} lang={lang} isActive={language === lang.code} onSelect={() => setLanguage(lang.code)} />
          ))}
          {filteredLanguages.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-text-secondary/60">No languages found</p>
          )}
        </div>
      </div>

      {/* RTL notice */}
      {(language === 'ar' || language === 'fa') && (
        <div className="flex items-center gap-2 rounded-xl border border-accent/20 bg-accent/5 px-3 py-2.5">
          <Globe size={14} className="text-accent" />
          <p className="text-xs text-text-secondary">
            RTL layout active — navigation and spacing are mirrored for {LANGUAGES.find((l) => l.code === language)?.nativeName}.
          </p>
        </div>
      )}
    </div>
  );

  const renderProfiles = () => (
    <div className="grid grid-cols-2 gap-2.5 px-3 py-2">
      {PROFILES.map((profile) => (
        <ProfileCard key={profile.id} profile={profile} isActive={activeProfile === profile.id} onApply={() => applyProfile(profile)} />
      ))}
      {/* Global profiles */}
      {GLOBAL_PROFILES.map((profile) => {
        const Icon = ICON_MAP[profile.icon] ?? Globe;
        const isActive = activeProfile === profile.id;
        return (
          <motion.button key={profile.id} type="button" whileHover={{ y: -2 }} whileTap={{ scale: 0.97 }}
            transition={{ duration: 0.2, ease: EASE }}
            onClick={() => { (Object.keys(profile.settings) as (keyof AccessibilitySettings)[]).forEach((k) => { updateSetting(k, profile.settings[k] as never); }); }}
            className={`group relative w-full overflow-hidden rounded-xl border p-3.5 text-left transition-colors duration-200 ${isActive ? 'border-accent/50 bg-accent/8' : 'border-border bg-bg-secondary hover:border-accent/30'}`}
          >
            <span className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors duration-200 ${isActive ? 'bg-accent/15 text-accent' : 'bg-bg-tertiary text-text-secondary group-hover:text-accent'}`}>
              <Icon size={17} />
            </span>
            <h5 className="mt-2.5 text-sm font-semibold leading-tight text-text-primary">{t(profile.nameKey)}</h5>
            <p className="mt-1 text-xs leading-relaxed text-text-secondary/70">{profile.description}</p>
          </motion.button>
        );
      })}
    </div>
  );

  const renderVision = () => (
    <>
      <Section icon={Type} title="Text & Font">
        <SliderRow label="Text Size" value={settings.textSize} min={0.875} max={1.5} step={0.025}
          displayValue={`${Math.round(settings.textSize * 100)}%`} onChange={(v) => updateSetting('textSize', v)} />
        <SliderRow label="Content Scaling" value={settings.contentScale} min={0.9} max={1.2} step={0.025}
          displayValue={`${Math.round(settings.contentScale * 100)}%`} onChange={(v) => updateSetting('contentScale', v)} />
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
    <Section icon={BookOpen} title="Reading Comfort">
      <SettingRow icon={BookOpen} label="Reading Mode" description="Simplify layout, narrow content width" checked={settings.readingMode} onChange={(v) => updateSetting('readingMode', v)} />
      <SliderRow label="Line Height" value={settings.lineHeight} min={1.4} max={2.2} step={0.1}
        displayValue={settings.lineHeight.toFixed(1)} onChange={(v) => updateSetting('lineHeight', v)} />
      <SliderRow label="Letter Spacing" value={settings.letterSpacing} min={0} max={0.2} step={0.02}
        displayValue={`${settings.letterSpacing}em`} onChange={(v) => updateSetting('letterSpacing', v)} />
      <SliderRow label="Word Spacing" value={settings.wordSpacing} min={0} max={0.3} step={0.05}
        displayValue={`${settings.wordSpacing}em`} onChange={(v) => updateSetting('wordSpacing', v)} />
    </Section>
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
      <div className="mt-2 rounded-xl bg-bg-tertiary/50 px-3 py-3">
        <div className="mb-2 flex items-center gap-2">
          <Globe size={14} className="text-accent" />
          <span className="text-xs font-bold uppercase tracking-wider text-text-secondary">{t('language')}</span>
        </div>
        <p className="text-xs leading-relaxed text-text-secondary/70">
          {LANGUAGES.find((l) => l.code === language)?.nativeName} — {LANGUAGES.find((l) => l.code === language)?.name}
        </p>
        <button onClick={() => setActiveTab('language')} className="mt-2 flex items-center gap-1 text-xs font-semibold text-accent hover:underline">
          {t('allLanguages')} <ChevronRight size={12} />
        </button>
      </div>
    </Section>
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="relative shrink-0 border-b border-border bg-bg-tertiary px-5 py-4">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0"
          style={{ backgroundImage: 'radial-gradient(circle at 80% 20%, rgb(var(--accent-primary) / 0.08), transparent 60%)' }} />
        <div className="relative flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/10 text-accent ring-1 ring-accent/20">
              <Accessibility size={18} />
            </span>
            <div>
              <h3 className="text-base font-bold tracking-tight text-text-primary">{t('accessibilityCenter')}</h3>
              <p className="text-xs text-text-secondary/70">{t('customizeExperience')}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label={t('close')}
            className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary">
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="shrink-0 overflow-x-auto border-b border-border bg-bg-secondary">
        <div className="flex min-w-max px-2">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button key={tab.id} type="button" onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-xs font-semibold transition-colors duration-200 ${active ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
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
          <motion.div key={activeTab} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }}
            transition={{ duration: 0.2, ease: EASE }}>
            {activeTab === 'assistant' && renderAssistant()}
            {activeTab === 'language' && renderLanguage()}
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
            <motion.div key="flash" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
              className="flex items-center justify-center gap-2 text-sm font-medium text-success">
              <Check size={15} /> Settings reset to defaults
            </motion.div>
          ) : showResetConfirm ? (
            <motion.div key="confirm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="flex items-center justify-between gap-3">
              <span className="text-xs text-text-secondary">Reset all accessibility settings?</span>
              <div className="flex gap-2">
                <button type="button" onClick={() => setShowResetConfirm(false)}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary">Cancel</button>
                <button type="button" onClick={handleReset}
                  className="rounded-lg bg-danger px-3 py-1.5 text-xs font-semibold text-white transition-all hover:brightness-110">Reset All</button>
              </div>
            </motion.div>
          ) : (
            <motion.div key="default" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 text-xs text-text-secondary/70">
                <Check size={13} className="text-success" /> {t('autoSaved')}
              </div>
              <button type="button" onClick={() => setShowResetConfirm(true)}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:text-danger">
                <RotateCcw size={13} /> {t('reset')}
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
    <motion.div initial={{ opacity: 0, y: 12, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.95 }} transition={{ duration: 0.35, ease: EASE }}
      className="a11y-widget absolute bottom-[72px] right-0 w-64 overflow-hidden rounded-2xl border border-border bg-bg-secondary/95 shadow-2xl backdrop-blur-xl">
      <div className="h-px bg-gradient-to-r from-transparent via-accent/50 to-transparent" />
      <div className="p-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10 text-accent"><Sparkles size={14} /></span>
          <h4 className="text-sm font-bold text-text-primary">Accessibility Center</h4>
        </div>
        <p className="text-xs leading-relaxed text-text-secondary">
          Customize text size, contrast, motion, language, and more. Your preferences are saved automatically.
        </p>
        <button type="button" onClick={onDismiss}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent py-2 text-xs font-semibold text-white transition-all hover:brightness-110">
          Got it <ChevronRight size={13} />
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

  useEffect(() => {
    if (!hasOnboarded) {
      const timer = setTimeout(() => setShowOnboarding(true), 2000);
      return () => clearTimeout(timer);
    }
  }, [hasOnboarded]);

  const dismissOnboarding = () => { setShowOnboarding(false); setHasOnboarded(true); };

  useEffect(() => {
    if (!isOpen) return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = panel.querySelectorAll<HTMLElement>('button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    panel.addEventListener('keydown', trap);
    return () => panel.removeEventListener('keydown', trap);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setIsOpen(false); buttonRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen]);

  return (
    <div className="a11y-widget fixed bottom-5 right-5 z-[75] print:hidden">
      <AnimatePresence>
        {showOnboarding && !isOpen && <OnboardingTip onDismiss={dismissOnboarding} />}
      </AnimatePresence>

      <motion.button ref={buttonRef} type="button"
        onClick={() => { setIsOpen((prev) => !prev); if (showOnboarding) dismissOnboarding(); }}
        onMouseEnter={() => setShowTooltip(true)} onMouseLeave={() => setShowTooltip(false)}
        aria-label={isOpen ? 'Close accessibility center' : 'Open accessibility center'} aria-expanded={isOpen}
        whileHover={{ scale: 1.08 }} whileTap={{ scale: 0.92 }} transition={{ type: 'spring', stiffness: 400, damping: 17 }}
        className="group relative flex h-12 w-12 items-center justify-center rounded-2xl border border-accent/20 bg-bg-secondary/80 text-accent shadow-glow-accent backdrop-blur-xl transition-colors duration-200 hover:border-accent/40">
        <AnimatePresence mode="wait" initial={false}>
          {isOpen ? (
            <motion.span key="close" initial={{ rotate: -90, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} exit={{ rotate: 90, opacity: 0 }} transition={{ duration: 0.2 }}>
              <X size={20} />
            </motion.span>
          ) : (
            <motion.span key="open" initial={{ rotate: 90, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} exit={{ rotate: -90, opacity: 0 }} transition={{ duration: 0.2 }}>
              <Accessibility size={20} />
            </motion.span>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {showTooltip && !isOpen && !showOnboarding && (
            <motion.span initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} transition={{ duration: 0.15 }}
              className="pointer-events-none absolute right-14 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-lg border border-border bg-bg-secondary/95 px-3 py-1.5 text-xs font-medium text-text-primary shadow-lg backdrop-blur-xl">
              Accessibility Center
            </motion.span>
          )}
        </AnimatePresence>
      </motion.button>

      <AnimatePresence>
        {isOpen && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
              onClick={() => setIsOpen(false)} className="fixed inset-0 z-[73] bg-slate-950/40 backdrop-blur-sm sm:hidden" />
            <motion.div ref={panelRef}
              initial={{ opacity: 0, y: 16, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: 0.96 }}
              transition={{ type: 'spring', stiffness: 320, damping: 28 }}
              className="fixed bottom-[72px] right-5 z-[74] hidden h-[min(640px,80vh)] w-[400px] flex-col overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-2xl sm:flex"
              role="dialog" aria-modal="true" aria-label="Accessibility Center">
              <PanelContent onClose={() => setIsOpen(false)} />
            </motion.div>
            <motion.div
              initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ type: 'spring', stiffness: 320, damping: 30 }}
              className="fixed inset-x-0 bottom-0 z-[74] flex h-[80vh] flex-col overflow-hidden rounded-t-3xl border border-border bg-bg-secondary shadow-2xl sm:hidden"
              role="dialog" aria-modal="true" aria-label="Accessibility Center">
              <div className="flex shrink-0 justify-center pt-2.5 pb-1"><span className="h-1 w-10 rounded-full bg-border" /></div>
              <PanelContent onClose={() => setIsOpen(false)} />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
