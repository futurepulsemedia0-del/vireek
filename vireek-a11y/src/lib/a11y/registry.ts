import type { A11yKey } from './strings';
import { DEFAULT_SETTINGS, type AccessibilitySettings, type BooleanSettingKey, type ChoiceSettingKey, type NumericSettingKey } from './settings';

export type CenterTab = 'quick' | 'vision' | 'reading' | 'cognitive' | 'hearing' | 'navigation' | 'cursor' | 'motion' | 'advanced';
export const CENTER_TABS: readonly { id: CenterTab; labelKey: A11yKey }[] = [
  { id: 'quick', labelKey: 'tabQuick' },
  { id: 'vision', labelKey: 'tabVision' },
  { id: 'reading', labelKey: 'tabReading' },
  { id: 'cognitive', labelKey: 'tabCognitive' },
  { id: 'hearing', labelKey: 'tabHearing' },
  { id: 'navigation', labelKey: 'tabNav' },
  { id: 'cursor', labelKey: 'tabCursor' },
  { id: 'motion', labelKey: 'tabMotion' },
  { id: 'advanced', labelKey: 'tabAdvanced' },
];

export type Control =
  | { kind: 'toggle'; key: BooleanSettingKey }
  | { kind: 'slider'; key: NumericSettingKey; step: number; unit: 'percent' | 'plain' | 'em' | 'px' }
  | { kind: 'choice'; key: ChoiceSettingKey }
  | { kind: 'colorBlind' }
  | { kind: 'theme' };

export interface RegistryItem {
  id: string;
  tab: CenterTab;
  control: Control;
  labelKey: A11yKey;
  descKey: A11yKey;
  /** English search synonyms (also matched when the UI is not English). */
  keywords: string;
}

const toggle = (tab: CenterTab, key: BooleanSettingKey, keywords = ''): RegistryItem => ({
  id: key, tab, control: { kind: 'toggle', key },
  labelKey: `lbl_${key}` as A11yKey, descKey: `dsc_${key}` as A11yKey, keywords,
});
const slider = (tab: CenterTab, key: NumericSettingKey, step: number, unit: 'percent' | 'plain' | 'em' | 'px', keywords = ''): RegistryItem => ({
  id: key, tab, control: { kind: 'slider', key, step, unit },
  labelKey: `lbl_${key}` as A11yKey, descKey: `dsc_${key}` as A11yKey, keywords,
});
const choice = (tab: CenterTab, key: ChoiceSettingKey, keywords = ''): RegistryItem => ({
  id: key, tab, control: { kind: 'choice', key },
  labelKey: `lbl_${key}` as A11yKey, descKey: `dsc_${key}` as A11yKey, keywords,
});

export const REGISTRY: readonly RegistryItem[] = [
  // Vision & display
  slider('vision', 'textSize', 0.125, 'percent', 'font size bigger larger zoom text'),
  slider('vision', 'contentScale', 0.05, 'percent', 'zoom magnify scale page'),
  { id: 'theme', tab: 'vision', control: { kind: 'theme' }, labelKey: 'lbl_theme', descKey: 'dsc_theme', keywords: 'dark mode light mode night' },
  toggle('vision', 'highlightLinks', 'underline'),
  toggle('vision', 'highlightHeadings', 'outline titles'),
  toggle('vision', 'magnifier', 'zoom text hover loupe'),
  toggle('vision', 'highContrast', 'contrast'),
  toggle('vision', 'darkContrast', 'dark background'),
  toggle('vision', 'lightContrast', 'light background'),
  toggle('vision', 'invertColors', 'negative invert'),
  toggle('vision', 'grayscale', 'gray grey'),
  toggle('vision', 'monochrome', 'black white'),
  toggle('vision', 'highSaturation', 'vivid saturate'),
  toggle('vision', 'lowSaturation', 'muted desaturate calm'),
  { id: 'colorBlind', tab: 'vision', control: { kind: 'colorBlind' }, labelKey: 'lbl_colorBlind', descKey: 'dsc_colorBlind', keywords: 'protanopia deuteranopia tritanopia daltonism color blind' },
  // Typography & reading
  toggle('reading', 'simpleFont', 'sans serif arial'),
  toggle('reading', 'readableFont', 'serif georgia'),
  toggle('reading', 'dyslexiaFont', 'dyslexia opendyslexic'),
  toggle('reading', 'readingMode', 'narrow column'),
  slider('reading', 'lineHeight', 0.1, 'plain', 'line spacing leading'),
  slider('reading', 'letterSpacing', 0.01, 'em', 'tracking'),
  slider('reading', 'wordSpacing', 0.02, 'em', ''),
  toggle('reading', 'readingMask', 'dim focus band'),
  toggle('reading', 'readingGuide', 'ruler line'),
  // Cognitive support
  toggle('cognitive', 'focusMode', 'distraction adhd sidebar clutter'),
  toggle('cognitive', 'hideImages', 'pictures'),
  toggle('cognitive', 'unstickHeaders', 'sticky fixed header bar covers obscured'),
  // Hearing & audio
  toggle('hearing', 'muteMedia', 'sound silent volume deaf video audio'),
  toggle('hearing', 'captionsAlways', 'subtitles captions deaf hard of hearing video'),
  // Navigation & motor
  toggle('navigation', 'largeTargets', 'touch target size 44px tremor'),
  toggle('navigation', 'screenReaderMode', 'nvda voiceover talkback aria'),
  // Cursor & focus
  toggle('cursor', 'largeCursor', 'mouse pointer big'),
  choice('cursor', 'cursorColor', 'mouse pointer color colour'),
  toggle('cursor', 'strongFocus', 'keyboard outline ring highlight'),
  choice('cursor', 'focusColor', 'keyboard outline ring color colour'),
  slider('cursor', 'focusWidth', 1, 'px', 'keyboard outline ring thickness width'),
  // Motion & animation
  toggle('motion', 'reduceMotion', 'vestibular'),
  toggle('motion', 'stopAnimations', 'pause autoplay video epilepsy'),
];

