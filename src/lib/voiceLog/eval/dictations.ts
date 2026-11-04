// 100 labeled field dictations (50 EN, 35 ES, 15 FA) for measuring structured-extraction accuracy.
// Deterministic (seeded) so labels never drift. These are TEXT transcripts of synthetic dictations:
// they measure extraction from words. Audio robustness (accents, noise) is measured separately
// with scripts/eval-voice-log.mjs --audio-dir (real recordings are required for that).

export type Lang = 'en' | 'es' | 'fa';
export interface ExpectedPart { kw: string; qty: number }
export interface Dictation {
  id: string;
  lang: Lang;
  text: string;
  expected: { findings: string[]; safety: string[]; parts: ExpectedPart[]; timeMinutes: number | null };
}

interface Vocab {
  findings: { say: string; kw: string }[];
  safety: { say: string; kw: string }[];
  parts: { say: string; kw: string }[];
  qty: { say: string; n: number }[];
  times: { say: string; min: number }[];
  open: string[];
  partVerb: (qty: string, part: string) => string;
}

const VOCAB: Record<Lang, Vocab> = {
  en: {
    open: ['Okay, job notes.', 'Alright, here is what I found.', 'Quick log for this visit.'],
    findings: [
      { say: 'the run capacitor is bad', kw: 'capacitor' }, { say: 'the condensate drain is clogged', kw: 'drain' },
      { say: 'the blower motor is noisy', kw: 'blower' }, { say: 'refrigerant is low', kw: 'refrigerant' },
      { say: 'the air filter is very dirty', kw: 'filter' }, { say: 'the thermostat is not responding', kw: 'thermostat' },
      { say: 'the contactor is pitted', kw: 'contactor' }, { say: 'the evaporator coil is frozen', kw: 'evaporator' },
    ],
    safety: [{ say: 'I smell gas near the furnace', kw: 'gas' }, { say: 'there is a carbon monoxide reading in the closet', kw: 'monoxide' }],
    parts: [
      { say: 'capacitor', kw: 'capacitor' }, { say: 'contactor', kw: 'contactor' }, { say: 'igniter', kw: 'igniter' },
      { say: 'drain pump', kw: 'drain pump' }, { say: 'air filter', kw: 'filter' },
    ],
    qty: [{ say: 'one', n: 1 }, { say: 'two', n: 2 }, { say: 'three', n: 3 }, { say: '4', n: 4 }],
    times: [{ say: 'I was on site for 45 minutes', min: 45 }, { say: 'it took about an hour and a half', min: 90 }, { say: 'total time two hours', min: 120 }, { say: 'twenty minutes of work', min: 20 }],
    partVerb: (q, p) => `Used ${q} ${p}${q === 'one' ? '' : 's'}.`,
  },
  es: {
    open: ['Bien, notas del trabajo.', 'Esto es lo que encontré.', 'Registro rápido de esta visita.'],
    findings: [
      { say: 'el capacitor de marcha está dañado', kw: 'capacitor' }, { say: 'el desagüe de condensado está tapado', kw: 'desag' },
      { say: 'el motor del ventilador hace ruido', kw: 'ventilador' }, { say: 'falta refrigerante', kw: 'refrigerante' },
      { say: 'el filtro de aire está muy sucio', kw: 'filtro' }, { say: 'el termostato no responde', kw: 'termostato' },
      { say: 'el contactor está picado', kw: 'contactor' }, { say: 'el serpentín del evaporador está congelado', kw: 'evaporador' },
    ],
    safety: [{ say: 'huele a gas cerca del calentador', kw: 'gas' }, { say: 'hay una lectura de monóxido de carbono en el clóset', kw: 'mon' }],
    parts: [
      { say: 'capacitor', kw: 'capacitor' }, { say: 'contactor', kw: 'contactor' }, { say: 'encendedor', kw: 'encendedor' },
      { say: 'bomba de condensado', kw: 'bomba' }, { say: 'filtro de aire', kw: 'filtro' },
    ],
    qty: [{ say: 'un', n: 1 }, { say: 'dos', n: 2 }, { say: 'tres', n: 3 }, { say: '4', n: 4 }],
    times: [{ say: 'estuve en el sitio 45 minutos', min: 45 }, { say: 'tardé una hora y media', min: 90 }, { say: 'tiempo total dos horas', min: 120 }, { say: 'veinte minutos de trabajo', min: 20 }],
    partVerb: (q, p) => `Usé ${q} ${p}.`,
  },
  fa: {
    open: ['خب، یادداشت کار.', 'این چیزی است که پیدا کردم.', 'گزارش سریع این بازدید.'],
    findings: [
      { say: 'خازن خراب است', kw: 'خازن' }, { say: 'مسیر تخلیهٔ آب گرفته است', kw: 'تخلیه' },
      { say: 'موتور فن صدا می‌دهد', kw: 'فن' }, { say: 'گاز مبرد کم است', kw: 'مبرد' },
      { say: 'فیلتر هوا خیلی کثیف است', kw: 'فیلتر' }, { say: 'ترموستات جواب نمی‌دهد', kw: 'ترموستات' },
    ],
    safety: [{ say: 'بوی گاز نزدیک پکیج می‌آید', kw: 'گاز' }],
    parts: [{ say: 'خازن', kw: 'خازن' }, { say: 'کنتاکتور', kw: 'کنتاکتور' }, { say: 'فیلتر هوا', kw: 'فیلتر' }],
    qty: [{ say: 'یک', n: 1 }, { say: 'دو', n: 2 }, { say: 'سه', n: 3 }],
    times: [{ say: 'یک ساعت و نیم طول کشید', min: 90 }, { say: 'در محل ۴۵ دقیقه بودم', min: 45 }, { say: 'مجموع زمان دو ساعت', min: 120 }],
    partVerb: (q, p) => `${q} عدد ${p} استفاده کردم.`,
  },
};

const SPLIT: [Lang, number][] = [['en', 50], ['es', 35], ['fa', 15]];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function build(): Dictation[] {
  const out: Dictation[] = [];
  const seen = new Set<string>();
  SPLIT.forEach(([lang, count], li) => {
    const r = rng(1000 + li * 7919);
    const v = VOCAB[lang];
    const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)];
    let n = 0;
    while (n < count) {
      const fs = Array.from(new Set([pick(v.findings), ...(r() < 0.5 ? [pick(v.findings)] : [])]));
      const safety = r() < 0.2 ? [pick(v.safety)] : [];
      const parts = Array.from(new Set(Array.from({ length: Math.floor(r() * 3) }, () => pick(v.parts))))
        .map((p) => ({ p, q: pick(v.qty) }));
      const time = r() < 0.7 ? pick(v.times) : null;
      const sentences = [pick(v.open), ...fs.map((f) => `${f.say[0].toUpperCase()}${f.say.slice(1)}.`),
        ...safety.map((f) => `${f.say[0].toUpperCase()}${f.say.slice(1)}.`), ...parts.map(({ p, q }) => v.partVerb(q.say, p.say)),
        ...(time ? [`${time.say[0].toUpperCase()}${time.say.slice(1)}.`] : [])];
      const text = sentences.join(' ');
      if (seen.has(text)) continue;
      seen.add(text);
      n++;
      out.push({
        id: `${lang}-${String(n).padStart(3, '0')}`, lang, text,
        expected: {
          findings: fs.map((f) => f.kw), safety: safety.map((f) => f.kw),
          parts: parts.map(({ p, q }) => ({ kw: p.kw, qty: q.n })), timeMinutes: time ? time.min : null,
        },
      });
    }
  });
  return out;
}

export const DICTATIONS: readonly Dictation[] = build();
