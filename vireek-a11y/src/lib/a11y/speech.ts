/** Read-aloud via the Web Speech API (speechSynthesis). Module-level controller shared by panel, shortcuts and voice commands. */
export const LANG_TAG: Record<string, string> = {
  en: 'en-US', es: 'es-ES', zh: 'zh-CN', hi: 'hi-IN', fr: 'fr-FR', de: 'de-DE', ar: 'ar-SA', fa: 'fa-IR', ja: 'ja-JP',
};

/** Chrome silently cuts utterances after ~15 s, so long text is split into sentence-sized chunks. */
export function splitIntoChunks(text: string, max = 180): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?؟۔。！？]+[.!?؟۔。！？]*/g) ?? [clean];
  const out: string[] = [];
  let cur = '';
  const flush = (): void => {
    if (cur) out.push(cur);
    cur = '';
  };
  for (const raw of sentences) {
    const piece = raw.trim();
    if (!piece) continue;
    if (piece.length > max) {
      flush();
      let part = '';
      for (const word of piece.split(' ')) {
        if (word.length > max) {
          if (part) out.push(part);
          part = '';
          for (let i = 0; i < word.length; i += max) out.push(word.slice(i, i + max));
        } else if ((part ? `${part} ${word}` : word).length > max) {
          out.push(part);
          part = word;
        } else part = part ? `${part} ${word}` : word;
      }
      if (part) out.push(part);
    } else if ((cur ? `${cur} ${piece}` : piece).length > max) {
      flush();
      cur = piece;
    } else cur = cur ? `${cur} ${piece}` : piece;
  }
  flush();
  return out;
}

export interface SpeechState { supported: boolean; speaking: boolean; paused: boolean; noVoice: boolean }
const supported = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
let state: SpeechState = { supported, speaking: false, paused: false, noVoice: false };
const listeners = new Set<() => void>();
let session = 0;

function set(p: Partial<SpeechState>): void {
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}
export const getSpeechState = (): SpeechState => state;
export function subscribeSpeech(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function pickVoice(voices: readonly SpeechSynthesisVoice[], lang: string, voiceURI: string): SpeechSynthesisVoice | null {
  if (voiceURI) {
    const exact = voices.find((v) => v.voiceURI === voiceURI);
    if (exact) return exact;
  }
  const prefix = (LANG_TAG[lang] ?? 'en-US').split('-')[0] ?? 'en';
  return voices.find((v) => v.lang.toLowerCase().startsWith(prefix)) ?? null;
}

export interface SpeakOptions { lang: string; rate: number; pitch: number; volume: number; voiceURI: string; onEnd?: () => void }

export function speak(text: string, o: SpeakOptions): 'started' | 'unsupported' | 'empty' {
  if (!supported) return 'unsupported';
  const chunks = splitIntoChunks(text);
  if (chunks.length === 0) return 'empty';
  window.speechSynthesis.cancel();
  const mine = ++session;
  const voices = window.speechSynthesis.getVoices();
  const voice = pickVoice(voices, o.lang, o.voiceURI);
  set({ speaking: true, paused: false, noVoice: voices.length > 0 && !voice });
  const next = (i: number): void => {
    if (mine !== session) return;
    const chunk = chunks[i];
    if (chunk === undefined) {
      set({ speaking: false, paused: false });
      o.onEnd?.();
      return;
    }
    const u = new SpeechSynthesisUtterance(chunk);
    u.lang = voice?.lang ?? LANG_TAG[o.lang] ?? 'en-US';
    if (voice) u.voice = voice;
    u.rate = o.rate;
    u.pitch = o.pitch;
    u.volume = o.volume;
    u.onend = () => next(i + 1);
    u.onerror = (e) => {
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      if (mine === session) set({ speaking: false, paused: false });
    };
    window.speechSynthesis.speak(u);
  };
  next(0);
  return 'started';
}
export function pauseSpeech(): void {
  if (!supported || !state.speaking) return;
  window.speechSynthesis.pause();
  set({ paused: true });
}
export function resumeSpeech(): void {
  if (!supported) return;
  window.speechSynthesis.resume();
  set({ paused: false });
}
export function stopSpeech(): void {
  if (!supported) return;
  session += 1;
  window.speechSynthesis.cancel();
  set({ speaking: false, paused: false });
}