/** Non-registry sections that are also searchable. */
export interface SectionDef { id: 'tts' | 'voice' | 'shortcuts' | 'pageMap' | 'language' | 'profiles' | 'customProfiles' | 'data'; tab: CenterTab; titleKey: A11yKey; keywords: string }
export const SECTIONS: readonly SectionDef[] = [
  { id: 'profiles', tab: 'quick', titleKey: 'profilesTitle', keywords: 'profile preset adhd dyslexia blind senior autism epilepsy' },
  { id: 'customProfiles', tab: 'quick', titleKey: 'customTitle', keywords: 'my profiles save custom personal preset snapshot' },
  { id: 'tts', tab: 'reading', titleKey: 'ttsTitle', keywords: 'text to speech tts read aloud speak voice' },
  { id: 'voice', tab: 'navigation', titleKey: 'voiceTitle', keywords: 'voice control speech recognition microphone commands' },
  { id: 'shortcuts', tab: 'navigation', titleKey: 'shortcutsTitle', keywords: 'hotkeys keybindings keyboard' },
  { id: 'pageMap', tab: 'navigation', titleKey: 'pageMapTitle', keywords: 'headings links outline table of contents landmarks' },
  { id: 'language', tab: 'advanced', titleKey: 'languageTitle', keywords: 'translate rtl direction persian arabic farsi' },
  { id: 'data', tab: 'advanced', titleKey: 'dataExport', keywords: 'export import backup sync cloud account reset device system' },
];

/** Case/diacritic/Arabic-Persian-variant insensitive normalisation for search. */
export function normalizeSearch(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u064B-\u065F\u0670\u0640\u200c\u200d]/g, '')
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toLowerCase()
    .trim();
}

export function matchesQuery(haystacks: readonly string[], query: string): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  const hay = normalizeSearch(haystacks.join(' '));
  return q.split(/\s+/).every((tok) => hay.includes(tok));
}

/* ------------------------------ per-category reset ------------------------------ */
/** Stored settings owned by non-registry sections. */
const SECTION_SETTING_KEYS: Partial<Record<SectionDef['id'], readonly (keyof AccessibilitySettings)[]>> = {
  tts: ['ttsRate', 'ttsPitch', 'ttsVolume', 'ttsVoiceURI'],
  shortcuts: ['shortcuts'],
};
/** Legacy keys that still affect a category but have no registry row. */
const EXTRA_TAB_KEYS: Partial<Record<CenterTab, readonly (keyof AccessibilitySettings)[]>> = {
  cursor: ['highlightKeyboardFocus'],
};

/** Every stored setting a category controls (the theme lives in ThemeContext and is not included). */
export function settingKeysForTab(tab: CenterTab): (keyof AccessibilitySettings)[] {
  const keys = new Set<keyof AccessibilitySettings>();
  for (const i of REGISTRY) {
    if (i.tab !== tab || i.control.kind === 'theme') continue;
    keys.add(i.control.kind === 'colorBlind' ? 'colorBlind' : i.control.key);
  }
  for (const sec of SECTIONS) if (sec.tab === tab) SECTION_SETTING_KEYS[sec.id]?.forEach((k) => keys.add(k));
  EXTRA_TAB_KEYS[tab]?.forEach((k) => keys.add(k));
  return [...keys];
}

export function isCategoryModified(s: AccessibilitySettings, tab: CenterTab): boolean {
  return settingKeysForTab(tab).some((k) => JSON.stringify(s[k]) !== JSON.stringify(DEFAULT_SETTINGS[k]));
}

/** Returns a copy of `s` with only this category's settings back at their defaults. */
export function resetCategory(s: AccessibilitySettings, tab: CenterTab): AccessibilitySettings {
  const next: AccessibilitySettings = { ...s };
  const put = <K extends keyof AccessibilitySettings>(k: K): void => {
    next[k] = (k === 'shortcuts' ? { ...DEFAULT_SETTINGS.shortcuts } : DEFAULT_SETTINGS[k]) as AccessibilitySettings[K];
  };
  settingKeysForTab(tab).forEach(put);
  return next;
}
