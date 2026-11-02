import type { A11yKey } from './strings';
import type { BooleanSettingKey, NumericSettingKey } from './settings';

export type CenterTab = 'quick' | 'vision' | 'color' | 'reading' | 'motion' | 'navigation' | 'language' | 'data';
export const CENTER_TABS: readonly { id: CenterTab; labelKey: A11yKey }[] = [
  { id: 'quick', labelKey: 'tabQuick' },
  { id: 'vision', labelKey: 'tabVision' },
  { id: 'color', labelKey: 'tabColor' },
  { id: 'reading', labelKey: 'tabReading' },
  { id: 'motion', labelKey: 'tabMotion' },
  { id: 'navigation', labelKey: 'tabNav' },
  { id: 'language', labelKey: 'tabLanguage' },
  { id: 'data', labelKey: 'tabData' },
];

export type Control =
  | { kind: 'toggle'; key: BooleanSettingKey }
  | { kind: 'slider'; key: NumericSettingKey; step: number; unit: 'percent' | 'plain' | 'em' }
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
const slider = (tab: CenterTab, key: NumericSettingKey, step: number, unit: 'percent' | 'plain' | 'em', keywords = ''): RegistryItem => ({
  id: key, tab, control: { kind: 'slider', key, step, unit },
  labelKey: `lbl_${key}` as A11yKey, descKey: `dsc_${key}` as A11yKey, keywords,
});

export const REGISTRY: readonly RegistryItem[] = [
  slider('vision', 'textSize', 0.125, 'percent', 'font size bigger larger zoom text'),
  slider('vision', 'contentScale', 0.05, 'percent', 'zoom magnify scale page'),
  { id: 'theme', tab: 'vision', control: { kind: 'theme' }, labelKey: 'lbl_theme', descKey: 'dsc_theme', keywords: 'dark mode light mode night' },
  toggle('vision', 'largeCursor', 'mouse pointer big'),
  toggle('vision', 'strongFocus', 'keyboard outline ring highlight'),
  toggle('vision', 'highlightLinks', 'underline'),
  toggle('vision', 'highlightHeadings', 'outline titles'),
  toggle('vision', 'magnifier', 'zoom text hover loupe'),
  toggle('color', 'highContrast', 'contrast'),
  toggle('color', 'darkContrast', 'dark background'),
  toggle('color', 'lightContrast', 'light background'),
  toggle('color', 'invertColors', 'negative invert'),
  toggle('color', 'grayscale', 'gray grey'),
  toggle('color', 'monochrome', 'black white'),
  toggle('color', 'highSaturation', 'vivid saturate'),
  toggle('color', 'lowSaturation', 'muted desaturate calm'),
  { id: 'colorBlind', tab: 'color', control: { kind: 'colorBlind' }, labelKey: 'lbl_colorBlind', descKey: 'dsc_colorBlind', keywords: 'protanopia deuteranopia tritanopia daltonism color blind' },
  toggle('reading', 'simpleFont', 'sans serif arial'),
  toggle('reading', 'readableFont', 'serif georgia'),
  toggle('reading', 'dyslexiaFont', 'dyslexia opendyslexic'),
  toggle('reading', 'readingMode', 'narrow column'),
  slider('reading', 'lineHeight', 0.1, 'plain', 'line spacing leading'),
  slider('reading', 'letterSpacing', 0.01, 'em', 'tracking'),
  slider('reading', 'wordSpacing', 0.02, 'em', ''),
  toggle('reading', 'readingMask', 'dim focus band'),
  toggle('reading', 'readingGuide', 'ruler line'),
  toggle('motion', 'reduceMotion', 'vestibular'),
  toggle('motion', 'stopAnimations', 'pause autoplay video epilepsy'),
  toggle('motion', 'hideImages', 'pictures'),
  toggle('motion', 'focusMode', 'distraction adhd sidebar'),
  toggle('navigation', 'largeTargets', 'touch target size 44px tremor'),
  toggle('navigation', 'screenReaderMode', 'nvda voiceover talkback aria'),
];

/** Non-registry sections that are also searchable. */
export interface SectionDef { id: 'tts' | 'voice' | 'shortcuts' | 'pageMap' | 'language' | 'profiles' | 'data'; tab: CenterTab; titleKey: A11yKey; keywords: string }
export const SECTIONS: readonly SectionDef[] = [
  { id: 'profiles', tab: 'quick', titleKey: 'profilesTitle', keywords: 'profile preset adhd dyslexia blind senior autism epilepsy' },
  { id: 'tts', tab: 'reading', titleKey: 'ttsTitle', keywords: 'text to speech tts read aloud speak voice' },
  { id: 'voice', tab: 'navigation', titleKey: 'voiceTitle', keywords: 'voice control speech recognition microphone commands' },
  { id: 'shortcuts', tab: 'navigation', titleKey: 'shortcutsTitle', keywords: 'hotkeys keybindings keyboard' },
  { id: 'pageMap', tab: 'navigation', titleKey: 'pageMapTitle', keywords: 'headings links outline table of contents landmarks' },
  { id: 'language', tab: 'language', titleKey: 'languageTitle', keywords: 'translate rtl direction persian arabic farsi' },
  { id: 'data', tab: 'data', titleKey: 'dataExport', keywords: 'export import backup sync cloud account reset device system' },
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
