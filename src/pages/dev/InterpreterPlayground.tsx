import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Input';
import {
  INTERP_LANGUAGES, INTERP_META, detectEmergency, extractCritical, identifyLanguage, interpLabel, normalizeInterpLang, translateLine,
  type InterpLang, type TranslateResponse,
} from '@/lib/interpreter';
import { buildReadback } from '../../../supabase/functions/_shared/interpreter/critical';
import { glossaryHints } from '../../../supabase/functions/_shared/interpreter/glossary';
import { safetyLines } from '../../../supabase/functions/_shared/interpreter/safety';

const SAMPLES: { label: string; lang: InterpLang; text: string }[] = [
  { label: 'ES · address + phone', lang: 'es', text: 'Mi dirección es 4521 Oak Street, apartamento 3B, y mi teléfono es 555 123 4567.' },
  { label: 'ES · gas emergency', lang: 'es', text: 'Huele a gas en la cocina, ayuda por favor.' },
  { label: 'PT · appointment', lang: 'pt', text: 'Preciso de um encanador amanhã às 15h.' },
  { label: 'VI · price', lang: 'vi', text: 'Giá $250 đúng không?' },
  { label: 'ZH · water heater', lang: 'zh', text: '热水器漏水，断路器跳闸了。明天下午3点可以来吗？' },
  { label: 'AR · phone', lang: 'ar', text: 'رقم هاتفي ٥٥٥ ١٢٣ ٤٥٦٧' },
  { label: 'FA · pipe burst', lang: 'fa', text: 'لوله ترکید و آب همه جا را گرفته' },
  { label: 'Code-switch', lang: 'es', text: 'Necesito un plumber para el water heater, el modelo es WH5000X.' },
];

/** /dev/interpreter — offline checks run instantly in the browser; "Translate" calls the real function (needs sign-in + GEMINI key). */
export default function InterpreterPlayground() {
  const [lang, setLang] = useState<InterpLang>('es');
  const [text, setText] = useState(SAMPLES[0].text);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TranslateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const offline = useMemo(() => {
    const id = identifyLanguage(text);
    const crit = extractCritical(text, lang);
    const em = detectEmergency(text);
    return {
      id, crit, em,
      glossary: lang === 'en' ? [] : glossaryHints(text, lang, 'en'),
      readback: buildReadback(crit, lang),
      safety: safetyLines(em.kinds, lang),
    };
  }, [text, lang]);

  const run = async () => {
    setBusy(true); setError(null); setResult(null);
    try { setResult(await translateLine(text, lang, lang === 'en' ? 'es' : 'en', 'caller')); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  };

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <h1 className="text-xl font-semibold">Interpreter playground</h1>
      <div className="flex flex-wrap gap-2">
        {SAMPLES.map((s) => <Button key={s.label} size="xs" variant="secondary" onClick={() => { setLang(s.lang); setText(s.text); setResult(null); }}>{s.label}</Button>)}
      </div>
      <Select label="Speaker language" value={lang} onChange={(e) => setLang(normalizeInterpLang(e.target.value) ?? 'es')}>
        {INTERP_LANGUAGES.map((l) => <option key={l} value={l}>{interpLabel(l)}</option>)}
      </Select>
      <Textarea label="Utterance" value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={1500} dir={INTERP_META[lang].dir} lang={lang} />

      <section aria-label="Offline analysis" className="space-y-2 rounded-xl border border-border p-4 text-sm">
        <p><b>Detected language:</b> {offline.id.lang ?? 'unknown'} ({offline.id.confidence.toFixed(2)})</p>
        <p><b>Critical fields:</b> {offline.crit.length ? offline.crit.map((c) => `${c.kind}=${c.value}`).join(', ') : 'none'}</p>
        <p><b>Glossary:</b> {offline.glossary.length ? offline.glossary.map((g) => `${g.source} → ${g.target[0]}`).join(', ') : 'none'}</p>
        <p><b>Emergency:</b> {offline.em.isEmergency ? `YES (${offline.em.kinds.join(', ')})` : 'no'}</p>
        {offline.safety.map((l) => <p key={l} className="rounded bg-danger/10 p-2" lang={lang} dir={INTERP_META[lang].dir}>{l}</p>)}
        {offline.readback && <p lang={lang} dir={INTERP_META[lang].dir}><b>Read-back:</b> {offline.readback}</p>}
      </section>

      <Button onClick={run} loading={busy} loadingLabel="Translating…">Translate (live)</Button>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {result && (
        <section aria-label="Translation" className="space-y-1 rounded-xl border border-border p-4 text-sm">
          <p>{result.translated}</p>
          <p className="text-text-secondary">confidence {result.confidence.toFixed(2)} · {result.latency_ms} ms · critical fields {result.verification.critical_ok ? 'preserved' : `CHANGED (${[...result.verification.missing, ...result.verification.extra].join(', ')})`}{result.verification.glossary_misses.length ? ` · glossary: ${result.verification.glossary_misses.join(', ')}` : ''}</p>
        </section>
      )}
    </main>
  );
}
