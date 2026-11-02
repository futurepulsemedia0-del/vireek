export type VoiceCommand =
  | { type: 'scroll'; dir: 'up' | 'down' }
  | { type: 'edge'; edge: 'top' | 'bottom' }
  | { type: 'history'; dir: 'back' | 'forward' }
  | { type: 'heading'; dir: 'next' | 'prev' }
  | { type: 'read' } | { type: 'stop' } | { type: 'contrast' } | { type: 'help' }
  | { type: 'textSize'; dir: 'up' | 'down' }
  | { type: 'click'; target: string };

/** Lowercase, strip diacritics/tatweel/ZWNJ, unify Arabic/Persian letter variants, drop punctuation, collapse spaces. */
export function normalizeSpeech(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/\u200c/g, ' ')
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه')
    .toLowerCase()
    .replace(/[.,!?؟،;:"'“”«»()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const squash = (s: string): string => normalizeSpeech(s).replace(/ /g, '');

type Phrases = Record<string, readonly string[]>;
const EN: Phrases = {
  down: ['scroll down', 'down', 'page down'], up: ['scroll up', 'up', 'page up'],
  top: ['top', 'go to top', 'scroll to top'], bottom: ['bottom', 'go to bottom', 'scroll to bottom'],
  back: ['go back', 'back'], forward: ['go forward', 'forward'],
  nextHeading: ['next heading', 'next section'], prevHeading: ['previous heading', 'last heading', 'previous section'],
  read: ['read page', 'read', 'read aloud', 'start reading'], stop: ['stop', 'stop reading', 'be quiet', 'silence'],
  bigger: ['bigger text', 'larger text', 'increase text', 'zoom in'], smaller: ['smaller text', 'decrease text', 'zoom out'],
  contrast: ['high contrast', 'toggle contrast', 'contrast'], help: ['help', 'what can i say', 'commands'],
};
const FA: Phrases = {
  down: ['برو پایین', 'پایین', 'اسکرول پایین', 'صفحه پایین'], up: ['برو بالا', 'بالا', 'اسکرول بالا'],
  top: ['ابتدای صفحه', 'اول صفحه', 'برو به بالای صفحه'], bottom: ['انتهای صفحه', 'آخر صفحه', 'پایین صفحه'],
  back: ['برگرد', 'بازگشت', 'عقب'], forward: ['جلو', 'برو جلو'],
  nextHeading: ['سرفصل بعدی', 'عنوان بعدی'], prevHeading: ['سرفصل قبلی', 'عنوان قبلی'],
  read: ['بخوان', 'صفحه را بخوان', 'خواندن', 'شروع خواندن'], stop: ['توقف', 'بس', 'ساکت', 'نخوان'],
  bigger: ['بزرگتر', 'متن بزرگتر', 'بزرگ کن'], smaller: ['کوچکتر', 'متن کوچکتر', 'کوچک کن'],
  contrast: ['کنتراست', 'کنتراست بالا'], help: ['راهنما', 'دستورها', 'دستورات'],
};
const AR: Phrases = {
  down: ['انزل', 'للاسفل', 'تمرير للاسفل'], up: ['اصعد', 'للاعلى', 'تمرير للاعلى'],
  top: ['اعلى الصفحه', 'بدايه الصفحه'], bottom: ['اسفل الصفحه', 'نهايه الصفحه'],
  back: ['رجوع', 'ارجع', 'عوده'], forward: ['تقدم', 'للامام'],
  nextHeading: ['العنوان التالی'], prevHeading: ['العنوان السابق'],
  read: ['اقرا', 'اقرا الصفحه', 'ابدا القراءه'], stop: ['توقف', 'قف', 'اصمت'],
  bigger: ['تكبير النص', 'نص اكبر', 'كبر'], smaller: ['تصغير النص', 'نص اصغر', 'صغر'],
  contrast: ['تباين عالی', 'التباين'], help: ['مساعده', 'الاوامر'],
};
const PREFIX: Record<string, readonly string[]> = {
  en: ['click', 'press', 'open', 'tap', 'select'], fa: ['کلیک', 'کلیک کن', 'باز کن', 'انتخاب'], ar: ['اضغط', 'انقر', 'افتح', 'اختر'],
};
const SUFFIX: Record<string, readonly string[]> = {
  en: [], fa: ['رو باز کن', 'را باز کن', 'باز کن', 'رو کلیک کن', 'را کلیک کن', 'کلیک کن'], ar: [],
};
const FILLER = /^(please|لطفا|من فضلک|لو سمحت)\s+|\s+(please|لطفا)$/;

const TABLES: Record<string, Phrases> = { en: EN, fa: FA, ar: AR };
const table = (lang: string): Phrases => TABLES[lang] ?? EN;
const SIMPLE: Record<string, VoiceCommand> = {
  down: { type: 'scroll', dir: 'down' }, up: { type: 'scroll', dir: 'up' },
  top: { type: 'edge', edge: 'top' }, bottom: { type: 'edge', edge: 'bottom' },
  back: { type: 'history', dir: 'back' }, forward: { type: 'history', dir: 'forward' },
  nextHeading: { type: 'heading', dir: 'next' }, prevHeading: { type: 'heading', dir: 'prev' },
  read: { type: 'read' }, stop: { type: 'stop' }, bigger: { type: 'textSize', dir: 'up' },
  smaller: { type: 'textSize', dir: 'down' }, contrast: { type: 'contrast' }, help: { type: 'help' },
};

/** Conservative: whole-utterance match (never substring) so normal speech cannot trigger actions by accident. */
export function parseVoiceCommand(raw: string, lang: string): VoiceCommand | null {
  const spaced = normalizeSpeech(raw).replace(FILLER, '').trim();
  if (!spaced) return null;
  const flat = spaced.replace(/ /g, '');
  const t = table(lang);
  for (const [name, phrases] of Object.entries(t)) {
    const cmd = SIMPLE[name];
    if (cmd && phrases.some((p) => squash(p) === flat)) return cmd;
  }
  const prefixes = PREFIX[lang] ?? PREFIX.en ?? [];
  for (const p of [...prefixes].sort((a, b) => b.length - a.length)) {
    const np = normalizeSpeech(p);
    if (spaced.startsWith(`${np} `)) {
      const target = spaced.slice(np.length).trim();
      if (target) return { type: 'click', target };
    }
  }
  for (const s of [...(SUFFIX[lang] ?? [])].sort((a, b) => b.length - a.length)) {
    const ns = normalizeSpeech(s);
    if (spaced.endsWith(` ${ns}`)) {
      const target = spaced.slice(0, spaced.length - ns.length).trim();
      if (target) return { type: 'click', target };
    }
  }
  return null;
}

/* ---- Minimal typed wrapper (no `any`) around SpeechRecognition ---- */
interface RecEvent { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }
interface Rec {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((e: RecEvent) => void) | null; onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
type RecCtor = new () => Rec;
export const isVoiceSupported = (): boolean =>
  typeof window !== 'undefined' && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

export interface RecognizerHandle { start(): void; stop(): void }
export function createRecognizer(o: { lang: string; onFinal: (t: string) => void; onError: (code: string) => void; onEnd: () => void }): RecognizerHandle | null {
  const w = window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = o.lang;
  rec.continuous = true;
  rec.interimResults = false;
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i += 1) {
      const r = e.results[i];
      const alt = r?.[0];
      if (r?.isFinal && alt) o.onFinal(alt.transcript);
    }
  };
  rec.onerror = (e) => o.onError(e.error);
  rec.onend = o.onEnd;
  return { start: () => rec.start(), stop: () => rec.stop() };
}
