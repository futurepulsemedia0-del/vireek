// Pre-job brief (phase C): visual + spoken, ~60 seconds. Built from the existing job brief only.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Heart, History, PackageX, ShieldAlert, Stethoscope, User, Volume2, VolumeX, Wrench, FileWarning, type LucideIcon } from 'lucide-react';
import type { JobBrief } from '@/lib/technicianOS';
import { useVoiceLogT } from '@/i18n/voiceLogNamespace';
import { buildBriefItems, estimateSeconds, fitSpoken, type BriefItem, type BriefKind } from '@/lib/voiceLog/preJobBrief';

type TFn = (key: string, opts?: Record<string, unknown>) => string;
const ICONS: Record<BriefKind, LucideIcon> = {
  safety: ShieldAlert, customer: User, equipment: Wrench, previous: History, claims: FileWarning, diagnosis: Stethoscope, shortage: PackageX, preference: Heart,
};
const SPEECH_LANG: Record<string, string> = { en: 'en-US', es: 'es-ES', fa: 'fa-IR' };
const SEVERITY_KEY: Record<string, string> = { low: 'sevLow', medium: 'sevMedium', high: 'sevHigh', emergency: 'sevEmergency' };

export function renderBriefItem(i: BriefItem, t: TFn): string {
  const p = i.params;
  switch (i.kind) {
    case 'safety': return p.note ? t('briefSafety', { note: p.note }) : t('briefSafetyNoNote');
    case 'customer': return p.service ? t('briefCustomer', p) : t('briefCustomerNoService', p);
    case 'equipment': {
      const warranty = t(`warranty${String(p.warranty).charAt(0).toUpperCase()}${String(p.warranty).slice(1)}`);
      return p.age !== '' ? t('briefEquipmentAge', { ...p, warranty }) : t('briefEquipment', { ...p, warranty });
    }
    case 'previous': return p.date ? t('briefPrevious', p) : t('briefPreviousNoDate', p);
    case 'claims': return t('briefClaims', { count: Number(p.count) });
    case 'diagnosis': {
      const severity = t(SEVERITY_KEY[String(p.severity)] ?? 'sevMedium');
      return p.pct !== '' ? t('briefDiagnosis', { severity, pct: p.pct }) : t('briefDiagnosisNoPct', { severity });
    }
    case 'shortage': return t('briefShortage', p);
    case 'preference': return t('briefPreference', p);
  }
}

export function PreJobBriefCard({ brief }: { brief: JobBrief }) {
  const { t, language } = useVoiceLogT();
  const tt = t as unknown as TFn;
  const [playing, setPlaying] = useState(false);
  const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
  const uttRef = useRef<SpeechSynthesisUtterance | null>(null);

  const rows = useMemo(() => buildBriefItems(brief).map((i) => ({ item: i, text: renderBriefItem(i, tt) })), [brief, tt]);
  const spoken = useMemo(() => fitSpoken(rows.map((r) => ({ text: r.text, priority: r.item.priority }))), [rows]);
  const seconds = estimateSeconds(spoken);

  useEffect(() => () => { if (canSpeak) window.speechSynthesis.cancel(); }, [canSpeak]);

  function toggle() {
    if (!canSpeak) return;
    if (playing) { window.speechSynthesis.cancel(); setPlaying(false); return; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(spoken.join('. '));
    u.lang = SPEECH_LANG[language.slice(0, 2)] ?? language;
    u.onend = () => setPlaying(false);
    u.onerror = () => setPlaying(false);
    uttRef.current = u;
    setPlaying(true);
    window.speechSynthesis.speak(u);
  }

  if (!rows.length) return null;
  const soon = brief.job.job_status === 'en_route';
  return (
    <section className={`space-y-3 rounded-lg border p-3 ${soon ? 'border-accent bg-accent/10' : 'border-border bg-bg-secondary'}`} aria-labelledby="prejob-brief-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="prejob-brief-title" className="text-base font-semibold text-text-primary">{soon ? tt('briefArriving') : tt('briefTitle')}</h2>
        <span className="text-xs text-text-secondary">{tt('briefSeconds', { seconds })}</span>
      </div>
      <ul className="space-y-2">
        {rows.map(({ item, text }) => {
          const Icon = ICONS[item.kind];
          const danger = item.kind === 'safety';
          return (
            <li key={item.id} className={`flex items-start gap-2 text-base ${danger ? 'font-semibold text-danger' : 'text-text-primary'}`}>
              <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
              <span>{text}</span>
            </li>
          );
        })}
      </ul>
      {canSpeak
        ? (
          <button type="button" onClick={toggle} aria-pressed={playing}
            className="flex min-h-[56px] w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-base font-semibold text-white">
            {playing ? <VolumeX className="h-5 w-5" aria-hidden="true" /> : <Volume2 className="h-5 w-5" aria-hidden="true" />}
            {playing ? tt('briefStop') : tt('briefPlay')}
          </button>
        )
        : <p className="text-sm text-text-secondary">{tt('briefNoSpeech')}</p>}
    </section>
  );
}
