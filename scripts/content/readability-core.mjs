/* Pure readability maths and template normalisation. No I/O, no dependencies.
   English only: the formulas below are calibrated for English text. */

export const CHANNELS = ['sms', 'email', 'quote'];

/** Normalise a template so scoring sees what a customer would read. */
export function toPlainText(raw, ignorePhrases = []) {
  let t = String(raw ?? '');
  for (const p of ignorePhrases) t = t.split(p).join(' ');
  t = t.replace(/\{\{[#/^][^}]*\}\}/g, ' ');                                  // section markers keep their content
  t = t.replace(/\{\{\s*[\w.]*link[\w.]*\s*(?:\|[^}]*)?\}\}/gi, ' ');         // link variables are not read as words
  t = t.replace(/\{\{\s*[\w.]+\s*\|\s*([^}]*?)\s*\}\}/g, (_m, fb) => fb || 'Sam'); // fallback text is what is read
  t = t.replace(/\{\{[^}]*\}\}/g, 'Sam');                                      // any other variable: one short word
  t = t.replace(/\[[^\]]{1,40}\]/g, 'Sam');                                    // [Name] style placeholders
  t = t.replace(/https?:\/\/\S+|www\.\S+/gi, ' ');
  return t.replace(/[ \t]+/g, ' ').trim();
}

const DOT = '\u0001';

export function splitSentences(text) {
  const protectedText = text
    .replace(/\b([ap])\.m\./gi, `$1m`)
    .replace(/\b(Mr|Mrs|Ms|Dr|St|Inc|Ltd|Co|vs|etc|No)\./g, `$1${DOT}`)
    .replace(/(\d)\.(?=\d)/g, `$1${DOT}`);
  return protectedText
    .split(/(?<=[.!?]["')\]]*)\s+|\n+/)
    .map((s) => s.split(DOT).join('.').trim())
    .filter((s) => /[A-Za-z0-9]/.test(s));
}

export function words(sentence) {
  return sentence.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) ?? [];
}

// Heuristic counter. Typical error is under one syllable per sentence and is consistent across
// templates, which is what matters for comparing copy against a threshold.
const SPECIAL = { created: 3, create: 2, queue: 1, schedule: 2, reschedule: 3, rescheduled: 3, beautiful: 3, people: 2, area: 3, video: 3, quiet: 2, doing: 2, going: 2, being: 2, seeing: 2, every: 2, evening: 2, different: 3, business: 2, our: 1, hour: 1, hours: 1, your: 1, years: 1, free: 1, via: 2, idea: 3 };

export function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 1; // digits and symbols are read as at least one syllable
  if (SPECIAL[w]) return SPECIAL[w];
  if (w.length <= 3) return 1;
  const stem = w.replace(/(?:[^laeiouy]es|[^td]ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  let n = (stem.match(/[aeiouy]{1,2}/g) ?? []).length;
  if (/[^aeiouy]le$/.test(w)) n = Math.max(n, (w.slice(0, -2).match(/[aeiouy]{1,2}/g) ?? []).length + 1);
  return Math.max(1, n);
}

export function score(text) {
  const sentences = splitSentences(text);
  const wordList = sentences.flatMap(words);
  const W = wordList.length;
  const S = sentences.length;
  if (W === 0 || S === 0) return { words: 0, sentences: 0, syllables: 0, avgSentenceWords: 0, longestSentenceWords: 0, ease: null, grade: null };
  const syl = wordList.reduce((a, w) => a + countSyllables(w), 0);
  const wps = W / S;
  const spw = syl / W;
  return {
    words: W,
    sentences: S,
    syllables: syl,
    avgSentenceWords: round(wps),
    longestSentenceWords: Math.max(...sentences.map((s) => words(s).length)),
    ease: round(206.835 - 1.015 * wps - 84.6 * spw),        // Flesch Reading Ease
    grade: round(0.39 * wps + 11.8 * spw - 15.59),          // Flesch-Kincaid Grade Level
  };
}
const round = (n) => Math.round(n * 10) / 10;

export function thresholdsFor(item, config) {
  const base = config.thresholds?.[item.channel];
  if (!base) throw new Error(`No thresholds configured for channel "${item.channel}"`);
  return { ...base, ...(config.overrides?.[item.id] ?? {}) };
}

/** Returns { id, channel, metrics, findings[] }. A finding is { rule, actual, limit }. */
export function evaluate(item, config) {
  const t = thresholdsFor(item, config);
  const plain = toPlainText(item.text, config.ignorePhrases ?? []);
  const metrics = score(plain);
  const findings = [];
  if (metrics.words === 0) return { id: item.id, channel: item.channel, metrics, findings };
  if (metrics.longestSentenceWords > t.maxSentenceWords) findings.push({ rule: 'sentence-length', actual: metrics.longestSentenceWords, limit: t.maxSentenceWords });
  // Grade and ease are unreliable on very short copy, so only sentence length is enforced there.
  if (metrics.words >= (config.minWordsForGrade ?? 12)) {
    if (metrics.grade > t.maxGrade) findings.push({ rule: 'grade', actual: metrics.grade, limit: t.maxGrade });
    if (metrics.ease < t.minEase) findings.push({ rule: 'ease', actual: metrics.ease, limit: t.minEase });
  }
  return { id: item.id, channel: item.channel, metrics, findings };
}

export function validateConfig(config) {
  const errors = [];
  for (const c of CHANNELS) {
    const t = config.thresholds?.[c];
    if (!t) { errors.push(`thresholds.${c} missing`); continue; }
    for (const k of ['maxGrade', 'minEase', 'maxSentenceWords']) if (typeof t[k] !== 'number' || !Number.isFinite(t[k])) errors.push(`thresholds.${c}.${k} must be a number`);
  }
  for (const [id, o] of Object.entries(config.overrides ?? {})) if (!o.reason) errors.push(`overrides.${id} needs a "reason"`);
  return errors;
}
